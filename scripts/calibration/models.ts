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
 */

export interface Row { x: number; y: number; id: string }
export type ModelName = 'baseline' | 'affine' | 'quadratic';
export interface FittedModel { name: ModelName; coef: number[]; predict(x: number): number }

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

/** Least squares with features [1, x, x², …] up to `degree`, via normal equations (x scaled). */
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

export function fit(name: ModelName, train: Row[]): FittedModel {
  if (name === 'baseline') return { name, coef: [0, 1], predict: (x) => x };
  const coef = fitPolynomial(train, name === 'affine' ? 1 : 2);
  if (!coef) throw new Error(`${name}: not enough training rows`);
  return { name, coef, predict: (x) => coef.reduce((s, c, i) => s + c * x ** i, 0) };
}

export interface Metrics {
  n: number;
  zeroTargets: number;
  mae: number;
  rmse: number;
  /** mean |e|/y over rows with y > 0 */
  mape: number | null;
  medianAbs: number;
  p95Abs: number;
  maxAbs: number;
  /** share of rows where prediction < target (local under-counts after the model) */
  underRate: number;
  overRate: number;
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, i)]!;
}

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

/** Alert rule matching otk.conference.rule.v1: |Δ| > abs AND (y = 0 OR |Δ|/y > rel). */
export function alerts(model: FittedModel, rows: Row[], threshold: { abs: number; rel: number }): boolean[] {
  return rows.map((r) => {
    const d = Math.abs(r.y - model.predict(r.x));
    return d > threshold.abs && (r.y === 0 || d / r.y > threshold.rel);
  });
}

/**
 * Threshold derived from validation residuals (never from test): abs = q-quantile of |Δ|,
 * rel = q-quantile of |Δ|/y. Versioned by the caller with corpus/model ids.
 */
export function calibrateThreshold(model: FittedModel, validation: Row[], q = 0.99): { abs: number; rel: number } {
  const abs = validation.map((r) => Math.abs(r.y - model.predict(r.x))).sort((a, b) => a - b);
  const rel = validation.filter((r) => r.y > 0).map((r) => Math.abs(r.y - model.predict(r.x)) / r.y).sort((a, b) => a - b);
  return { abs: Math.max(1, Math.ceil(quantile(abs, q))), rel: quantile(rel, q) };
}

export interface DetectionResult { alteration: string; detected: number; n: number; rate: number }

/** Controlled artificial alterations of the target (inflation) on the test split. */
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
