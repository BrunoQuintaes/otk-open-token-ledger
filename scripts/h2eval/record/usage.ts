/** R12 usage validation: the adapter normalizes; the core refuses anything that is not Count-typed and re-derives cacheObserved by use. */
import { H2EVAL_SCHEMA, type CacheObserved, type Count, type NormalizedUsageH2 } from '../types.js';

const isCount = (v: unknown): v is Count => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || v === 'UNKNOWN' || v === 'NOT_APPLICABLE';
const COUNT_FIELDS = ['inputUncached', 'cacheRead', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite', 'outputVisible', 'reasoning', 'imageUnits', 'audioUnits', 'toolTokens', 'U'] as const;

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

export class UsageInvalid extends Error { constructor(public readonly field: string) { super(`usage invalid: ${field}`); this.name = 'UsageInvalid'; } }

/** Returns a frozen, validated copy; throws UsageInvalid on type violations (a 0 for an absent field cannot be detected here: the adapter contract forbids it). */
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
