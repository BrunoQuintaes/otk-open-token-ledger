/** R12 usage validation: the adapter normalizes; the core refuses anything that is not Count-typed and re-derives cacheObserved by use. */
/**
 * Validates the normalized usage an adapter returns, before the runner records it (called by `core/runner.ts`).
 *
 * Every count must be a safe non-negative integer, `'UNKNOWN'` or `'NOT_APPLICABLE'`; the cache outcome is recomputed
 * from the counts and must match the adapter's. It does not detect a 0 written for an absent field; the adapter
 * contract forbids that.
 *
 * @module scripts/h2eval/record/usage
 */
import { H2EVAL_SCHEMA, type CacheObserved, type Count, type NormalizedUsageH2 } from '../types.js';

const isCount = (v: unknown): v is Count => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || v === 'UNKNOWN' || v === 'NOT_APPLICABLE';
const COUNT_FIELDS = ['inputUncached', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite', 'outputVisible', 'reasoning', 'imageUnits', 'audioUnits', 'toolTokens', 'U'] as const;

/**
 * Derives the cache outcome from the cache counts alone ("by use").
 *
 * @param u - Cache counts and usage completeness.
 * @returns `HIT` (read > 0), `CREATION` (write > 0, no read), `NO_HIT` (both 0) or `UNKNOWN` (usage missing, read
 *   unknown, or a write unknown while read is 0).
 */
export function cacheObservedOf(u: Pick<NormalizedUsageH2, 'cacheRead' | 'cacheWrite' | 'cacheWrite5m' | 'cacheWrite1h' | 'usageCompleteness'>): CacheObserved {
  // by USE only (contract §4): the cache counts decide; an unknown output count does not make the cache arm unknown
  if (u.usageCompleteness === 'MISSING') return 'UNKNOWN';
  const read = u.cacheRead; if (typeof read !== 'number') return 'UNKNOWN';
  const writes = [u.cacheWrite, u.cacheWrite5m, u.cacheWrite1h].filter((w) => w !== 'NOT_APPLICABLE');
  if (writes.some((w) => w === 'UNKNOWN')) return read > 0 ? 'HIT' : 'UNKNOWN';
  const write = writes.reduce<number>((a, w) => a + (w as number), 0);
  if (read > 0) return 'HIT';
  if (write > 0) return 'CREATION';
  return 'NO_HIT';
}

/** Raised when normalized usage breaks the contract; `field` names the first bad field. */
export class UsageInvalid extends Error { constructor(public readonly field: string) { super(`usage invalid: ${field}`); this.name = 'UsageInvalid'; } }

/**
 * Returns a frozen, validated copy; throws UsageInvalid on type violations (a 0 for an absent field cannot be detected here: the adapter contract forbids it).
 *
 * @param u - Normalized usage from an adapter (not mutated).
 * @returns A frozen copy (with a frozen `rawUsageSanitized`).
 * @throws {UsageInvalid} When the schema, a count, `usageCompleteness`, `usageSource`, `rawUsageSanitized`,
 *   `modelServed` (at most 128 characters, no whitespace) or `cacheObserved` is invalid.
 */
export function validateUsage(u: NormalizedUsageH2): NormalizedUsageH2 {
  if (!u || u.schema !== H2EVAL_SCHEMA.usage) throw new UsageInvalid('schema');
  for (const f of COUNT_FIELDS) if (!isCount(u[f])) throw new UsageInvalid(f);
  if (!['COMPLETE', 'PARTIAL', 'MISSING'].includes(u.usageCompleteness)) throw new UsageInvalid('usageCompleteness');
  if (u.usageSource !== 'provider_response') throw new UsageInvalid('usageSource');
  if (!u.rawUsageSanitized || typeof u.rawUsageSanitized !== 'object' || Object.values(u.rawUsageSanitized).some((v) => typeof v !== 'number' || !Number.isFinite(v))) throw new UsageInvalid('rawUsageSanitized');
  if (typeof u.modelServed !== 'string' || u.modelServed.length > 128 || /\s/.test(u.modelServed)) throw new UsageInvalid('modelServed');
  const cacheObserved = cacheObservedOf(u);
  if (u.cacheObserved !== cacheObserved) throw new UsageInvalid(`cacheObserved (adapter ${u.cacheObserved}, by use ${cacheObserved})`);
  return Object.freeze({ ...u, rawUsageSanitized: Object.freeze({ ...u.rawUsageSanitized }) });
}
