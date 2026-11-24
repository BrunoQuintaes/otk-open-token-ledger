/**
 * CU computation from normalized usage (D5 §4–5, D5-G01/G04, S0-F01; front B).
 * Implements ComputeCuFn and EstimateReservationFn's CU part.
 *
 *   CU = (T_entrada + T_saida) × W_modelo × W_provedor
 *
 * Formulas (cfg.formula):
 *  - CU_MULT_v2_micro: units = (tIn + tOut) × Wm_milli × Wp_milli, scale = 10^6. Exact: weights
 *    are integer milli, so the product is an integer number of micro-CU and no rounding
 *    happens. 1 token of gpt-4o-mini/openai = 0.4 CU stays 0.4 CU (400000 / 10^6).
 *  - CU_MODEL_v1 (legacy, scale = 1): round half up of the same product / 10^6, exactly as
 *    calculateCostUnitsV1. Available to reinterpret history; it rounds 1 token × 0.4 to 0.
 * The public bucket (D2 §4, owned by A) is never applied here. Latency, price and benefit
 * have no input in this module.
 */
import type { CuResult, NormalizedUsage, Scaled } from '../types/d1d8/index.js';
import type { CuConfig } from '../types/d1d8/index.js';
import { CU_FORMULA_EXACT, CU_FORMULA_LEGACY, SUPPORTED_CU_FORMULAS } from './cuWeightsV2.js';

const MICRO = 1_000_000n;
const MAX_UINT64 = (1n << 64n) - 1n;

export interface CuWeightResolution {
  providerKey: string;
  modelKey: string | null;
  wProviderMilli: bigint | null;
  wModelMilli: bigint | null;
}

/** Resolve weights by provider and model id through the table's explicit aliases (lowercase). */
export function resolveCuWeights(cfg: CuConfig, provider: string, model: string): CuWeightResolution {
  const providerKey = provider.trim().toLowerCase();
  const m = model.trim().toLowerCase();
  // Own properties only: ids such as 'constructor' or '__proto__' must not reach the prototype.
  const own = <T>(o: Record<string, T>, k: string): T | null => (Object.hasOwn(o, k) ? o[k]! : null);
  const modelKey = own(cfg.table.modelWeightsMilli, m) !== null ? m : own(cfg.table.aliases, m);
  return {
    providerKey,
    modelKey,
    wProviderMilli: own(cfg.table.providerWeightsMilli, providerKey),
    wModelMilli: modelKey ? own(cfg.table.modelWeightsMilli, modelKey) : null,
  };
}

/** Exact or legacy CU value for given totals and weights (no validation of origin). */
export function cuFromTotals(formula: string, tIn: bigint, tOut: bigint, wModelMilli: bigint, wProviderMilli: bigint): Scaled {
  const product = (tIn + tOut) * wModelMilli * wProviderMilli;
  if (formula === CU_FORMULA_EXACT) return { units: product, scale: MICRO };
  if (formula === CU_FORMULA_LEGACY) return { units: (product * 2n + MICRO) / (MICRO * 2n), scale: 1n };
  throw new Error(`unsupported CU formula ${formula}`);
}

export interface ComputeCuOptions {
  /**
   * Which completeness values may produce a 'computed' CU. Default: only 'complete'.
   * 'partial' is for provisional figures (e.g. settlement display); the caller keeps the
   * usage completeness next to the result and never bills a partial value as final.
   */
  acceptCompleteness?: ReadonlyArray<NormalizedUsage['completeness']>;
}

/**
 * ComputeCuFn. The model used for W_modelo is the one the provider returned (an observed fact)
 * and, only when absent, the requested one. A returned id that the table does not know is
 * 'unsupported_model' — the requested id is not substituted, so a model swap never takes the
 * cheaper weight silently.
 */
export function computeCu(usage: NormalizedUsage, cfg: CuConfig, opts: ComputeCuOptions = {}): CuResult {
  const accept = opts.acceptCompleteness ?? ['complete'];
  const model = usage.modelReturned ?? usage.modelRequested;
  const w = resolveCuWeights(cfg, usage.provider, model);
  const base: Omit<CuResult, 'status' | 'cu'> = {
    schema: 'otk.cu_result.v1',
    formula: cfg.formula,
    weights: cfg.ref,
    tIn: usage.tIn,
    tOut: usage.tOut,
    wModelMilli: w.wModelMilli,
    wProviderMilli: w.wProviderMilli,
    developmentProfile: cfg.developmentProfile,
  };
  if (!SUPPORTED_CU_FORMULAS.includes(cfg.formula)) return { ...base, status: 'invalid_config', cu: null };
  if (usage.tIn === null || usage.tOut === null || !accept.includes(usage.completeness)) {
    return { ...base, status: 'usage_not_computable', cu: null };
  }
  if (w.wModelMilli === null || w.wProviderMilli === null) return { ...base, status: 'unsupported_model', cu: null };
  const cu = cuFromTotals(cfg.formula, usage.tIn, usage.tOut, w.wModelMilli, w.wProviderMilli);
  if (cu.units > MAX_UINT64) return { ...base, status: 'usage_not_computable', cu: null };
  return { ...base, status: 'computed', cu };
}

/**
 * Same formula for paths that only have token totals (SDK defaultCostNormalizer, reconciliation).
 * Invalid totals (negative, fractional, unsafe) are refused, never coerced.
 */
export function computeCuFromTotals(args: { provider: string; model: string; tIn: number | bigint; tOut: number | bigint }, cfg: CuConfig): CuResult {
  const toBig = (v: number | bigint): bigint | null => {
    if (typeof v === 'bigint') return v >= 0n ? v : null;
    return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  };
  const tIn = toBig(args.tIn);
  const tOut = toBig(args.tOut);
  const pseudo: NormalizedUsage = {
    schema: 'otk.usage.v1',
    api: 'openai.chat_completions',
    provider: args.provider,
    modelRequested: args.model,
    modelReturned: null,
    providerRequestId: null,
    origin: 'client_declared',
    completeness: tIn !== null && tOut !== null ? 'complete' : 'partial',
    categories: [],
    tIn,
    tOut,
    tRule: 'totals_only',
    rawUsageDigest: '0x0000000000000000000000000000000000000000000000000000000000000000',
    normalizerVersion: 'computeCuFromTotals',
    docRef: { url: 'n/a', retrievedAt: '1970-01-01T00:00:00.000Z' },
    observedAt: '1970-01-01T00:00:00.000Z',
  };
  return computeCu(pseudo, cfg);
}

/** Render a Scaled CU as a decimal string without loss (e.g. 400000/10^6 → "0.4"). */
export function scaledToDecimal(s: Scaled): string {
  const neg = s.units < 0n;
  const u = neg ? -s.units : s.units;
  const digits = s.scale.toString().length - 1;
  const intPart = u / s.scale;
  const frac = (u % s.scale).toString().padStart(digits, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${intPart}${frac ? `.${frac}` : ''}`;
}
