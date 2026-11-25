/**
 * D1–D8 / C — durable profile of the MITM proxy (D7 §1–4, §8–10; RV30-06).
 *
 *   auth/tenant (caller) → API + limits → admit (durable BEFORE the provider is called; quota,
 *   money ceiling, idempotency) → upstream_started under an execution lease → relay →
 *   settle in one transaction (ledger debit + outbox effects) or keep the exposure uncertain.
 *
 * - App closes: delivery becomes client_disconnected; the upstream keeps being read until it
 *   ends or a limit (duration/output) stops it, so a final usage is still captured once.
 * - Explicit cancel (POST /v1/operations/{id}/cancel, any instance): cancel_requested is written;
 *   the streaming instance aborts the upstream (in-process signal or lease-renewal poll).
 *   Already-reported usage is kept; partial usage never becomes final (held_uncertain).
 * - Upstream lost before the final usage: upstream_failed + uncertain, never re-sent, never 0.
 * - Same operation id again: answered from the stored operation (409), no new generation.
 * - PostgreSQL down at the end: the measurement goes to the local spool (fsync) and is applied
 *   when the database returns.
 * Prompt/response text is never stored; the optional counter keeps it in memory only.
 *
 * Entry point: {@link handleDurableMitm}, called by `src/proxy/ProxyGateway.ts` after it identified the tenant.
 * `replaySpool` runs periodically from `src/operations/runtime.ts`. Side effects: PostgreSQL writes, the local
 * spool, one upstream provider call per admitted operation (spends the operator's provider key), the
 * admission-refusal metric, and structured logs (keys, states and errors only; no text, no secrets).
 *
 * @module src/operations/proxyDurable
 */
import { getTenantPlanVersioned } from '../billing/PlanRegistry.js';
import { admissionRefusalsTotal } from '../observability/prometheusMetrics.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type {
  CuConfig, CuResult, DeliveryState, DurableOperation, LocalCounter, LocalCountResult, MoneySettlement, NormalizedUsage, OperationKey,
  PriceQuote, PricingTerms, Reservation, StreamUsageAccumulator, UsageApi,
} from '../types/d1d8/index.js';
import { ACCOUNTING_SCALE, toAccountingUnits } from './accounting.js';
import { decodeLocalCount, decodeUsage, decodeCuResult, decodePrice, encodeJson } from './codec.js';
import { effectId, payloadDigest, requestDigest, requestDigestV2, REQUEST_DIGEST_V2 } from './ids.js';
import { attributionFromHeaders } from './attribution.js';
import { AdmissionQueueTimeout } from './admissionGate.js';
import { keyString, legacyReceiptId, type OperationsContext } from './context.js';
import { RevisionConflictError } from './PgOperationStore.js';
import type { EnqueueInput } from './PgEffectOutbox.js';
import { IllegalTransitionError, type OperationPatch } from './transitions.js';
import type { UpstreamResponse } from '../proxy/ProxyForwarder.js';
import type { SpoolApplyOutcome, SpoolRecord, SpoolReplayResult } from './spool.js';
import { assessMoneyBound, serviceTierMatches } from './moneyBound.js';

// ───────────────────────────── request inspection ─────────────────────────────

/**
 * Provider API addressed by a request path (the declared text scope, D5 §2); null = unsupported.
 *
 * @param provider - Provider id as routed by the gateway (lower case).
 * @param pathname - Upstream path; trailing slashes are ignored.
 * @returns The usage API, or `null` when the path is outside the metered scope.
 */
export function detectApi(provider: string, pathname: string): UsageApi | null {
  const p = pathname.replace(/\/+$/, '');
  switch (provider) {
    case 'openai':
      if (/\/v1\/chat\/completions$/.test(p)) return 'openai.chat_completions';
      if (/\/v1\/responses$/.test(p)) return 'openai.responses';
      return null;
    case 'anthropic': return /\/v1\/messages$/.test(p) ? 'anthropic.messages' : null;
    // exact method names (review L1): a different case would be detected as Gemini but not as a stream
    case 'gemini': return /:(generateContent|streamGenerateContent)$/.test(p) ? 'gemini.generate_content' : null;
    case 'deepseek': return /\/chat\/completions$/.test(p) ? 'deepseek.chat_completions' : null;
    case 'mistral': return /\/v1\/chat\/completions$/.test(p) ? 'mistral.chat_completions' : null;
    case 'cohere': return /\/v[12]\/chat$/.test(p) ? 'cohere.chat' : null;
    default: return null;
  }
}

/** Field that limits the output of each API, as documented by the provider. */
const MAX_OUTPUT_FIELDS: Record<UsageApi, string[]> = {
  'openai.chat_completions': ['max_completion_tokens', 'max_tokens'],
  'openai.responses': ['max_output_tokens'],
  'anthropic.messages': ['max_tokens'],
  'gemini.generate_content': ['generationConfig.maxOutputTokens'],
  'deepseek.chat_completions': ['max_tokens'],
  'mistral.chat_completions': ['max_tokens'],
  'cohere.chat': ['max_tokens'],
};

// Dotted-path helpers for nested limit fields such as `generationConfig.maxOutputTokens`. setPath mutates `o`.
function getPath(o: Record<string, unknown>, dotted: string): unknown {
  return dotted.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), o);
}
function setPath(o: Record<string, unknown>, dotted: string, v: unknown): void {
  const parts = dotted.split('.');
  let cur = o;
  for (const k of parts.slice(0, -1)) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = v;
}

/** Other spellings a provider may accept for the same limit; refused so the frozen limit is the only one. */
const MAX_OUTPUT_ALIASES: Partial<Record<UsageApi, string[]>> = {
  'gemini.generate_content': ['generation_config', 'generationConfig.max_output_tokens'],
};

/** Output limit frozen for an operation (tokens), whether the policy default was injected, or why it was refused. */
export type LimitDecision =
  | { ok: true; maxOutputTokens: bigint; injected: boolean }
  | { ok: false; error: 'max_output_invalid' | 'max_output_above_policy' | 'max_output_ambiguous'; detail: string };

/**
 * Freeze the output limit: the request's (≤ cap) or the policy default injected into the body.
 * More than one limit field (or an alias spelling) is refused: the provider might honour the
 * other one (review MEDIUM-5).
 *
 * Mutates `body` when the default is injected.
 *
 * @param api - Provider API (selects the documented limit field).
 * @param body - Parsed request body.
 * @param policy - Default limit and maximum accepted limit, tokens.
 * @returns The frozen limit, or a refusal with an error code and detail.
 */
export function applyOutputLimit(api: UsageApi, body: Record<string, unknown>, policy: { defaultMaxOutputTokens: bigint; maxOutputTokensCap: bigint }): LimitDecision {
  for (const alias of MAX_OUTPUT_ALIASES[api] ?? []) {
    if (getPath(body, alias) !== undefined) return { ok: false, error: 'max_output_ambiguous', detail: `${alias} is not accepted; use ${MAX_OUTPUT_FIELDS[api][0]}` };
  }
  const present = MAX_OUTPUT_FIELDS[api].filter((f) => getPath(body, f) !== undefined && getPath(body, f) !== null);
  if (present.length > 1) return { ok: false, error: 'max_output_ambiguous', detail: `only one of ${present.join(', ')} may be sent` };
  const f = present[0];
  if (f) {
    const v = getPath(body, f);
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) return { ok: false, error: 'max_output_invalid', detail: `${f} must be a positive integer` };
    if (BigInt(v) > policy.maxOutputTokensCap) return { ok: false, error: 'max_output_above_policy', detail: `${f}=${v} > ${policy.maxOutputTokensCap}` };
    return { ok: true, maxOutputTokens: BigInt(v), injected: false };
  }
  setPath(body, MAX_OUTPUT_FIELDS[api][0]!, Number(policy.defaultMaxOutputTokens));
  return { ok: true, maxOutputTokens: policy.defaultMaxOutputTokens, injected: true };
}

const OP_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

// ───────────────────────────── status view (no text) ─────────────────────────────

/**
 * Public shape of an operation for its tenant: state axes, amounts, effects — never text.
 *
 * @param op - The operation.
 * @param extra - Extra top-level fields merged last (they override same-named fields).
 * @returns A JSON-safe object (bigint values as decimal strings).
 */
export function operationView(op: DurableOperation, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const scaled = (x: { units: bigint; scale: bigint } | null) => (x ? { units: x.units.toString(), scale: x.scale.toString() } : null);
  return {
    schema: op.schema,
    operationId: op.key.operationId,
    provider: op.provider,
    api: op.api,
    modelRequested: op.modelRequested,
    execution: op.execution,
    measurement: op.measurement,
    delivery: op.delivery,
    reservation: { state: op.reservation.state, basis: op.reservation.basis, cu: scaled(op.reservation.cu), money: op.reservation.money ? { ...scaled(op.reservation.money), currency: 'USD' } : null },
    // ABC-03: reserved (worst case held), confirmed (spent) and pending are distinct fields
    money: op.money ? {
      state: op.money.state,
      reserved: { ...scaled(op.money.reserved), currency: 'USD' },
      confirmed: op.money.confirmed ? { ...scaled(op.money.confirmed), currency: 'USD' } : null,
      knownSubtotal: op.money.knownSubtotal ? { ...scaled(op.money.knownSubtotal), currency: 'USD' } : null,
      priceStatus: op.money.priceStatus,
      priceTable: op.money.priceTable,
    } : null,
    usage: op.usage ? {
      completeness: op.usage.completeness, origin: op.usage.origin, modelReturned: op.usage.modelReturned,
      categories: op.usage.categories.map((c) => ({ name: c.name, count: c.count === null ? null : c.count.toString(), inclusion: c.inclusion })),
      tIn: op.usage.tIn === null ? null : op.usage.tIn.toString(), tOut: op.usage.tOut === null ? null : op.usage.tOut.toString(),
    } : null,
    cancellation: op.cancellation,
    effects: op.effects,
    limits: { maxOutputTokens: op.limits.maxOutputTokens.toString(), maxDurationMs: op.limits.maxDurationMs.toString() },
    config: { cuWeights: op.config.cuWeights, cuFormula: op.config.cuFormula, developmentProfile: op.config.developmentProfile },
    createdAt: op.createdAt,
    updatedAt: op.updatedAt,
    revision: op.revision.toString(),
    ...extra,
  };
}

// ───────────────────────────── final state (facts → patch) ─────────────────────────────

/** What happened, independent of the state the operation is in when it is written. */
export interface FinalFacts {
  /** rejected = the provider answered 4xx without usage (nothing generated, nothing billed). */
  outcome: 'completed' | 'upstream_failed' | 'cancelled' | 'limit' | 'not_delivered' | 'rejected';
  /** Measured usage; `null` when none was read. */
  usage: NormalizedUsage | null;
  /** CU of a complete usage; `null` otherwise. */
  cu: CuResult | null;
  /** Price quote of a complete usage; `null` when not priced. */
  price: PriceQuote | null;
  delivery: DeliveryState;
  providerRequestId: string | null;
  /** Numeric result of the in-memory auxiliary counter; `null` when no counter ran. */
  localCount: LocalCountResult | null;
  /** ISO time the facts were recorded. */
  at: string;
}

const TERMINAL_EXEC = new Set(['completed', 'cancelled', 'upstream_failed', 'process_lost']);
const TERMINAL_DELIVERY = new Set(['delivered', 'client_disconnected']);

/**
 * Money after a complete measurement (ABC-03): only a complete quote ('priced', total known)
 * confirms spend; missing/partial/no quote keeps the reserved worst case held ('pending_price'),
 * with a partial subtotal recorded as information only.
 *
 * @param m - Current money settlement of the operation (not mutated).
 * @param price - Quote of the usage, or `null`.
 * @returns The new money settlement: `settled` with the confirmed total, or `pending_price`.
 */
export function moneyFromQuote(m: MoneySettlement, price: PriceQuote | null): MoneySettlement {
  if (price && price.status === 'priced' && price.total) {
    return { ...m, state: 'settled', confirmed: price.total, knownSubtotal: null, priceStatus: 'priced', priceTable: price.priceTable };
  }
  return {
    ...m, state: 'pending_price', confirmed: null,
    knownSubtotal: price && price.status === 'partial' ? price.total : null,
    priceStatus: price ? price.status : null, priceTable: price ? price.priceTable : null,
  };
}

/**
 * Completion of a pending price by a complete quote of the same stored usage; null = nothing to do.
 *
 * @param cur - The operation as stored.
 * @param price - A new quote.
 * @param usage - The usage the quote priced; must have the same raw usage digest as the stored usage.
 * @returns The settled money, or `null` when the price is not pending, the quote is incomplete, or the usage differs.
 */
export function resolvedMoney(cur: DurableOperation, price: PriceQuote | null, usage: NormalizedUsage | null): MoneySettlement | null {
  if (cur.money?.state !== 'pending_price' || !price || price.status !== 'priced' || !price.total) return null;
  if (!cur.usage || !usage || usage.rawUsageDigest !== cur.usage.rawUsageDigest) return null;
  return moneyFromQuote(cur.money, price);
}

/**
 * Build the patch for the operation's CURRENT state (it may have been moved meanwhile by a cancel
 * request or by recovery). Exactly one settlement: a complete usage with a computed CU settles;
 * anything else keeps (or turns) the exposure uncertain.
 *
 * A stop (cancel or limit) on a running operation first returns only `cancel_requested`; the caller applies
 * the facts again for the final state.
 *
 * @param cur - The operation as currently stored.
 * @param f - What happened.
 * @returns The patch to apply (may be empty when nothing changes).
 */
export function patchFromFacts(cur: DurableOperation, f: FinalFacts): OperationPatch {
  const patch: OperationPatch = {};
  const stopped = f.outcome === 'cancelled' || f.outcome === 'limit';
  if (stopped && (cur.execution === 'admitted' || cur.execution === 'upstream_started')) {
    // first step of a stop decided by OTK (explicit cancel or limit): cancel_requested, then the
    // caller writes the final state on the next pass (contract: cancel_requested → cancelled)
    return { execution: 'cancel_requested', cancellation: { requestedAt: cur.cancellation?.requestedAt ?? f.at, result: null } };
  }
  if (!TERMINAL_EXEC.has(cur.execution)) {
    if (f.outcome === 'completed') patch.execution = 'completed';
    else if (f.outcome === 'upstream_failed' || f.outcome === 'not_delivered' || f.outcome === 'rejected') patch.execution = 'upstream_failed';
    else patch.execution = 'cancelled';
  }
  if (!TERMINAL_DELIVERY.has(cur.delivery) && f.delivery !== cur.delivery) patch.delivery = f.delivery;
  if (f.providerRequestId && cur.providerRequestId === null) patch.providerRequestId = f.providerRequestId;
  if ((f.outcome === 'cancelled' || f.outcome === 'limit') && cur.cancellation?.result == null) {
    patch.cancellation = { requestedAt: cur.cancellation?.requestedAt ?? f.at, result: 'stopped_upstream' };
  } else if (f.outcome === 'completed' && cur.execution === 'cancel_requested' && cur.cancellation?.result == null) {
    patch.cancellation = { requestedAt: cur.cancellation?.requestedAt ?? f.at, result: 'already_finished' };
  }
  const settledAlready = cur.reservation.state === 'settled' || cur.measurement === 'final';
  if (settledAlready) {
    // ABC-03: the measurement is final but the price may still be pending; a complete quote of the
    // SAME stored usage (same raw usage digest) settles it — never a new inference
    const m = resolvedMoney(cur, f.price, f.usage);
    if (m) patch.money = m;
    return patch;
  }
  if (f.outcome === 'not_delivered' || f.outcome === 'rejected') {
    // certain non-consumption: connection refused before the request left, or the provider
    // refused it with a 4xx and no usage (review H3: such a hold would stay forever)
    if (cur.measurement === 'none' && cur.reservation.state === 'held') patch.reservation = { ...cur.reservation, state: 'released' };
    return patch;
  }
  if (f.usage && f.usage.completeness === 'complete') {
    patch.measurement = 'final';
    patch.usage = f.usage;
    if (f.cu && f.cu.status === 'computed' && f.cu.cu) {
      // ABC-03: CU/quota settles here; the reserved money stays as reserved (it is not spend)
      patch.reservation = { cu: f.cu.cu, money: cur.reservation.money, basis: `settled:${cur.reservation.basis}`, state: 'settled' };
      if (cur.money) patch.money = moneyFromQuote(cur.money, f.price);
    } else if (cur.reservation.state === 'held') {
      // complete usage whose CU is not computable: exposure kept and visible (cu_not_computable),
      // never a plain hold behind a terminal execution (review H2)
      patch.reservation = { ...cur.reservation, state: 'held_uncertain' };
      // a complete quote can still settle the money of a usage whose CU is not computable
      if (cur.money && f.price?.status === 'priced') patch.money = moneyFromQuote(cur.money, f.price);
    }
    return patch;
  }
  if (f.usage && f.usage.completeness === 'partial') {
    patch.measurement = 'partial';
    patch.usage = f.usage;
  } else if (cur.measurement !== 'partial') {
    patch.measurement = 'uncertain';
  }
  if (cur.reservation.state === 'held') patch.reservation = { ...cur.reservation, state: 'held_uncertain' };
  // the terminal-execution invariant needs the hold to turn uncertain in the same patch
  return patch;
}

/**
 * Outbox effects created by a settlement (written in the same transaction).
 *
 * @param ctx - Operations context (decides the v3 or legacy receipt flavor).
 * @param op - The operation as it will be after settlement.
 * @param epochId - Quota epoch of the operation.
 * @returns A `persist_receipt` effect and a `project_redis` effect (integer CU rounded up).
 * @throws {@link ScaleLossError} When the settled CU cannot be converted to micro-CU exactly.
 */
export function settlementEffects(ctx: OperationsContext, op: DurableOperation, epochId: string): EnqueueInput[] {
  const key = op.key;
  const units = toAccountingUnits(op.reservation.cu);
  // the Redis TAL is an integer-CU projection; the exact value stays in the ledger (rounded up)
  const cuInt = (units + ACCOUNTING_SCALE - 1n) / ACCOUNTING_SCALE;
  const projection = { requestId: legacyReceiptId(key), epochId, cu: cuInt.toString(), provider: op.provider, model: op.usage?.modelReturned ?? op.modelRequested, ts: Date.parse(op.updatedAt) || Date.now() };
  const persist = { key, revision: op.revision.toString(), flavor: ctx.crypto ? 'v3' : 'legacy' };
  return [
    { schema: 'otk.outbox_effect.v1', effectId: effectId('persist_receipt', key), key, kind: 'persist_receipt', payloadDigest: payloadDigest(persist), target: null, payload: persist },
    { schema: 'otk.outbox_effect.v1', effectId: effectId('project_redis', key), key, kind: 'project_redis', payloadDigest: payloadDigest(projection), target: null, payload: projection },
  ];
}

// Errors that waiting cannot fix (rule or data errors), as opposed to the database being unavailable.
function isLogic(err: unknown): boolean {
  const n = (err as Error | null)?.name;
  return err instanceof IllegalTransitionError || n === 'ScaleLossError' || n === 'CodecError' || n === 'LedgerIdentityError';
}

/** Outcome of one attempt to write final facts to PostgreSQL (RV2-05: permanent vs transient). */
type CoreWrite = 'written' | { rejected: string } | { unavailable: string };

/**
 * CAS on the current revision (re-read on conflict), settlement effects in the same transaction.
 *
 * @param ctx - Operations context.
 * @param key - Tenant and operation id.
 * @param facts - What happened.
 * @returns `'written'`, a permanent rejection, or a transient unavailability (never throws).
 */
async function writeFinalCore(ctx: OperationsContext, key: OperationKey, facts: FinalFacts): Promise<CoreWrite> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const detail = await ctx.store.getDetail(key);
      if (!detail) throw new Error(`operation ${keyString(key)} vanished`);
      const cur = detail.operation;
      const patch = patchFromFacts(cur, facts);
      if (Object.keys(patch).length === 0) return 'written';
      const settles = patch.reservation?.state === 'settled';
      let enqueue: EnqueueInput[] = [];
      if (settles) {
        const projected = { ...cur, ...patch, reservation: patch.reservation!, usage: patch.usage ?? cur.usage, revision: cur.revision + 1n, updatedAt: facts.at };
        enqueue = settlementEffects(ctx, projected, detail.epochId);
      }
      const cuMissing = patch.measurement === 'final' && patch.reservation?.state === 'held_uncertain';
      await ctx.store.transition(key, cur.revision, patch, { enqueue, localCount: facts.localCount, ...(cuMissing ? { settlementNote: 'cu_not_computable' as const } : {}) });
      if (patch.execution === 'cancel_requested') continue; // second pass writes the final state
      return 'written';
    } catch (err) {
      if (err instanceof RevisionConflictError) continue;
      if (isLogic(err)) return { rejected: `${(err as Error).name}: ${(err as Error).message}` };
      return { unavailable: String(err) };
    }
  }
  return { unavailable: 'revision_conflict_retries_exhausted' };
}

/**
 * Write the final facts. If PostgreSQL is unreachable the facts go to the spool; if PostgreSQL rejects
 * them for a permanent logical reason they go to the intervention queue (RV2-05) — in both cases the
 * consumption is kept durably, never dropped. 'lost' only when neither could be written (logged).
 *
 * @param ctx - Operations context.
 * @param key - Tenant and operation id.
 * @param facts - What happened (numbers and states only).
 * @returns Where the facts ended up.
 */
export async function writeFinal(ctx: OperationsContext, key: OperationKey, facts: FinalFacts): Promise<'written' | 'spooled' | 'rejected' | 'lost'> {
  const w = await writeFinalCore(ctx, key, facts);
  if (w === 'written') return 'written';
  const record = { v: 1 as const, id: randomUUID(), key, patch: JSON.parse(encodeJson(facts)) as unknown, localCount: null, enqueue: [], at: facts.at };
  if ('rejected' in w) {
    ctx.log('operation_final_rejected', { key: keyString(key), error: w.rejected });
    if (!ctx.spool) return 'lost';
    try {
      ctx.spool.recordIntervention(record, w.rejected, 'live');
      ctx.log('operation_final_needs_intervention', { key: keyString(key), id: record.id, file: ctx.spool.interventionFile });
      return 'rejected';
    } catch (e) {
      ctx.log('operation_final_unwritten', { key: keyString(key), error: w.rejected, intervention: String(e) });
      return 'lost';
    }
  }
  // database unreachable: spool the facts (numbers only), applied when it returns
  if (!ctx.spool) {
    ctx.log('operation_final_unwritten', { key: keyString(key), error: w.unavailable, spool: 'not_configured' });
    return 'lost';
  }
  try {
    ctx.spool.append({ id: record.id, key, patch: record.patch, localCount: null, enqueue: [] });
    ctx.log('operation_final_spooled', { key: keyString(key) });
    return 'spooled';
  } catch (spoolErr) {
    ctx.log('operation_final_unwritten', { key: keyString(key), error: w.unavailable, spool: String(spoolErr) });
    return 'lost';
  }
}

/**
 * Decode spooled facts (inverse of encodeJson(FinalFacts)).
 *
 * `outcome` and `delivery` are taken as stored, without validation.
 *
 * @param v - Parsed spool record payload.
 * @returns The facts.
 * @throws {@link CodecError} When a usage, CU, price or local-count field is malformed.
 */
export function decodeFacts(v: unknown): FinalFacts {
  const o = v as Record<string, unknown>;
  return {
    outcome: o['outcome'] as FinalFacts['outcome'],
    usage: o['usage'] == null ? null : decodeUsage(o['usage']),
    cu: o['cu'] == null ? null : decodeCuResult(o['cu']),
    price: decodePrice(o['price']),
    delivery: o['delivery'] as DeliveryState,
    providerRequestId: (o['providerRequestId'] ?? null) as string | null,
    localCount: o['localCount'] == null ? null : decodeLocalCount(o['localCount']),
    at: String(o['at']),
  };
}

/**
 * Re-apply spooled measurements once PostgreSQL is back (idempotent per operation).
 *
 * @param ctx - Operations context.
 * @returns The replay counts, or `null` when no spool is configured.
 */
export async function replaySpool(ctx: OperationsContext): Promise<SpoolReplayResult | null> {
  if (!ctx.spool) return null;
  const res = await ctx.spool.replay((rec) => applySpooled(ctx, rec));
  // ABC-01: corrupt lines are evidence of a lost acknowledged write: always visible in the log
  if (res.corrupt > 0) ctx.log('spool_corrupt_lines_quarantined', { count: res.corrupt, file: ctx.spool.quarantineFile });
  // RV2-05: intact records PostgreSQL rejected for a permanent reason wait for an operator (alert)
  if (res.intervention > 0) ctx.log('spool_records_need_intervention', { count: res.intervention, file: ctx.spool.interventionFile });
  reportInterventionFileDamage(ctx);
  return res;
}

/**
 * F-FPS5-01: damaged bytes in the intervention file are reported, never skipped silently.
 *
 * @param ctx - Operations context (spool and logger); does nothing without a spool. Never throws.
 */
function reportInterventionFileDamage(ctx: OperationsContext): void {
  if (!ctx.spool) return;
  let h: ReturnType<NonNullable<OperationsContext['spool']>['inspectInterventions']>;
  try { h = ctx.spool.inspectInterventions(); } catch (err) {
    // reporting must never stop the replay itself; an unreadable queue is an alert of its own
    ctx.log('spool_intervention_file_unreadable', { file: ctx.spool.interventionFile, error: String(err) });
    return;
  }
  if (h.corrupt.length > 0 || h.tornTail) {
    ctx.log('spool_intervention_file_damaged', {
      file: ctx.spool.interventionFile, corruptLines: h.corrupt.length, recovered: h.corrupt.filter((c) => c.recovered).length,
      offsets: h.corrupt.map((c) => c.offset), tornTail: h.tornTail,
    });
  }
}

/**
 * Apply one spooled record: transient failures retry, permanent logical rejections go to intervention.
 *
 * @param ctx - Operations context.
 * @param rec - The spooled record.
 * @returns `applied`, `already`, `retry`, or an intervention reason.
 */
async function applySpooled(ctx: OperationsContext, rec: SpoolRecord): Promise<SpoolApplyOutcome> {
  let facts: FinalFacts;
  try { facts = decodeFacts(rec.patch); } catch (err) {
    // a record that parses as JSON but not as facts cannot become valid by waiting
    return { intervention: `undecodable: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}` };
  }
  const cur = await ctx.store.get(rec.key);
  if (!cur) return 'retry';
  // S4 (ABC-03): a final measurement may still carry a pending price; writeFinal decides (it
  // resolves the price from the same stored usage when the spooled quote is complete)
  if (cur.measurement === 'final' && cur.money?.state !== 'pending_price') return 'already';
  const w = await writeFinalCore(ctx, rec.key, facts);
  if (w === 'written') return cur.measurement === 'final' ? 'already' : 'applied';
  if ('rejected' in w) return { intervention: w.rejected };
  return 'retry';
}

/**
 * RV2-05 resume procedure: after the cause of a rejection was fixed (code, data or configuration),
 * re-apply the open intervention entries. Applied/already → a 'resolved' line is appended; still
 * rejected or database unavailable → the entry stays open. Never deletes; the operation's revision and
 * ledger identity keep a repeated apply from counting twice. `ids` limits it to chosen entries.
 *
 * @param ctx - Operations context.
 * @param ids - Optional intervention entry ids to re-apply; all open entries when omitted.
 * @returns Counts of entries resolved, still open, and open because their integrity check failed.
 */
export async function reapplyInterventions(ctx: OperationsContext, ids?: readonly string[]): Promise<{ resolved: number; open: number; corrupt: number }> {
  if (!ctx.spool) return { resolved: 0, open: 0, corrupt: 0 };
  let resolved = 0; let open = 0; let corrupt = 0;
  reportInterventionFileDamage(ctx);
  for (const e of ctx.spool.openInterventions()) {
    if (ids && !ids.includes(e.id)) continue;
    if (!e.intact) { corrupt++; open++; ctx.log('spool_intervention_integrity_mismatch', { id: e.id }); continue; }
    let out: SpoolApplyOutcome;
    try { out = await applySpooled(ctx, e.record); } catch { out = 'retry'; }
    if (out === 'applied' || out === 'already') {
      ctx.spool.markResolved(e.id, out);
      ctx.log('spool_intervention_resolved', { id: e.id, key: keyString(e.record.key), outcome: out });
      resolved++;
    } else {
      open++;
      ctx.log('spool_intervention_still_open', { id: e.id, reason: typeof out === 'object' ? out.intervention : 'database_unavailable' });
    }
  }
  return { resolved, open, corrupt };
}

// ───────────────────────────── the request handler ─────────────────────────────

/** Inputs of {@link handleDurableMitm}, prepared by the gateway. */
export interface DurableMitmArgs {
  req: IncomingMessage;
  res: ServerResponse;
  /** Tenant decided by the gateway from the caller's credential (never from the body). */
  tenantId: string;
  /** Provider id (lower case). */
  provider: string;
  /** Provider path, used for API detection and the request digest. */
  upstreamPath: string;
  /** Full upstream URL (query string included). */
  upstreamUrl: string;
  method: string;
  /** Incoming request headers; only an allowlist is forwarded upstream. */
  headers: Record<string, string>;
  /** Raw request body text (JSON). */
  bodyStr: string;
  /**
   * Resolves the operator's provider key for this call; an empty or rejected value means nothing is sent.
   *
   * @returns The provider key (secret; never logged).
   */
  resolveApiKey(): Promise<string>;
  /**
   * Opens the upstream request (network call to the provider).
   *
   * @returns The upstream response with a readable body.
   */
  openUpstream(url: string, method: string, headers: Record<string, string>, body: string, apiKey: string, provider: string, headerTimeoutMs?: number, signal?: AbortSignal): Promise<UpstreamResponse>;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const data = JSON.stringify(body);
  res.statusCode = status;
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(data));
  res.end(data);
}

/**
 * Wait for the client to drain; false when it stalled past `stallMs` (treated as gone).
 *
 * @param res - The client response.
 * @param stallMs - Longest wait, ms.
 * @returns `true` when drained or closed, `false` on stall.
 */
function waitForDrainOrClose(res: ServerResponse, stallMs: number): Promise<boolean> {
  if (res.destroyed || !res.writableNeedDrain) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => { cleanup(); resolve(false); }, stallMs);
    const done = (): void => { cleanup(); resolve(true); };
    const cleanup = (): void => { clearTimeout(timer); res.off('drain', done); res.off('close', done); };
    res.once('drain', done);
    res.once('close', done);
  });
}

// Connection-level errors that prove the request never reached the provider (safe to release the hold).
function isCertainNonDelivery(err: unknown): boolean {
  const code = (err as { cause?: { code?: string } } | null)?.cause?.code ?? (err as { code?: string } | null)?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN';
}

/** Request headers a tenant may send to the provider (others never leave the gateway). */
const FORWARDED_REQUEST_HEADERS = new Set(['content-type', 'accept', 'user-agent', 'anthropic-version']);
/** Operator-side response headers never relayed to tenants (org ids, rate-limit state, cookies). */
const HIDDEN_RESPONSE_HEADERS = /^(set-cookie|openai-organization|openai-project|anthropic-organization-id|x-ratelimit-.*|anthropic-ratelimit-.*|content-length|content-encoding|transfer-encoding)$/i;

/** Fields whose content is fetched by the provider from a reference: not boundable from the body. */
const BY_REFERENCE_KEYS = new Set(['image_url', 'input_image', 'file_id', 'file_url', 'fileData', 'file_data', 'cachedContent', 'cached_content', 'previous_response_id', 'prompt_cache_key']);
// First by-reference key found in the body, or null. Depth-capped; deeper content is not scanned.
function findByReference(v: unknown, depth = 0): string | null {
  if (depth > 32 || v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) { for (const x of v) { const r = findByReference(x, depth + 1); if (r) return r; } return null; }
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (BY_REFERENCE_KEYS.has(k)) return k;
    const r = findByReference(x, depth + 1);
    if (r) return r;
  }
  return null;
}

/**
 * A cache_control TTL other than the default 5 minutes, anywhere in the body (incl. the top-level automatic
 * cache_control). Fail-closed: a body nested beyond the scan depth counts as found (RV2-07).
 *
 * @param v - Parsed body or a nested value.
 * @param depth - Current recursion depth.
 * @returns A short description of the unsupported TTL, or `null`.
 */
function hasUnpricedCacheTtl(v: unknown, depth = 0): string | null {
  if (depth > 32) return 'body nested beyond the scanned depth';
  if (v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) { for (const x of v) { const r = hasUnpricedCacheTtl(x, depth + 1); if (r) return r; } return null; }
  const o = v as Record<string, unknown>;
  const cc = o['cache_control'];
  if (cc && typeof cc === 'object') {
    const ttl = (cc as Record<string, unknown>)['ttl'];
    if (ttl !== undefined && ttl !== '5m') return `cache_control.ttl ${JSON.stringify(ttl)}`;
  }
  for (const x of Object.values(o)) { const r = hasUnpricedCacheTtl(x, depth + 1); if (r) return r; }
  return null;
}

/**
 * Usage object found in the tail of a body too large to parse (non-stream overflow).
 *
 * Scans backwards for the API's usage field and parses the first balanced JSON object after it.
 *
 * @param api - Provider API (selects the usage field name).
 * @param tail - Last characters of the response body.
 * @returns `{ <field>: <usage object> }`, or `null` when no parsable usage is found.
 */
export function usageFromTail(api: UsageApi, tail: string): Record<string, unknown> | null {
  const field = api === 'gemini.generate_content' ? '"usageMetadata"' : api === 'cohere.chat' ? '"meta"' : '"usage"';
  let at = tail.lastIndexOf(field);
  while (at >= 0) {
    const start = tail.indexOf('{', at + field.length);
    if (start < 0) return null;
    let depth = 0; let inStr = false; let esc = false;
    for (let i = start; i < tail.length; i++) {
      const ch = tail[i];
      if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true;
      else if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try { return { [field.slice(1, -1)]: JSON.parse(tail.slice(start, i + 1)) as unknown }; } catch { break; }
        }
      }
    }
    at = tail.lastIndexOf(field, at - 1);
  }
  return null;
}

/**
 * Handles one metered provider request end to end and always answers the client.
 *
 * Validates the request, freezes limits, admits the operation durably (quota, money budget, idempotency),
 * calls the provider under an execution lease, relays the response, and writes the final facts (settled,
 * uncertain, spooled or sent to intervention). Refusals before the provider answer 4xx/5xx JSON with an
 * error code and send nothing upstream. Long by design: the order of these steps is the durability
 * guarantee and is documented step by step in the comments below.
 *
 * @param ctx - Operations context.
 * @param a - Request, response, tenant and upstream helpers.
 * @returns Resolves once the response was ended and the final facts were written (or spooled).
 * @throws {Error} Unexpected errors during admission (other than a queue timeout) propagate to the gateway.
 */
export async function handleDurableMitm(ctx: OperationsContext, a: DurableMitmArgs): Promise<void> {
  const { res, tenantId, provider } = a;
  if (a.method !== 'POST') return json(res, 405, { ok: false, error: 'durable_profile_meters_post_only' });
  const api = detectApi(provider, a.upstreamPath);
  if (!api) return json(res, 404, { ok: false, error: 'api_not_supported', detail: `${provider} ${a.upstreamPath} is outside the metered scope` });

  let body: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(a.bodyStr);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    body = parsed as Record<string, unknown>;
  } catch {
    return json(res, 400, { ok: false, error: 'invalid_json' });
  }
  // identity of the request as the client sent it (digest v2): measured before any OTK injection below
  const clientBodyBytes = Buffer.byteLength(JSON.stringify(body));
  // FECHAMENTO_GEMINI_AD: Gemini streams by path only (a body `stream` field is not part of its API); the
  // accumulator reads SSE, so the stream must be asked as alt=sse (added when absent) and JSON as alt=json/absent
  let upstreamUrl = a.upstreamUrl;
  if (api === 'gemini.generate_content') {
    if (body['stream'] !== undefined) return json(res, 400, { ok: false, error: 'field_not_supported', detail: 'Gemini streams by path (:streamGenerateContent), not by a body field' });
    const u = new URL(a.upstreamUrl);
    // review H1: a response mask (?fields=, ?$fields=) could hide usage counts that the normalizer would read as omitted
    // zeros, and $alt/callback change the response format: only `alt` is accepted on a metered Gemini route
    const extra = [...new Set([...u.searchParams.keys()].filter((k) => k !== 'alt'))];
    if (extra.length > 0) return json(res, 400, { ok: false, error: 'query_parameter_not_supported', detail: `${extra.join(', ')}: only alt is accepted on a metered Gemini route` });
    const alt = u.searchParams.getAll('alt');
    const streaming = /:streamGenerateContent$/.test(a.upstreamPath);
    if (alt.length > 1 || (alt.length === 1 && alt[0] !== (streaming ? 'sse' : 'json'))) {
      return json(res, 400, { ok: false, error: 'stream_format_not_supported', detail: `alt=${alt.join(',')}: OTK meters ${streaming ? 'alt=sse' : 'alt=json'} only` });
    }
    if (streaming && alt.length === 0) { u.searchParams.set('alt', 'sse'); upstreamUrl = String(u); }
  }
  const stream = api === 'gemini.generate_content' ? a.upstreamPath.endsWith(':streamGenerateContent') : body['stream'] === true;
  // review HIGH-1/H3: an API the active measurement cannot read is refused, never relayed unmetered
  if (!ctx.measurement.supportsApi(api, stream)) return json(res, 404, { ok: false, error: 'api_not_measurable', detail: `${api}${stream ? ' (stream)' : ''} is not measured by ${ctx.measurement.label}` });
  let model: string;
  if (api === 'gemini.generate_content') {
    // review HIGH-2: Gemini binds the model to the URL; a different body.model is refused
    model = a.upstreamPath.match(/models\/([^/:]+)/)?.[1] ?? '';
    if (body['model'] !== undefined && body['model'] !== model && body['model'] !== `models/${model}`) return json(res, 400, { ok: false, error: 'model_mismatch' });
  } else {
    model = typeof body['model'] === 'string' ? body['model'].trim() : '';
  }
  if (!model) return json(res, 400, { ok: false, error: 'model_required' });
  // review MEDIUM-3: several completions per call multiply the output beyond the reservation
  // review M2: each spelling on its own (`candidateCount: 1, candidate_count: 4` must not pass)
  const gcs = [body['generationConfig'], body['generation_config']].filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  for (const [name, v] of [['n', body['n']], ...gcs.flatMap((g) => [['candidateCount', g['candidateCount']], ['candidate_count', g['candidate_count']]])] as Array<[string, unknown]>) {
    if (v !== undefined && v !== null && v !== 1) return json(res, 400, { ok: false, error: 'multiple_completions_not_supported', detail: `${name}=${String(v)}` });
  }
  // S4 DEC-17, corrected in RV2-07: the API DOES report 1-hour writes separately
  // (usage.cache_creation.ephemeral_1h_input_tokens), but OTK's normalization folds every cache write into
  // one category and the frozen tables carry only the 5-minute tariff (1.25×), so a 1-hour write (2×) would
  // be under-priced. OTK limitation, not the API's: refused before the upstream.
  const ttl = api === 'anthropic.messages' ? hasUnpricedCacheTtl(body) : null;
  if (ttl) return json(res, 400, { ok: false, error: 'cache_ttl_not_supported', detail: `${ttl}: OTK prices cache writes only at the 5-minute tariff (it does not normalize the 1-hour breakdown); use the default TTL` });
  const ref = findByReference(body);
  if (ref && !ctx.measurement.inputBoundable(api, body)) return json(res, 400, { ok: false, error: 'input_by_reference_not_supported', detail: ref });
  if (provider === 'openai' && api === 'openai.chat_completions' && stream) {
    // PROXY-06: usage only arrives in the final chunk when requested
    const so = (body['stream_options'] && typeof body['stream_options'] === 'object' ? body['stream_options'] : {}) as Record<string, unknown>;
    so['include_usage'] = true;
    body['stream_options'] = so;
  }
  const limit = applyOutputLimit(api, body, ctx.policy);
  if (!limit.ok) return json(res, 400, { ok: false, error: limit.error, detail: limit.detail });
  // FECHAMENTO_GEMINI_AD (DL-07): OpenAI processes an omitted service_tier as "auto" (the PROJECT's setting,
  // possibly not Standard); the OTK prices Standard, so it asks for "default" explicitly. The admission check
  // below sees the client's body (this field is the OTK's, not the client's).
  const injectedTier = api === 'openai.chat_completions' && body['service_tier'] === undefined;
  if (injectedTier) body['service_tier'] = 'default';
  // tier the frozen table prices; Gemini's omitted serviceTier is Standard by its documentation
  const expectedTier: string | null = api === 'openai.chat_completions' ? 'default' : api === 'gemini.generate_content' ? 'standard' : null;
  const tierDerivableWhenUnreported = api === 'gemini.generate_content' && body['serviceTier'] === undefined && body['service_tier'] === undefined;

  const opHeader = a.req.headers['x-otk-operation-id'];
  const operationId = typeof opHeader === 'string' && opHeader.trim() ? opHeader.trim() : randomUUID();
  if (!OP_ID_RE.test(operationId)) return json(res, 400, { ok: false, error: 'invalid_operation_id' });
  const key: OperationKey = { tenantId, operationId };
  const opHeaders = { 'x-otk-operation-id': operationId };
  // OVERNIGHT 20261005 (Phase 7): optional project/task attribution named by the client (format here, registration
  // for this tenant inside the admission transaction). These headers are OTK's own and never forwarded upstream.
  const attr = attributionFromHeaders(a.req.headers);
  if (!attr.ok) return json(res, 400, { ok: false, error: 'attribution_invalid', detail: attr.detail }, opHeaders);

  const cfg: CuConfig | null = ctx.measurement.activeCuConfig();
  if (!cfg) return json(res, 503, { ok: false, error: 'cu_config_unavailable' }, opHeaders);
  const outBody = JSON.stringify(body);
  const bodyBytes = Buffer.byteLength(outBody);
  // the price table frozen into the operation also prices its money reservation
  const frozen = ctx.measurement.frozenConfig(cfg);
  const tableRef = frozen.priceTable;
  // ABC-04: a tenant under a money budget is admitted only with a defensible upper bound of cost.
  // RV2-01 (AUD-6): this early read only chooses the first plan; the scope that counts is the one the
  // admission transaction locks (money_policy_required → re-planned in strict mode, retried once).
  type Plan = { reservation: Omit<Reservation, 'state'>; strict: { allowedReturnedModels: string[]; policyId: string; pricingTerms?: PricingTerms } | null };
  // the body as the client sent it EXCEPT stream_options.include_usage (OTK injection for OpenAI streams, constant on every
  // call): only the injected service_tier is removed here; the digest v2 uses clientBodyBytes, measured before any injection
  const clientBody = injectedTier ? Object.fromEntries(Object.entries(body).filter(([k]) => k !== 'service_tier')) : body;
  const plan = (strictMode: boolean): Plan | { refuse: [number, Record<string, unknown>] } => {
    let strict: Plan['strict'] = null;
    let strictModels: string[] = [model];
    let strictInput: bigint | null = null;
    if (strictMode) {
      const forwarded = Object.keys(a.headers).filter((k) => FORWARDED_REQUEST_HEADERS.has(k.toLowerCase()) || ctx.policy.extraForwardHeaders.includes(k.toLowerCase()));
      const d = assessMoneyBound(ctx.moneyBoundPolicy, { provider, api, model, body: clientBody, maxOutputTokens: limit.maxOutputTokens, headers: forwarded });
      if (!d.ok) return { refuse: [402, { ok: false, error: 'money_bound_unavailable', detail: d.reason }] };
      if (!tableRef) return { refuse: [402, { ok: false, error: 'money_bound_unavailable', detail: 'no frozen price table' }] };
      strict = { allowedReturnedModels: d.rule.returnedModels, policyId: d.policyId, ...(d.pricingTerms ? { pricingTerms: d.pricingTerms } : {}) };
      strictModels = [...new Set([model, ...d.rule.returnedModels])];
      strictInput = d.inputBoundTokens;
    }
    let reservation: Plan['reservation'] | undefined;
    try {
      // the input estimate is about the client's content: the OTK's own service_tier field is not billable input
      const estimatedInputTokens = injectedTier
        ? ctx.measurement.estimateInputTokens(api, clientBody, Buffer.byteLength(JSON.stringify(clientBody)))
        : ctx.measurement.estimateInputTokens(api, body, bodyBytes);
      // the reservation is the worst case over every model the provider may report (strict mode).
      // RV2-04: in strict mode the MONEY side uses the documented input bound (context window); the CU
      // side (flexible quota, D7 §8) keeps the measurement's estimate.
      for (const m of strictModels) {
        const req = { provider, api, modelRequested: m, estimatedInputTokens, maxOutputTokens: limit.maxOutputTokens };
        let r = ctx.measurement.estimateReservation(req, cfg, tableRef);
        if (strictInput !== null) {
          const bound = ctx.measurement.estimateReservation({ ...req, estimatedInputTokens: strictInput }, cfg, tableRef);
          r = { cu: r.cu, money: bound.money, basis: `cu:${r.basis}; money(input ≤ ${strictInput} documented window):${bound.basis}` };
        }
        if (strict && r.money === null) return { refuse: [402, { ok: false, error: 'money_bound_unavailable', detail: `no price for ${m}` }] };
        if (!reservation) reservation = r;
        else reservation = {
          cu: r.cu.units > reservation.cu.units ? r.cu : reservation.cu,
          money: r.money && (!reservation.money || r.money.units > reservation.money.units) ? r.money : reservation.money,
          basis: `${reservation.basis} | ${r.basis}`,
        };
      }
      if (strict && reservation) reservation = { ...reservation, basis: `${strict.policyId} worst case over [${strictModels.join(',')}]; ${reservation.basis}` };
    } catch (err) {
      return { refuse: [400, { ok: false, error: 'model_not_supported', detail: err instanceof Error ? err.message : String(err) }] };
    }
    if (!reservation) return { refuse: [400, { ok: false, error: 'model_not_supported' }] };
    return { reservation, strict };
  };
  // F-P1-04: database work of the admission runs through the per-process gate (waiters hold no connection)
  const gated = <T>(f: () => Promise<T>): Promise<T> => (ctx.admission ? ctx.admission.run(f) : f());
  const busy = () => {
    ctx.log('operation_admission_busy', { key: keyString(key), queued: ctx.admission?.queued ?? 0, limit: ctx.admission?.limit ?? null });
    return json(res, 503, { ok: false, error: 'admission_busy', detail: 'admission queue wait exceeded; nothing was reserved or sent' }, opHeaders);
  };
  // H1 R-01 (adversarial review): the CU quota of the admission (quotaFor → plan) must come from the plan store, not
  // from a cache another replica (or an ambiguous write) left stale; a store failure refuses before any reservation
  try {
    await getTenantPlanVersioned(tenantId);
  } catch (err) {
    ctx.log('operation_admission_unavailable', { key: keyString(key), stage: 'plan_read', error: String(err).slice(0, 200) });
    return json(res, 503, { ok: false, error: 'plan_store_unavailable' }, opHeaders);
  }
  let p: ReturnType<typeof plan>;
  try {
    p = plan(await gated(() => ctx.store.hasMoneyBudget(tenantId)));
  } catch (err) {
    if (err instanceof AdmissionQueueTimeout) return busy();
    ctx.log('operation_admission_unavailable', { key: keyString(key), stage: 'money_scope_read', error: String(err).slice(0, 200) });
    return json(res, 503, { ok: false, error: 'persistence_unavailable' }, opHeaders);
  }
  if ('refuse' in p) return json(res, p.refuse[0], p.refuse[1], opHeaders);
  // OVERNIGHT 20261005 (identity across versions): v2 identifies the client's request; the v1 values are the
  // digests earlier releases stored for this same request (forwarded body with and without the service_tier the
  // OTK injects since 58609db), recognized only on rows recorded as v1.
  const digest = requestDigestV2({ provider, api, path: a.upstreamPath, modelRequested: model, clientMaxOutputTokens: limit.injected ? null : limit.maxOutputTokens, stream, clientBodyBytes });
  const v1 = (bytes: number) => requestDigest({ provider, api, path: a.upstreamPath, modelRequested: model, maxOutputTokens: limit.maxOutputTokens, stream, bodyBytes: bytes });
  const equivalentDigests = [...new Set([v1(bodyBytes), v1(Buffer.byteLength(JSON.stringify(clientBody)))])];
  const admitWith = (q: Plan) => gated(() => ctx.store.admit({
    key, requestDigest: digest, requestDigestVersion: REQUEST_DIGEST_V2, equivalentDigests, attribution: attr.attribution, provider, api, modelRequested: model,
    reservation: { ...q.reservation, state: 'held' },
    limits: {
      maxOutputTokens: limit.maxOutputTokens, maxDurationMs: ctx.policy.maxDurationMs, maxCost: q.reservation.money,
      ...(q.strict ? { allowedReturnedModels: q.strict.allowedReturnedModels, moneyBoundPolicy: q.strict.policyId } : {}),
      ...(q.strict?.pricingTerms ? { pricingTerms: q.strict.pricingTerms } : {}),
    },
    config: frozen,
    // F-P1-04: the execution lease is written with the admission (no window in which recovery sees it unowned)
    lease: { owner: ctx.instanceId, ms: ctx.policy.leaseMs },
  }));
  let admitted: Awaited<ReturnType<typeof admitWith>>;
  try { admitted = await admitWith(p); } catch (err) { if (err instanceof AdmissionQueueTimeout) return busy(); throw err; }
  if (admitted.outcome === 'money_policy_required') {
    const need = admitted.required;
    const mismatch = { ok: false, error: 'money_bound_unavailable', detail: `the tenant's money budget requires bound policy ${need.join(', ')}; this instance applies ${ctx.moneyBoundPolicy.id}` };
    // only a single required policy equal to ours can be met by re-reserving in strict mode
    if (p.strict || need.length !== 1 || need[0] !== ctx.moneyBoundPolicy.id) return json(res, 402, mismatch, opHeaders);
    p = plan(true);
    if ('refuse' in p) return json(res, p.refuse[0], p.refuse[1], opHeaders);
    try { admitted = await admitWith(p); } catch (err) { if (err instanceof AdmissionQueueTimeout) return busy(); throw err; }
    if (admitted.outcome === 'money_policy_required') return json(res, 402, mismatch, opHeaders);
  }
  // H1-S22: every refusal before the provider is counted by reason (no tenant id in the labels)
  if (admitted.outcome !== 'admitted') admissionRefusalsTotal.inc({ reason: admitted.outcome });
  switch (admitted.outcome) {
    case 'persistence_unavailable':
      ctx.log('operation_admission_unavailable', { key: keyString(key), stage: 'admission_tx', error: admitted.detail ?? 'unknown' });
      return json(res, 503, { ok: false, error: 'persistence_unavailable' }, opHeaders);
    case 'quota_exceeded': return json(res, 429, { ok: false, error: 'quota_exceeded', quotaCU: (admitted.quota.units / ACCOUNTING_SCALE).toString(), currentCU: (admitted.current.units / ACCOUNTING_SCALE).toString() }, opHeaders);
    case 'money_budget_required': return json(res, 402, { ok: false, error: 'money_budget_required', detail: 'no USD ceiling applies to this tenant; the operator must assign a money budget before its provider key can be used' }, opHeaders);
    case 'budget_exceeded': return json(res, 402, { ok: false, error: 'budget_exceeded', remaining: { units: admitted.remaining.units.toString(), scale: admitted.remaining.scale.toString(), currency: 'USD' } }, opHeaders);
    case 'conflict': return json(res, 409, { ok: false, error: 'operation_conflict', detail: 'same operation id with a different request' }, opHeaders);
    case 'erased': return json(res, 410, { ok: false, error: 'operation_erased', detail: 'this operation id was erased by the retention policy; it is not admitted again' }, opHeaders);
    case 'attribution_rejected': return json(res, 400, { ok: false, error: 'attribution_rejected', detail: admitted.reason }, opHeaders);
    case 'existing': return json(res, 409, { ok: false, error: 'operation_exists', operation: operationView(admitted.operation) }, opHeaders);
    case 'admitted': break;
  }
  let op = admitted.operation;

  // execution lease before the provider is called; the transition is durable before upstream.
  // FPS5-F01 (found by the closing verification): the auxiliary counter's first use in a process is
  // synchronous (tokenizer load, ~0.9 s measured idle, more under load) and blocks the event loop, so no
  // timer can renew the lease during it; the lease used to expire and another instance declared the live
  // operation process_lost. Now: lease, counter, lease RENEWED right before the durable start. If another
  // instance took the operation meanwhile, the renewal or the revision check refuses to start it (the
  // provider is not called).
  try {
    await ctx.store.claimLease(key, ctx.instanceId, ctx.policy.leaseMs);
  } catch (err) {
    ctx.log('operation_start_unwritten', { key: keyString(key), error: String(err) });
    return json(res, 503, { ok: false, error: 'persistence_unavailable' }, opHeaders);
  }

  // auxiliary counter (B): in memory only
  let counter: LocalCounter | null = null;
  let counterFailed = false;
  if (ctx.measurement.createLocalCounter && ctx.measurement.resolveModelSupport) {
    try {
      counter = ctx.measurement.createLocalCounter(ctx.measurement.resolveModelSupport(provider, api, model), { maxTextBytes: ctx.policy.maxCounterTextBytes });
      counter.observeInput({ api, body });
    } catch { counter = null; counterFailed = true; }
  }
  const observe = (fn: () => void) => { try { fn(); } catch { counterFailed = true; } };

  try {
    if (!(await ctx.store.claimLease(key, ctx.instanceId, ctx.policy.leaseMs))) throw new Error('execution lease taken by another instance before start');
    op = await ctx.store.transition(key, op.revision, { execution: 'upstream_started' });
  } catch (err) {
    if (err instanceof RevisionConflictError) {
      // cancelled between admission and start: nothing was sent, nothing is consumed
      const cur = await ctx.store.get(key).catch(() => null);
      if (cur?.execution === 'cancelled') return json(res, 409, { ok: false, error: 'operation_cancelled' }, opHeaders);
      if (cur?.execution === 'cancel_requested') {
        await ctx.store.transition(key, cur.revision, {
          execution: 'cancelled', reservation: { ...cur.reservation, state: 'released' },
          cancellation: { requestedAt: cur.cancellation?.requestedAt ?? new Date().toISOString(), result: 'stopped_upstream' },
        }).catch((e2) => ctx.log('operation_cancel_release_failed', { key: keyString(key), error: String(e2) }));
        return json(res, 409, { ok: false, error: 'operation_cancelled' }, opHeaders);
      }
    }
    // the provider was not called: recovery releases this admitted operation
    ctx.log('operation_start_unwritten', { key: keyString(key), error: String(err) });
    return json(res, 503, { ok: false, error: 'persistence_unavailable' }, opHeaders);
  }

  const upstreamAbort = new AbortController();
  let stopReason: 'cancel' | 'limit' | null = null;
  const abort = (reason: 'cancel' | 'limit') => { if (!stopReason) { stopReason = reason; upstreamAbort.abort(new Error(`otk_${reason}`)); } };
  ctx.inflight.set(keyString(key), { abort });
  const durationTimer = setTimeout(() => abort('limit'), Number(ctx.policy.maxDurationMs));
  durationTimer.unref?.();
  const poll = setInterval(() => {
    void (async () => {
      try {
        await ctx.store.claimLease(key, ctx.instanceId, ctx.policy.leaseMs);
        const now = await ctx.store.get(key);
        if (now?.execution === 'cancel_requested') abort('cancel');
      } catch { /* database unreachable: keep streaming; the final write spools if needed */ }
    })();
  }, ctx.policy.cancelPollMs);
  poll.unref?.();

  const usageCtx = { provider, modelRequested: model, origin: (stream ? 'provider_stream' : 'provider_response') as NormalizedUsage['origin'], observedAt: new Date().toISOString() };
  let clientGone = false;
  res.on('close', () => { if (!res.writableFinished) clientGone = true; });
  res.on('error', () => { clientGone = true; });
  // A client that goes away sends FIN; Node keeps the half-open socket writable until a write
  // fails, so a response could look "delivered" to nobody. The socket events tell it at once.
  const sock = a.req.socket;
  const onSocketGone = () => { if (!res.writableFinished) clientGone = true; };
  sock.on('end', onSocketGone);
  sock.on('close', onSocketGone);

  let finished = false;
  const finish = async (facts: Omit<FinalFacts, 'at' | 'delivery' | 'localCount'> & { delivery?: DeliveryState }) => {
    if (finished) return;
    finished = true;
    clearTimeout(durationTimer);
    clearInterval(poll);
    sock.off('end', onSocketGone);
    sock.off('close', onSocketGone);
    ctx.inflight.delete(keyString(key));
    let localCount: LocalCountResult | null = null;
    if (counter) { try { localCount = counter.finish(); } catch { counterFailed = true; } }
    if (counterFailed) localCount = { counts: [], covered: [], uncovered: [], status: 'failed', counterVersion: localCount?.counterVersion ?? 'unknown', cost: { cpuMicros: null, peakBufferedBytes: 0 } };
    const delivery: DeliveryState = facts.delivery ?? (clientGone ? 'client_disconnected' : 'delivered');
    const out = await writeFinal(ctx, key, { ...facts, delivery, localCount, at: new Date().toISOString() });
    await ctx.store.releaseLease(key, ctx.instanceId).catch(() => {});
    if (out !== 'written') ctx.log('operation_final', { key: keyString(key), result: out });
  };

  // review M1/LOW: from here on, any exception still ends the operation (no lease renewed forever)
  try {
    let upstream: UpstreamResponse;
    let apiKey: string;
    try {
      apiKey = await a.resolveApiKey();
      if (!apiKey) throw new Error('empty provider key');
    } catch (err) {
      // DL-05: no provider key → nothing left the gateway: certain non-delivery, never an uncertain exposure
      ctx.log('operation_provider_key_unavailable', { key: keyString(key), provider, error: err instanceof Error ? err.message : String(err) });
      await finish({ outcome: 'not_delivered', usage: null, cu: null, price: null, providerRequestId: null, delivery: 'pending' });
      if (!res.headersSent) json(res, 502, { ok: false, error: 'upstream_key_unavailable' }, opHeaders);
      return;
    }
    try {
      const headers = Object.fromEntries(Object.entries(a.headers).filter(([k]) => FORWARDED_REQUEST_HEADERS.has(k.toLowerCase()) || ctx.policy.extraForwardHeaders.includes(k.toLowerCase())));
      upstream = await a.openUpstream(upstreamUrl, a.method, headers, outBody, apiKey, provider, 30_000, upstreamAbort.signal);
    } catch (err) {
      const certain = isCertainNonDelivery(err);
      await finish({ outcome: stopReason === 'cancel' ? 'cancelled' : certain ? 'not_delivered' : 'upstream_failed', usage: null, cu: null, price: null, providerRequestId: null, delivery: 'pending' });
      if (!res.headersSent) json(res, 502, { ok: false, error: certain ? 'upstream_unreachable' : 'upstream_uncertain' }, opHeaders);
      return;
    }

    for (const [k, v] of Object.entries(upstream.headers)) {
      if (HIDDEN_RESPONSE_HEADERS.test(k)) continue;
      res.setHeader(k, v);
    }
    res.setHeader('x-otk-operation-id', operationId);
    res.statusCode = upstream.status;
    res.flushHeaders();

    const hooks = ctx.measurement.streamTextHooks && counter
      ? ctx.measurement.streamTextHooks({ onTextDelta: (t) => observe(() => counter!.observeOutputText(t)), onNonTextOutput: () => { /* coverage is reported by B's counter */ } })
      : null;
    const acc: StreamUsageAccumulator | null = upstream.isStream
      ? (hooks ? hooks.create : ctx.measurement.createStreamUsageAccumulator)(api, usageCtx, { maxBufferedBytes: ctx.policy.maxStreamBufferBytes })
      : null;
    const chunks: Buffer[] = [];
    let bufferedBytes = 0;
    let overflow = false;
    let tail = '';
    const TAIL_BYTES = 256 * 1024;
    let upstreamFailed = false;
    const reader = upstream.body?.getReader();
    try {
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        if (acc) acc.push(buf);
        else {
          if (!overflow) {
            bufferedBytes += buf.length;
            if (bufferedBytes > ctx.policy.maxResponseBytes) { overflow = true; tail = Buffer.concat(chunks).toString('utf8').slice(-TAIL_BYTES); chunks.length = 0; } else chunks.push(buf);
          }
          if (overflow) tail = (tail + buf.toString('utf8')).slice(-TAIL_BYTES);
        }
        // D7 §2: a closed app does not stop the upstream; bytes are simply not delivered
        if (!clientGone && !res.destroyed) {
          // review HIGH-1: a client that stops reading is treated as gone (the upstream keeps
          // being read to its final usage) instead of stalling the provider into the limit
          if (!res.write(buf) && !(await waitForDrainOrClose(res, ctx.policy.clientStallMs))) { clientGone = true; res.destroy(); }
        }
      }
    } catch {
      upstreamFailed = true;
    }
    if (!res.writableEnded && !res.destroyed) res.end();

    let usage: NormalizedUsage | null = null;
    if (acc) usage = acc.finish();
    else {
      let parsed: unknown = null;
      if (!overflow) { try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; } }
      else parsed = usageFromTail(api, tail);
      if (parsed !== null) {
        usage = ctx.measurement.normalizeUsage(api, parsed, usageCtx);
        if (counter && ctx.measurement.extractOutputText && !overflow) {
          observe(() => { const out = ctx.measurement.extractOutputText!(api, parsed); out.texts.forEach((t) => counter!.observeOutputText(t)); });
        }
      }
    }
    const rejected = upstream.status >= 400 && upstream.status < 500 && !(usage && usage.completeness !== 'missing');
    const outcome: FinalFacts['outcome'] = stopReason === 'cancel' ? 'cancelled' : stopReason === 'limit' ? 'limit'
      // review H3: a provider 4xx without usage rejected the request before generating: nothing consumed
      : rejected ? 'rejected'
      : upstreamFailed || upstream.status < 200 || upstream.status >= 300 ? 'upstream_failed' : 'completed';
    let cu: CuResult | null = null;
    let price: PriceQuote | null = null;
    if (usage && usage.completeness === 'complete') {
      cu = ctx.measurement.computeCu(usage, cfg);
      if (ctx.measurement.priceUsage && op.config.priceTable) {
        try { price = ctx.measurement.priceUsage(usage, usage.observedAt, op.config.priceTable); } catch { price = null; }
      }
      // DL-07: the frozen table prices one service tier; a usage served (or not shown to be served) on another
      // is not settled at that tariff: the price stays pending with the reserved worst case held
      const tier = op.limits.pricingTerms?.serviceTier ?? expectedTier;
      if (price && tier !== null && !serviceTierMatches(tier, usage.serviceTier) && !(tierDerivableWhenUnreported && (usage.serviceTier ?? null) === null)) {
        ctx.log('operation_service_tier_unconfirmed', { key: keyString(key), expected: tier, reported: usage.serviceTier ?? null });
        price = null;
      }
    }
    await finish({ outcome, usage, cu, price, providerRequestId: usage?.providerRequestId ?? null });
  } catch (err) {
    ctx.log('operation_handler_error', { key: keyString(key), error: err instanceof Error ? err.message : String(err) });
    await finish({ outcome: 'upstream_failed', usage: null, cu: null, price: null, providerRequestId: null }).catch(() => {});
    if (!res.headersSent) json(res, 502, { ok: false, error: 'operation_failed' }, opHeaders);
    else if (!res.writableEnded) res.end();
  }
}
