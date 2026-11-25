/**
 * D1–D8 / C — JSON persistence codec for the shared contract types.
 *
 * Wire rule (src/types/d1d8/common.ts): bigint travels as a base-10 string, absent stays null and
 * optional fields that are absent are omitted (never written as undefined). Decoders revive only
 * the bigint paths they know and copy every other field verbatim, so additive fields of a newer
 * contract version (e.g. NormalizedUsage.issues, ConferenceReport.support in 1.1.0) survive a
 * round trip without a fixed field list (D3 §6, D3-G02).
 *
 * Every decoder takes the value as node-postgres returns it (JSONB already parsed) and throws
 * {@link CodecError} with the JSON path of the first bad field; decoders never mutate their input.
 * Used by the PostgreSQL stores and routes of `src/operations/`.
 *
 * @module src/operations/codec
 */
import type {
  CommitmentOpening, ConferenceReport, CuResult, DurableOperation, FrozenConfigRef, Money, MoneySettlement,
  NormalizedUsage, OperationLimits, PriceQuote, PricingTerms, PrivateReceiptV3, Reservation, Scaled,
} from '../types/d1d8/index.js';
import type { LocalCountResult } from '../types/d1d8/index.js';
import { assertStateValues } from './transitions.js';

/** A stored value does not match the contract shape; the message starts with the JSON path. */
export class CodecError extends Error {
  /**
   * Builds the error.
   *
   * @param message - Path and reason, e.g. `reservation.cu.units: expected decimal integer`.
   */
  constructor(message: string) { super(message); this.name = 'CodecError'; }
}

/**
 * Deep copy with bigint → decimal string; undefined properties are dropped.
 *
 * Class instances (for example `Date`) are copied as plain objects of their own enumerable properties.
 *
 * @param value - Any JSON-like value; not mutated.
 * @returns A value safe for `JSON.stringify`.
 */
export function toJsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString(10);
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = toJsonValue(v);
  }
  return out;
}

/**
 * Serializes a contract value to JSON text using the wire rule (bigint as decimal string).
 *
 * @param value - The value to encode.
 * @returns JSON text, e.g. for a `$n::jsonb` query parameter.
 */
export const encodeJson = (value: unknown): string => JSON.stringify(toJsonValue(value));

const INT_RE = /^-?(0|[1-9][0-9]*)$/;

/**
 * Strict decimal → bigint ('' and '1e3' are refused; BigInt('') would silently be 0n).
 *
 * @param v - A bigint, a base-10 integer string, or a safe-integer number.
 * @param path - JSON path used in the error message.
 * @returns The integer as bigint.
 * @throws {@link CodecError} When `v` is anything else (including `null`).
 */
export function big(v: unknown, path: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && INT_RE.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new CodecError(`${path}: expected decimal integer, got ${JSON.stringify(v)}`);
}
/**
 * Like {@link big}, but `null`/`undefined` stay `null` ("absent", never zero).
 *
 * @param v - The value to decode.
 * @param path - JSON path used in the error message.
 * @returns The integer, or `null`.
 * @throws {@link CodecError} When a present value is not a decimal integer.
 */
export function bigOrNull(v: unknown, path: string): bigint | null {
  return v === null || v === undefined ? null : big(v, path);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new CodecError(`${path}: expected object`);
  return v as Record<string, unknown>;
}

/**
 * Decodes a scaled amount `{ units, scale }`.
 *
 * @param v - Stored value.
 * @param path - JSON path for errors.
 * @returns The amount with bigint fields.
 * @throws {@link CodecError} When the value is not an object or a field is not an integer.
 */
export function decodeScaled(v: unknown, path = 'scaled'): Scaled {
  const o = obj(v, path);
  return { units: big(o['units'], `${path}.units`), scale: big(o['scale'], `${path}.scale`) };
}
/**
 * Decodes a USD money amount `{ units, scale, currency: 'USD' }`.
 *
 * @param v - Stored value.
 * @param path - JSON path for errors.
 * @returns The amount; other fields of the stored object are dropped.
 * @throws {@link CodecError} When the currency is not USD or the amount is malformed.
 */
export function decodeMoney(v: unknown, path = 'money'): Money {
  const o = obj(v, path);
  if (o['currency'] !== 'USD') throw new CodecError(`${path}.currency: expected USD`);
  return { ...decodeScaled(o, path), currency: 'USD' };
}
const moneyOrNull = (v: unknown, path: string): Money | null => (v === null || v === undefined ? null : decodeMoney(v, path));

/**
 * Decodes the limits frozen at admission; optional fields are omitted when absent.
 *
 * @param v - Stored `limits` value.
 * @returns The limits.
 * @throws {@link CodecError} When a field has the wrong type.
 */
export function decodeLimits(v: unknown): OperationLimits {
  const o = obj(v, 'limits');
  return {
    maxOutputTokens: big(o['maxOutputTokens'], 'limits.maxOutputTokens'),
    maxDurationMs: big(o['maxDurationMs'], 'limits.maxDurationMs'),
    maxCost: moneyOrNull(o['maxCost'], 'limits.maxCost'),
    // contract 1.2 (ABC-04): omitted when absent, never undefined
    ...(Array.isArray(o['allowedReturnedModels']) ? { allowedReturnedModels: (o['allowedReturnedModels'] as unknown[]).map(String) } : {}),
    ...(typeof o['moneyBoundPolicy'] === 'string' ? { moneyBoundPolicy: o['moneyBoundPolicy'] } : {}),
    // contract 1.3 (FECHAMENTO_GEMINI_AD): omitted when absent
    ...(decodePricingTerms(o['pricingTerms'])),
  };
}

function decodePricingTerms(v: unknown): { pricingTerms?: PricingTerms } {
  if (v === undefined || v === null) return {};
  const o = obj(v, 'limits.pricingTerms');
  const t: PricingTerms = {};
  if (o['serviceTier'] !== undefined) {
    if (typeof o['serviceTier'] !== 'string') throw new CodecError('limits.pricingTerms.serviceTier: expected string');
    t.serviceTier = o['serviceTier'];
  }
  if (o['thinking'] !== undefined) {
    if (o['thinking'] !== 'off') throw new CodecError('limits.pricingTerms.thinking: expected "off"');
    t.thinking = 'off';
  }
  return { pricingTerms: t };
}

/**
 * Decodes a reservation (CU and optional money); other fields are copied verbatim.
 *
 * @param v - Stored value.
 * @returns The reservation.
 * @throws {@link CodecError} When the value or an amount is malformed.
 */
export function decodeReservation(v: unknown): Reservation {
  const o = obj(v, 'reservation');
  return { ...o, cu: decodeScaled(o['cu'], 'reservation.cu'), money: moneyOrNull(o['money'], 'reservation.money') } as Reservation;
}

/**
 * Decodes the frozen configuration reference (only `chain.chainId` is revived as bigint).
 *
 * @param v - Stored value.
 * @returns The configuration reference; `chain` is `null` when absent.
 * @throws {@link CodecError} When the value is malformed.
 */
export function decodeConfig(v: unknown): FrozenConfigRef {
  const o = obj(v, 'config');
  const chain = o['chain'] == null ? null : { ...obj(o['chain'], 'config.chain'), chainId: big(obj(o['chain'], 'config.chain')['chainId'], 'config.chain.chainId') };
  return { ...o, chain } as FrozenConfigRef;
}

/**
 * Decodes a normalized usage; category counts and totals may be `null` (not reported).
 *
 * @param v - Stored value.
 * @returns The usage.
 * @throws {@link CodecError} When the value or a count is malformed.
 */
export function decodeUsage(v: unknown): NormalizedUsage {
  const o = obj(v, 'usage');
  const cats = Array.isArray(o['categories']) ? o['categories'] : [];
  return {
    ...o,
    categories: cats.map((c, i) => {
      const co = obj(c, `usage.categories[${i}]`);
      return { ...co, count: bigOrNull(co['count'], `usage.categories[${i}].count`) };
    }),
    tIn: bigOrNull(o['tIn'], 'usage.tIn'),
    tOut: bigOrNull(o['tOut'], 'usage.tOut'),
  } as NormalizedUsage;
}

/**
 * Decodes a CU computation result; `cu` is `null` when CU was not computable.
 *
 * @param v - Stored value.
 * @returns The result.
 * @throws {@link CodecError} When the value or a number is malformed.
 */
export function decodeCuResult(v: unknown): CuResult {
  const o = obj(v, 'cu');
  return {
    ...o,
    cu: o['cu'] == null ? null : decodeScaled(o['cu'], 'cu.cu'),
    tIn: bigOrNull(o['tIn'], 'cu.tIn'),
    tOut: bigOrNull(o['tOut'], 'cu.tOut'),
    wModelMilli: bigOrNull(o['wModelMilli'], 'cu.wModelMilli'),
    wProviderMilli: bigOrNull(o['wProviderMilli'], 'cu.wProviderMilli'),
  } as CuResult;
}

/**
 * Decodes a price quote.
 *
 * @param v - Stored value.
 * @returns The quote, or `null` when none was stored.
 * @throws {@link CodecError} When the value or an amount is malformed.
 */
export function decodePrice(v: unknown): PriceQuote | null {
  if (v == null) return null;
  const o = obj(v, 'price');
  const lines = Array.isArray(o['lines']) ? o['lines'] : [];
  return {
    ...o,
    total: moneyOrNull(o['total'], 'price.total'),
    lines: lines.map((l, i) => {
      const lo = obj(l, `price.lines[${i}]`);
      return {
        ...lo,
        count: big(lo['count'], `price.lines[${i}].count`),
        // contract 1.1.0 allows null here (R-B3)
        unitPricePerMTok: moneyOrNull(lo['unitPricePerMTok'], `price.lines[${i}].unitPricePerMTok`),
        amount: moneyOrNull(lo['amount'], `price.lines[${i}].amount`),
      };
    }),
  } as PriceQuote;
}

/**
 * Decodes a private v3 receipt payload (usage, CU, price, config and timing are revived).
 *
 * @param v - Stored value.
 * @returns The receipt.
 * @throws {@link CodecError} When any nested part is malformed.
 */
export function decodeReceiptV3(v: unknown): PrivateReceiptV3 {
  const o = obj(v, 'receipt');
  const timing = obj(o['timing'], 'receipt.timing');
  return {
    ...o,
    usage: decodeUsage(o['usage']),
    cu: decodeCuResult(o['cu']),
    price: decodePrice(o['price']),
    config: decodeConfig(o['config']),
    timing: { ...timing, latencyMs: bigOrNull(timing['latencyMs'], 'receipt.timing.latencyMs') },
  } as PrivateReceiptV3;
}

function decodeAdjusted(v: unknown, path: string): { expected: bigint; absoluteDelta: bigint; relativeDelta: string | null } {
  const o = obj(v, path);
  const rel = o['relativeDelta'];
  if (rel !== null && typeof rel !== 'string') throw new CodecError(`${path}.relativeDelta must be a string or null`);
  return { ...o, expected: big(o['expected'], `${path}.expected`), absoluteDelta: big(o['absoluteDelta'], `${path}.absoluteDelta`), relativeDelta: rel };
}

/**
 * Decodes a conference report (provider-reported vs local token counts).
 *
 * @param v - Stored value.
 * @returns The report.
 * @throws {@link CodecError} When the value, a comparison or the threshold is malformed.
 */
export function decodeConference(v: unknown): ConferenceReport {
  const o = obj(v, 'conference');
  const th = obj(o['threshold'], 'conference.threshold');
  const comps = Array.isArray(o['comparisons']) ? o['comparisons'] : [];
  return {
    ...o,
    comparisons: comps.map((c, i) => {
      const co = obj(c, `conference.comparisons[${i}]`);
      return {
        ...co,
        provider: bigOrNull(co['provider'], `conference.comparisons[${i}].provider`),
        local: bigOrNull(co['local'], `conference.comparisons[${i}].local`),
        absoluteDelta: bigOrNull(co['absoluteDelta'], `conference.comparisons[${i}].absoluteDelta`),
        // v1.2 (Phase 8): adjusted expectation of a calibrated profile, only when present
        ...(co['adjusted'] !== undefined ? { adjusted: decodeAdjusted(co['adjusted'], `conference.comparisons[${i}].adjusted`) } : {}),
      };
    }),
    threshold: { ...th, absoluteTokens: big(th['absoluteTokens'], 'conference.threshold.absoluteTokens') },
  } as ConferenceReport;
}

/**
 * Decodes a commitment opening (private; never log the result).
 *
 * @param v - Stored value.
 * @returns The opening.
 * @throws {@link CodecError} When the value or its usage amount is malformed.
 */
export function decodeOpening(v: unknown): CommitmentOpening {
  const o = obj(v, 'opening');
  return { ...o, usage: decodeScaled(o['usage'], 'opening.usage') } as CommitmentOpening;
}

/**
 * Decodes the auxiliary local token count (numbers only, no text).
 *
 * @param v - Stored value.
 * @returns The count result.
 * @throws {@link CodecError} When the value, a count or the cost block is malformed.
 */
export function decodeLocalCount(v: unknown): LocalCountResult {
  const o = obj(v, 'localCount');
  const counts = Array.isArray(o['counts']) ? o['counts'] : [];
  const cost = obj(o['cost'], 'localCount.cost');
  return {
    ...o,
    counts: counts.map((c, i) => {
      const co = obj(c, `localCount.counts[${i}]`);
      return { ...co, count: big(co['count'], `localCount.counts[${i}].count`) };
    }),
    cost: { ...cost, cpuMicros: bigOrNull(cost['cpuMicros'], 'localCount.cost.cpuMicros') },
  } as LocalCountResult;
}

/** Row of otk_operations (node-postgres returns JSONB parsed, NUMERIC/BIGINT as strings). */
export interface OperationRow {
  tenant_id: string;
  operation_id: string;
  schema: string;
  request_digest: string;
  /** NULL on rows admitted before migration 153 (they used otk.request_digest.v1). */
  request_digest_version?: string | null;
  provider: string;
  api: string;
  model_requested: string;
  config: unknown;
  limits: unknown;
  reservation: unknown;
  provider_request_id: string | null;
  execution: string;
  measurement: string;
  delivery: string;
  usage: unknown;
  cancellation: unknown;
  effects: unknown;
  created_at: Date | string;
  updated_at: Date | string;
  revision: string | number;
  /** S4 migration 150 (ABC-03); absent/null when the operation holds no money. */
  money?: unknown;
}

const MONEY_STATES = new Set(['held', 'pending_price', 'settled', 'held_uncertain', 'released']);

/**
 * Monetary axis (contract 1.2, ABC-03).
 *
 * @param v - Stored `money` value.
 * @returns The money settlement; `origin` is omitted when absent.
 * @throws {@link CodecError} When the state is unknown or an amount is malformed.
 */
export function decodeMoneySettlement(v: unknown): MoneySettlement {
  const o = obj(v, 'money');
  if (typeof o['state'] !== 'string' || !MONEY_STATES.has(o['state'])) throw new CodecError(`money.state: unknown ${JSON.stringify(o['state'])}`);
  const out: MoneySettlement = {
    ...o,
    state: o['state'] as MoneySettlement['state'],
    reserved: decodeMoney(o['reserved'], 'money.reserved'),
    confirmed: moneyOrNull(o['confirmed'], 'money.confirmed'),
    knownSubtotal: moneyOrNull(o['knownSubtotal'], 'money.knownSubtotal'),
    priceStatus: (o['priceStatus'] ?? null) as MoneySettlement['priceStatus'],
    priceTable: (o['priceTable'] ?? null) as MoneySettlement['priceTable'],
  };
  if (o['origin'] == null) delete (out as { origin?: unknown }).origin;
  return out;
}

const iso = (t: Date | string): string => (t instanceof Date ? t.toISOString() : new Date(t).toISOString());

/**
 * NULL/absent = a row from before migration 153, digested with v1; unknown values are refused.
 *
 * @param v - The `request_digest_version` column.
 * @returns The digest version id.
 * @throws {Error} When the value is neither v1 nor v2.
 */
function decodeDigestVersion(v: string | null | undefined): NonNullable<DurableOperation['requestDigestVersion']> {
  if (v == null) return 'otk.request_digest.v1';
  if (v === 'otk.request_digest.v1' || v === 'otk.request_digest.v2') return v;
  throw new Error(`unknown request_digest_version ${v}`);
}

/**
 * Decodes one `otk_operations` row into the contract's operation record.
 *
 * @param r - The row as returned by node-postgres.
 * @returns The operation; `money` is omitted when the row holds none.
 * @throws {@link CodecError} When a JSON column is malformed.
 * @throws {Error} When the digest version or a state value is unknown.
 */
export function decodeOperationRow(r: OperationRow): DurableOperation {
  const effects = obj(r.effects, 'effects');
  const reservation = decodeReservation(r.reservation);
  assertStateValues({ execution: r.execution, measurement: r.measurement, delivery: r.delivery, reservation });
  return {
    schema: 'otk.operation.v1',
    key: { tenantId: r.tenant_id, operationId: r.operation_id },
    requestDigest: r.request_digest as DurableOperation['requestDigest'],
    requestDigestVersion: decodeDigestVersion(r.request_digest_version),
    provider: r.provider,
    api: r.api as DurableOperation['api'],
    modelRequested: r.model_requested,
    config: decodeConfig(r.config),
    limits: decodeLimits(r.limits),
    reservation,
    providerRequestId: r.provider_request_id,
    execution: r.execution as DurableOperation['execution'],
    measurement: r.measurement as DurableOperation['measurement'],
    delivery: r.delivery as DurableOperation['delivery'],
    usage: r.usage == null ? null : decodeUsage(r.usage),
    cancellation: (r.cancellation ?? null) as DurableOperation['cancellation'],
    effects: {
      receiptDigest: (effects['receiptDigest'] ?? null) as DurableOperation['effects']['receiptDigest'],
      conferenceDigest: (effects['conferenceDigest'] ?? null) as DurableOperation['effects']['conferenceDigest'],
      debitApplied: effects['debitApplied'] === true,
      proofJobId: (effects['proofJobId'] ?? null) as string | null,
    },
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
    revision: big(r.revision, 'revision'),
    // omitted (never undefined) when the operation holds no money
    ...(r.money == null ? {} : { money: decodeMoneySettlement(r.money) }),
  };
}
