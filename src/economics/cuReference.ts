/**
 * CU reference framework (OVERNIGHT 2): profile validation and digest, decomposition of the observed usage into
 * disjoint canonical categories, and the exact CU under a frozen base-period reference structure.
 *
 *   CU_o^(b) = scale × Σ_c q_(o,m,c) × p_(m,c)^(b) / p_ref^(b)
 *
 * CU = normalized quantity of AI-service consumption (the author's definition). The weights p/p_ref are relative
 * prices of the FROZEN reference structure of the base period, never current prices: this module does not
 * read any current price table, so a price change after the base period cannot change a CU computed here.
 * Not computable is never 0: an unknown model, a category without a profile price or an undefined reference
 * returns a status and cu = null.
 *
 * Pure: no I/O, no clock, no environment variables. Imported by the campaign analysis script
 * (`scripts/pilot/campaign/analyzeCampaign.ts`); no runtime path in `src/` imports it at the evaluated version.
 * The profile types live in `src/types/d1d8/cuReference.ts`.
 *
 * @module src/economics/cuReference
 */
import type { Hex32, NormalizedUsage, Scaled } from '../types/d1d8/index.js';
import type {
  CuCanonicalCategory, CuReferenceDefinition, CuReferencePriceEntry, CuReferenceProfileV1, CuReferenceResult,
} from '../types/d1d8/cuReference.js';
import { domainDigest } from '../receipt/v3/canonicalEncoding.js';

/** Domain separator of the profile digest. */
export const CU_REFERENCE_PROFILE_DOMAIN = 'OTK_CU_REFERENCE_PROFILE_V1' as const;
/** Formula version a profile must declare and results carry. */
export const CU_REF_FORMULA = 'CU_REF_SUM_v1' as const;
/** Label of the historical multiplicative profile (computeCu.ts). Kept for reading old receipts only. */
export const CU_LEGACY_PROFILE_LABEL = 'development_legacy' as const;
/** The disjoint usage categories a CU is summed over, in a fixed order. */
export const CU_CANONICAL_CATEGORIES: readonly CuCanonicalCategory[] = Object.freeze([
  'input_uncached', 'input_cache_read', 'input_cache_write', 'output_visible', 'output_reasoning',
]);
/** Decimal rendering: 10^-9 CU, round half up. The exact fraction is always kept next to it. */
export const CU_DECIMAL_SCALE = 1_000_000_000n;

const DEC = /^[0-9]+$/;
const POS = /^[1-9][0-9]*$/;
const SCALE = /^[1-9][0-9]*(\/[1-9][0-9]*)?$/;

/**
 * Exact scale as a fraction: "1" → 1/1, "1/1000" → 1/1000.
 *
 * @param scale - Positive integer `"n"` or positive fraction `"n/d"`, no leading zeros.
 * @returns Numerator and denominator.
 * @throws {@link CuProfileError} When the text is not in that form.
 */
export function parseScale(scale: string): { n: bigint; d: bigint } {
  if (typeof scale !== 'string' || !SCALE.test(scale)) throw new CuProfileError('scale must be a positive integer or a positive fraction "n/d"');
  const [n, d = '1'] = scale.split('/');
  return { n: BigInt(n!), d: BigInt(d) };
}
const HEX64 = /^[0-9a-f]{64}$/;

/** A reference profile failed validation; the message starts with `cu reference profile:`. */
export class CuProfileError extends Error {
  constructor(message: string) { super(`cu reference profile: ${message}`); this.name = 'CuProfileError'; }
}

function validateReference(r: CuReferenceDefinition, where: string): void {
  if (r.kind === 'model_category') {
    if (!r.provider || !r.model || !CU_CANONICAL_CATEGORIES.includes(r.category)) throw new CuProfileError(`${where}: model_category needs provider, model and a canonical category`);
  } else if (r.kind === 'abstract_price') {
    if (typeof r.priceMicroUsdPerMTok !== 'string' || !POS.test(r.priceMicroUsdPerMTok)) throw new CuProfileError(`${where}: abstract_price needs a positive integer string`);
  } else {
    throw new CuProfileError(`${where}: unknown reference kind`);
  }
}

/**
 * Structural validation. Throws CuProfileError; returns the profile unchanged when valid.
 *
 * Checks schema, formula, ids, base period and snapshot date, scale, the reference, every entry's price and
 * archived source, aliases, and (when present or required by FINAL) that `derivedWeights` equal p / p_ref.
 *
 * @param p - Profile to check (not mutated).
 * @returns The same object.
 * @throws {@link CuProfileError} At the first rule the profile breaks.
 */
export function validateCuReferenceProfile(p: CuReferenceProfileV1): CuReferenceProfileV1 {
  if (!p || p.schema !== 'otk.cu.reference.v1') throw new CuProfileError('schema must be otk.cu.reference.v1');
  if (p.formulaVersion !== CU_REF_FORMULA) throw new CuProfileError(`formulaVersion must be ${CU_REF_FORMULA}`);
  if (typeof p.profileId !== 'string' || !/^[A-Za-z0-9._:-]{3,128}$/.test(p.profileId)) throw new CuProfileError('profileId');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(p.basePeriod)) throw new CuProfileError('basePeriod must be YYYY-MM');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(p.snapshotDate) || !p.snapshotDate.startsWith(p.basePeriod)) throw new CuProfileError('snapshotDate must be YYYY-MM-DD inside the base period');
  if (p.status !== 'CANDIDATE' && p.status !== 'FINAL') throw new CuProfileError('status must be CANDIDATE or FINAL');
  parseScale(p.scale);
  if (p.referenceDefinition !== null) validateReference(p.referenceDefinition, 'referenceDefinition');
  if (p.status === 'FINAL' && p.referenceDefinition === null) throw new CuProfileError('a FINAL profile needs a referenceDefinition (DN-01)');
  if (!Array.isArray(p.entries) || p.entries.length === 0) throw new CuProfileError('entries must be a non-empty array');
  const seen = new Set<string>();
  p.entries.forEach((e, i) => {
    const w = `entries[${i}]`;
    if (!e.provider || e.provider !== e.provider.toLowerCase() || !e.model || e.model !== e.model.toLowerCase()) throw new CuProfileError(`${w}: provider and model must be non-empty lowercase`);
    if (!CU_CANONICAL_CATEGORIES.includes(e.category)) throw new CuProfileError(`${w}: unknown category ${String(e.category)}`);
    if (typeof e.priceMicroUsdPerMTok !== 'string' || !POS.test(e.priceMicroUsdPerMTok)) throw new CuProfileError(`${w}: price must be a positive integer string (no zero price, no float)`);
    const s = e.source;
    if (!s || !s.url || !s.archivedCopy || !HEX64.test(s.sha256 ?? '') || !s.literal || !Array.isArray(s.retrievedAt) || s.retrievedAt.length === 0) {
      throw new CuProfileError(`${w}: source needs url, archivedCopy, sha256 (64 hex), literal and retrievedAt[]`);
    }
    const k = `${e.provider}|${e.model}|${e.category}`;
    if (seen.has(k)) throw new CuProfileError(`${w}: duplicate ${k}`);
    seen.add(k);
  });
  for (const [a, m] of Object.entries(p.aliases ?? {})) {
    if (a !== a.toLowerCase() || !p.entries.some((e) => e.model === m)) throw new CuProfileError(`alias ${a} → ${m}: alias must be lowercase and point to a profile model`);
  }
  if (p.referenceDefinition !== null && referencePrice(p, p.referenceDefinition) === null) throw new CuProfileError('referenceDefinition is not a (provider, model, category) of this profile');
  if (p.status === 'FINAL' && !Array.isArray(p.derivedWeights)) throw new CuProfileError('a FINAL profile must record derivedWeights (w = p / p_ref)');
  if (p.derivedWeights !== undefined) {
    if (p.referenceDefinition === null) throw new CuProfileError('derivedWeights require a referenceDefinition');
    const expected = derivedWeightsOf(p);
    const key = (w: { provider: string; model: string; category: string }) => `${w.provider}|${w.model}|${w.category}`;
    const exp = new Map(expected.map((w) => [key(w), `${w.weight.numerator}/${w.weight.denominator}`]));
    if (p.derivedWeights.length !== expected.length) throw new CuProfileError(`derivedWeights must list every entry (${expected.length})`);
    for (const w of p.derivedWeights) {
      const want = exp.get(key(w));
      if (want === undefined || want !== `${w.weight?.numerator}/${w.weight?.denominator}`) throw new CuProfileError(`derivedWeights ${key(w)} = ${w.weight?.numerator}/${w.weight?.denominator}, expected ${want ?? 'no such entry'}`);
    }
  }
  return p;
}

/**
 * keccak256 over CE1 of the whole profile, domain OTK_CU_REFERENCE_PROFILE_V1. Any change → another digest.
 *
 * @param p - Profile; validated first.
 * @returns The 32-byte digest as hex.
 * @throws {@link CuProfileError} When the profile is invalid.
 */
export function digestCuReferenceProfile(p: CuReferenceProfileV1): Hex32 {
  validateCuReferenceProfile(p);
  return domainDigest(CU_REFERENCE_PROFILE_DOMAIN, p) as Hex32;
}

/** Usage split into canonical categories, or why it could not be split. */
export interface Decomposition {
  /** False when the usage could not be decomposed; `quantities` is then partial. */
  ok: boolean;
  /** Tokens per canonical category. */
  quantities: Record<CuCanonicalCategory, bigint>;
  /** Why decomposition failed. */
  detail?: string;
  /** Raw category with a non-zero count and no canonical mapping. */
  unsupportedCategory?: string;
}

/**
 * Observed usage → disjoint canonical quantities, following the inclusion rule the normalizer documents per API:
 * subsets are carved out of their base (OpenAI/Gemini cached input inside input; OpenAI reasoning inside output);
 * separate addends stand alone (Anthropic cache_read/cache_creation; Gemini thoughtsTokenCount).
 * A category reported as null was not reported (absent) and contributes nothing; it is never invented.
 *
 * @param u - Normalized usage.
 * @returns The decomposition; `ok: false` when base input/output is missing, a count is negative, a subset
 *   exceeds its base, or a non-zero raw category has no mapping.
 */
export function decomposeUsage(u: NormalizedUsage): Decomposition {
  const q: Record<CuCanonicalCategory, bigint> = { input_uncached: 0n, input_cache_read: 0n, input_cache_write: 0n, output_visible: 0n, output_reasoning: 0n };
  const inBase = u.categories.find((c) => c.name === 'input' && c.inclusion === 'base');
  const outBase = u.categories.find((c) => c.name === 'output' && c.inclusion === 'base');
  if (!inBase || !outBase || inBase.count === null || outBase.count === null) return { ok: false, quantities: q, detail: 'base input/output absent' };
  let carveIn = 0n;
  let carveOut = 0n;
  for (const c of u.categories) {
    if (c.inclusion === 'base' || c.count === null) continue;
    if (c.count < 0n) return { ok: false, quantities: q, detail: `negative ${c.name}` };
    const target: CuCanonicalCategory | null =
      c.name === 'input_cache_read' ? 'input_cache_read'
        : c.name === 'input_cache_write' ? 'input_cache_write'
          : c.name === 'output_reasoning' ? 'output_reasoning' : null;
    if (target === null) {
      if (c.count === 0n) continue;
      return { ok: false, quantities: q, detail: `raw category ${c.name} has no canonical mapping`, unsupportedCategory: c.name };
    }
    q[target] += c.count;
    if (c.inclusion === 'subset_of_input') carveIn += c.count;
    else if (c.inclusion === 'subset_of_output') carveOut += c.count;
  }
  if (carveIn > inBase.count || carveOut > outBase.count) return { ok: false, quantities: q, detail: 'subset larger than its base' };
  q.input_uncached = inBase.count - carveIn;
  q.output_visible = outBase.count - carveOut;
  return { ok: true, quantities: q };
}

function gcd(a: bigint, b: bigint): bigint { while (b) [a, b] = [b, a % b]; return a; }

function resolveModel(p: CuReferenceProfileV1, id: string): string | null {
  const m = id.trim().toLowerCase();
  if (p.entries.some((e) => e.model === m)) return m;
  return Object.hasOwn(p.aliases, m) ? p.aliases[m]! : null;
}

function priceOf(p: CuReferenceProfileV1, provider: string, model: string, cat: CuCanonicalCategory): CuReferencePriceEntry | null {
  return p.entries.find((e) => e.provider === provider && e.model === model && e.category === cat) ?? null;
}

/**
 * p_ref in micro-USD per MTok for a reference definition, or null when the reference is not in the profile. A real
 * reference may name a dated snapshot (e.g. gpt-4o-mini-2024-07-18): it is resolved through the profile's explicit aliases.
 *
 * @param p - Profile holding the prices.
 * @param r - Reference definition (a profile entry or an abstract price).
 * @returns p_ref in micro-USD per million tokens, or null.
 */
export function referencePrice(p: CuReferenceProfileV1, r: CuReferenceDefinition): bigint | null {
  if (r.kind === 'abstract_price') return BigInt(r.priceMicroUsdPerMTok);
  const model = resolveModel(p, r.model);
  const e = model ? priceOf(p, r.provider, model, r.category) : null;
  return e ? BigInt(e.priceMicroUsdPerMTok) : null;
}

/**
 * w = p / p_ref for every entry, as irreducible fractions (empty when the profile has no reference).
 *
 * @param p - Profile.
 * @returns One weight per entry, in entry order; empty when the reference is missing or not in the profile.
 */
export function derivedWeightsOf(p: CuReferenceProfileV1): NonNullable<CuReferenceProfileV1['derivedWeights']> {
  if (p.referenceDefinition === null) return [];
  const pRef = referencePrice(p, p.referenceDefinition);
  if (pRef === null) return [];
  return p.entries.map((e) => {
    const n = BigInt(e.priceMicroUsdPerMTok); const g = gcd(n, pRef) || 1n;
    return { provider: e.provider, model: e.model, category: e.category, weight: { numerator: (n / g).toString(), denominator: (pRef / g).toString() } };
  });
}

/** Options of `computeCuReference`. */
export interface ComputeCuReferenceOptions {
  /** Explicit normalization when the profile has none (DN-01 open). The result is then labelled CANDIDATE. */
  reference?: CuReferenceDefinition;
  /** Usage completeness accepted; default only 'complete' (a partial stream is never a final CU). */
  acceptCompleteness?: ReadonlyArray<NormalizedUsage['completeness']>;
}

/**
 * Computes the reference CU of one observed usage under a frozen profile.
 *
 * Never throws: an invalid profile, refused completeness, unknown model or category, or a missing reference
 * gives a result with `cu: null` and a status. The result is labelled FINAL only for a FINAL profile with its own
 * reference; otherwise CANDIDATE. `cu` is rounded half up at 10^-9; `exact` keeps the irreducible fraction.
 *
 * @param usage - Normalized usage of one call.
 * @param profile - Reference profile (validated here).
 * @param opts - Explicit reference when the profile has none, and accepted completeness values.
 * @returns The reference CU result.
 */
export function computeCuReference(usage: NormalizedUsage, profile: CuReferenceProfileV1, opts: ComputeCuReferenceOptions = {}): CuReferenceResult {
  let digest: Hex32;
  try { digest = digestCuReferenceProfile(profile); } catch (e) {
    return { schema: 'otk.cu_reference_result.v1', status: 'invalid_profile', formulaVersion: CU_REF_FORMULA, profileId: String(profile?.profileId ?? ''), profileDigest: '0x', basePeriod: String(profile?.basePeriod ?? ''), label: 'CU_REFERENCE_CANDIDATE', reference: null, provider: usage.provider, model: null, quantities: null, exact: null, cu: null, detail: (e as Error).message };
  }
  const reference = profile.referenceDefinition ?? opts.reference ?? null;
  const final = profile.status === 'FINAL' && profile.referenceDefinition !== null;
  const provider = usage.provider.trim().toLowerCase();
  const base = {
    schema: 'otk.cu_reference_result.v1' as const, formulaVersion: CU_REF_FORMULA, profileId: profile.profileId, profileDigest: digest,
    basePeriod: profile.basePeriod, label: (final ? 'CU_REFERENCE_FINAL' : 'CU_REFERENCE_CANDIDATE') as CuReferenceResult['label'], reference, provider,
  };
  const none = (status: CuReferenceResult['status'], model: string | null, detail: string, quantities: CuReferenceResult['quantities'] = null): CuReferenceResult =>
    ({ ...base, status, model, quantities, exact: null, cu: null, detail });

  const accept = opts.acceptCompleteness ?? ['complete'];
  if (!accept.includes(usage.completeness)) return none('usage_not_computable', null, `usage completeness ${usage.completeness}`);
  // The model the provider returned is an observed fact; the requested id is used only when none was returned,
  // and an unknown returned id is never replaced by the requested one (no silent model swap).
  const model = resolveModel(profile, usage.modelReturned ?? usage.modelRequested);
  if (model === null || !profile.entries.some((e) => e.provider === provider && e.model === model)) {
    return none('model_not_in_profile', model, `model ${usage.modelReturned ?? usage.modelRequested} (${provider}) has no entry in ${profile.profileId}`);
  }
  const d = decomposeUsage(usage);
  if (!d.ok) return none(d.unsupportedCategory ? 'category_not_in_profile' : 'usage_not_computable', model, d.detail ?? 'decomposition failed');
  const quantities = Object.fromEntries(CU_CANONICAL_CATEGORIES.map((c) => [c, d.quantities[c].toString()])) as Record<CuCanonicalCategory, string>;
  if (reference === null) return none('reference_undefined', model, 'no normalization reference (DN-01 open): pass opts.reference explicitly', quantities);
  const pRef = referencePrice(profile, reference);
  if (pRef === null) return none('reference_undefined', model, 'reference (provider, model, category) is not in the profile', quantities);

  let sum = 0n;
  for (const c of CU_CANONICAL_CATEGORIES) {
    const qty = d.quantities[c];
    if (qty === 0n) continue; // zero quantity needs no weight
    const e = priceOf(profile, provider, model, c);
    if (!e) return none('category_not_in_profile', model, `${provider}/${model} has ${qty} ${c} but the profile has no base price for it (no invented weight)`, quantities);
    sum += qty * BigInt(e.priceMicroUsdPerMTok);
  }
  const sc = parseScale(profile.scale);
  let num = sc.n * sum;
  let den = pRef * sc.d;
  const g = gcd(num, den) || 1n;
  num /= g; den /= g;
  const units = (num * CU_DECIMAL_SCALE * 2n + den) / (den * 2n); // round half up at 10^-9
  const cu: Scaled = { units, scale: CU_DECIMAL_SCALE };
  return { ...base, status: 'computed', model, quantities, exact: { numerator: num.toString(), denominator: den.toString() }, cu };
}

/**
 * Exact comparison of two computed results: a/b as an irreducible fraction (used to show scale invariance).
 *
 * @param a - Numerator result.
 * @param b - Denominator result.
 * @returns The ratio, or null when either result has no exact value or `b` is zero.
 */
export function cuRatio(a: CuReferenceResult, b: CuReferenceResult): { numerator: string; denominator: string } | null {
  if (!a.exact || !b.exact) return null;
  let n = BigInt(a.exact.numerator) * BigInt(b.exact.denominator);
  let d = BigInt(a.exact.denominator) * BigInt(b.exact.numerator);
  if (d === 0n) return null;
  const g = gcd(n, d) || 1n;
  n /= g; d /= g;
  return { numerator: n.toString(), denominator: d.toString() };
}

/**
 * Plain integer check for loaders (keeps numbers out of CE1).
 *
 * @param s - Any value.
 * @returns True when `s` is a string of decimal digits.
 */
export function isDecimalString(s: unknown): s is string { return typeof s === 'string' && DEC.test(s); }
