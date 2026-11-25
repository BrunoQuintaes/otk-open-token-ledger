/**
 * OTK side of the reconciliation: OtkRecord[] from PostgreSQL (otk_operations) or, offline, from the
 * pilot budget-ledger JSONL files (read-only).
 *
 * Quantity convention (same as the statements): input = UNCACHED input; cache_read and cache_write
 * are separate; output includes thinking when the provider bills thinking as output (thinking is also
 * reported on its own as a subset). Absent categories stay absent (never written as 0).
 *
 * @module reconciliation/otkSource
 */
import type { PgQueryable } from '../operations/schema.js';
import type { OtkCategoryQuantity, OtkRecord, ReconProvider, ScaledAmount, UsageCategory } from './types.js';
import { DecimalParseError, parseDecimal, roundHalfEvenToScale } from './decimal.js';
import { getPath, lexemeOf, parseJsonLossless } from './parse.js';
import type { JsonValue } from './parse.js';
import { sha256Hex } from './importers/engine.js';

/**
 * Scale of OTK money: 10^12 units per USD (pico-USD).
 */
export const PICO = 1_000_000_000_000n;

/**
 * OTK records loaded from one source, with what was left out and the digests of what was read.
 */
export interface OtkLoadResult {
  records: OtkRecord[];
  excluded: Array<{ id: string; reason: string }>;
  /** SHA-256 hex digests of the data read (rows or file bytes). */
  digests: string[];
  description: string;
}

/**
 * Provider of a model id by its documented family prefix (explicit list; anything else is refused).
 *
 * @param model - Model ID (any case; surrounding whitespace ignored).
 * @returns The provider, or `null` for an unknown family.
 */
export function providerOfModel(model: string): ReconProvider | null {
  const m = model.trim().toLowerCase();
  if (m.startsWith('claude-')) return 'anthropic';
  if (m.startsWith('gpt-') || /^o\d/.test(m)) return 'openai';
  if (m.startsWith('gemini-') || m.startsWith('models/gemini-')) return 'gemini';
  return null;
}

const addQ = (out: Map<UsageCategory, bigint>, c: UsageCategory, v: bigint) => out.set(c, (out.get(c) ?? 0n) + v);
const toQuantities = (m: Map<UsageCategory, bigint>): OtkCategoryQuantity[] =>
  [...m.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => a.category.localeCompare(b.category));

interface UsageCategoryJson { name: string; count: string | null; inclusion: string }

/**
 * NormalizedUsage.categories (wire form) → statement categories.
 *
 * @param categories - Categories of a stored normalized usage (counts as decimal strings or null).
 * @param notes - Receives a note for each absent or inconsistent category (mutated).
 * @returns Quantities sorted by category; input is the base minus its subsets, output includes thinking
 *   reported as a separate addend.
 * @throws {SyntaxError} When a count is not an integer string (from `BigInt`).
 */
export function quantitiesFromNormalizedUsage(categories: UsageCategoryJson[], notes: string[]): OtkCategoryQuantity[] {
  const get = (n: string) => categories.find((c) => c.name === n);
  const val = (c: UsageCategoryJson | undefined): bigint | null => (c && c.count !== null && c.count !== undefined ? BigInt(c.count) : null);
  const out = new Map<UsageCategory, bigint>();
  const baseIn = val(get('input'));
  const baseOut = val(get('output'));
  let inSubsets = 0n;
  for (const c of categories) {
    const v = val(c);
    if (v === null) { if (c.name !== 'input' && c.name !== 'output') notes.push(`category ${c.name} absent (not counted)`); continue; }
    if (c.name === 'input' || c.name === 'output') continue;
    if (c.inclusion === 'subset_of_input') inSubsets += v;
    if (c.name === 'input_cache_read') addQ(out, 'cache_read', v);
    else if (c.name === 'input_cache_write') addQ(out, 'cache_write', v);
    else if (c.name === 'output_reasoning') addQ(out, 'thinking', v);
    else addQ(out, 'other', v);
  }
  if (baseIn !== null) {
    const unc = baseIn - inSubsets;
    if (unc < 0n) notes.push('input subsets exceed the input base; input not counted'); else out.set('input', unc);
  } else notes.push('input base absent');
  if (baseOut !== null) {
    const reasoning = get('output_reasoning');
    const addend = reasoning && reasoning.inclusion === 'separate_addend' ? (val(reasoning) ?? 0n) : 0n;
    out.set('output', baseOut + addend);
    if (addend > 0n) notes.push(`output includes ${addend} thinking tokens reported as a separate addend (billed as output)`);
  } else notes.push('output base absent');
  return toQuantities(out);
}

function moneyFromJson(v: unknown): ScaledAmount | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o['units'] === undefined || o['scale'] === undefined || o['units'] === null) return null;
  return { units: BigInt(String(o['units'])), scale: BigInt(String(o['scale'])) };
}

const isoOf = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/**
 * Operations of one tenant and provider observed in [start, end) (observedAt of the usage, else
 * created_at). Every operation is returned; one without confirmed money keeps confirmedMoney null.
 *
 * Read-only: one SELECT on `otk_operations`.
 *
 * @param db - PostgreSQL connection or pool.
 * @param q - Tenant, provider and half-open window `[start, end)` (ISO instants).
 * @returns The records ordered by operation ID, with a digest of the records read.
 */
export async function loadOtkFromPostgres(db: PgQueryable, q: { tenantId: string; provider: ReconProvider; start: string; end: string }): Promise<OtkLoadResult> {
  const r = await db.query<{
    operation_id: string; provider: string; model_requested: string; provider_request_id: string | null;
    usage: unknown; money: unknown; config: unknown; created_at: unknown;
  }>(
    `SELECT o.operation_id, o.provider, o.model_requested, o.provider_request_id, o.usage, o.money, o.config, o.created_at
       FROM otk_operations o
      WHERE o.tenant_id = $1 AND o.provider = $2
        AND COALESCE((o.usage->>'observedAt')::timestamptz, o.created_at) >= $3::timestamptz
        AND COALESCE((o.usage->>'observedAt')::timestamptz, o.created_at) <  $4::timestamptz
      ORDER BY o.operation_id`,
    [q.tenantId, q.provider, q.start, q.end],
  );
  const records: OtkRecord[] = [];
  const excluded: OtkLoadResult['excluded'] = [];
  for (const row of r.rows) {
    const notes: string[] = [];
    const usage = (typeof row.usage === 'string' ? JSON.parse(row.usage) : row.usage) as Record<string, unknown> | null;
    const money = (typeof row.money === 'string' ? JSON.parse(row.money) : row.money) as Record<string, unknown> | null;
    const config = (typeof row.config === 'string' ? JSON.parse(row.config) : row.config) as Record<string, unknown> | null;
    const quantities = usage && Array.isArray(usage['categories']) ? quantitiesFromNormalizedUsage(usage['categories'] as UsageCategoryJson[], notes) : [];
    if (!usage) notes.push('no usage recorded (measurement missing)');
    else if (usage['completeness'] !== 'complete') notes.push(`usage completeness ${String(usage['completeness'])}`);
    const confirmed = money ? moneyFromJson(money['confirmed']) : null;
    const pt = (money?.['priceTable'] as { version?: string } | null | undefined)?.version
      ?? ((config?.['priceTable'] as { version?: string } | null | undefined)?.version ?? null);
    records.push({
      source: 'postgres', tenantId: q.tenantId, operationId: row.operation_id, provider: q.provider,
      modelRequested: row.model_requested, modelReturned: (usage?.['modelReturned'] as string | null | undefined) ?? null,
      providerRequestId: row.provider_request_id ?? ((usage?.['providerRequestId'] as string | null | undefined) ?? null),
      quantities, priceTableVersion: pt, confirmedMoney: confirmed,
      moneyState: (money?.['state'] as string | undefined) ?? null,
      moneyOrigin: money?.['origin'] === 'legacy_pre_s4' ? 'otk_operations.money.confirmed (legacy_pre_s4 backfill)' : 'otk_operations.money.confirmed',
      moneyRoundingHalfUnits: 0n,
      observedAt: usage && typeof usage['observedAt'] === 'string' ? isoOf(usage['observedAt']) : isoOf(row.created_at),
      notes,
    });
  }
  const digest = sha256Hex(JSON.stringify(records, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  return { records, excluded, digests: [digest], description: `PostgreSQL otk_operations tenant=${q.tenantId} provider=${q.provider} window=[${q.start}, ${q.end})` };
}

/**
 * Options for {@link loadOtkFromPilotLedger}.
 */
export interface PilotLedgerOptions {
  /** Label of the ledger file, used in excluded IDs and the description. */
  sourceName: string;
  /** Keep only this provider (others go to excluded). */
  provider?: ReconProvider;
  /** Price table frozen for the pilot operations (from the run manifest); null when unknown. */
  priceTableVersion?: string | null;
  tenantId?: string | null;
}

const lex = (v: JsonValue | undefined): string | null => lexemeOf(v);

/**
 * Pilot budget ledger (JSONL of reserve/settle events written by scripts/pilot). Read-only.
 * Money: settle.costUsd was written by the runner as a JS number; its exact lexeme is parsed and
 * rounded half-even to pico-USD (moneyRoundingHalfUnits = 1 when digits were dropped).
 *
 * @param text - Whole JSONL ledger content.
 * @param opts - Source label, provider filter, frozen price table and tenant.
 * @returns Settled, successful operations as records; everything else is listed in `excluded` with a reason.
 * @throws {@link StatementParseError} When a non-blank line is not valid JSON.
 */
export function loadOtkFromPilotLedger(text: string, opts: PilotLedgerOptions): OtkLoadResult {
  const reserves = new Map<string, JsonValue>();
  const settles = new Map<string, JsonValue>();
  const order: string[] = [];
  const excluded: OtkLoadResult['excluded'] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (line.trim() === '') return;
    const v = parseJsonLossless(line);
    const type = lex(getPath(v, 'type'));
    const id = lex(getPath(v, 'id'));
    if (!id || (type !== 'reserve' && type !== 'settle')) { excluded.push({ id: `${opts.sourceName}:line${i + 1}`, reason: `unrecognized ledger event ${JSON.stringify(type)}` }); return; }
    if (type === 'reserve') { reserves.set(id, v); order.push(id); } else settles.set(id, v);
  });
  const records: OtkRecord[] = [];
  for (const id of order) {
    const res = reserves.get(id)!;
    const st = settles.get(id);
    const model = lex(getPath(res, 'model')) ?? '';
    const provider = providerOfModel(model);
    if (!provider) { excluded.push({ id: `ledger:${id}`, reason: `model ${JSON.stringify(model)} has no known provider prefix` }); continue; }
    if (opts.provider && provider !== opts.provider) { excluded.push({ id: `ledger:${id}`, reason: `provider ${provider} (not ${opts.provider})` }); continue; }
    if (!st) { excluded.push({ id: `ledger:${id}`, reason: 'reservation without settlement (open or uncertain): not a confirmed cost' }); continue; }
    const outcome = lex(getPath(st, 'outcome'));
    if (outcome !== 'ok') { excluded.push({ id: `ledger:${id}`, reason: `settlement outcome ${JSON.stringify(outcome)} (http ${lex(getPath(st, 'httpStatus')) ?? '?'}): no usage billed` }); continue; }
    const notes: string[] = [];
    const q = new Map<UsageCategory, bigint>();
    const take = (path: string, cat: UsageCategory) => {
      const x = lex(getPath(st, `usage.${path}`));
      if (x === null) { notes.push(`usage.${path} absent`); return; }
      addQ(q, cat, BigInt(x));
    };
    take('input_tokens', 'input');
    take('output_tokens', 'output');
    take('cache_read_input_tokens', 'cache_read');
    take('cache_creation_input_tokens', 'cache_write');
    let confirmed: ScaledAmount | null = null;
    let lost = 0n;
    const cost = lex(getPath(st, 'costUsd'));
    if (cost !== null) {
      try {
        const r = roundHalfEvenToScale(parseDecimal(cost).amount, PICO);
        confirmed = r.amount; lost = r.lostHalfUnits;
        if (lost > 0n) notes.push(`costUsd lexeme ${cost} rounded half-even to pico-USD`);
      } catch (e) {
        if (!(e instanceof DecimalParseError)) throw e;
        notes.push(`costUsd unparseable: ${cost}`);
      }
    } else notes.push('costUsd absent');
    const msgId = lex(getPath(st, 'providerMessageId'));
    if (msgId) notes.push(`providerMessageId=${msgId}`);
    records.push({
      source: 'pilot_ledger', tenantId: opts.tenantId ?? null, operationId: `ledger:${id}`, provider,
      modelRequested: model, modelReturned: null,
      providerRequestId: lex(getPath(st, 'providerRequestId')),
      quantities: toQuantities(q), priceTableVersion: opts.priceTableVersion ?? null,
      confirmedMoney: confirmed, moneyState: 'settled',
      moneyOrigin: 'pilot budget ledger settle.costUsd (JS number lexeme, rounded half-even to pico-USD); computed by OTK/pilot, not a provider statement',
      moneyRoundingHalfUnits: lost,
      observedAt: new Date(lex(getPath(st, 'ts')) ?? '').toISOString(),
      notes,
    });
  }
  return {
    records, excluded, digests: [sha256Hex(Buffer.from(text, 'utf8'))],
    description: `pilot budget ledger ${opts.sourceName} (read-only copy)`,
  };
}

/**
 * SYNTHETIC OTK records from a fixture file (tests and documented demonstrations only). The file must carry a
 * top-level "_synthetic" marker; records come out with source 'fixture' so the report can never present them
 * as measured data.
 *
 * @param text - Fixture JSON text.
 * @param sourceName - Label used in errors and in the description.
 * @returns Records with `source: 'fixture'`.
 * @throws {Error} When the `_synthetic` marker is missing, `records` is not an array, or a record has an
 *   unsupported provider (and JSON parse errors).
 */
export function loadOtkFromFixtureJson(text: string, sourceName: string): OtkLoadResult {
  const doc = JSON.parse(text) as { _synthetic?: unknown; records?: unknown };
  if (typeof doc._synthetic !== 'string' || !/SYNTHETIC/.test(doc._synthetic)) throw new Error(`${sourceName}: OTK fixture without a "_synthetic" marker is refused`);
  if (!Array.isArray(doc.records)) throw new Error(`${sourceName}: "records" must be an array`);
  const records = (doc.records as Array<Record<string, unknown>>).map((r, i): OtkRecord => {
    const provider = r['provider'] as ReconProvider;
    if (!['anthropic', 'openai', 'gemini'].includes(provider)) throw new Error(`${sourceName} record ${i + 1}: provider`);
    const q = (r['quantities'] ?? {}) as Record<string, string>;
    const money = r['confirmedMoneyPico'];
    return {
      source: 'fixture', tenantId: (r['tenantId'] as string | undefined) ?? null, operationId: String(r['operationId']), provider,
      modelRequested: String(r['modelRequested']), modelReturned: (r['modelReturned'] as string | null | undefined) ?? null,
      providerRequestId: (r['providerRequestId'] as string | null | undefined) ?? null,
      quantities: Object.entries(q).map(([category, count]) => ({ category: category as UsageCategory, count: BigInt(count) })).sort((a, b) => a.category.localeCompare(b.category)),
      priceTableVersion: (r['priceTableVersion'] as string | null | undefined) ?? null,
      confirmedMoney: money === null || money === undefined ? null : { units: BigInt(String(money)), scale: PICO },
      moneyState: money === null || money === undefined ? null : 'settled',
      moneyOrigin: 'SYNTHETIC fixture record', moneyRoundingHalfUnits: 0n,
      observedAt: new Date(String(r['observedAt'])).toISOString(), notes: [],
    };
  });
  return { records, excluded: [], digests: [sha256Hex(Buffer.from(text, 'utf8'))], description: `SYNTHETIC OTK fixture ${sourceName}` };
}

/**
 * Concatenate several loads (e.g. three pilot ledgers).
 *
 * @param loads - Loads to combine, in order.
 * @returns A new load with records, exclusions and digests concatenated.
 */
export function mergeOtkLoads(loads: OtkLoadResult[]): OtkLoadResult {
  return {
    records: loads.flatMap((l) => l.records),
    excluded: loads.flatMap((l) => l.excluded),
    digests: loads.flatMap((l) => l.digests),
    description: loads.map((l) => l.description).join(' + '),
  };
}
