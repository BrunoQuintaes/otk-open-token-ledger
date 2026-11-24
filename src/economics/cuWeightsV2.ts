/**
 * Signed CU weights table v2 — load, verify, build (D4 §1–2, D4-G01, S0-F01; front B).
 * Implements LoadCuWeightsFn.
 *
 * The v1 CW JSON (CUWeightsLoader.ts) stored input/output/latency weights per model, which
 * expresses a weighted sum and puts latency next to CU. D5 keeps the multiplicative formula
 *     CU = (T_entrada + T_saida) × W_modelo × W_provedor
 * so v2 carries W_provedor and W_modelo separately, in integer milli units, with explicit
 * aliases and no latency. Loading never falls back to built-in constants: an absent or
 * invalid table yields a status and no config. The development profile is a separate,
 * explicitly labelled function.
 *
 * Wire format (JSON): weights are decimal strings ("1100"), never JS numbers.
 * Signed message: 'OTK-CU-WEIGHTS-V2:' + canonicalJson(table without `signature`), EIP-191.
 */
import { verifyMessage } from 'ethers';
import type { CuWeightsLoadStatus, CuWeightsTableV2, IsoTime, VersionRef } from '../types/d1d8/index.js';
import type { CuConfig } from '../types/d1d8/index.js';
import { canonicalJson, sha256Hex } from '../providers/usage/canonicalJson.js';
import { MODEL_WEIGHTS_INT, PROVIDER_WEIGHTS_INT } from '../pricing/CostUnits.js';

export const CU_WEIGHTS_V2_MESSAGE_PREFIX = 'OTK-CU-WEIGHTS-V2:';

/** Exact multiplicative formula: units = (tIn + tOut) × Wm_milli × Wp_milli, scale 10^6, no rounding. */
export const CU_FORMULA_EXACT = 'CU_MULT_v2_micro' as const;
/** Legacy formula: integer CU, round half up (src/pricing/CostUnits.ts). Kept to read history. */
export const CU_FORMULA_LEGACY = 'CU_MODEL_v1' as const;
export const SUPPORTED_CU_FORMULAS: readonly string[] = [CU_FORMULA_EXACT, CU_FORMULA_LEGACY];

/** Weight bounds in milli units: 0 would make usage free, above 10^6 is 1000× the baseline. */
export const MIN_WEIGHT_MILLI = 1n;
export const MAX_WEIGHT_MILLI = 1_000_000n;

const KEY_RE = /^[a-z0-9][a-z0-9._:/-]*$/;

export interface CuWeightsLoadResult {
  status: CuWeightsLoadStatus;
  config: CuConfig | null;
  /** Human-readable reason for any non-valid status (no secrets, no table content). */
  reason: string | null;
}

/** Body that is signed: every field except `signature`, weights as decimal strings. */
export function cuWeightsV2SignedBody(table: Omit<CuWeightsTableV2, 'signature'>): string {
  return canonicalJson({
    schema: table.schema,
    version: table.version,
    validFrom: table.validFrom,
    validUntil: table.validUntil,
    providerWeightsMilli: table.providerWeightsMilli,
    modelWeightsMilli: table.modelWeightsMilli,
    aliases: table.aliases,
    signedBy: table.signedBy.toLowerCase(),
  });
}

export function cuWeightsV2Message(table: Omit<CuWeightsTableV2, 'signature'>): string {
  return `${CU_WEIGHTS_V2_MESSAGE_PREFIX}${cuWeightsV2SignedBody(table)}`;
}

/** Digest of the exact validated content including the signature (frozen in operations). */
export function cuWeightsV2Ref(table: CuWeightsTableV2): VersionRef {
  return {
    version: table.version,
    digest: sha256Hex(canonicalJson({ body: cuWeightsV2SignedBody(table), signature: table.signature })),
  };
}

/** JSON wire form (bigint → string). */
export function cuWeightsV2ToJson(table: CuWeightsTableV2): Record<string, unknown> {
  const strMap = (m: Record<string, bigint>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.toString()]));
  return {
    schema: table.schema,
    version: table.version,
    validFrom: table.validFrom,
    validUntil: table.validUntil,
    providerWeightsMilli: strMap(table.providerWeightsMilli),
    modelWeightsMilli: strMap(table.modelWeightsMilli),
    aliases: { ...table.aliases },
    signedBy: table.signedBy,
    signature: table.signature,
  };
}

type Parse<T> = { ok: true; value: T } | { ok: false; reason: string };

function parseWeightMap(raw: unknown, field: string): Parse<Record<string, bigint>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: `${field} must be an object` };
  const out: Record<string, bigint> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!KEY_RE.test(k)) return { ok: false, reason: `${field} key must be lowercase id: ${JSON.stringify(k)}` };
    let w: bigint;
    if (typeof v === 'bigint') w = v;
    else if (typeof v === 'string' && /^[0-9]+$/.test(v)) w = BigInt(v);
    else return { ok: false, reason: `${field}.${k} must be a decimal string of an integer` };
    if (w < MIN_WEIGHT_MILLI || w > MAX_WEIGHT_MILLI) return { ok: false, reason: `${field}.${k} out of range [${MIN_WEIGHT_MILLI}, ${MAX_WEIGHT_MILLI}]` };
    out[k] = w;
  }
  if (Object.keys(out).length === 0) return { ok: false, reason: `${field} is empty` };
  return { ok: true, value: out };
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** Structural parse of a v2 table (no signature or time checks). */
export function parseCuWeightsTableV2(raw: unknown): Parse<CuWeightsTableV2> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'table must be an object' };
  const t = raw as Record<string, unknown>;
  if (t['schema'] !== 'otk.cu_weights.v2') return { ok: false, reason: `schema must be otk.cu_weights.v2 (got ${JSON.stringify(t['schema'] ?? null)})` };
  for (const f of ['version', 'validFrom', 'validUntil', 'signedBy', 'signature']) {
    if (typeof t[f] !== 'string' || (t[f] as string).length === 0) return { ok: false, reason: `missing ${f}` };
  }
  if ('latencyWeight' in t || 'weights' in t) return { ok: false, reason: 'v1 fields (weights/latencyWeight) are not part of v2' };
  for (const f of ['validFrom', 'validUntil']) {
    if (!ISO_RE.test(t[f] as string) || Number.isNaN(Date.parse(t[f] as string))) return { ok: false, reason: `${f} must be ISO-8601 UTC` };
  }
  if (Date.parse(t['validFrom'] as string) >= Date.parse(t['validUntil'] as string)) return { ok: false, reason: 'validFrom must precede validUntil' };
  if (!/^0x[0-9a-fA-F]{40}$/.test(t['signedBy'] as string)) return { ok: false, reason: 'signedBy must be an address' };
  const providers = parseWeightMap(t['providerWeightsMilli'], 'providerWeightsMilli');
  if (!providers.ok) return providers;
  const models = parseWeightMap(t['modelWeightsMilli'], 'modelWeightsMilli');
  if (!models.ok) return models;
  const aliasesRaw = t['aliases'] ?? {};
  if (typeof aliasesRaw !== 'object' || aliasesRaw === null || Array.isArray(aliasesRaw)) return { ok: false, reason: 'aliases must be an object' };
  const aliases: Record<string, string> = {};
  for (const [a, target] of Object.entries(aliasesRaw as Record<string, unknown>)) {
    if (!KEY_RE.test(a) || typeof target !== 'string') return { ok: false, reason: `alias ${JSON.stringify(a)} invalid` };
    if (Object.hasOwn(models.value, a)) return { ok: false, reason: `alias ${a} collides with a model key` };
    if (!Object.hasOwn(models.value, target)) return { ok: false, reason: `alias ${a} points to unknown model ${target}` };
    aliases[a] = target;
  }
  return {
    ok: true,
    value: {
      schema: 'otk.cu_weights.v2',
      version: t['version'] as string,
      validFrom: t['validFrom'] as string,
      validUntil: t['validUntil'] as string,
      providerWeightsMilli: providers.value,
      modelWeightsMilli: models.value,
      aliases,
      signedBy: t['signedBy'] as string,
      signature: t['signature'] as string,
    },
  };
}

/**
 * LoadCuWeightsFn. Order of checks: missing → malformed → signature → signer authorization →
 * validity window. An empty trustedSigners list authorizes nobody (no development fallback).
 */
export function loadCuWeights(raw: unknown, opts: { now: IsoTime; trustedSigners: readonly string[]; formula?: string }): CuWeightsLoadResult {
  if (raw === undefined || raw === null) return { status: 'missing', config: null, reason: 'no table provided' };
  const parsed = parseCuWeightsTableV2(raw);
  if (!parsed.ok) return { status: 'malformed', config: null, reason: parsed.reason };
  const table = parsed.value;
  let recovered: string;
  try {
    recovered = verifyMessage(cuWeightsV2Message(table), table.signature).toLowerCase();
  } catch {
    return { status: 'bad_signature', config: null, reason: 'signature does not decode' };
  }
  if (recovered !== table.signedBy.toLowerCase()) return { status: 'bad_signature', config: null, reason: 'signature does not match signedBy over the v2 message' };
  const trusted = opts.trustedSigners.map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!trusted.includes(recovered)) return { status: 'unauthorized_signer', config: null, reason: 'signer not in the trusted list' };
  const now = Date.parse(opts.now);
  if (Number.isNaN(now)) return { status: 'malformed', config: null, reason: 'opts.now is not a valid time' };
  if (now < Date.parse(table.validFrom)) return { status: 'not_yet_valid', config: null, reason: `valid from ${table.validFrom}` };
  if (now >= Date.parse(table.validUntil)) return { status: 'expired', config: null, reason: `valid until ${table.validUntil}` };
  const formula = opts.formula ?? CU_FORMULA_EXACT;
  if (!SUPPORTED_CU_FORMULAS.includes(formula)) return { status: 'malformed', config: null, reason: `unsupported formula ${formula}` };
  return {
    status: 'valid',
    config: { table, ref: cuWeightsV2Ref(table), formula, developmentProfile: false },
    reason: null,
  };
}

/**
 * Unsigned v2 body migrated from the static v1 tables in src/pricing/CostUnits.ts (same values,
 * same multiplicative meaning). The operator signs it; nothing here holds a production key.
 * Dated Anthropic snapshots previously mapped by weightModelKey() become explicit aliases.
 */
export function staticTablesAsV2Body(args: { version: string; validFrom: IsoTime; validUntil: IsoTime; signedBy: string;
  aliases?: Record<string, string> }): Omit<CuWeightsTableV2, 'signature'> {
  return {
    schema: 'otk.cu_weights.v2',
    version: args.version,
    validFrom: args.validFrom,
    validUntil: args.validUntil,
    providerWeightsMilli: { ...PROVIDER_WEIGHTS_INT },
    modelWeightsMilli: { ...MODEL_WEIGHTS_INT },
    aliases: { ...(args.aliases ?? DEFAULT_V2_ALIASES) },
    signedBy: args.signedBy,
  };
}

/**
 * Explicit aliases proposed with the migration: each one is a dated id documented by its
 * provider for a family already in the static table. Unknown ids are never guessed.
 */
export const DEFAULT_V2_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'gpt-4o-2024-05-13': 'gpt-4o',
  'gpt-4o-2024-08-06': 'gpt-4o',
  'gpt-4o-2024-11-20': 'gpt-4o',
  'gpt-4o-mini-2024-07-18': 'gpt-4o-mini',
  'gpt-4-turbo-2024-04-09': 'gpt-4-turbo',
  'claude-haiku-4-5-20251001': 'claude-haiku-4-5',
  'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5',
  'claude-opus-4-5-20251101': 'claude-opus-4-5',
});

/**
 * Development profile (D4 §1): the static tables, flagged developmentProfile = true and with a
 * version that says so. Never returned by loadCuWeights; callers must opt in explicitly.
 */
export function developmentCuConfig(formula: string = CU_FORMULA_EXACT): CuConfig {
  return developmentProfileConfig(DEV_PROFILE_HISTORICAL, formula);
}

/**
 * Versioned development profiles (FECHAMENTO_GEMINI_AD, DL-09). `development` is the historical one (same
 * version and digest as before, so operations admitted under it still resolve their weights). Each later
 * profile is the historical table plus explicit additions, with a version that says what was added. None of
 * them is calibrated: they are development weights, flagged developmentProfile = true in every result.
 */
export interface DevelopmentProfileSpec { version: string; extraModelWeightsMilli: Readonly<Record<string, bigint>>; note: string }
const DEV_PROFILE_HISTORICAL: DevelopmentProfileSpec = { version: 'dev-static-from-CostUnits.ts', extraModelWeightsMilli: {}, note: 'static tables of src/pricing/CostUnits.ts' };
export const DEVELOPMENT_PROFILES: Readonly<Record<string, DevelopmentProfileSpec>> = Object.freeze({
  development: DEV_PROFILE_HISTORICAL,
  // gemini-2.5-flash-lite inherits the weight of the same family already in the table (gemini-2.0-flash = 600):
  // no new economic judgement, NOT CALIBRATED; provider weight gemini = 900 already existed
  'development-2026-10-03': {
    version: 'dev-static-from-CostUnits.ts+gemini-2.5-flash-lite@2026-10-03',
    extraModelWeightsMilli: Object.freeze({ 'gemini-2.5-flash-lite': 600n }),
    note: 'historical table + gemini-2.5-flash-lite = gemini-2.0-flash family weight (600 milli); NOT CALIBRATED',
  },
  // gemini-3.5-flash-lite (author decision 2026-10-04): same flash-lite family weight (600); no new economic judgement,
  // NOT CALIBRATED (its price is higher than 2.5's, but CU measures consumption, not money)
  'development-2026-10-04': {
    version: 'dev-static-from-CostUnits.ts+gemini-2.5-flash-lite+gemini-3.5-flash-lite@2026-10-04',
    extraModelWeightsMilli: Object.freeze({ 'gemini-2.5-flash-lite': 600n, 'gemini-3.5-flash-lite': 600n }),
    note: 'development-2026-10-03 + gemini-3.5-flash-lite = flash-lite family weight (600 milli); NOT CALIBRATED',
  },
});

export function developmentProfileConfig(spec: DevelopmentProfileSpec, formula: string = CU_FORMULA_EXACT): CuConfig {
  const base = staticTablesAsV2Body({
    version: spec.version,
    validFrom: '2000-01-01T00:00:00.000Z',
    validUntil: '2100-01-01T00:00:00.000Z',
    signedBy: '0x0000000000000000000000000000000000000000',
  });
  const body = { ...base, modelWeightsMilli: { ...base.modelWeightsMilli, ...spec.extraModelWeightsMilli } };
  const table: CuWeightsTableV2 = { ...body, signature: 'unsigned-development-profile' };
  return { table, ref: cuWeightsV2Ref(table), formula, developmentProfile: true };
}
