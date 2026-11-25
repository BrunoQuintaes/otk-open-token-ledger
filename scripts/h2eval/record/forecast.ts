/**
 * E1 (R10 rev. 3 §5.5): the ex-ante forecast block written into the pre-call snapshot BEFORE egress and never touched again.
 * Shapes and arithmetic follow runs/R25_PREP/analysis/lib/forecast.mjs (ECON-02) so the analysis can recompute each value from the
 * frozen table and the snapshot and flag FORECAST_RECORD_MISMATCH on any divergence:
 *   - IN_M0 = L0 (counter), OUT_MAX = maxTokens, COST_MAXOUT = L0·p_in + maxTokens·p_out  (always derivable, no table needed)
 *   - OUT_MEAN = meanByCell[cellId] ?? modelMeanOutput ; OUT_LEARN = clip(w·features, maxTokens) ; COST_SIMPLE / COST_LEARN ;
 *     intervals = cost·(1+q05) .. cost·(1+q95)  — only with a frozen table whose status for the model is OK
 *   - money: costPicoFrac(tokens, micro) = (round(tokens·1000) · micro + 500) / 1000 pico-USD, written as "I.FFFFFFFFFFFF" (12 decimals)
 * Premise: NO cache (full input price). Missing table / counts ⇒ the corresponding field is 'NAO_REGISTRADA' (never filled later).
 *
 * Called by `core/runner.ts` while it builds the pre-call snapshot. Pure: no I/O.
 *
 * @module scripts/h2eval/record/forecast
 */
import type { Count, OperationPlan, PicoUsd } from '../types.js';

/** Labels of a forecast block: `EX_ANTE_REGISTRADA` (recorded before the call) or `NAO_REGISTRADA` (not recorded). */
export const FORECAST_LABEL = Object.freeze({ registered: 'EX_ANTE_REGISTRADA', none: 'NAO_REGISTRADA' } as const);
/** One of the {@link FORECAST_LABEL} values. */
export type ForecastLabel = (typeof FORECAST_LABEL)[keyof typeof FORECAST_LABEL];
/** USD amount as text with exactly 12 decimals (integer pico-USD), for example `"0.000123456789"`. */
export type UsdStr12 = string; // "I.FFFFFFFFFFFF"

/**
 * Frozen forecast model of one provider model: `status` must be `OK` to be used; mean output tokens (overall and per
 * cell); a linear (ridge) model over fixed features; relative error quantiles for the intervals (`null` = none).
 */
export interface ForecastFrozenModel { status: string; modelMeanOutput?: number; meanByCell?: Record<string, number>; ridge?: { weights: number[]; features: string[] }; intervalSimple?: { qlo: number; qhi: number; n: number } | null; intervalLearn?: { qlo: number; qhi: number; n: number } | null }
/** ECON-02 `forecast_frozen.json` (schema h2eval.forecast_frozen.v0). */
export interface ForecastFrozen { schema: string; fittedOn?: string; holdoutRead?: boolean; perModel: Record<string, ForecastFrozenModel>; freezeSha256: string }

/**
 * Forecast block stored in the snapshot. Token fields are tokens; cost fields are {@link UsdStr12}; any field that
 * could not be computed is `'NAO_REGISTRADA'`. `priceMicroPerMTok` holds the prices used, in micro-USD per million tokens.
 */
export interface ForecastRecord {
  label: ForecastLabel;
  premise: 'NO_CACHE_FULL_INPUT_PRICE';
  inM0: Count;
  outMax: number;
  costMaxOut: UsdStr12 | 'NAO_REGISTRADA';
  outMean: number | 'NAO_REGISTRADA';
  outLearn: number | 'NAO_REGISTRADA';
  costSimple: UsdStr12 | 'NAO_REGISTRADA';
  costLearn: UsdStr12 | 'NAO_REGISTRADA';
  intervalSimple: { lo: UsdStr12; hi: UsdStr12 } | 'NAO_REGISTRADA';
  intervalLearn: { lo: UsdStr12; hi: UsdStr12 } | 'NAO_REGISTRADA';
  frozenSha256: string | 'NAO_REGISTRADA';
  priceMicroPerMTok: { input: string | 'UNKNOWN'; output: string | 'UNKNOWN' };
}

const EXPECTED_FEATURES = ['1', 'L0/1000', 'maxTokens/256', 'isL', 'isCode', 'isAnalysis', 'isS2', 'isS3'];
/**
 * Groups a task name for the forecast features.
 *
 * @param t - Task name.
 * @returns `summary`, `code` (any task starting with `code`), `analysis` or `other`.
 */
export const taskGroup = (t: string): string => (t === 'summary' ? 'summary' : /^code/.test(t) ? 'code' : t === 'analysis' ? 'analysis' : 'other');
/**
 * Feature vector of the linear output model, in the fixed order
 * `1, L0/1000, maxTokens/256, isL, isCode, isAnalysis, isS2, isS3`.
 *
 * @param r - Local input count `L0` (tokens), output ceiling, size bucket, task and structure of the operation.
 * @returns The 8 feature values.
 */
export const features = (r: { L0: number; maxTokens: number; sizeBucket: string; task: string; structure: string }): number[] => [1, r.L0 / 1000, r.maxTokens / 256, r.sizeBucket === 'L' ? 1 : 0, taskGroup(r.task) === 'code' ? 1 : 0, taskGroup(r.task) === 'analysis' ? 1 : 0, r.structure === 'S2' ? 1 : 0, r.structure === 'S3' ? 1 : 0];
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const clip = (x: number, hi: number): number => Math.max(0, Math.min(hi, x));
/**
 * identical to ECON-02 costPicoFrac: tokens may be fractional (means); micro = micro-USD per MTok
 *
 * @param tokens - Token count, possibly fractional (rounded to thousandths).
 * @param micro - Price in micro-USD per million tokens.
 * @returns Cost in pico-USD, rounded half up.
 */
export const costPicoFrac = (tokens: number, micro: bigint): bigint => (BigInt(Math.round(tokens * 1000)) * micro + 500n) / 1000n;
/**
 * Formats pico-USD as a USD string with 12 decimals.
 *
 * @param v - Amount in pico-USD (>= 0).
 * @returns For example `1234567n` gives `"0.000001234567"`.
 */
export const picoToStr12 = (v: bigint): UsdStr12 => { const s = v.toString().padStart(13, '0'); return `${s.slice(0, -12)}.${s.slice(-12)}`; };
/**
 * Parses a {@link UsdStr12} back to pico-USD.
 *
 * @param s - Text with digits, a dot and exactly 12 decimals.
 * @returns The amount in pico-USD, or `null` when the text is not in that form.
 */
export const str12ToPico = (s: string): bigint | null => (/^\d+\.\d{12}$/.test(s) ? BigInt(s.replace('.', '')) : null);

/**
 * Builds the ex-ante forecast block of one operation.
 *
 * @param plan - Operation plan (output ceiling, cell, model, task, size, structure).
 * @param L0 - Local input token count, or `'UNKNOWN'`/`'NOT_APPLICABLE'`.
 * @param microInput - Input price in micro-USD per million tokens, or `null` when unknown.
 * @param microOutput - Output price in micro-USD per million tokens, or `null` when unknown.
 * @param frozen - Frozen forecast models, or `null`/`undefined` when none was given.
 * @returns The block; without a count or prices nothing is costed, and without a usable frozen model only
 *   `costMaxOut` is filled (label stays `NAO_REGISTRADA`).
 */
export function buildForecast(plan: OperationPlan, L0: Count, microInput: bigint | null, microOutput: bigint | null, frozen: ForecastFrozen | null | undefined): ForecastRecord {
  const maxTokens = plan.params.maxTokens;
  const base: ForecastRecord = { label: FORECAST_LABEL.none, premise: 'NO_CACHE_FULL_INPUT_PRICE', inM0: L0, outMax: maxTokens, costMaxOut: 'NAO_REGISTRADA', outMean: 'NAO_REGISTRADA', outLearn: 'NAO_REGISTRADA', costSimple: 'NAO_REGISTRADA', costLearn: 'NAO_REGISTRADA', intervalSimple: 'NAO_REGISTRADA', intervalLearn: 'NAO_REGISTRADA', frozenSha256: 'NAO_REGISTRADA', priceMicroPerMTok: { input: microInput === null ? 'UNKNOWN' : microInput.toString(), output: microOutput === null ? 'UNKNOWN' : microOutput.toString() } };
  if (typeof L0 !== 'number' || microInput === null || microOutput === null) return base;
  const cost = (outTokens: number): bigint => costPicoFrac(L0, microInput) + costPicoFrac(outTokens, microOutput);
  base.costMaxOut = picoToStr12(cost(maxTokens));
  const fm = frozen?.perModel?.[plan.modelRequested];
  if (!frozen || !fm || fm.status !== 'OK' || typeof fm.modelMeanOutput !== 'number' || !fm.ridge || JSON.stringify(fm.ridge.features) !== JSON.stringify(EXPECTED_FEATURES) || fm.ridge.weights.length !== EXPECTED_FEATURES.length) return base;
  const om = fm.meanByCell?.[plan.cellId] ?? fm.modelMeanOutput;
  const f = features({ L0, maxTokens, sizeBucket: plan.sizeBucket, task: plan.task, structure: plan.structure });
  const ol = clip(fm.ridge.weights.reduce((s, w, i) => s + w * f[i]!, 0), maxTokens);
  const cs = cost(om); const cl = cost(ol);
  const iv = (c: bigint, q: { qlo: number; qhi: number } | null | undefined) => (q ? { lo: picoToStr12(BigInt(Math.max(0, Math.round(Number(c) * (1 + q.qlo))))), hi: picoToStr12(BigInt(Math.round(Number(c) * (1 + q.qhi)))) } : ('NAO_REGISTRADA' as const));
  return { ...base, label: FORECAST_LABEL.registered, outMean: om, outLearn: r6(ol), costSimple: picoToStr12(cs), costLearn: picoToStr12(cl), intervalSimple: iv(cs, fm.intervalSimple), intervalLearn: iv(cl, fm.intervalLearn), frozenSha256: frozen.freezeSha256 };
}

export type { PicoUsd };
