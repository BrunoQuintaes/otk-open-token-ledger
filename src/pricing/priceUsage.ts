/**
 * Historical, per-category monetary pricing of normalized usage (D5 §6, D5-G05/G07; front B).
 * createPriceUsage(tables) returns a PriceUsageFn.
 *
 * Money is separate from CU. Amounts are exact: unit prices are micro-USD per 1,000,000
 * tokens (scale 10^6), so count × price is an integer at scale 10^12 (pico-USD) and nothing
 * is rounded here; display/invoice rounding is a later, explicit policy.
 *
 * Line rule (no omission, no double count):
 *  - a non-base category with a table price gets its own line; a subset is carved out of the base;
 *  - without a price, PRICE_CATEGORY_POLICY_V1 decides: 'billed_as_base' only where the provider
 *    documents it (e.g. reasoning billed as output: a subset stays in the base line, an addend is
 *    billed at the base rate of its side); otherwise ('separately_priced', the default) the
 *    category is an unpriced line, carved out of the base, and the quote is 'partial' (ABC-02);
 *  - zero tokens need no price.
 * A missing table, model or base price is 'missing_price' with total null — never US$ 0.
 * Tables are immutable by digest: pricing an operation with its frozen VersionRef gives the
 * same quote after newer tables are published (historical price).
 *
 * Pure (no I/O): tables are loaded by the caller (`src/operations/d1d8Ports.ts` reads them from files).
 *
 * @module src/pricing/priceUsage
 */
import type {
  IsoTime, Money, NormalizedUsage, PriceLine, PriceQuote, TokenCategory, TokenCategoryName, VersionRef,
} from '../types/d1d8/index.js';
import { canonicalJson, sha256Hex } from '../providers/usage/canonicalJson.js';
import { categorySide } from '../providers/usage/normalizeUsage.js';

/** Scale of unit prices: units are micro-USD per 1,000,000 tokens. */
export const UNIT_PRICE_SCALE = 1_000_000n; // micro-USD per MTok
/** Scale of amounts and totals: units are pico-USD. */
export const AMOUNT_SCALE = 1_000_000_000_000n; // pico-USD
const MTOK = 1_000_000n;

/** One published price of one token category of one model, valid in a time window. */
export interface PriceEntryV1 {
  /** Provider id (lower case after parsing). */
  provider: string;
  /** Priced model key (lower case after parsing). */
  model: string;
  category: TokenCategoryName;
  /** micro-USD per 1,000,000 tokens (e.g. US$ 0.15/MTok → 150000n). */
  pricePerMTokMicroUsd: bigint;
  /** Inclusive start of validity. */
  effectiveFrom: IsoTime;
  /** Exclusive end; null = open. */
  effectiveUntil: IsoTime | null;
  /** URL or document id of the published price, with its date. */
  source: string;
}

/** A versioned, immutable USD price table. */
export interface PriceTableV1 {
  schema: 'otk.price_table.v1';
  /** Human-readable version label; the digest of the whole table is what freezes it. */
  version: string;
  currency: 'USD';
  entries: PriceEntryV1[];
  /** Explicit model id → priced model key (dated snapshots). */
  aliases: Record<string, string>;
}

/**
 * Reference that freezes a table: its version label and the SHA-256 of its canonical JSON.
 *
 * @param table - The table.
 * @returns Version and digest.
 */
export function priceTableRef(table: PriceTableV1): VersionRef {
  return { version: table.version, digest: sha256Hex(canonicalJson(table)) };
}

function money(units: bigint, scale: bigint): Money {
  return { units, scale, currency: 'USD' };
}

/**
 * Parse the JSON wire form (prices as decimal strings) into a table; throws on invalid input.
 *
 * Provider, model and alias keys/values are lower-cased.
 *
 * @param raw - Parsed JSON of an `otk.price_table.v1` file.
 * @returns The table.
 * @throws {Error} When the schema, currency or version is wrong, an entry field is missing or malformed, an
 *   alias is not a string, or two windows of the same provider/model/category overlap.
 */
export function parsePriceTableV1(raw: unknown): PriceTableV1 {
  if (!raw || typeof raw !== 'object') throw new Error('price table must be an object');
  const t = raw as Record<string, unknown>;
  if (t['schema'] !== 'otk.price_table.v1' || t['currency'] !== 'USD' || typeof t['version'] !== 'string') {
    throw new Error('price table: schema/currency/version invalid');
  }
  if (!Array.isArray(t['entries'])) throw new Error('price table: entries must be an array');
  const entries = (t['entries'] as unknown[]).map((e, i): PriceEntryV1 => {
    const r = e as Record<string, unknown>;
    const p = r['pricePerMTokMicroUsd'];
    const price = typeof p === 'bigint' ? p : typeof p === 'string' && /^[0-9]+$/.test(p) ? BigInt(p) : null;
    if (price === null) throw new Error(`price table entry ${i}: pricePerMTokMicroUsd must be a decimal string`);
    for (const f of ['provider', 'model', 'category', 'effectiveFrom', 'source']) {
      if (typeof r[f] !== 'string' || !(r[f] as string)) throw new Error(`price table entry ${i}: ${f} missing`);
    }
    if (r['effectiveUntil'] !== null && typeof r['effectiveUntil'] !== 'string') throw new Error(`price table entry ${i}: effectiveUntil`);
    return {
      provider: (r['provider'] as string).toLowerCase(),
      model: (r['model'] as string).toLowerCase(),
      category: r['category'] as TokenCategoryName,
      pricePerMTokMicroUsd: price,
      effectiveFrom: r['effectiveFrom'] as string,
      effectiveUntil: (r['effectiveUntil'] as string | null) ?? null,
      source: r['source'] as string,
    };
  });
  const aliases: Record<string, string> = {};
  for (const [k, v] of Object.entries((t['aliases'] ?? {}) as Record<string, unknown>)) {
    if (typeof v !== 'string') throw new Error(`price table: alias ${k} must map to a string`);
    aliases[k.toLowerCase()] = v.toLowerCase();
  }
  // Overlapping windows for the same provider/model/category would make the price ambiguous.
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]!;
      const b = entries[j]!;
      if (a.provider !== b.provider || a.model !== b.model || a.category !== b.category) continue;
      const aEnd = a.effectiveUntil === null ? Infinity : Date.parse(a.effectiveUntil);
      const bEnd = b.effectiveUntil === null ? Infinity : Date.parse(b.effectiveUntil);
      if (Date.parse(a.effectiveFrom) < bEnd && Date.parse(b.effectiveFrom) < aEnd) {
        throw new Error(`price table: overlapping windows for ${a.provider}/${a.model}/${a.category}`);
      }
    }
  }
  return { schema: 'otk.price_table.v1', version: t['version'] as string, currency: 'USD', entries, aliases };
}

function effective(e: PriceEntryV1, atMs: number): boolean {
  return Date.parse(e.effectiveFrom) <= atMs && (e.effectiveUntil === null || atMs < Date.parse(e.effectiveUntil));
}

/** In-memory registry of immutable price tables, keyed by digest. */
export interface PriceTableRegistry {
  /**
   * Adds an immutable table and returns its ref (the digest freezes its content).
   *
   * @param table - The table (stored as a deep copy).
   * @returns Its reference.
   */
  add(table: PriceTableV1): VersionRef;
  /**
   * Returns a deep copy of the table frozen by `ref`.
   *
   * @param ref - Version and digest.
   * @returns The table, or `null` when the digest is unknown or the version label differs.
   */
  get(ref: VersionRef): PriceTableV1 | null;
}

/**
 * Creates a registry pre-loaded with the given tables.
 *
 * @param tables - Tables to add.
 * @returns The registry.
 */
export function createPriceTableRegistry(tables: PriceTableV1[] = []): PriceTableRegistry {
  const byDigest = new Map<string, PriceTableV1>();
  const reg: PriceTableRegistry = {
    add(table) {
      const ref = priceTableRef(table);
      byDigest.set(ref.digest, structuredClone(table));
      return ref;
    },
    get(ref) {
      const t = byDigest.get(ref.digest);
      // A copy: mutating the returned table must not change prices behind a frozen digest.
      return t && t.version === ref.version ? structuredClone(t) : null;
    },
  };
  for (const t of tables) reg.add(t);
  return reg;
}

function resolveModelKey(table: PriceTableV1, model: string): string {
  const m = model.trim().toLowerCase();
  return Object.hasOwn(table.aliases, m) ? table.aliases[m]! : m;
}

function findEntry(table: PriceTableV1, provider: string, modelKey: string, category: TokenCategoryName, atMs: number): PriceEntryV1 | null {
  const p = provider.trim().toLowerCase();
  return table.entries.find((e) => e.provider === p && e.model === modelKey && e.category === category && effective(e, atMs)) ?? null;
}

/**
 * Versioned billing policy of non-base categories (S4, audit ABC-02). A table without a price for
 * a category does NOT mean "inherits the base rate": that inheritance holds only where the
 * provider documents it, listed here explicitly. Everything else is 'separately_priced', so a
 * missing tariff makes the quote partial instead of silently charging the base rate.
 */
export type CategoryBillingMode = 'separately_priced' | 'billed_as_base';
/** One documented exception: this provider bills this category at its side's base rate. */
export interface CategoryPolicyRule { provider: string; category: TokenCategoryName; mode: CategoryBillingMode; docRef: string }
/** Version 1 of the category billing policy (id stamped in every quote). */
export const PRICE_CATEGORY_POLICY_V1: { id: string; default: CategoryBillingMode; rules: readonly CategoryPolicyRule[] } = Object.freeze({
  id: 'otk.price_category_policy.v1@2026-10-01',
  default: 'separately_priced' as const,
  rules: Object.freeze([
    { provider: 'openai', category: 'output_reasoning', mode: 'billed_as_base', docRef: 'https://platform.openai.com/docs/guides/reasoning — reasoning tokens are billed as output tokens (B USAGE_MATRIX, 2026-09-30)' },
    { provider: 'anthropic', category: 'output_reasoning', mode: 'billed_as_base', docRef: 'https://platform.claude.com/docs/en/build-with-claude/extended-thinking — thinking tokens are billed as output tokens (S4 FONTES_PRECO_20261001.md)' },
    { provider: 'gemini', category: 'output_reasoning', mode: 'billed_as_base', docRef: 'https://ai.google.dev/gemini-api/docs/pricing — output price includes thinking tokens (B USAGE_MATRIX, 2026-09-30)' },
    { provider: 'deepseek', category: 'output_reasoning', mode: 'billed_as_base', docRef: 'https://api-docs.deepseek.com/quick_start/pricing — CoT and answer tokens priced equally (B USAGE_MATRIX, 2026-09-30)' },
  ] as CategoryPolicyRule[]),
});

/**
 * Billing mode of an unpriced non-base category for a provider.
 *
 * @param provider - Provider id (trimmed, case-insensitive).
 * @param category - Token category.
 * @returns `billed_as_base` only for a listed rule; otherwise `separately_priced`.
 */
export function categoryBillingMode(provider: string, category: TokenCategoryName): CategoryBillingMode {
  const p = provider.trim().toLowerCase();
  return PRICE_CATEGORY_POLICY_V1.rules.find((r) => r.provider === p && r.category === category)?.mode ?? PRICE_CATEGORY_POLICY_V1.default;
}

function line(category: TokenCategoryName, count: bigint, entry: PriceEntryV1 | null, note = ''): PriceLine {
  if (!entry) {
    return {
      category,
      count,
      // contract 1.1.0 (R-B3): no published price → null unit price and null amount (never 0)
      unitPricePerMTok: null,
      source: 'otk:missing_price',
      effectiveFrom: '1970-01-01T00:00:00.000Z',
      amount: null,
    };
  }
  return {
    category,
    count,
    unitPricePerMTok: money(entry.pricePerMTokMicroUsd, UNIT_PRICE_SCALE),
    source: note ? `${entry.source} [${note}]` : entry.source,
    effectiveFrom: entry.effectiveFrom,
    // count × µUSD/MTok = count × price × 10^-12 USD → units at scale 10^12, exact.
    amount: money(count * entry.pricePerMTokMicroUsd * (AMOUNT_SCALE / UNIT_PRICE_SCALE / MTOK), AMOUNT_SCALE),
  };
}

/**
 * Quote for one usage with one table (exported for direct use and tests).
 *
 * The returned model is priced (the requested one when none was returned). Status `priced` requires every
 * line priced and a complete usage; a partial quote still carries the total of its priced lines.
 *
 * @param usage - Normalized usage.
 * @param at - Time whose prices apply (usually the observation time).
 * @param table - The price table.
 * @param tableRef - Its reference, stamped in the quote.
 * @returns `priced`, `partial` (total of known lines) or `missing_price` (total `null`).
 */
export function priceUsageWithTable(usage: NormalizedUsage, at: IsoTime, table: PriceTableV1, tableRef: VersionRef): PriceQuote {
  const quote = (status: PriceQuote['status'], lines: PriceLine[], total: Money | null): PriceQuote =>
    ({ schema: 'otk.price_quote.v1', status, total, lines, priceTable: tableRef, pricedAt: at, categoryPolicy: PRICE_CATEGORY_POLICY_V1.id });
  const atMs = Date.parse(at);
  if (Number.isNaN(atMs) || usage.completeness === 'missing') return quote('missing_price', [], null);
  const modelKey = resolveModelKey(table, usage.modelReturned ?? usage.modelRequested);
  const priced = (c: TokenCategory) => findEntry(table, usage.provider, modelKey, c.name, atMs);
  const inputBase = usage.categories.find((c) => c.name === 'input' && c.inclusion === 'base');
  const outputBase = usage.categories.find((c) => c.name === 'output' && c.inclusion === 'base');
  if (!inputBase || !outputBase || inputBase.count === null || outputBase.count === null) return quote('missing_price', [], null);
  const inputEntry = priced(inputBase);
  const outputEntry = priced(outputBase);
  if (!inputEntry || !outputEntry) return quote('missing_price', [], null);

  const lines: PriceLine[] = [];
  let carveIn = 0n;
  let carveOut = 0n;
  for (const c of usage.categories) {
    if (c.count === null || c.inclusion === 'base') continue;
    const entry = priced(c);
    const carve = () => { if (c.inclusion === 'subset_of_input') carveIn += c.count!; else if (c.inclusion === 'subset_of_output') carveOut += c.count!; };
    if (entry) {
      lines.push(line(c.name, c.count, entry));
      carve();
      continue;
    }
    // Zero tokens need no price: an unpriced 0 line would only block the quote.
    if (c.count === 0n) continue;
    if (categoryBillingMode(usage.provider, c.name) === 'billed_as_base') {
      // documented inheritance: a subset stays inside its base line; an addend is billed at its side's base rate
      if (c.inclusion === 'separate_addend') {
        lines.push(line(c.name, c.count, categorySide(c.name) === 'input' ? inputEntry : outputEntry, `${PRICE_CATEGORY_POLICY_V1.id}: billed_as_base`));
      }
      continue;
    }
    // separately priced and no tariff: an unpriced line (quote partial); a subset is carved out of
    // the base line so its tokens are never billed at the base rate (ABC-02)
    lines.push(line(c.name, c.count, null));
    carve();
  }
  if (carveIn > inputBase.count || carveOut > outputBase.count) return quote('missing_price', [], null);
  lines.unshift(line('output', outputBase.count - carveOut, outputEntry));
  lines.unshift(line('input', inputBase.count - carveIn, inputEntry));

  const total = lines.reduce((s, l) => s + (l.amount?.units ?? 0n), 0n);
  const allPriced = lines.every((l) => l.amount !== null);
  const status = allPriced && usage.completeness === 'complete' ? 'priced' : 'partial';
  return quote(status, lines, money(total, AMOUNT_SCALE));
}

/**
 * PriceUsageFn bound to a registry of immutable tables.
 *
 * @param registry - The table registry.
 * @returns A pricing function; an unknown table reference gives `missing_price`.
 */
export function createPriceUsage(registry: PriceTableRegistry) {
  return (usage: NormalizedUsage, at: IsoTime, tableRef: VersionRef): PriceQuote => {
    const table = registry.get(tableRef);
    if (!table) {
      return { schema: 'otk.price_quote.v1', status: 'missing_price', total: null, lines: [], priceTable: tableRef, pricedAt: at, categoryPolicy: PRICE_CATEGORY_POLICY_V1.id };
    }
    return priceUsageWithTable(usage, at, table, tableRef);
  };
}

/**
 * Highest price per side for a model across every window of the table (time-independent, so a
 * reservation never depends on the wall clock). null when the model has no base price.
 *
 * @param table - The price table.
 * @param provider - Provider id (trimmed, case-insensitive).
 * @param model - Model id (aliases resolved).
 * @returns Highest micro-USD/MTok price on the input side and on the output side, or `null`.
 */
export function worstCaseSidePrices(table: PriceTableV1, provider: string, model: string): { input: bigint; output: bigint } | null {
  const p = provider.trim().toLowerCase();
  const key = resolveModelKey(table, model);
  const rows = table.entries.filter((e) => e.provider === p && e.model === key);
  if (!rows.some((e) => e.category === 'input') || !rows.some((e) => e.category === 'output')) return null;
  const max = (side: 'input' | 'output') => rows.filter((e) => categorySide(e.category) === side)
    .reduce((m, e) => (e.pricePerMTokMicroUsd > m ? e.pricePerMTokMicroUsd : m), 0n);
  return { input: max('input'), output: max('output') };
}
