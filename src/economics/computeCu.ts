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
 *
 * Callers include the operation and proxy paths in `src/operations/`, `src/pricing/reservation.ts`,
 * `src/providers/d1d8Measurement.ts` and the SDK (`computeCuFromTotals`). The weights come from a `CuConfig`
 * built by `cuWeightsV2.ts` / `cuWeightsRuntimeV2.ts`. Pure: no I/O, no clock, no environment variables.
 *
 * @module src/economics/computeCu
 */
import type { CuResult, NormalizedUsage, Scaled } from '../types/d1d8/index.js';
import type { CuConfig } from '../types/d1d8/index.js';
import { CU_FORMULA_EXACT, CU_FORMULA_LEGACY, SUPPORTED_CU_FORMULAS } from './cuWeightsV2.js';

const MICRO = 1_000_000n;
const MAX_UINT64 = (1n << 64n) - 1n;

/** Result of looking up the provider and model weights in a v2 table. */
export interface CuWeightResolution {
  /** Provider id, trimmed and lower-cased. */
  providerKey: string;
  /** Table key used for the model (the id itself or its alias target); null when unknown. */
  modelKey: string | null;
  /** Provider weight in milli units; null when the provider is not in the table. */
  wProviderMilli: bigint | null;
  /** Model weight in milli units; null when the model is not in the table. */
  wModelMilli: bigint | null;
}

/**
 * Resolve weights by provider and model id through the table's explicit aliases (lowercase).
 *
 * @param cfg - Validated weights configuration.
 * @param provider - Provider id (case and surrounding spaces ignored).
 * @param model - Model id (case and surrounding spaces ignored).
 * @returns The keys used and the weights found (null for each one not found).
 */
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

/**
 * Exact or legacy CU value for given totals and weights (no validation of origin).
 *
 * @param formula - `CU_MULT_v2_micro` (exact, scale 10^6) or `CU_MODEL_v1` (rounded, scale 1).
 * @param tIn - Input tokens.
 * @param tOut - Output tokens.
 * @param wModelMilli - Model weight in milli units.
 * @param wProviderMilli - Provider weight in milli units.
 * @returns The CU as `{ units, scale }` (value = units / scale).
 * @throws {Error} When `formula` is neither supported formula.
 */
export function cuFromTotals(formula: string, tIn: bigint, tOut: bigint, wModelMilli: bigint, wProviderMilli: bigint): Scaled {
  const product = (tIn + tOut) * wModelMilli * wProviderMilli;
  if (formula === CU_FORMULA_EXACT) return { units: product, scale: MICRO };
  if (formula === CU_FORMULA_LEGACY) return { units: (product * 2n + MICRO) / (MICRO * 2n), scale: 1n };
  throw new Error(`unsupported CU formula ${formula}`);
}

/** Options of `computeCu`. */
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
 *
 * Never throws for bad input: the result `status` says why `cu` is null (`invalid_config`,
 * `usage_not_computable` for missing tokens, refused completeness or a value above uint64, `unsupported_model`).
 *
 * @param usage - Normalized usage of one provider call.
 * @param cfg - Validated weights configuration.
 * @param opts - Which completeness values are accepted (default only `complete`).
 * @returns The CU result with the weights, formula and table reference used.
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
 *
 * An invalid total gives a `usage_not_computable` result (the pseudo-usage is marked `partial`).
 *
 * @param args - Provider, model and token totals.
 * @param cfg - Validated weights configuration.
 * @returns The CU result, as `computeCu` returns it.
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

/**
 * Render a Scaled CU as a decimal string without loss (e.g. 400000/10^6 → "0.4").
 *
 * Assumes `scale` is a power of ten (1, 10^6).
 *
 * @param s - Scaled value.
 * @returns Decimal text without trailing zeros.
 */
export function scaledToDecimal(s: Scaled): string {
  const neg = s.units < 0n;
  const u = neg ? -s.units : s.units;
  const digits = s.scale.toString().length - 1;
  const intPart = u / s.scale;
  const frac = (u % s.scale).toString().padStart(digits, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${intPart}${frac ? `.${frac}` : ''}`;
}
