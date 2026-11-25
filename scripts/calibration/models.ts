/**
 * D8 §4 — calibration models and out-of-sample metrics (front B).
 *
 * Models map a local count x to a predicted target y:
 *   baseline  ŷ = x                (no adjustment)
 *   affine    ŷ = a + b·x          (least squares on the training split)
 *   quadratic ŷ = a + b·x + c·x²   (comparison only; never adopted by default)
 * No family is assumed true. Selection uses the validation split; the test split is touched
 * only for the final report. Relative errors use the documented zero rule: rows with target 0
 * are excluded from relative metrics and counted separately; their absolute error still counts.
 *
 * Pure numeric code (no I/O). Used by `runOffline.ts` and `runExternal.ts`, and by the calibration unit tests.
 *
 * @module scripts/calibration/models
 */

/** One observation: local count `x` and target `y`, both in tokens, with the document id. */
export interface Row { x: number; y: number; id: string }
/** Calibration model family (see the module comment). */
export type ModelName = 'baseline' | 'affine' | 'quadratic';
/** A fitted model: coefficients in increasing power of x (`[a, b]` or `[a, b, c]`) and its prediction function. */
export interface FittedModel { name: ModelName; coef: number[]; predict(x: number): number }

/**
 * Gauss-Jordan elimination with partial pivoting.
 *
 * @param A - Square coefficient matrix (not mutated; a copy is reduced).
 * @param b - Right-hand side.
 * @returns The solution x of A·x = b; `null` when the system is (numerically) singular.
 */
function solve(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-12) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  return M.map((row, i) => row[n]! / row[i]!);
}

/**
 * Least squares with features [1, x, x², …] up to `degree`, via normal equations (x scaled).
 *
 * x is divided by max(1, max |x|) before solving, for numerical stability, and the coefficients are scaled back.
 *
 * @param rows - Training rows.
 * @param degree - 1 (affine) or 2 (quadratic).
 * @returns Coefficients `[a, b]` or `[a, b, c]` in the original x units; `null` when there are fewer than
 *   `degree + 1` rows or the system is singular (for example, all x equal).
 */
export function fitPolynomial(rows: Row[], degree: 1 | 2): number[] | null {
  if (rows.length < degree + 1) return null;
  const s = Math.max(1, ...rows.map((r) => Math.abs(r.x)));
  const k = degree + 1;
  const A = Array.from({ length: k }, () => Array(k).fill(0) as number[]);
  const b = Array(k).fill(0) as number[];
  for (const r of rows) {
    const f = Array.from({ length: k }, (_, i) => (r.x / s) ** i);
    for (let i = 0; i < k; i++) {
      b[i] += f[i]! * r.y;
      for (let j = 0; j < k; j++) A[i]![j] += f[i]! * f[j]!;
    }
  }
  const c = solve(A, b);
  return c ? c.map((v, i) => v / s ** i) : null;
}

/**
 * Fits one model family on the training rows.
 *
 * @param name - Model family; `'baseline'` needs no data (ŷ = x).
 * @param train - Training rows.
 * @returns The fitted model.
 * @throws {Error} When an affine or quadratic fit is not possible (too few rows or a singular system).
 */
export function fit(name: ModelName, train: Row[]): FittedModel {
  if (name === 'baseline') return { name, coef: [0, 1], predict: (x) => x };
  const coef = fitPolynomial(train, name === 'affine' ? 1 : 2);
  if (!coef) throw new Error(`${name}: not enough training rows`);
  return { name, coef, predict: (x) => coef.reduce((s, c, i) => s + c * x ** i, 0) };
}

/** Error metrics of a model on one split. Errors are prediction − target, in tokens. */
export interface Metrics {
  /** Number of rows. */
  n: number;
  /** Rows with target 0 (excluded from `mape`). */
  zeroTargets: number;
  /** Mean absolute error, tokens. */
  mae: number;
  /** Root mean squared error, tokens. */
  rmse: number;
  /** mean |e|/y over rows with y > 0 */
  mape: number | null;
  /** Median absolute error, tokens (0 for an empty split). */
  medianAbs: number;
  /** 95th percentile of the absolute error, tokens. */
  p95Abs: number;
  /** Largest absolute error, tokens. */
  maxAbs: number;
  /** share of rows where prediction < target (local under-counts after the model) */
  underRate: number;
  /** Share of rows where prediction > target (fraction in [0, 1]). */
  overRate: number;
}

/** Nearest-rank quantile of an ascending array; 0 for an empty array. */

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

/**
 * Computes the error metrics of a model on a set of rows.
 *
 * @param model - Fitted model.
 * @param rows - Rows to evaluate (may be empty: means and rates are then 0 and `mape` is `null`).
 * @returns The metrics.
 */
export function metrics(model: FittedModel, rows: Row[]): Metrics {
  const errs = rows.map((r) => model.predict(r.x) - r.y);
  const abs = errs.map(Math.abs).sort((a, b) => a - b);
  const rel = rows.filter((r) => r.y > 0).map((r) => Math.abs(model.predict(r.x) - r.y) / r.y);
  const n = rows.length || 1;
  return {
    n: rows.length,
    zeroTargets: rows.filter((r) => r.y === 0).length,
    mae: abs.reduce((s, e) => s + e, 0) / n,
    rmse: Math.sqrt(errs.reduce((s, e) => s + e * e, 0) / n),
    mape: rel.length ? rel.reduce((s, e) => s + e, 0) / rel.length : null,
    medianAbs: quantile(abs, 0.5),
    p95Abs: quantile(abs, 0.95),
    maxAbs: abs[abs.length - 1] ?? 0,
    underRate: errs.filter((e) => e < -1e-9).length / n,
    overRate: errs.filter((e) => e > 1e-9).length / n,
  };
}

/**
 * Alert rule matching otk.conference.rule.v1: |Δ| > abs AND (y = 0 OR |Δ|/y > rel).
 *
 * @param model - Model applied to each local count before comparing.
 * @param rows - Rows to check.
 * @param threshold - `abs` in tokens and `rel` as a fraction (0.1 = 10 %).
 * @returns One flag per row, in the same order; `true` means the row would raise an alert.
 */
export function alerts(model: FittedModel, rows: Row[], threshold: { abs: number; rel: number }): boolean[] {
  return rows.map((r) => {
    const d = Math.abs(r.y - model.predict(r.x));
    return d > threshold.abs && (r.y === 0 || d / r.y > threshold.rel);
  });
}

/**
 * Threshold derived from validation residuals (never from test): abs = q-quantile of |Δ|,
 * rel = q-quantile of |Δ|/y. Versioned by the caller with corpus/model ids.
 *
 * @param model - Fitted model.
 * @param validation - Validation rows (rows with y = 0 are left out of the relative quantile).
 * @param q - Quantile in [0, 1]; default 0.99.
 * @returns `abs` in whole tokens (rounded up, at least 1) and `rel` as a fraction.
 */
export function calibrateThreshold(model: FittedModel, validation: Row[], q = 0.99): { abs: number; rel: number } {
  const abs = validation.map((r) => Math.abs(r.y - model.predict(r.x))).sort((a, b) => a - b);
  const rel = validation.filter((r) => r.y > 0).map((r) => Math.abs(r.y - model.predict(r.x)) / r.y).sort((a, b) => a - b);
  return { abs: Math.max(1, Math.ceil(quantile(abs, q))), rel: quantile(rel, q) };
}

/** How many rows raised an alert after one artificial inflation of the target; `rate` = detected / n (0 if n = 0). */
export interface DetectionResult { alteration: string; detected: number; n: number; rate: number }

/**
 * Controlled artificial alterations of the target (inflation) on the test split.
 *
 * @param model - Fitted model.
 * @param rows - Rows whose targets are inflated (copies; the input is not mutated).
 * @param threshold - Alert threshold (see {@link alerts}).
 * @returns One result per alteration: +5 %, +10 %, +25 %, +50 tokens, +200 tokens.
 */
export function detection(model: FittedModel, rows: Row[], threshold: { abs: number; rel: number }): DetectionResult[] {
  const alterations: Array<[string, (y: number) => number]> = [
    ['+5%', (y) => Math.round(y * 1.05)],
    ['+10%', (y) => Math.round(y * 1.1)],
    ['+25%', (y) => Math.round(y * 1.25)],
    ['+50 tokens', (y) => y + 50],
    ['+200 tokens', (y) => y + 200],
  ];
  return alterations.map(([name, f]) => {
    const altered = rows.map((r) => ({ ...r, y: f(r.y) }));
    const flagged = alerts(model, altered, threshold).filter(Boolean).length;
    return { alteration: name, detected: flagged, n: rows.length, rate: rows.length ? flagged / rows.length : 0 };
  });
}
