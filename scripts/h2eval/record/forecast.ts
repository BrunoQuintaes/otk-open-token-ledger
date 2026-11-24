/**
 * E1 (R10 rev. 3 §5.5): the ex-ante forecast block written into the pre-call snapshot BEFORE egress and never touched again.
 * Shapes and arithmetic follow runs/R25_PREP/analysis/lib/forecast.mjs (ECON-02) so the analysis can recompute each value from the
 * frozen table and the snapshot and flag FORECAST_RECORD_MISMATCH on any divergence:
 *   - IN_M0 = L0 (counter), OUT_MAX = maxTokens, COST_MAXOUT = L0·p_in + maxTokens·p_out  (always derivable, no table needed)
 *   - OUT_MEAN = meanByCell[cellId] ?? modelMeanOutput ; OUT_LEARN = clip(w·features, maxTokens) ; COST_SIMPLE / COST_LEARN ;
 *     intervals = cost·(1+q05) .. cost·(1+q95)  — only with a frozen table whose status for the model is OK
 *   - money: costPicoFrac(tokens, micro) = (round(tokens·1000) · micro + 500) / 1000 pico-USD, written as "I.FFFFFFFFFFFF" (12 decimals)
 * Premise: NO cache (full input price). Missing table / counts ⇒ the corresponding field is 'NAO_REGISTRADA' (never filled later).
 */
import type { Count, OperationPlan, PicoUsd } from '../types.js';

export const FORECAST_LABEL = Object.freeze({ registered: 'EX_ANTE_REGISTRADA', none: 'NAO_REGISTRADA' } as const);
export type ForecastLabel = (typeof FORECAST_LABEL)[keyof typeof FORECAST_LABEL];
export type UsdStr12 = string; // "I.FFFFFFFFFFFF"

export interface ForecastFrozenModel { status: string; modelMeanOutput?: number; meanByCell?: Record<string, number>; ridge?: { weights: number[]; features: string[] }; intervalSimple?: { qlo: number; qhi: number; n: number } | null; intervalLearn?: { qlo: number; qhi: number; n: number } | null }
/** ECON-02 `forecast_frozen.json` (schema h2eval.forecast_frozen.v0). */
export interface ForecastFrozen { schema: string; fittedOn?: string; holdoutRead?: boolean; perModel: Record<string, ForecastFrozenModel>; freezeSha256: string }

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
export const taskGroup = (t: string): string => (t === 'summary' ? 'summary' : /^code/.test(t) ? 'code' : t === 'analysis' ? 'analysis' : 'other');
export const features = (r: { L0: number; maxTokens: number; sizeBucket: string; task: string; structure: string }): number[] => [1, r.L0 / 1000, r.maxTokens / 256, r.sizeBucket === 'L' ? 1 : 0, taskGroup(r.task) === 'code' ? 1 : 0, taskGroup(r.task) === 'analysis' ? 1 : 0, r.structure === 'S2' ? 1 : 0, r.structure === 'S3' ? 1 : 0];
const r6 = (x: number): number => Math.round(x * 1e6) / 1e6;
const clip = (x: number, hi: number): number => Math.max(0, Math.min(hi, x));
/** identical to ECON-02 costPicoFrac: tokens may be fractional (means); micro = micro-USD per MTok */
export const costPicoFrac = (tokens: number, micro: bigint): bigint => (BigInt(Math.round(tokens * 1000)) * micro + 500n) / 1000n;
export const picoToStr12 = (v: bigint): UsdStr12 => { const s = v.toString().padStart(13, '0'); return `${s.slice(0, -12)}.${s.slice(-12)}`; };
export const str12ToPico = (s: string): bigint | null => (/^\d+\.\d{12}$/.test(s) ? BigInt(s.replace('.', '')) : null);

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
