/**
 * D1–D8 / C — server-side CU for entry points whose token totals are known (POST /receipts,
 * SDK normalizer, legacy proxy receipt). D5-G04: the client's `costUnits` never decides a debit.
 *
 * Default in this branch: the legacy exact integer formula already in the COMMON
 * (`calculateCostUnitsV1`, CU_MODEL_v1 = round half up of (tIn + tOut) × W_m × W_p, no public
 * bucket). S4 replaces it with B's `computeCuFromTotals` (micro-CU, signed weights v2) through
 * setKnownCuCalculator(); the legacy integer receipts keep their own formula id.
 *
 * Holds one process-wide calculator (module state). `bootstrapD1D8.ts` installs the weights-based one at
 * startup of the durable profile; otherwise the legacy calculator stays. No function here throws: failures
 * are returned as a status with `costUnits: null` (never zero).
 *
 * @module src/operations/knownCu
 */
import { calculateCostUnitsV1, weightModelKey } from '../pricing/CostUnits.js';

/** Result of a known-CU computation: an integer CU with the formula and weights used, or why it failed. */
export type KnownCu =
  /** `weights`: id of the weights actually used (stamped as cwVersion; S0-F01b). */
  | { status: 'computed'; costUnits: number; formula: string; weights: string }
  | { status: 'unsupported_model' | 'usage_not_computable'; costUnits: null; formula: string; detail: string };

/** Token totals of one call (tokens; must be non-negative safe integers). */
export interface KnownCuInput { provider: string; model: string; inputTokens: number; outputTokens: number }
/** A function from token totals to a {@link KnownCu} result. */
export type KnownCuCalculator = (input: KnownCuInput) => KnownCu;

/** Formula id stamped on legacy integer receipts. */
export const LEGACY_CU_FORMULA = 'CU_MODEL_v1';
/** The legacy calculator uses the static weight tables of src/pricing/CostUnits.ts. */
export const LEGACY_CU_WEIGHTS = 'static';

/**
 * Legacy exact integer CU (dated Anthropic ids use their family's weights, N8).
 *
 * @param root0 - Token totals of the call (provider, model, inputTokens, outputTokens).
 * @returns `computed` with whole CU and weights `static`; `unsupported_model` for an unknown provider/model;
 *   `usage_not_computable` for invalid counts or a CU above `Number.MAX_SAFE_INTEGER`.
 */
export const legacyKnownCu: KnownCuCalculator = ({ provider, model, inputTokens, outputTokens }) => {
  if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || inputTokens < 0 || outputTokens < 0) {
    return { status: 'usage_not_computable', costUnits: null, formula: LEGACY_CU_FORMULA, detail: 'token counts must be non-negative integers' };
  }
  try {
    const cu = calculateCostUnitsV1({ provider, model: weightModelKey(provider, model), inputTokens, outputTokens });
    if (cu > BigInt(Number.MAX_SAFE_INTEGER)) return { status: 'usage_not_computable', costUnits: null, formula: LEGACY_CU_FORMULA, detail: 'CU out of range' };
    return { status: 'computed', costUnits: Number(cu), formula: LEGACY_CU_FORMULA, weights: LEGACY_CU_WEIGHTS };
  } catch (err) {
    const code = (err as { code?: string }).code ?? '';
    const status = code === 'CU_UNKNOWN_PROVIDER' || code === 'CU_UNKNOWN_MODEL' ? 'unsupported_model' : 'usage_not_computable';
    return { status, costUnits: null, formula: LEGACY_CU_FORMULA, detail: err instanceof Error ? err.message : String(err) };
  }
};

let _calculator: KnownCuCalculator = legacyKnownCu;

/**
 * Integration point for S4 (B's computeCuFromTotals). Returns the previous calculator.
 *
 * @param fn - The calculator to use from now on, process-wide.
 * @returns The calculator that was active before (tests restore it).
 */
export function setKnownCuCalculator(fn: KnownCuCalculator): KnownCuCalculator {
  const prev = _calculator;
  _calculator = fn;
  return prev;
}

/**
 * Computes the server-side CU of known token totals with the currently installed calculator.
 *
 * @param input - Provider, model and token totals.
 * @returns The CU result; on failure `costUnits` is `null` with a status and detail.
 */
export function computeKnownCu(input: KnownCuInput): KnownCu {
  return _calculator(input);
}

/**
 * S4: B's computeCuFromTotals over the ACTIVE signed weights table, with the legacy integer
 * formula (CU_MODEL_v1) because these entry points produce integer legacy receipts (v1/v2
 * circuits). The receipt is stamped with the version of the table actually used (S0-F01b). No
 * active table → not computable (the request is refused, never priced with silent constants).
 *
 * @param active - Returns the active weights table, or `null`; called on every computation.
 * @param computeCuFromTotals - The CU function to apply with the table (the formula is forced to the legacy id).
 * @returns A calculator whose `weights` field is `<version>@<digest>` of the table used.
 */
export function knownCuFromWeights(active: () => import('../types/d1d8/index.js').CuConfig | null,
  computeCuFromTotals: (a: { provider: string; model: string; tIn: number | bigint; tOut: number | bigint }, cfg: import('../types/d1d8/index.js').CuConfig) => import('../types/d1d8/index.js').CuResult): KnownCuCalculator {
  return ({ provider, model, inputTokens, outputTokens }) => {
    const cfg = active();
    if (!cfg) return { status: 'usage_not_computable', costUnits: null, formula: LEGACY_CU_FORMULA, detail: 'no valid CU weights table is active' };
    if (!Number.isSafeInteger(inputTokens) || !Number.isSafeInteger(outputTokens) || inputTokens < 0 || outputTokens < 0) {
      return { status: 'usage_not_computable', costUnits: null, formula: LEGACY_CU_FORMULA, detail: 'token counts must be non-negative integers' };
    }
    const r = computeCuFromTotals({ provider, model, tIn: inputTokens, tOut: outputTokens }, { ...cfg, formula: LEGACY_CU_FORMULA });
    if (r.status !== 'computed' || !r.cu) {
      return { status: r.status === 'unsupported_model' ? 'unsupported_model' : 'usage_not_computable', costUnits: null, formula: LEGACY_CU_FORMULA, detail: r.status };
    }
    if (r.cu.units > BigInt(Number.MAX_SAFE_INTEGER)) return { status: 'usage_not_computable', costUnits: null, formula: LEGACY_CU_FORMULA, detail: 'CU out of range' };
    return { status: 'computed', costUnits: Number(r.cu.units), formula: LEGACY_CU_FORMULA, weights: `${cfg.ref.version}@${cfg.ref.digest}` };
  };
}
