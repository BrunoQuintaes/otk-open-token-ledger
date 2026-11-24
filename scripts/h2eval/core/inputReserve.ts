/**
 * C158 §3.2 — conservative INPUT RESERVE policy (ECON-02, SUBESTIMACAO_TOKENS_R2.md §3), as a configurable PRE-SEND gate.
 *
 * The local counter (cl100k) under-estimates the 5.5 family systematically (median U/L0 ~1.5). ECON-02 proposes a reserve curve fitted on CAL-ANTH-01 only
 * (train + validation): R-A = k*L0 + c with k = 1.815, c = 14, times a margin (1.03 default, 1.05 for a new model/generation). This module holds the curve and the
 * decision; the runner applies it as a gate: when the policy is configured, an operation whose PLANNED reservation bound is below the policy bound is refused BEFORE
 * anything is reserved or sent (STOP_INPUT_RESERVE_POLICY). It never raises a reservation silently (plans are frozen by hash: a plan that fails the gate is rebuilt, a human act).
 *
 * NOT active by default (no policy configured => behaviour identical to before). It can only make the executor stop EARLIER, never spend more. H1 is untouched.
 * Pure integer arithmetic (no floating rounding surprises). Offline; no I/O.
 */
export type InputReservePolicyId = 'R-A-1.03' | 'R-A-1.05';
export interface InputReservePolicy {
  id: InputReservePolicyId;
  /** what to do when L0 is outside the MEASURED range of the model (ECON-02 A3/A4: extrapolation): STOP (default) or ALLOW (explicit human choice, e.g. with a probe-first batch) */
  outsideMeasuredRange?: 'STOP' | 'ALLOW';
}
export const POLICY_ID_LIST: readonly InputReservePolicyId[] = ['R-A-1.03', 'R-A-1.05'];

const K_MILLI = 1815n; const C_TOKENS = 14n; const FLOOR_TOKENS = 37; // reserve of R-A x1.03 at L0 = 12 (ECON-02 §3 rule 2)
const MARGIN_CENTI: Record<InputReservePolicyId, bigint> = { 'R-A-1.03': 103n, 'R-A-1.05': 105n };
/** ECON-02 §4 (A3/A4): the range of L0 where the curve was measured. The 4.5 generation, GPT and Gemini are NOT covered by this policy (gate not applicable). */
const MEASURED_L0: Record<string, { min: number; max: number }> = {
  'claude-haiku-5-5': { min: 12, max: 5705 },
  'claude-sonnet-5-5': { min: 12, max: 810 },
  'claude-opus-5-5': { min: 12, max: 810 },
};

/** ceil(margin * (1.815*L0 + 14)) with the floor of 37 tokens; integers only */
export function policyBoundTokens(id: InputReservePolicyId, L0: number): number {
  if (!Number.isInteger(L0) || L0 < 0) throw new RangeError('L0 must be a non-negative integer');
  const num = MARGIN_CENTI[id] * (K_MILLI * BigInt(L0) + C_TOKENS * 1000n); // x 100 x 1000
  const den = 100_000n; const ceil = (num + den - 1n) / den;
  return Math.max(FLOOR_TOKENS, Number(ceil));
}
export function isPolicyModel(model: string): boolean { return model in MEASURED_L0; }
/** the measured L0 range of a table model, or null (used by the model probe) */
export function measuredRangeOf(model: string): { min: number; max: number } | null { return isPolicyModel(model) ? MEASURED_L0[model]! : null; }
/** BOT-01 P09/P15 (allowlist, not a pattern list): with the policy on, EVERY anthropic model outside the measured table is refused unless it is in this explicit exemption list (the 4.5 generation of the matrix). Aliases, snapshots, other separators/case, unknown families: all STOP. */
const EXEMPT_ANTHROPIC_MODELS: ReadonlySet<string> = new Set(['claude-haiku-4-5-20251001']);
export function isExemptFromPolicy(provider: string, model: string): boolean { return provider !== 'anthropic' || EXEMPT_ANTHROPIC_MODELS.has(model); }

/** the explicit choice of a run: a policy, or the deliberate `none` (registered in every RESERVED line as reservePolicy: 'none') */
export type InputReserveChoice = InputReservePolicy | 'none';
/**
 * MET-02 R4(a): a policy that is only an optional flag is silently off when forgotten. In a REAL campaign the choice must be explicit (a policy or a deliberate `none`), and every RESERVED line of the
 * batch journal must carry it: declared `none` => 'none'; declared policy => the policy id for the 5.5 models and 'NOT_APPLICABLE' for the exempt ones. Returns the offending operation ids.
 */
export function reservePolicyMismatches(lines: ReadonlyArray<{ kind: string; operationId: string; body: Record<string, unknown> }>, declared: InputReserveChoice): string[] {
  const model = new Map<string, string>(); for (const l of lines) if (l.kind === 'PLANNED') model.set(l.operationId, String(l.body['modelRequested'] ?? ''));
  const bad: string[] = [];
  for (const l of lines) {
    if (l.kind !== 'RESERVED') continue; const got = l.body['reservePolicy'];
    const want = declared === 'none' ? 'none' : isPolicyModel(model.get(l.operationId) ?? '') ? declared.id : 'NOT_APPLICABLE';
    if (got !== want) bad.push(l.operationId);
  }
  return bad;
}

export type ReserveGateDecision =
  | { stop: false; applicable: boolean; policyBoundTokens?: number; extrapolated?: boolean }
  | { stop: true; reason: 'MODEL_NOT_IN_POLICY_TABLE' | 'L0_UNKNOWN' | 'TOOLS_PRESENT' | 'RESERVE_BELOW_POLICY' | 'OUTSIDE_MEASURED_RANGE'; policyBoundTokens?: number; detail: string };

/** the gate decision for ONE operation (pure). `plannedBound` is the input upper bound the reservation will be priced with. */
export function evaluateInputReserve(policy: InputReservePolicy | undefined, o: { provider: string; model: string; L0: number | 'UNKNOWN'; plannedBound: number; hasTools: boolean; /** a configured model probe covers the unmeasured model / the outside-range length: they are judged by the probe instead of being refused here */ probeCovers?: boolean }): ReserveGateDecision {
  if (!policy) return { stop: false, applicable: false };
  if (!isPolicyModel(o.model)) {
    if (!isExemptFromPolicy(o.provider, o.model) && !o.probeCovers) return { stop: true, reason: 'MODEL_NOT_IN_POLICY_TABLE', detail: `anthropic model ${JSON.stringify(o.model)} is neither in the measured table nor in the explicit exemption list: no silent exemption` };
    return { stop: false, applicable: false }; // Haiku 4.5 (listed), GPT, Gemini: unchanged
  }
  if (o.hasTools) return { stop: true, reason: 'TOOLS_PRESENT', detail: 'no measurement with tools in any source (ECON-02 A6): no paid call with tools under this policy' };
  if (o.L0 === 'UNKNOWN') return { stop: true, reason: 'L0_UNKNOWN', detail: 'local count unavailable: the reserve curve cannot be evaluated (UNKNOWN is never zero)' };
  const range = MEASURED_L0[o.model]!; const outside = o.L0 < range.min || o.L0 > range.max;
  if (outside && (policy.outsideMeasuredRange ?? 'STOP') === 'STOP' && !o.probeCovers) return { stop: true, reason: 'OUTSIDE_MEASURED_RANGE', detail: `L0 ${o.L0} outside the measured range ${range.min}..${range.max} of ${o.model}` };
  const bound = policyBoundTokens(policy.id, o.L0);
  if (o.plannedBound < bound) return { stop: true, reason: 'RESERVE_BELOW_POLICY', policyBoundTokens: bound, detail: `planned input bound ${o.plannedBound} < ${policy.id} bound ${bound} for L0 ${o.L0}` };
  return { stop: false, applicable: true, policyBoundTokens: bound, extrapolated: outside };
}
