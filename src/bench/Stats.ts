/**
 * Stats — deterministic statistical utilities for benchmark harnesses.
 *
 * All functions:
 *   - Accept a plain number[] (samples), assume values are in the same unit
 *   - Apply sample std (n−1 denominator) by default
 *   - CI95 uses normal approximation: mean ± 1.96 × (std / √n)
 *   - Output is rounded to a configurable number of decimal places (default 6)
 *
 * Output columns produced by `computeStats()`:
 *   count, mean, median, std, min, p50, p95, max, ci95_low, ci95_high
 *
 * @module Stats
 * @since U9.3.1
 */

/** Full statistical summary for a sample set. */
export interface Stats {
  /** Number of observations. */
  count: number;
  /** Arithmetic mean. */
  mean: number;
  /** Median (50th percentile). */
  median: number;
  /** Sample standard deviation (n−1 denominator). */
  std: number;
  /** Minimum value. */
  min: number;
  /** 50th percentile (same as median; explicit for CSV column parity). */
  p50: number;
  /** 95th percentile. */
  p95: number;
  /** Maximum value. */
  max: number;
  /** Lower bound of 95 % CI (normal approximation). */
  ci95_low: number;
  /** Upper bound of 95 % CI (normal approximation). */
  ci95_high: number;
}

// z-score for 95 % confidence (two-tailed normal approximation)
const Z95 = 1.96;

/**
 * Round to `decimals` decimal places deterministically.
 * Uses Math.round (ties to nearest, which is deterministic for doubles).
 */
export function fixedPrec(x: number, decimals: number): number {
  const factor = Math.pow(10, decimals);
  return Math.round(x * factor) / factor;
}

/**
 * Arithmetic mean of a non-empty sample.
 */
export function mean(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  return samples.reduce((a, b) => a + b, 0) / samples.length;
}

/**
 * Median (P50) of a sample (sorts internally; does not mutate input).
 */
export function median(samples: readonly number[]): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  // For even-length, average the two middle values
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Sample standard deviation (n−1 denominator).
 * Returns 0 if n < 2.
 */
export function std(samples: readonly number[]): number {
  const n = samples.length;
  if (n < 2) return 0;
  const m = mean(samples);
  const variance = samples.reduce((acc, x) => acc + (x - m) ** 2, 0) / (n - 1);
  return Math.sqrt(variance);
}

/**
 * Arbitrary percentile (0–100) using nearest-rank method (sorted ascending).
 * Returns the value at the floor-indexed position.
 */
export function percentile(samples: readonly number[], p: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.floor((p / 100) * sorted.length);
  // Clamp to valid range
  return sorted[Math.min(idx, sorted.length - 1)];
}

/**
 * 95 % confidence interval (normal approximation).
 * low  = mean − 1.96 × (std / √n)
 * high = mean + 1.96 × (std / √n)
 */
export function ci95(samples: readonly number[]): { low: number; high: number } {
  const n = samples.length;
  if (n === 0) return { low: 0, high: 0 };
  const m = mean(samples);
  const s = std(samples);
  const sem = n > 1 ? s / Math.sqrt(n) : 0;
  return { low: m - Z95 * sem, high: m + Z95 * sem };
}

/**
 * Compute full statistical summary for a sample set.
 *
 * @param samples  Raw observations (any unit).
 * @param decimals Number of decimal places for rounding (default 6).
 * @returns        Deterministic `Stats` object — same input → same output.
 */
export function computeStats(samples: readonly number[], decimals = 6): Stats {
  if (samples.length === 0) {
    return {
      count: 0, mean: 0, median: 0, std: 0,
      min: 0, p50: 0, p95: 0, max: 0,
      ci95_low: 0, ci95_high: 0,
    };
  }

  const r = (x: number) => fixedPrec(x, decimals);
  const sorted = [...samples].sort((a, b) => a - b);
  const n = sorted.length;
  const m = mean(samples);
  const s = std(samples);
  const { low, high } = ci95(samples);

  return {
    count:     n,
    mean:      r(m),
    median:    r(median(samples)),
    std:       r(s),
    min:       r(sorted[0]),
    p50:       r(percentile(samples, 50)),
    p95:       r(percentile(samples, 95)),
    max:       r(sorted[n - 1]),
    ci95_low:  r(low),
    ci95_high: r(high),
  };
}

/**
 * CSV header string matching the Stats field order (canonical, fixed).
 * Prefix a column group name to disambiguate multi-metric CSVs, e.g.:
 *   `sign_${STATS_CSV_SUFFIX_HEADER}`
 */
export const STATS_CSV_HEADER =
  'count,mean,median,std,min,p50,p95,max,ci95_low,ci95_high';

/**
 * Serialize a Stats object to a CSV row (no trailing newline).
 * Column order matches STATS_CSV_HEADER exactly.
 */
export function statsToCsvRow(s: Stats): string {
  return [
    s.count, s.mean, s.median, s.std,
    s.min, s.p50, s.p95, s.max,
    s.ci95_low, s.ci95_high,
  ].join(',');
}

/**
 * Environment-driven precision (BENCH_PRECISION env var, default 6).
 */
export const BENCH_PRECISION: number = (() => {
  const v = parseInt(process.env['BENCH_PRECISION'] ?? '', 10);
  return Number.isFinite(v) && v >= 0 && v <= 15 ? v : 6;
})();

/**
 * Convenience: compute stats with env-driven precision.
 */
export function computeStatsBench(samples: readonly number[]): Stats {
  return computeStats(samples, BENCH_PRECISION);
}
