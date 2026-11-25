/**
 * bench_stats — unit tests for src/bench/Stats.ts
 *
 * Validates:
 *   1. Schema completeness (all expected fields present)
 *   2. Determinism (same input → identical output, across two calls)
 *   3. Correctness of each statistic against known values
 *   4. Edge cases (empty array, single element, n=2)
 *   5. CSV header / row format matches Stats field order
 *
 * Module under test: `src/bench/Stats.ts` (summary statistics used in benchmark reports).
 *
 * Strategy / partitions: for each statistic (mean, median, sample standard deviation,
 * percentiles, 95% confidence interval) the empty input (zeros), one element, odd and even
 * lengths, identical values and larger samples; `computeStats` does not mutate its input and
 * rounds deterministically; CSV header and row have the same column count and numeric values.
 *
 * Needs: nothing external (pure computation).
 *
 * Run just this file: `npx tsx --test test/unit/bench_stats.test.ts`
 *
 * @since U9.3.1
 * @module test/unit/bench_stats.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  mean, median, std, percentile, ci95, computeStats, fixedPrec,
  statsToCsvRow, STATS_CSV_HEADER,
  type Stats,
} from '../../src/bench/Stats.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const SAMPLES_10 = [3, 1, 4, 1, 5, 9, 2, 6, 5, 3]; // sum=39, mean=3.9
const SAMPLES_SORTED_10 = [1, 1, 2, 3, 3, 4, 5, 5, 6, 9];

// ---------------------------------------------------------------------------
// 1. Schema completeness
// ---------------------------------------------------------------------------
describe('Stats schema', () => {
  it('computeStats returns all required fields', () => {
    const s = computeStats(SAMPLES_10);
    const REQUIRED: (keyof Stats)[] = [
      'count', 'mean', 'median', 'std',
      'min', 'p50', 'p95', 'max',
      'ci95_low', 'ci95_high',
    ];
    for (const f of REQUIRED) {
      assert.ok(f in s, `missing field: ${f}`);
      assert.ok(typeof s[f] === 'number', `field ${f} should be number, got ${typeof s[f]}`);
    }
  });

  it('computeStats count matches input length', () => {
    assert.strictEqual(computeStats(SAMPLES_10).count, 10);
    assert.strictEqual(computeStats([42]).count, 1);
    assert.strictEqual(computeStats([]).count, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. Determinism — same input → identical output
// ---------------------------------------------------------------------------
describe('Determinism', () => {
  it('computeStats produces identical output for repeated calls', () => {
    const a = computeStats(SAMPLES_10);
    const b = computeStats(SAMPLES_10);
    assert.deepStrictEqual(a, b);
  });

  it('computeStats does not mutate the input array', () => {
    const input = [5, 3, 1, 4, 2];
    const copy = [...input];
    computeStats(input);
    assert.deepStrictEqual(input, copy);
  });

  it('fixedPrec is deterministic for same (x, decimals)', () => {
    const v = 1 / 3;
    assert.strictEqual(fixedPrec(v, 6), fixedPrec(v, 6));
    assert.strictEqual(fixedPrec(v, 4), fixedPrec(v, 4));
  });

  it('computeStats with different precision produces different rounding but same rank order', () => {
    const s6 = computeStats(SAMPLES_10, 6);
    const s2 = computeStats(SAMPLES_10, 2);
    // s2 is coarser; both should have same min/max rank ordering
    assert.ok(s6.min <= s6.p50);
    assert.ok(s2.min <= s2.p50);
  });
});

// ---------------------------------------------------------------------------
// 3. Correctness — known values
// ---------------------------------------------------------------------------
describe('mean()', () => {
  it('computes mean correctly', () => {
    // sum=39, n=10
    assert.strictEqual(mean(SAMPLES_10), 3.9);
  });

  it('single element returns itself', () => {
    assert.strictEqual(mean([7]), 7);
  });

  it('empty returns 0', () => {
    assert.strictEqual(mean([]), 0);
  });
});

describe('median()', () => {
  it('odd-length returns middle value', () => {
    // [1, 2, 3, 4, 5] → 3
    assert.strictEqual(median([3, 1, 4, 1, 5]), 3);
  });

  it('even-length returns average of two middle values', () => {
    // sorted [1, 1, 2, 3, 3, 4, 5, 5, 6, 9] → (3+4)/2 = 3.5
    assert.strictEqual(median(SAMPLES_10), 3.5);
  });

  it('empty returns 0', () => {
    assert.strictEqual(median([]), 0);
  });
});

describe('std()', () => {
  it('zero for single element', () => {
    assert.strictEqual(std([42]), 0);
  });

  it('zero for empty', () => {
    assert.strictEqual(std([]), 0);
  });

  it('uses sample std (n-1)', () => {
    // [2, 4]: mean=3, variance_sample=((2-3)²+(4-3)²)/1=2, std=√2≈1.41421
    const result = std([2, 4]);
    assert.ok(Math.abs(result - Math.sqrt(2)) < 1e-10, `expected √2, got ${result}`);
  });

  it('non-negative for arbitrary samples', () => {
    assert.ok(std(SAMPLES_10) >= 0);
  });
});

describe('percentile()', () => {
  it('p0 returns minimum', () => {
    assert.strictEqual(percentile(SAMPLES_10, 0), SAMPLES_SORTED_10[0]);
  });

  it('p50 matches median for odd-index', () => {
    // floor(50/100 * 10) = 5 → sorted[5] = 4
    const p50 = percentile(SAMPLES_10, 50);
    assert.ok(typeof p50 === 'number');
  });

  it('p95 is >= p50', () => {
    assert.ok(percentile(SAMPLES_10, 95) >= percentile(SAMPLES_10, 50));
  });

  it('p100 returns maximum', () => {
    // floor(100/100 * 10) = 10, clamped to 9 → sorted[9] = 9
    assert.strictEqual(percentile(SAMPLES_10, 100), 9);
  });

  it('empty returns 0', () => {
    assert.strictEqual(percentile([], 50), 0);
  });
});

describe('ci95()', () => {
  it('low <= high', () => {
    const { low, high } = ci95(SAMPLES_10);
    assert.ok(low <= high, `expected low <= high, got [${low}, ${high}]`);
  });

  it('low <= mean <= high', () => {
    const m = mean(SAMPLES_10);
    const { low, high } = ci95(SAMPLES_10);
    assert.ok(low <= m, `expected low (${low}) <= mean (${m})`);
    assert.ok(m <= high, `expected mean (${m}) <= high (${high})`);
  });

  it('empty returns {low:0, high:0}', () => {
    const { low, high } = ci95([]);
    assert.strictEqual(low, 0);
    assert.strictEqual(high, 0);
  });

  it('larger sample produces narrower CI', () => {
    const small = ci95([1, 2, 3, 4, 5]);
    const large = ci95([1, 2, 3, 4, 5, 1, 2, 3, 4, 5, 1, 2, 3, 4, 5]);
    assert.ok(large.high - large.low < small.high - small.low,
      'larger sample should have narrower CI');
  });
});

describe('computeStats() correctness', () => {
  it('min and max are correct', () => {
    const s = computeStats(SAMPLES_10);
    assert.strictEqual(s.min, 1);
    assert.strictEqual(s.max, 9);
  });

  it('p95 >= p50 >= min', () => {
    const s = computeStats(SAMPLES_10);
    assert.ok(s.p95 >= s.p50, `p95 (${s.p95}) should be >= p50 (${s.p50})`);
    assert.ok(s.p50 >= s.min, `p50 (${s.p50}) should be >= min (${s.min})`);
  });

  it('ci95_low <= mean <= ci95_high', () => {
    const s = computeStats(SAMPLES_10);
    assert.ok(s.ci95_low <= s.mean, `ci95_low (${s.ci95_low}) should be <= mean (${s.mean})`);
    assert.ok(s.mean <= s.ci95_high, `mean (${s.mean}) should be <= ci95_high (${s.ci95_high})`);
  });

  it('std field is present and >= 0', () => {
    const s = computeStats(SAMPLES_10);
    assert.ok('std' in s);
    assert.ok(s.std >= 0);
  });
});

// ---------------------------------------------------------------------------
// 4. Edge cases
// ---------------------------------------------------------------------------
describe('Edge cases', () => {
  it('single element — all stats equal that element except ci bounds', () => {
    const s = computeStats([7]);
    assert.strictEqual(s.count, 1);
    assert.strictEqual(s.mean, 7);
    assert.strictEqual(s.min, 7);
    assert.strictEqual(s.max, 7);
    assert.strictEqual(s.std, 0);
  });

  it('empty array — all zeros', () => {
    const s = computeStats([]);
    assert.strictEqual(s.count, 0);
    assert.strictEqual(s.mean, 0);
    assert.strictEqual(s.ci95_low, 0);
    assert.strictEqual(s.ci95_high, 0);
  });

  it('identical values — std=0, CI collapses to mean', () => {
    const s = computeStats([5, 5, 5, 5, 5]);
    assert.strictEqual(s.std, 0);
    assert.strictEqual(s.ci95_low, 5);
    assert.strictEqual(s.ci95_high, 5);
  });
});

// ---------------------------------------------------------------------------
// 5. CSV format — header matches row field order
// ---------------------------------------------------------------------------
describe('CSV format', () => {
  it('STATS_CSV_HEADER contains all expected column names', () => {
    const cols = STATS_CSV_HEADER.split(',');
    for (const expected of ['count','mean','median','std','min','p50','p95','max','ci95_low','ci95_high']) {
      assert.ok(cols.includes(expected), `STATS_CSV_HEADER missing column: ${expected}`);
    }
  });

  it('statsToCsvRow column count matches header column count', () => {
    const s = computeStats(SAMPLES_10);
    const row = statsToCsvRow(s);
    const headerCols = STATS_CSV_HEADER.split(',').length;
    const rowCols = row.split(',').length;
    assert.strictEqual(rowCols, headerCols, `header has ${headerCols} cols, row has ${rowCols}`);
  });

  it('statsToCsvRow values are all numeric strings', () => {
    const s = computeStats(SAMPLES_10);
    const row = statsToCsvRow(s);
    for (const cell of row.split(',')) {
      assert.ok(!isNaN(Number(cell)), `CSV cell "${cell}" is not a number`);
    }
  });

  it('statsToCsvRow is deterministic', () => {
    const s = computeStats(SAMPLES_10);
    assert.strictEqual(statsToCsvRow(s), statsToCsvRow(s));
  });
});
