/** Helpers shared by the parsers: integer parsing that never turns absence into zero, and consistency checks. */
import type { CanonicalUsage, Count, PricingTermsObserved } from './types.js';

export const UNKNOWN = 'UNKNOWN' as const;
export const NA = 'NOT_APPLICABLE' as const;
export const MAX_FIELD = 1_000_000_000n;

/** Reads a non-negative integer at `path`; absent/invalid => UNKNOWN (never 0). */
export function intAt(obj: unknown, path: string): Count {
  let cur: unknown = obj;
  for (const k of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return UNKNOWN;
    cur = (cur as Record<string, unknown>)[k];
  }
  return toCount(cur);
}

export function toCount(v: unknown): Count {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= Number(MAX_FIELD)) return BigInt(v);
  if (typeof v === 'string' && /^[0-9]+$/.test(v)) { const b = BigInt(v); return b <= MAX_FIELD ? b : UNKNOWN; }
  if (typeof v === 'bigint' && v >= 0n && v <= MAX_FIELD) return v;
  return UNKNOWN;
}

export function sub(a: Count, b: Count): Count {
  if (typeof a !== 'bigint' || typeof b !== 'bigint') return a === NA || b === NA ? NA : UNKNOWN;
  return a >= b ? a - b : UNKNOWN; // a subset larger than its container is an inconsistency, not a negative count
}

export function add(...xs: Count[]): Count {
  let s = 0n;
  for (const x of xs) { if (x === NA) continue; if (typeof x !== 'bigint') return UNKNOWN; s += x; }
  return s;
}

/** Numbers only (contract §4 rawUsageSanitized): walks the usage object and keeps numeric leaves. */
export function sanitizeNumbers(obj: unknown, prefix = '', out: Record<string, number | null> = {}): Record<string, number | null> {
  if (obj === null || obj === undefined) return out;
  if (typeof obj === 'number') { out[prefix] = obj; return out; }
  if (typeof obj !== 'object') return out;
  if (Array.isArray(obj)) { obj.forEach((v, i) => sanitizeNumbers(v, `${prefix}[${i}]`, out)); return out; }
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === 'string' && /^(TEXT|IMAGE|AUDIO|VIDEO|DOCUMENT|MODALITY_UNSPECIFIED)$/.test(v)) { out[`${prefix ? prefix + '.' : ''}${k}`] = null; continue; } // modality enum kept as key marker only
    sanitizeNumbers(v, `${prefix ? prefix + '.' : ''}${k}`, out);
  }
  return out;
}

export function emptyUsage(notes: string[] = []): CanonicalUsage {
  return {
    inputUncached: UNKNOWN, cacheRead: UNKNOWN, cacheWrite5m: UNKNOWN, cacheWrite1h: UNKNOWN, cacheWrite: UNKNOWN,
    outputVisible: UNKNOWN, reasoning: UNKNOWN, imageUnits: UNKNOWN, audioUnits: UNKNOWN, toolTokens: UNKNOWN,
    providerTotals: { inputTotal: UNKNOWN, outputTotal: UNKNOWN },
    usageCompleteness: 'MISSING', usageSource: 'none', rawUsageSanitized: {}, notes,
  };
}

/** COMPLETE when every category that the API can report is known (or NOT_APPLICABLE), PARTIAL otherwise. */
export function completeness(u: CanonicalUsage): CanonicalUsage['usageCompleteness'] {
  if (u.usageSource === 'none') return 'MISSING';
  const fields: Count[] = [u.inputUncached, u.cacheRead, u.cacheWrite5m, u.cacheWrite1h, u.cacheWrite, u.outputVisible, u.reasoning, u.imageUnits, u.audioUnits, u.toolTokens];
  return fields.every((f) => f !== UNKNOWN) ? 'COMPLETE' : 'PARTIAL';
}

/** Contract §4: cache classified by the usage, never by a flag. */
export function cacheObserved(u: CanonicalUsage): 'HIT' | 'CREATION' | 'NO_HIT' | 'UNKNOWN' {
  // E3G5 (C160 OPENAI-R-FIX, DR-221): the total write also counts when 5m/1h are NOT_APPLICABLE (gpt-6-luna cache_write_tokens), as in
  // record/usage.ts cacheObservedOf. Before, it was ignored (NO_HIT) and validateUsage refused the usage (CREATION/UNKNOWN by use).
  const totalOnly = (u.cacheWrite5m === UNKNOWN && u.cacheWrite1h === UNKNOWN) || (u.cacheWrite5m === NA && u.cacheWrite1h === NA);
  const w = add(u.cacheWrite5m, u.cacheWrite1h, u.cacheWrite === NA ? NA : (totalOnly ? u.cacheWrite : NA));
  if (typeof u.cacheRead !== 'bigint') return 'UNKNOWN';
  if (u.cacheRead > 0n) return 'HIT';
  if (typeof w !== 'bigint') return 'UNKNOWN';
  return w > 0n ? 'CREATION' : 'NO_HIT';
}

export function terms(serviceTier: string | null, inferenceGeo: string | null, speed: string | null, standardTiers: readonly string[], opts: { geoStandard?: (g: string | null) => boolean; speedStandard?: (s: string | null) => boolean } = {}): PricingTermsObserved {
  const reasons: string[] = [];
  if (!(serviceTier === null ? standardTiers.includes('') : standardTiers.includes(serviceTier))) reasons.push(`service_tier=${serviceTier ?? 'absent'}`);
  const geoOk = opts.geoStandard ? opts.geoStandard(inferenceGeo) : true;
  if (!geoOk) reasons.push(`inference_geo=${inferenceGeo}`);
  const speedOk = opts.speedStandard ? opts.speedStandard(speed) : true;
  if (!speedOk) reasons.push(`speed=${speed}`);
  return { serviceTier, inferenceGeo, speed, standard: reasons.length === 0, nonStandardReasons: reasons };
}
