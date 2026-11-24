/**
 * D1–D8 / C — JSON persistence codec for the shared contract types.
 *
 * Wire rule (src/types/d1d8/common.ts): bigint travels as a base-10 string, absent stays null and
 * optional fields that are absent are omitted (never written as undefined). Decoders revive only
 * the bigint paths they know and copy every other field verbatim, so additive fields of a newer
 * contract version (e.g. NormalizedUsage.issues, ConferenceReport.support in 1.1.0) survive a
 * round trip without a fixed field list (D3 §6, D3-G02).
 *
 * @module operations/codec
 */
import type {
  CommitmentOpening, ConferenceReport, CuResult, DurableOperation, FrozenConfigRef, Money, MoneySettlement,
  NormalizedUsage, OperationLimits, PriceQuote, PricingTerms, PrivateReceiptV3, Reservation, Scaled,
} from '../types/d1d8/index.js';
import type { LocalCountResult } from '../types/d1d8/index.js';
import { assertStateValues } from './transitions.js';

export class CodecError extends Error {
  constructor(message: string) { super(message); this.name = 'CodecError'; }
}

/** Deep copy with bigint → decimal string; undefined properties are dropped. */
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

export const encodeJson = (value: unknown): string => JSON.stringify(toJsonValue(value));

const INT_RE = /^-?(0|[1-9][0-9]*)$/;

/** Strict decimal → bigint ('' and '1e3' are refused; BigInt('') would silently be 0n). */
export function big(v: unknown, path: string): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string' && INT_RE.test(v)) return BigInt(v);
  if (typeof v === 'number' && Number.isSafeInteger(v)) return BigInt(v);
  throw new CodecError(`${path}: expected decimal integer, got ${JSON.stringify(v)}`);
}
export function bigOrNull(v: unknown, path: string): bigint | null {
  return v === null || v === undefined ? null : big(v, path);
}

function obj(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new CodecError(`${path}: expected object`);
  return v as Record<string, unknown>;
}

export function decodeScaled(v: unknown, path = 'scaled'): Scaled {
  const o = obj(v, path);
  return { units: big(o['units'], `${path}.units`), scale: big(o['scale'], `${path}.scale`) };
}
export function decodeMoney(v: unknown, path = 'money'): Money {
  const o = obj(v, path);
  if (o['currency'] !== 'USD') throw new CodecError(`${path}.currency: expected USD`);
  return { ...decodeScaled(o, path), currency: 'USD' };
}
const moneyOrNull = (v: unknown, path: string): Money | null => (v === null || v === undefined ? null : decodeMoney(v, path));

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

export function decodeReservation(v: unknown): Reservation {
  const o = obj(v, 'reservation');
  return { ...o, cu: decodeScaled(o['cu'], 'reservation.cu'), money: moneyOrNull(o['money'], 'reservation.money') } as Reservation;
}

export function decodeConfig(v: unknown): FrozenConfigRef {
  const o = obj(v, 'config');
  const chain = o['chain'] == null ? null : { ...obj(o['chain'], 'config.chain'), chainId: big(obj(o['chain'], 'config.chain')['chainId'], 'config.chain.chainId') };
  return { ...o, chain } as FrozenConfigRef;
}

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

export function decodeOpening(v: unknown): CommitmentOpening {
  const o = obj(v, 'opening');
  return { ...o, usage: decodeScaled(o['usage'], 'opening.usage') } as CommitmentOpening;
}

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

/** Monetary axis (contract 1.2, ABC-03). */
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

/** NULL/absent = a row from before migration 153, digested with v1; unknown values are refused. */
function decodeDigestVersion(v: string | null | undefined): NonNullable<DurableOperation['requestDigestVersion']> {
  if (v == null) return 'otk.request_digest.v1';
  if (v === 'otk.request_digest.v1' || v === 'otk.request_digest.v2') return v;
  throw new Error(`unknown request_digest_version ${v}`);
}

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
