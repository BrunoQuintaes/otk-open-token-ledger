/**
 * OVERNIGHT 20261005 / Phase 8 — fits an otk.calibration_profile.v1 from (local count, provider count) pairs.
 *
 * Procedure (no step looks at the holdout before the profile is frozen):
 *   1. per category, affine least squares on the TRAIN split (models.ts), parameters rounded to 6 decimals; every
 *      metric is then computed with the rounded parameters and the runtime's integer arithmetic (expectedTokens);
 *   2. threshold from VALIDATION rows only: grid search of (absoluteTokens, relative) keeping a false-alert rate
 *      <= 1% on unaltered validation targets and maximizing detection of injected inflation (selectThreshold);
 *      the AND rule of the conference makes per-dimension quantiles (q0.99 each) almost blind, which an earlier
 *      draft of this script showed (detection 0 at +200 tokens on the synthetic holdout);
 *   3. holdout metrics (bias, MAE, max, relative-error quantiles with n, alert rate of the frozen threshold);
 *   4. acceptance policy otk.calibration_acceptance.v1 (minimum n per split, holdout groups, holdout false-alert
 *      rate and holdout detection power at +25%);
 *      calibrated = every check passed. Failing is a documented limitation, never a reason to relax a check.
 */
import type { ModelSupport, UsageApi } from '../../src/types/d1d8/index.js';
import {
  CALIBRATION_PROFILE_SCHEMA, expectedTokens, numberToDecimal6, sealProfile,
  type AcceptanceCheck, type AffineAdjustment, type CalibrationCategory, type CalibrationProfileV1, type CategoryMetrics, type ErrorSummary,
} from '../../src/tokenization/calibrationProfile.js';
import { HEURISTIC_THRESHOLD_V0 } from '../../src/tokenization/conferenceReport.js';
import { fit } from './models.js';
import type { Split } from './messageCorpus.js';

export interface CalibrationPair {
  id: string;
  group: string;
  split: Split;
  category: CalibrationCategory;
  local: number;
  target: number;
}

export const ACCEPTANCE_POLICY_V1 = Object.freeze({
  id: 'otk.calibration_acceptance.v1',
  minTrain: 60,
  minValidation: 30,
  minHoldout: 30,
  minHoldoutGroups: 10,
  maxHoldoutAlertRate: 0.05,
  /** share of holdout rows flagged when the provider count is inflated by 25% (power, not only false alerts) */
  minHoldoutDetectionPlus25: 0.5,
});

/** Threshold selection on validation (see fitCalibrationProfile step 2). */
export const THRESHOLD_SELECTION = Object.freeze({
  maxFalseAlertRate: 0.01,
  gridPoints: 60,
  alterations: [['+10%', (y: number) => Math.round(y * 1.1)], ['+25%', (y: number) => Math.round(y * 1.25)], ['+50 tokens', (y: number) => y + 50]] as Array<[string, (y: number) => number]>,
});

function gridOf(values: number[], points: number): number[] {
  const u = [...new Set(values)].sort((a, b) => a - b);
  if (u.length <= points) return u;
  return [...new Set(Array.from({ length: points }, (_, i) => u[Math.round((i * (u.length - 1)) / (points - 1))]!))];
}

/** Grid search of (abs, rel) on validation rows; returns null only when there are no rows. */
export function selectThreshold(val: Array<{ pred: number; target: number }>): { abs: number; rel: number; falseAlertRate: number; power: number } | null {
  if (val.length === 0) return null;
  const absC = gridOf([1, ...val.map((r) => Math.max(1, Math.ceil(Math.abs(r.target - r.pred))))], THRESHOLD_SELECTION.gridPoints);
  const relC = gridOf([0, ...val.filter((r) => r.target > 0).map((r) => Math.ceil((Math.abs(r.target - r.pred) / r.target) * 1e6) / 1e6)], THRESHOLD_SELECTION.gridPoints);
  let best: { abs: number; rel: number; falseAlertRate: number; power: number } | null = null;
  for (const A of absC) {
    for (const R of relC) {
      const t = { abs: A, rel: R };
      const fa = val.filter((r) => alerts(r.pred, r.target, t)).length / val.length;
      if (fa > THRESHOLD_SELECTION.maxFalseAlertRate) continue;
      const power = THRESHOLD_SELECTION.alterations.reduce((s, [, f]) => s + val.filter((r) => alerts(r.pred, f(r.target), t)).length / val.length, 0) / THRESHOLD_SELECTION.alterations.length;
      if (!best || power > best.power + 1e-12 || (Math.abs(power - best.power) <= 1e-12 && (A > best.abs || (A === best.abs && R > best.rel)))) {
        best = { abs: A, rel: R, falseAlertRate: r6(fa), power: r6(power) };
      }
    }
  }
  // the largest grid point flags no validation row, so a feasible pair always exists
  return best;
}

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** Nearest-rank quantile; null when n < 1/(1 − q) (see ErrorSummary). */
function quantileOrNull(sorted: number[], q: number): number | null {
  if (sorted.length === 0) return null;
  const need = q === 0.5 ? 1 : Math.ceil(1 / (1 - q) - 1e-9);
  if (sorted.length < need) return null;
  return r6(sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!);
}

export interface ThresholdNumbers { abs: number; rel: number | null }

/** Same rule as otk.conference.rule.v1: |Δ| > abs AND (target = 0 OR rel = null OR |Δ|/target > rel). */
export function alerts(pred: number, target: number, t: ThresholdNumbers): boolean {
  const d = Math.abs(target - pred);
  if (d <= t.abs) return false;
  if (target === 0 || t.rel === null) return true;
  return d / target > t.rel;
}

export function summarize(rows: CalibrationPair[], predict: (x: number) => number, t: ThresholdNumbers | null): ErrorSummary {
  const errs = rows.map((r) => predict(r.local) - r.target);
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const relRows = rows.filter((r) => r.target > 0);
  const rel = relRows.map((r) => Math.abs(predict(r.local) - r.target) / r.target).sort((a, b) => a - b);
  const n = rows.length;
  return {
    n,
    groups: new Set(rows.map((r) => r.group)).size,
    bias: n ? r6(errs.reduce((s, e) => s + e, 0) / n) : null,
    mae: n ? r6(abs.reduce((s, e) => s + e, 0) / n) : null,
    maxAbs: n ? abs[abs.length - 1]! : null,
    relErrorQuantiles: {
      nRelative: rel.length, zeroTargets: n - relRows.length,
      p50: quantileOrNull(rel, 0.5), p90: quantileOrNull(rel, 0.9), p95: quantileOrNull(rel, 0.95), p99: quantileOrNull(rel, 0.99),
    },
    alertRate: n && t ? r6(rows.filter((r) => alerts(predict(r.local), r.target, t)).length / n) : null,
  };
}

export interface FitInput {
  profileId: string;
  synthetic: boolean;
  targetKind: CalibrationProfileV1['targetKind'];
  support: ModelSupport;
  model: string;
  modelAliases?: string[];
  counterVersion: string;
  categories: CalibrationCategory[];
  pairs: CalibrationPair[];
  corpusId: string;
  corpusSha256: string | null;
  splitRule: string;
  createdAt: string;
  scope: { description: string; excludes: string[] };
  limitations: string[];
}

function ceilMicroString(x: number): string {
  const micro = Math.ceil(x * 1e6 - 1e-6);
  return `${Math.floor(micro / 1e6)}.${String(micro % 1e6).padStart(6, '0')}`;
}

export function fitCalibrationProfile(inp: FitInput): CalibrationProfileV1 {
  const tok = inp.support.tokenizer;
  if (!tok || !tok.vocabularyDigest || !tok.messageAssembly) throw new Error('profile needs a local tokenizer with a vocabulary digest and message assembly');
  const rowsOf = (c: CalibrationCategory, s: Split) => inp.pairs.filter((p) => p.category === c && p.split === s);
  const params: Partial<Record<CalibrationCategory, AffineAdjustment>> = {};
  const predictors: Partial<Record<CalibrationCategory, (x: number) => number>> = {};
  const fitNotes: string[] = [];
  for (const c of inp.categories) {
    const train = rowsOf(c, 'train');
    if (new Set(train.map((r) => r.local)).size < 2) { fitNotes.push(`${c}: fewer than 2 distinct local values in train (n=${train.length}); no parameters`); continue; }
    const m = fit('affine', train.map((r) => ({ id: r.id, x: r.local, y: r.target })));
    const adj: AffineAdjustment = { slope: numberToDecimal6(m.coef[1]!), intercept: numberToDecimal6(m.coef[0]!) };
    params[c] = adj;
    predictors[c] = (x: number) => Number(expectedTokens(adj, BigInt(x)));
  }

  // threshold from validation rows only (rounded parameters, integer predictions); the holdout is not looked at
  const val: Array<{ pred: number; target: number }> = [];
  for (const c of inp.categories) {
    const p = predictors[c]; if (!p) continue;
    for (const r of rowsOf(c, 'validation')) val.push({ pred: p(r.local), target: r.target });
  }
  const sel = val.length > 0 ? selectThreshold(val) : null;
  const thresholdPolicy = sel
    ? { absoluteTokens: String(sel.abs), relative: ceilMicroString(sel.rel),
      derivation: `validation split only (n=${val.length} rows, categories pooled): grid over (absoluteTokens, relative) taken from validation residual quantiles; keep pairs whose false-alert rate on unaltered validation targets is <= ${THRESHOLD_SELECTION.maxFalseAlertRate}; pick the pair with the highest mean detection of injected inflation (${THRESHOLD_SELECTION.alterations.map(([n]) => n).join(', ')}) on validation; ties -> larger absoluteTokens, then larger relative. Validation false-alert rate ${sel.falseAlertRate}, mean detection ${sel.power}.` }
    : { absoluteTokens: HEURISTIC_THRESHOLD_V0.absoluteTokens.toString(), relative: HEURISTIC_THRESHOLD_V0.relative,
      derivation: 'NOT DERIVED: no validation rows with parameters; values copied from HEURISTIC_THRESHOLD_V0 (heuristic, no evidence)' };
  const derived = sel !== null;
  const tNum: ThresholdNumbers = { abs: Number(thresholdPolicy.absoluteTokens), rel: thresholdPolicy.relative === null ? null : Number(thresholdPolicy.relative) };

  const metricsFor = (s: Split): CategoryMetrics => Object.fromEntries(inp.categories.filter((c) => predictors[c]).map((c) => [c, summarize(rowsOf(c, s), predictors[c]!, s === 'train' ? null : tNum)]));
  const train = metricsFor('train'); const validation = metricsFor('validation'); const holdout = metricsFor('holdout');

  const P = ACCEPTANCE_POLICY_V1;
  const checks: AcceptanceCheck[] = [];
  const add = (id: string, required: string, observed: string, passed: boolean) => checks.push({ id, required, observed, passed });
  add('threshold_derived_from_validation', 'true', String(derived), derived);
  for (const c of inp.categories) {
    add(`${c}.parameters`, 'present', params[c] ? 'present' : 'absent', !!params[c]);
    add(`${c}.train_n`, `>= ${P.minTrain}`, String(rowsOf(c, 'train').length), rowsOf(c, 'train').length >= P.minTrain);
    add(`${c}.validation_n`, `>= ${P.minValidation}`, String(rowsOf(c, 'validation').length), rowsOf(c, 'validation').length >= P.minValidation);
    add(`${c}.holdout_n`, `>= ${P.minHoldout}`, String(rowsOf(c, 'holdout').length), rowsOf(c, 'holdout').length >= P.minHoldout);
    const hg = new Set(rowsOf(c, 'holdout').map((r) => r.group)).size;
    add(`${c}.holdout_groups`, `>= ${P.minHoldoutGroups}`, String(hg), hg >= P.minHoldoutGroups);
    const ar = holdout[c]?.alertRate ?? null;
    add(`${c}.holdout_alert_rate`, `<= ${P.maxHoldoutAlertRate}`, ar === null ? 'n/a' : String(ar), ar !== null && ar <= P.maxHoldoutAlertRate);
    // a threshold that flags nothing also has no false alerts: require detection power on the holdout too
    const hp = predictors[c]; const hr = rowsOf(c, 'holdout');
    const det = hp && hr.length ? r6(hr.filter((r) => alerts(hp(r.local), Math.round(r.target * 1.25), tNum)).length / hr.length) : null;
    add(`${c}.holdout_detection_plus25pct`, `>= ${P.minHoldoutDetectionPlus25}`, det === null ? 'n/a' : String(det), det !== null && det >= P.minHoldoutDetectionPlus25);
  }
  const passed = checks.every((c) => c.passed);
  const count = (s: Split) => new Set(inp.pairs.filter((p) => p.split === s).map((p) => p.id)).size;
  const groups = (s: Split) => new Set(inp.pairs.filter((p) => p.split === s).map((p) => p.group)).size;

  return sealProfile({
    schema: CALIBRATION_PROFILE_SCHEMA,
    profileId: inp.profileId,
    synthetic: inp.synthetic,
    targetKind: inp.targetKind,
    provider: inp.support.provider.toLowerCase(),
    apiVariant: inp.support.api as UsageApi,
    model: inp.model.toLowerCase(),
    modelAliases: (inp.modelAliases ?? []).map((a) => a.toLowerCase()),
    tokenizer: tok.encoding,
    tokenizerVersion: { package: tok.package, packageVersion: tok.packageVersion, vocabularyDigest: tok.vocabularyDigest.toLowerCase() as `0x${string}`, messageAssembly: { ...tok.messageAssembly } },
    counterVersion: inp.counterVersion,
    scope: inp.scope,
    categoriesCovered: [...inp.categories],
    corpusId: inp.corpusId,
    corpus: {
      sha256: inp.corpusSha256, splitRule: inp.splitRule,
      documents: { train: count('train'), validation: count('validation'), holdout: count('holdout') },
      groups: { train: groups('train'), validation: groups('validation'), holdout: groups('holdout') },
    },
    createdAt: inp.createdAt,
    parameters: { method: 'affine_least_squares', categories: params },
    errorMetrics: { train },
    validationMetrics: { validation, holdout },
    thresholdPolicy,
    acceptance: { policy: P.id, checks, passed },
    calibrated: passed,
    limitations: [...inp.limitations, ...fitNotes, ...(passed ? [] : ['calibrated=false: acceptance policy otk.calibration_acceptance.v1 not met (see acceptance.checks); the conference keeps HEURISTIC_THRESHOLD_V0'])],
  });
}
