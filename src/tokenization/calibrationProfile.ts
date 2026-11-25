/**
 * Versioned calibration profiles for the auxiliary conference (OVERNIGHT 20261005, Phase 8; D8 §4).
 *
 * A profile states, for ONE (provider, api, model) and ONE local tokenizer (encoding + vocabulary digest + package
 * version + message assembly) and counter version, how the raw local count relates to the provider-reported count:
 * an affine adjustment per category (expected = slope × local + intercept, integer, ≥ 0), the threshold derived
 * from validation residuals, and the metrics measured on train / validation / holdout splits with their n.
 *
 * Loader states (the conference never upgrades a state by guessing):
 *   ABSENT          no profile for (provider, api, model), or no local tokenizer at all;
 *   CORRUPT         the file does not parse, does not follow the schema, is internally inconsistent, or its
 *                   evidenceHash does not match its body (tampered or damaged);
 *   INCOMPATIBLE    a profile exists for the key but was made for another tokenizer / vocabulary / package /
 *                   assembly / counter version, is synthetic in a runtime that refuses synthetic profiles, or
 *                   more than one profile claims the key;
 *   NOT_CALIBRATED  intact and compatible, but calibrated = false (e.g. insufficient sample);
 *   COMPATIBLE      intact, compatible and calibrated = true. ONLY this state yields a ConferenceThreshold with
 *                   calibrated = true and calibrationVersion = profileId.
 * Every other state keeps the heuristic threshold (HEURISTIC_THRESHOLD_V0) and is recorded in the report.
 *
 * evidenceHash = sha256 over the canonical JSON of the profile without the evidenceHash key. It detects damage and
 * edits that did not recompute it; it is NOT a signature: whoever can write the profile directory can write a
 * consistent profile. The directory is operator configuration (OTK_CALIBRATION_PROFILES_DIR, read in bootstrap).
 *
 * @module tokenization/calibrationProfile
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  CalibrationState, ConferenceCalibration, ConferenceCalibrationRecord, ConferenceThreshold, Hex32, ModelSupport,
  TokenCategoryName, UsageApi,
} from '../types/d1d8/index.js';
import { HEURISTIC_THRESHOLD_V0, decimalToMicro } from './conferenceReport.js';

/**
 * Schema identifier every profile file must carry.
 */
export const CALIBRATION_PROFILE_SCHEMA = 'otk.calibration_profile.v1' as const;

/** Categories a profile may adjust (text input and visible text output, as the local counter covers them). */
export type CalibrationCategory = 'input' | 'output';
/**
 * All {@link CalibrationCategory} values, frozen.
 */
export const CALIBRATION_CATEGORIES: readonly CalibrationCategory[] = Object.freeze(['input', 'output']);

/** expected = round_half_up(slope × local + intercept), clamped at 0. Decimals with at most 6 fraction digits. */
export interface AffineAdjustment {
  slope: string;
  intercept: string;
}

/**
 * Error summary of one split for one category. Errors are prediction − target (positive = local side over-counts
 * after adjustment). Relative errors exclude target 0 (counted in zeroTargets). A quantile q is reported only when
 * nRelative ≥ 1/(1 − q) (p90 needs 10, p95 needs 20, p99 needs 100), otherwise null: the n is always given.
 */
export interface ErrorSummary {
  n: number;
  groups: number;
  bias: number | null;
  mae: number | null;
  maxAbs: number | null;
  relErrorQuantiles: { nRelative: number; zeroTargets: number; p50: number | null; p90: number | null; p95: number | null; p99: number | null };
  /** Share of rows the profile's own threshold would flag (false alerts: the targets are unaltered). */
  alertRate: number | null;
}

/**
 * Error summaries per category for one split.
 */
export type CategoryMetrics = Partial<Record<CalibrationCategory, ErrorSummary>>;

/**
 * One acceptance criterion of a profile: what was required, what was observed, and the verdict.
 */
export interface AcceptanceCheck {
  id: string;
  required: string;
  observed: string;
  passed: boolean;
}

/**
 * A calibration profile file (schema `otk.calibration_profile.v1`).
 */
export interface CalibrationProfileV1 {
  schema: typeof CALIBRATION_PROFILE_SCHEMA;
  profileId: string;
  /** true when the target is a synthetic rule (tests only); a runtime refuses these unless explicitly allowed. */
  synthetic: boolean;
  /** What the target column is: final usage of real calls, a provider count endpoint, or a synthetic rule. */
  targetKind: 'provider_final_usage' | 'provider_count_endpoint' | 'synthetic_rule';
  provider: string;
  apiVariant: UsageApi;
  /** Exact model id (lowercase) and explicit aliases; no prefix matching. */
  model: string;
  modelAliases: string[];
  /** Encoding name of the local tokenizer, e.g. 'o200k_base'. */
  tokenizer: string;
  tokenizerVersion: {
    package: string;
    packageVersion: string;
    vocabularyDigest: Hex32;
    messageAssembly: { id: string; version: string };
  };
  counterVersion: string;
  scope: { description: string; excludes: string[] };
  categoriesCovered: CalibrationCategory[];
  corpusId: string;
  corpus: {
    sha256: string | null;
    splitRule: string;
    documents: { train: number; validation: number; holdout: number };
    groups: { train: number; validation: number; holdout: number };
  };
  createdAt: string;
  parameters: { method: 'affine_least_squares'; categories: Partial<Record<CalibrationCategory, AffineAdjustment>> };
  errorMetrics: { train: CategoryMetrics };
  validationMetrics: { validation: CategoryMetrics; holdout: CategoryMetrics };
  thresholdPolicy: { absoluteTokens: string; relative: string | null; derivation: string };
  acceptance: { policy: string; checks: AcceptanceCheck[]; passed: boolean };
  calibrated: boolean;
  limitations: string[];
  evidenceHash: Hex32;
}

/**
 * A profile without its `evidenceHash` (input of {@link sealProfile}).
 */
export type CalibrationProfileBody = Omit<CalibrationProfileV1, 'evidenceHash'>;

// ───────────────────────────── canonical hash ─────────────────────────────

/**
 * Canonical JSON: keys sorted at every level; undefined dropped. Numbers as JSON numbers (metrics only).
 *
 *
 * @param value - JSON-compatible value.
 */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sort);
    return Object.fromEntries(Object.keys(v as object).sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k, sort((v as Record<string, unknown>)[k])]));
  };
  return JSON.stringify(sort(value));
}

/**
 * SHA-256 of the canonical JSON of a profile, ignoring any `evidenceHash` member.
 *
 * @param body - Profile or body (not modified).
 * @returns `0x`-prefixed lowercase hex digest.
 */
export function computeEvidenceHash(body: CalibrationProfileBody | Record<string, unknown>): Hex32 {
  const { evidenceHash: _drop, ...rest } = body as Record<string, unknown>;
  return `0x${createHash('sha256').update(canonical(rest), 'utf8').digest('hex')}`;
}

/**
 * Adds the evidenceHash of the body.
 *
 *
 * @param body - Profile body.
 * @returns A new profile object with `evidenceHash` set.
 */
export function sealProfile(body: CalibrationProfileBody): CalibrationProfileV1 {
  return { ...body, evidenceHash: computeEvidenceHash(body) };
}

// ───────────────────────────── arithmetic ─────────────────────────────

const SIGNED_DECIMAL = /^-?\d+(?:\.\d{1,6})?$/;
const MICRO = 1_000_000n;

/**
 * Parses a signed decimal with at most 6 fraction digits into millionths.
 *
 * @param s - Decimal text, optionally starting with `-`.
 * @returns The value × 10^6.
 * @throws {Error} When `s` is not in that format.
 */
export function signedDecimalToMicro(s: string): bigint {
  if (!SIGNED_DECIMAL.test(s)) throw new Error(`invalid signed decimal ${s}`);
  return s.startsWith('-') ? -decimalToMicro(s.slice(1)) : decimalToMicro(s);
}

/**
 * Decimal string with exactly 6 fraction digits (round half away from zero), from a JS number.
 *
 *
 * @param x - Finite number.
 * @returns Decimal text with exactly 6 fraction digits.
 * @throws {Error} When `x` is not finite.
 */
export function numberToDecimal6(x: number): string {
  if (!Number.isFinite(x)) throw new Error('non-finite parameter');
  const micro = BigInt(Math.round(Math.abs(x) * 1e6)) * (x < 0 ? -1n : 1n);
  const neg = micro < 0n;
  const m = neg ? -micro : micro;
  return `${neg && m !== 0n ? '-' : ''}${m / MICRO}.${(m % MICRO).toString().padStart(6, '0')}`;
}

/**
 * expected = round_half_up(slope × local + intercept), clamped at 0 (integer tokens).
 *
 *
 * @param adj - Slope and intercept of the profile.
 * @param local - Raw local count in tokens.
 * @returns Expected provider count in tokens (never negative).
 * @throws {Error} When the slope or intercept is not a valid decimal.
 */
export function expectedTokens(adj: AffineAdjustment, local: bigint): bigint {
  const v = signedDecimalToMicro(adj.slope) * local + signedDecimalToMicro(adj.intercept);
  if (v <= 0n) return 0n;
  return (v + MICRO / 2n) / MICRO;
}

// ───────────────────────────── parsing / integrity ─────────────────────────────

/**
 * Result of {@link parseCalibrationProfile}; on failure `claimed` holds what the file says it covers, when readable.
 */
export type ParseResult =
  | { ok: true; profile: CalibrationProfileV1 }
  | { ok: false; reason: string; claimed: { provider: string; apiVariant: string; model: string; modelAliases: string[]; profileId: string | null; evidenceHash: Hex32 | null } | null };

const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const isNum = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const HEX32 = /^0x[0-9a-f]{64}$/;

function schemaProblem(p: Record<string, unknown>): string | null {
  if (p['schema'] !== CALIBRATION_PROFILE_SCHEMA) return 'schema_unknown';
  for (const f of ['profileId', 'provider', 'apiVariant', 'model', 'tokenizer', 'counterVersion', 'corpusId', 'createdAt']) if (!isStr(p[f])) return `field_${f}`;
  if (typeof p['synthetic'] !== 'boolean' || typeof p['calibrated'] !== 'boolean') return 'field_flags';
  if (!['provider_final_usage', 'provider_count_endpoint', 'synthetic_rule'].includes(p['targetKind'] as string)) return 'field_targetKind';
  if ((p['targetKind'] === 'synthetic_rule') !== p['synthetic']) return 'synthetic_flag_inconsistent';
  if (!Array.isArray(p['modelAliases']) || !(p['modelAliases'] as unknown[]).every(isStr)) return 'field_modelAliases';
  if (p['model'] !== (p['model'] as string).toLowerCase() || (p['modelAliases'] as string[]).some((a) => a !== a.toLowerCase())) return 'model_not_lowercase';
  const tv = p['tokenizerVersion'] as Record<string, unknown> | undefined;
  if (!tv || !isStr(tv['package']) || !isStr(tv['packageVersion']) || typeof tv['vocabularyDigest'] !== 'string' || !HEX32.test(tv['vocabularyDigest'] as string)) return 'field_tokenizerVersion';
  const ma = tv['messageAssembly'] as Record<string, unknown> | undefined;
  if (!ma || !isStr(ma['id']) || !isStr(ma['version'])) return 'field_messageAssembly';
  const cats = p['categoriesCovered'];
  if (!Array.isArray(cats) || cats.length === 0 || !cats.every((c) => (CALIBRATION_CATEGORIES as readonly unknown[]).includes(c)) || new Set(cats).size !== cats.length) return 'field_categoriesCovered';
  const par = p['parameters'] as Record<string, unknown> | undefined;
  if (!par || par['method'] !== 'affine_least_squares' || !par['categories'] || typeof par['categories'] !== 'object') return 'field_parameters';
  const pc = par['categories'] as Record<string, unknown>;
  for (const [k, v] of Object.entries(pc)) {
    if (!(CALIBRATION_CATEGORIES as readonly string[]).includes(k)) return 'parameters_unknown_category';
    const a = v as Record<string, unknown>;
    if (!a || typeof a['slope'] !== 'string' || typeof a['intercept'] !== 'string' || !SIGNED_DECIMAL.test(a['slope']) || !SIGNED_DECIMAL.test(a['intercept'])) return 'parameters_malformed';
  }
  const th = p['thresholdPolicy'] as Record<string, unknown> | undefined;
  if (!th || typeof th['absoluteTokens'] !== 'string' || !/^(0|[1-9]\d*)$/.test(th['absoluteTokens'])) return 'threshold_absolute_malformed';
  if (th['relative'] !== null && (typeof th['relative'] !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(th['relative']))) return 'threshold_relative_malformed';
  if (!isStr(th['derivation'])) return 'threshold_derivation_missing';
  const acc = p['acceptance'] as Record<string, unknown> | undefined;
  if (!acc || !isStr(acc['policy']) || typeof acc['passed'] !== 'boolean' || !Array.isArray(acc['checks'])) return 'field_acceptance';
  const checks = acc['checks'] as Array<Record<string, unknown>>;
  if (!checks.every((c) => c && isStr(c['id']) && typeof c['passed'] === 'boolean')) return 'acceptance_checks_malformed';
  if (acc['passed'] !== (checks.length > 0 && checks.every((c) => c['passed'] === true))) return 'acceptance_inconsistent';
  for (const f of ['errorMetrics', 'validationMetrics', 'scope', 'corpus']) if (!p[f] || typeof p[f] !== 'object') return `field_${f}`;
  const hold = (p['validationMetrics'] as Record<string, unknown>)['holdout'] as Record<string, Record<string, unknown>> | undefined;
  if (!hold || typeof hold !== 'object') return 'field_holdout';
  if (!Array.isArray(p['limitations']) || !(p['limitations'] as unknown[]).every((l) => typeof l === 'string')) return 'field_limitations';
  // a calibrated profile must be backed by its own acceptance, parameters and holdout n for every covered category
  if (p['calibrated'] === true) {
    if (acc['passed'] !== true) return 'calibrated_without_acceptance';
    for (const c of cats as string[]) {
      if (!pc[c]) return `calibrated_without_parameters_${c}`;
      if (!hold[c] || !isNum(hold[c]!['n']) || (hold[c]!['n'] as number) <= 0) return `calibrated_without_holdout_${c}`;
    }
  }
  if (typeof p['evidenceHash'] !== 'string' || !HEX32.test(p['evidenceHash'])) return 'evidence_hash_missing';
  return null;
}

function claimedOf(p: Record<string, unknown>): Extract<ParseResult, { ok: false }>['claimed'] {
  if (!isStr(p['provider']) || !isStr(p['apiVariant']) || !isStr(p['model'])) return null;
  return {
    provider: p['provider'].toLowerCase(), apiVariant: p['apiVariant'], model: p['model'].toLowerCase(),
    modelAliases: Array.isArray(p['modelAliases']) ? (p['modelAliases'] as unknown[]).filter(isStr).map((a) => a.toLowerCase()) : [],
    profileId: isStr(p['profileId']) ? p['profileId'] : null,
    evidenceHash: typeof p['evidenceHash'] === 'string' && HEX32.test(p['evidenceHash']) ? p['evidenceHash'] as Hex32 : null,
  };
}

/**
 * Parse + schema + internal consistency + evidenceHash. Never throws.
 *
 *
 * @param text - File content.
 * @returns The profile, or the reason it was rejected.
 */
export function parseCalibrationProfile(text: string): ParseResult {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return { ok: false, reason: 'json_parse_failed', claimed: null }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'not_an_object', claimed: null };
  const p = raw as Record<string, unknown>;
  const problem = schemaProblem(p);
  if (problem) return { ok: false, reason: problem, claimed: claimedOf(p) };
  if (computeEvidenceHash(p) !== p['evidenceHash']) return { ok: false, reason: 'evidence_hash_mismatch', claimed: claimedOf(p) };
  return { ok: true, profile: p as unknown as CalibrationProfileV1 };
}

// ───────────────────────────── compatibility ─────────────────────────────

/**
 * Options for compatibility checks.
 */
export interface CompatibilityOptions {
  /** Synthetic profiles are refused unless this is true (tests only; bootstrap never sets it). */
  allowSynthetic?: boolean;
}

/**
 * True when the operation's model is the profile's model or one of its explicit aliases (no prefixes).
 *
 *
 * @param p - Profile model and aliases (lowercase).
 * @param support - Operation's model support (requested model and catalog key are compared).
 * @returns `true` on an exact match.
 */
export function modelMatches(p: { model: string; modelAliases: string[] }, support: ModelSupport): boolean {
  const ids = new Set([p.model, ...p.modelAliases]);
  const req = support.modelRequested.trim().toLowerCase();
  const key = support.catalogKey?.trim().toLowerCase() ?? null;
  return ids.has(req) || (key !== null && ids.has(key));
}

/**
 * Compatibility of one intact profile with the operation's support and counter version.
 *
 *
 * @param profile - Intact profile.
 * @param support - Operation's model support and tokenizer identity.
 * @param counterVersion - Version of the local counter in use.
 * @param opts - Whether synthetic profiles are accepted.
 * @returns The state and, unless COMPATIBLE, the first failed check as reason.
 */
export function checkCompatibility(profile: CalibrationProfileV1, support: ModelSupport, counterVersion: string, opts: CompatibilityOptions = {}): { state: CalibrationState; reason: string | null } {
  const tok = support.tokenizer;
  if (support.support === 'unsupported' || !tok) return { state: 'ABSENT', reason: 'no_local_tokenizer' };
  if (profile.provider.toLowerCase() !== support.provider.trim().toLowerCase()) return { state: 'INCOMPATIBLE', reason: 'provider_mismatch' };
  if (profile.apiVariant !== support.api) return { state: 'INCOMPATIBLE', reason: 'api_mismatch' };
  if (!modelMatches(profile, support)) return { state: 'INCOMPATIBLE', reason: 'model_mismatch' };
  if (profile.synthetic && !opts.allowSynthetic) return { state: 'INCOMPATIBLE', reason: 'synthetic_profile_not_allowed' };
  if (profile.tokenizer !== tok.encoding) return { state: 'INCOMPATIBLE', reason: 'tokenizer_encoding_mismatch' };
  if (!tok.vocabularyDigest || profile.tokenizerVersion.vocabularyDigest !== tok.vocabularyDigest.toLowerCase()) return { state: 'INCOMPATIBLE', reason: 'tokenizer_vocabulary_digest_mismatch' };
  if (profile.tokenizerVersion.package !== tok.package || profile.tokenizerVersion.packageVersion !== tok.packageVersion) return { state: 'INCOMPATIBLE', reason: 'tokenizer_package_mismatch' };
  const ma = tok.messageAssembly;
  if (!ma || ma.id !== profile.tokenizerVersion.messageAssembly.id || ma.version !== profile.tokenizerVersion.messageAssembly.version) return { state: 'INCOMPATIBLE', reason: 'message_assembly_mismatch' };
  if (profile.counterVersion !== counterVersion) return { state: 'INCOMPATIBLE', reason: 'counter_version_mismatch' };
  if (!profile.calibrated) return { state: 'NOT_CALIBRATED', reason: 'profile_not_calibrated' };
  return { state: 'COMPATIBLE', reason: null };
}

/**
 * Threshold of a COMPATIBLE calibrated profile.
 *
 *
 * @param profile - Profile in state COMPATIBLE.
 * @returns Its threshold, marked calibrated with the profile ID as version.
 */
export function thresholdFromProfile(profile: CalibrationProfileV1): ConferenceThreshold {
  return {
    absoluteTokens: BigInt(profile.thresholdPolicy.absoluteTokens),
    relative: profile.thresholdPolicy.relative,
    calibrationVersion: profile.profileId,
    calibrated: true,
  };
}

// ───────────────────────────── registry ─────────────────────────────

/**
 * Outcome of selecting a profile for one operation.
 */
export interface CalibrationSelection {
  state: CalibrationState;
  profileId: string | null;
  evidenceHash: Hex32 | null;
  reason: string | null;
  /** Heuristic unless state = COMPATIBLE. */
  threshold: ConferenceThreshold;
  /** What the conference report receives (record + adjusted expectation for COMPATIBLE only). */
  conference: ConferenceCalibration;
}

/**
 * One profile source after loading: parsed (`LOADED`) or rejected (`CORRUPT`, with the reason).
 */
export interface LoadedProfileEntry {
  source: string;
  state: 'LOADED' | 'CORRUPT';
  reason: string | null;
  profile: CalibrationProfileV1 | null;
  claimed: { provider: string; apiVariant: string; model: string; modelAliases: string[]; profileId: string | null; evidenceHash: Hex32 | null } | null;
}

/**
 * Set of loaded profiles that picks the profile (and threshold) for an operation.
 */
export interface CalibrationRegistry {
  /** Where the profiles came from (directory, 'none', or a test label). */
  readonly source: string;
  readonly entries: readonly LoadedProfileEntry[];
  readonly allowSynthetic: boolean;
  /**
   * Selects the profile for an operation's provider, API and model.
   */
  select(support: ModelSupport, counterVersion: string): CalibrationSelection;
  /** Startup summary (ids and states only). */
  summary(): { source: string; loaded: string[]; corrupt: Array<{ source: string; reason: string | null }> };
}

function selection(state: CalibrationState, reason: string | null, profile: { profileId: string | null; evidenceHash: Hex32 | null } | null,
  calibrated: CalibrationProfileV1 | null): CalibrationSelection {
  const record: ConferenceCalibrationRecord = { state, profileId: profile?.profileId ?? null, evidenceHash: profile?.evidenceHash ?? null, reason };
  if (state === 'COMPATIBLE' && calibrated) {
    const params = calibrated.parameters.categories;
    const covered = new Set<string>(calibrated.categoriesCovered);
    return {
      state, profileId: calibrated.profileId, evidenceHash: calibrated.evidenceHash, reason,
      threshold: thresholdFromProfile(calibrated),
      conference: {
        record,
        expected: (category: TokenCategoryName, local: bigint) => {
          const adj = covered.has(category) ? params[category as CalibrationCategory] : undefined;
          return adj ? expectedTokens(adj, local) : null;
        },
      },
    };
  }
  return { state, profileId: record.profileId, evidenceHash: record.evidenceHash, reason, threshold: { ...HEURISTIC_THRESHOLD_V0 }, conference: { record } };
}

function claimsKey(c: { provider: string; apiVariant: string; model: string; modelAliases: string[] }, support: ModelSupport): boolean {
  return c.provider === support.provider.trim().toLowerCase() && c.apiVariant === support.api && modelMatches(c, support);
}

/**
 * Registry over already-read profile texts (tests and the directory loader).
 *
 *
 * @param sources - Profile texts with a source label each.
 * @param opts - Synthetic acceptance and a label for `source`.
 * @returns The registry; a key claimed by more than one profile is INCOMPATIBLE.
 */
export function createCalibrationRegistry(sources: Array<{ source: string; text: string }>, opts: CompatibilityOptions & { label?: string } = {}): CalibrationRegistry {
  const entries: LoadedProfileEntry[] = sources.map(({ source, text }) => {
    const r = parseCalibrationProfile(text);
    if (r.ok) {
      const p = r.profile;
      return { source, state: 'LOADED', reason: null, profile: p,
        claimed: { provider: p.provider.toLowerCase(), apiVariant: p.apiVariant, model: p.model, modelAliases: p.modelAliases, profileId: p.profileId, evidenceHash: p.evidenceHash } };
    }
    return { source, state: 'CORRUPT', reason: r.reason, profile: null, claimed: r.claimed };
  });
  const allowSynthetic = opts.allowSynthetic === true;
  return {
    source: opts.label ?? 'memory',
    entries,
    allowSynthetic,
    select(support, counterVersion) {
      if (support.support === 'unsupported' || !support.tokenizer) return selection('ABSENT', 'no_local_tokenizer', null, null);
      const candidates = entries.filter((e) => e.claimed && claimsKey(e.claimed, support));
      if (candidates.length === 0) return selection('ABSENT', 'no_profile_for_provider_api_model', null, null);
      const corrupt = candidates.find((e) => e.state === 'CORRUPT');
      if (corrupt) return selection('CORRUPT', corrupt.reason, corrupt.claimed, null);
      if (candidates.length > 1) return selection('INCOMPATIBLE', 'multiple_profiles_for_key', null, null);
      const p = candidates[0]!.profile!;
      const c = checkCompatibility(p, support, counterVersion, { allowSynthetic });
      return selection(c.state, c.reason, p, c.state === 'COMPATIBLE' ? p : null);
    },
    summary() {
      return {
        source: opts.label ?? 'memory',
        loaded: entries.filter((e) => e.state === 'LOADED').map((e) => `${e.profile!.profileId}${e.profile!.calibrated ? '' : ' (calibrated=false)'}${e.profile!.synthetic ? ' (SYNTHETIC)' : ''}`),
        corrupt: entries.filter((e) => e.state === 'CORRUPT').map((e) => ({ source: e.source, reason: e.reason })),
      };
    },
  };
}

/**
 * Empty registry: every selection is ABSENT (explicit not-calibrated outcome).
 *
 *
 * @returns A registry with no profile.
 */
export function emptyCalibrationRegistry(): CalibrationRegistry {
  return createCalibrationRegistry([], { label: 'none' });
}

/**
 * Loads every *.json file of `dir` (non-recursive, sorted by name) at startup. A file that cannot be read is
 * recorded as CORRUPT; nothing here throws for a bad profile (the conference reports the state instead).
 * A missing directory is a configuration error and throws.
 *
 * @param dir - Folder with the profile files.
 * @param opts - Whether synthetic profiles are accepted.
 * @returns The registry built from the files.
 * @throws {Error} When the folder cannot be listed (e.g. it does not exist).
 */
export function loadCalibrationProfilesFromDir(dir: string, opts: CompatibilityOptions = {}): CalibrationRegistry {
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  const sources = files.map((f) => {
    try { return { source: f, text: readFileSync(join(dir, f), 'utf8') }; } catch { return { source: f, text: '' }; }
  });
  return createCalibrationRegistry(sources, { ...opts, label: dir });
}
