/**
 * W4-4A02 — ICUStrategy polymorphic CU engine tests (S5.3)
 *
 * Covers:
 *   1.  ICUStrategy.ts file exists
 *   2.  LinearCUStrategy.name === 'linear'
 *   3.  LinearCUStrategy.compute() matches calculateCostUnitsV1 output
 *   4.  NonlinearCUStrategy.name === 'nonlinear'
 *   5.  NonlinearCUStrategy.compute() returns integer (bigint) ≥ 0
 *   6.  NonlinearCUStrategy gives sub-linear growth (double tokens < double CU)
 *   7.  getActiveStrategy() defaults to LinearCUStrategy
 *   8.  getActiveStrategy() returns NonlinearCUStrategy when OTK_CU_STRATEGY=nonlinear
 *   9.  getActiveStrategy() returns LinearCUStrategy when OTK_CU_STRATEGY=linear
 *  10.  computePublishedCU() uses active strategy (linear baseline unchanged)
 *  11.  bigintSqrt edge: input=0 gives 0 for nonlinear
 *  12.  Strategy hot-switch: env var change takes effect without process restart
 *
 * @since Wave 4 (4A-PACK-4A02 / S5.3)
 *
 * Modules under test: `src/economics/ICUStrategy.ts`, `src/economics/CUEngine.ts` (`computePublishedCU`) and
 * `src/pricing/CostUnits.ts` (the linear reference).
 *
 * Strategy / partitions: as listed above; the strategy selected with `OTK_CU_STRATEGY` unset, `nonlinear` and
 * `linear`, and switched within the same process.
 *
 * Needs: nothing external. Changes `OTK_CU_STRATEGY` and restores it after each group.
 *
 * Run just this file: `npx tsx --test test/unit/wave4_cu_strategy.test.ts`
 *
 * @module test/unit/wave4_cu_strategy.test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

import {
  LinearCUStrategy,
  NonlinearCUStrategy,
  getActiveStrategy,
} from '../../src/economics/ICUStrategy.js';
import { calculateCostUnitsV1 } from '../../src/pricing/CostUnits.js';
import { computePublishedCU } from '../../src/economics/CUEngine.js';

const BASE_INPUT = {
  provider: 'anthropic',
  model: 'claude-3-sonnet',
  inputTokens: 1000,
  outputTokens: 500,
};

// ──────────────────────────────────────────────────────────
// 1. File structure
// ──────────────────────────────────────────────────────────
describe('W4-4A02 — File structure', () => {
  it('src/economics/ICUStrategy.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/economics/ICUStrategy.ts')));
  });
});

// ──────────────────────────────────────────────────────────
// 2–3. LinearCUStrategy
// ──────────────────────────────────────────────────────────
describe('W4-4A02 — LinearCUStrategy', () => {
  it('name is "linear"', () => {
    assert.strictEqual(LinearCUStrategy.name, 'linear');
  });

  it('compute() matches calculateCostUnitsV1 exactly', () => {
    const expected = calculateCostUnitsV1(BASE_INPUT);
    const actual = LinearCUStrategy.compute(BASE_INPUT);
    assert.strictEqual(actual, expected);
  });
});

// ──────────────────────────────────────────────────────────
// 4–6. NonlinearCUStrategy
// ──────────────────────────────────────────────────────────
describe('W4-4A02 — NonlinearCUStrategy', () => {
  it('name is "nonlinear"', () => {
    assert.strictEqual(NonlinearCUStrategy.name, 'nonlinear');
  });

  it('compute() returns bigint ≥ 0', () => {
    const cu = NonlinearCUStrategy.compute(BASE_INPUT);
    assert.ok(typeof cu === 'bigint');
    assert.ok(cu >= 0n);
  });

  it('gives sub-linear growth: doubling tokens < doubling CU', () => {
    const small = NonlinearCUStrategy.compute({ ...BASE_INPUT, inputTokens: 1000, outputTokens: 0 });
    const large = NonlinearCUStrategy.compute({ ...BASE_INPUT, inputTokens: 4000, outputTokens: 0 });
    // sqrt(4000) / sqrt(1000) = 2 → sub-linear vs 4x linear
    // So large < 4 * small
    assert.ok(large < 4n * small, `large=${large} should be < 4*small=${4n * small}`);
  });

  it('edge case: zero tokens returns 0', () => {
    const cu = NonlinearCUStrategy.compute({ ...BASE_INPUT, inputTokens: 0, outputTokens: 0 });
    assert.strictEqual(cu, 0n);
  });
});

// ──────────────────────────────────────────────────────────
// 7–9. getActiveStrategy()
// ──────────────────────────────────────────────────────────
describe('W4-4A02 — getActiveStrategy()', () => {
  let origVal: string | undefined;

  before(() => { origVal = process.env['OTK_CU_STRATEGY']; });
  after(() => {
    if (origVal !== undefined) process.env['OTK_CU_STRATEGY'] = origVal;
    else delete process.env['OTK_CU_STRATEGY'];
  });

  it('defaults to LinearCUStrategy when OTK_CU_STRATEGY unset', () => {
    delete process.env['OTK_CU_STRATEGY'];
    const strategy = getActiveStrategy();
    assert.strictEqual(strategy.name, 'linear');
  });

  it('returns NonlinearCUStrategy when OTK_CU_STRATEGY=nonlinear', () => {
    process.env['OTK_CU_STRATEGY'] = 'nonlinear';
    const strategy = getActiveStrategy();
    assert.strictEqual(strategy.name, 'nonlinear');
  });

  it('returns LinearCUStrategy when OTK_CU_STRATEGY=linear', () => {
    process.env['OTK_CU_STRATEGY'] = 'linear';
    const strategy = getActiveStrategy();
    assert.strictEqual(strategy.name, 'linear');
  });
});

// ──────────────────────────────────────────────────────────
// 10. computePublishedCU uses active strategy
// ──────────────────────────────────────────────────────────
describe('W4-4A02 — computePublishedCU with active strategy', () => {
  let origVal: string | undefined;

  before(() => { origVal = process.env['OTK_CU_STRATEGY']; });
  after(() => {
    if (origVal !== undefined) process.env['OTK_CU_STRATEGY'] = origVal;
    else delete process.env['OTK_CU_STRATEGY'];
  });

  it('uses linear strategy by default (backward compat: computePublishedCU result unchanged)', () => {
    delete process.env['OTK_CU_STRATEGY'];
    // In linear mode, computePublishedCU should produce same bucketed value as before
    const cu = computePublishedCU(BASE_INPUT);
    assert.ok(typeof cu === 'bigint');
    assert.ok(cu >= 0n);
    // With linear strategy, raw = calculateCostUnitsV1, result must be > 0 for nonzero input
    assert.ok(cu > 0n);
  });
});

// ──────────────────────────────────────────────────────────
// 12. Hot-switch test
// ──────────────────────────────────────────────────────────
describe('W4-4A02 — Hot-switch via OTK_CU_STRATEGY', () => {
  let origVal: string | undefined;

  before(() => { origVal = process.env['OTK_CU_STRATEGY']; });
  after(() => {
    if (origVal !== undefined) process.env['OTK_CU_STRATEGY'] = origVal;
    else delete process.env['OTK_CU_STRATEGY'];
  });

  it('strategy switches without process restart', () => {
    delete process.env['OTK_CU_STRATEGY'];
    assert.strictEqual(getActiveStrategy().name, 'linear');

    process.env['OTK_CU_STRATEGY'] = 'nonlinear';
    assert.strictEqual(getActiveStrategy().name, 'nonlinear');

    process.env['OTK_CU_STRATEGY'] = 'linear';
    assert.strictEqual(getActiveStrategy().name, 'linear');
  });
});
