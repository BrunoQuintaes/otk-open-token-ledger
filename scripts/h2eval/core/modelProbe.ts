/**
 * C158 — AUTOMATIC PROBE of a new model / of an unmeasured length region (ECON-02 §3 rules 3 and 4, made a blocking gate of the executor).
 *
 * When configured, the FIRST operation of a probe region is a PROBE: it is sent like any operation (same reservation, same ledger), but its measurement is judged and the batch STOPS if the
 * judgement fails (STOP_MODEL_PROBE_FAILED, HALT_ALL, no retry, latching in the batch journal). The remaining operations of that region run only after a journaled PASSED verdict.
 * Regions (anthropic only; the measured table is the Claude 5.5 one, see inputReserve.ts):
 *   UNMEASURED_MODEL — an anthropic model outside the measured table that is not in the explicit exemption list (a new model or generation);
 *   ABOVE_RANGE / BELOW_RANGE — a measured 5.5 model with L0 above / below the measured range of that model.
 * Not active by default (no `modelProbe` config => behaviour identical to before). The ratio limit has NO default: it is a number the operator chooses (UNKNOWN is never invented).
 * Pure functions; no I/O.
 *
 * In short: the first call of a model or length region that was never measured is sent alone; if its measured input
 * divided by the local estimate exceeds the operator's limit (or any needed fact is unknown), the batch stops before
 * more calls are spent. The runner (`./runner.ts`) journals MODEL_PROBE_STARTED / MODEL_PROBE_RESULT lines, which
 * {@link probeStateOf} reads back.
 *
 * @module scripts/h2eval/core/modelProbe
 */
import { isExemptFromPolicy, isPolicyModel, measuredRangeOf } from './inputReserve.js';

/** Model probe settings (no defaults). */
export interface ModelProbeConfig {
  /** blocking limit for measured input U divided by the local estimate L0 (e.g. 1.9); a probe whose ratio is above it FAILS */
  maxMeasuredToEstimatedRatio: number;
}
/** ABOVE_RANGE is split in BANDS that double the length (BOT-01 Q08): band k covers (max*2^k, max*2^(k+1)] of the model's measured maximum, each band has its own probe, so a probe never licenses more than twice its own length. */
export type ProbeRegion = 'UNMEASURED_MODEL' | 'BELOW_RANGE' | `ABOVE_RANGE_B${number}`;
/**
 * the upper bound of the band that contains L0 (L0 above the measured maximum `max`)
 *
 * @param max - Measured maximum local count of the model, in tokens.
 * @param L0 - Local count of the operation, above `max`.
 * @returns The band index k (0-based) and the largest local count that band licenses, `max * 2^(k+1)`.
 */
export function aboveRangeBand(max: number, L0: number): { band: number; licensedMaxLocalCount: number } { let k = 0; let hi = max * 2; while (L0 > hi) { hi *= 2; k += 1; } return { band: k, licensedMaxLocalCount: hi }; }

/**
 * Checks a probe configuration.
 *
 * @param c - The configuration.
 * @throws {RangeError} When the ratio limit is missing, not finite, or outside [1, 10].
 */
export function validateModelProbeConfig(c: ModelProbeConfig): void {
  if (!c || typeof c.maxMeasuredToEstimatedRatio !== 'number' || !Number.isFinite(c.maxMeasuredToEstimatedRatio) || c.maxMeasuredToEstimatedRatio < 1 || c.maxMeasuredToEstimatedRatio > 10) throw new RangeError('maxMeasuredToEstimatedRatio must be a finite number in [1, 10]');
}

/**
 * the probe region of an operation, null when the operation is not subject to a probe; 'L0_UNKNOWN' when it is but the local count is unavailable (the probe cannot be judged)
 *
 * @param provider - Provider id (only Anthropic models can need a probe).
 * @param model - Model id.
 * @param L0 - Local input count in tokens, or `UNKNOWN`.
 * @returns The region, `L0_UNKNOWN`, or `null`.
 */
export function probeRegionOf(provider: string, model: string, L0: number | 'UNKNOWN'): ProbeRegion | 'L0_UNKNOWN' | null {
  if (provider !== 'anthropic' || isExemptFromPolicy(provider, model)) return null;
  if (L0 === 'UNKNOWN') return 'L0_UNKNOWN'; // BOT-01 Q07: checked BEFORE the new-model region: a probe that cannot be judged is refused pre-send, never sent
  if (!isPolicyModel(model)) return 'UNMEASURED_MODEL';
  const r = measuredRangeOf(model)!;
  return L0 > r.max ? (`ABOVE_RANGE_B${aboveRangeBand(r.max, L0).band}` as ProbeRegion) : L0 < r.min ? 'BELOW_RANGE' : null;
}
/**
 * Key that identifies a probe region in the journal.
 *
 * @param provider - Provider id.
 * @param model - Model id.
 * @param region - Probe region.
 * @returns `<provider>|<model>|<region>`.
 */
export const probeKeyOf = (provider: string, model: string, region: ProbeRegion): string => `${provider}|${model}|${region}`;

/**
 * Usage facts of the probe response: `U` is the measured input tokens; output, reasoning and total output are token
 * counts (non-numbers mean unknown); `completion` and `tierServed` are the parsed completion state and service tier.
 */
export interface ProbeMeasurement { U: unknown; outputVisible: unknown; reasoning: unknown; outputTotal: unknown; completion: string; tierServed: string }
/** Probe verdict: PASSED only when `reasons` is empty; `ratio` is U / L0, or `UNKNOWN`. */
export interface ProbeVerdict { verdict: 'PASSED' | 'FAILED'; reasons: string[]; ratio: number | 'UNKNOWN' }
/**
 * E1HR (C160, HAIKU-R-FIX; opcao (b) do X1 do kit HAIKU-R, B2): facts of the probe RESPONSE, used ONLY to admit a probe whose completion is not COMPLETE.
 * The probe measures the INPUT (U/L0 and U vs the reservation); a refusal WITH complete usage (REFUSAL_WITH_USAGE as in the HAIKU-R protocol 48befe37 §5.1) or an output truncated by max_tokens
 * with complete usage carries the same input measurement, so it does not fail the probe. Every condition is required; anything else (or no context at all) keeps failing.
 */
export interface ProbeResponseContext { httpStatus: number | 'UNKNOWN'; outcome: string; stopReason: string; usageCompleteness: string; modelServed: string; modelRequested: string; acceptedModels?: readonly string[]; costState: string; exclusion: string }
/**
 * E1HR: the conditions that a REFUSED / TRUNCATED_MAX_TOKENS probe misses (empty = admissible)
 *
 * @param completion - The non-complete state of the probe.
 * @param U - Measured input tokens, or `null` when unknown.
 * @param r - Facts of the probe response.
 * @returns Codes of the unmet conditions.
 */
function nonCompleteMisses(completion: 'REFUSED' | 'TRUNCATED_MAX_TOKENS', U: number | null, r: ProbeResponseContext): string[] {
  const m: string[] = [];
  const want = completion === 'REFUSED' ? { outcome: 'REFUSED_WITH_USAGE', stopReason: 'refusal' } : { outcome: 'OK', stopReason: 'max_tokens' };
  if (r.httpStatus !== 200) m.push(`HTTP_${r.httpStatus}`);
  if (r.outcome !== want.outcome) m.push(`OUTCOME_${r.outcome}`);
  if (r.stopReason !== want.stopReason) m.push(`STOP_REASON_${r.stopReason}`);
  if (r.usageCompleteness !== 'COMPLETE') m.push(`USAGE_${r.usageCompleteness}`);
  if (U === null || !(U > 0)) m.push('U_NOT_POSITIVE');
  const modelOk = r.modelServed !== 'UNKNOWN' && (r.acceptedModels && r.acceptedModels.length ? r.acceptedModels.includes(r.modelServed) : r.modelServed === r.modelRequested);
  if (!modelOk) m.push(`MODEL_SERVED_${r.modelServed}`);
  if (r.costState !== 'CALCULATED') m.push(`COST_${r.costState}`);
  if (r.exclusion !== 'NONE') m.push(`EXCLUSION_${r.exclusion}`);
  return m;
}
/**
 * judge ONE probe. Every unknown measurement that the verdict depends on FAILS (never assumed fine). `usage` null = the response carried no usable usage.
 *
 * @param o - Ratio limit, local count L0, reserved input bound (tokens), the usage facts, the requested service tier,
 *   the reasoning allowance (tokens) and, optionally, the response context that can admit a refused or truncated
 *   probe with complete usage.
 * @returns The verdict, with every failing reason.
 */
export function judgeProbe(o: { limit: number; L0: number | 'UNKNOWN'; reservedBound: number; usage: ProbeMeasurement | null; tierRequested: string; reasoningAllowance: number; response?: ProbeResponseContext }): ProbeVerdict {
  const reasons: string[] = [];
  if (typeof o.L0 !== 'number') return { verdict: 'FAILED', reasons: ['LOCAL_COUNT_UNKNOWN'], ratio: 'UNKNOWN' }; // BOT-01 Q07: never divide by an unknown count
  if (!o.usage) return { verdict: 'FAILED', reasons: ['USAGE_MISSING'], ratio: 'UNKNOWN' };
  const u = o.usage; const U = typeof u.U === 'number' ? u.U : null;
  let ratio: number | 'UNKNOWN' = 'UNKNOWN';
  if (U === null) reasons.push('INPUT_TOKENS_UNKNOWN'); else if (o.L0 <= 0) reasons.push('LOCAL_COUNT_NOT_POSITIVE'); else { ratio = U / o.L0; if (ratio > o.limit) reasons.push(`RATIO_ABOVE_LIMIT(${ratio.toFixed(4)}>${o.limit})`); }
  if (U !== null && U > o.reservedBound) reasons.push(`INPUT_ABOVE_RESERVATION(${U}>${o.reservedBound})`);
  if (u.completion === 'COMPLETE') { /* as before */ }
  else if ((u.completion === 'REFUSED' || u.completion === 'TRUNCATED_MAX_TOKENS') && o.response) { const m = nonCompleteMisses(u.completion, U, o.response); if (m.length) reasons.push(`COMPLETION_${u.completion}(${m.join(',')})`); } // E1HR
  else reasons.push(`COMPLETION_${u.completion}`);
  if (typeof u.reasoning === 'number' && u.reasoning > o.reasoningAllowance) reasons.push(`REASONING_ABOVE_ALLOWANCE(${u.reasoning}>${o.reasoningAllowance})`);
  if (o.tierRequested === 'standard_only' && u.tierServed !== 'UNKNOWN' && u.tierServed !== 'standard') reasons.push(`TIER_MISMATCH(${u.tierServed})`);
  return { verdict: reasons.length ? 'FAILED' : 'PASSED', reasons, ratio };
}

/**
 * probe state of a key in a batch journal: PASSED (licence), UNRESOLVED (started, no PASSED verdict: failed, interrupted or incomplete), NONE (no probe yet)
 *
 * @param lines - Journal lines of the batch.
 * @param key - Probe key from {@link probeKeyOf}.
 * @returns The probe state.
 */
export function probeStateOf(lines: ReadonlyArray<{ kind: string; operationId: string; body: Record<string, unknown> }>, key: string): 'NONE' | 'PASSED' | 'UNRESOLVED' {
  let started = false;
  for (const l of lines) {
    if (l.kind === 'MODEL_PROBE_RESULT' && l.body['key'] === key && l.body['verdict'] === 'PASSED') return 'PASSED';
    if (l.kind === 'MODEL_PROBE_STARTED' && l.body['key'] === key) started = true;
  }
  return started ? 'UNRESOLVED' : 'NONE';
}
