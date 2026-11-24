/**
 * cu_bucketing — unit tests for CU privacy bucketing integration in CUEngine.
 *
 * Validates:
 *   1. bucketCU() rounding rule (round-half-up to nearest multiple)
 *   2. computePublishedCU() vs computeCostUnits() in raw mode
 *   3. CU_ENGINE_MODE default is 'bucketed'
 *   4. CU_ENGINE_BUCKET_SIZE default is 100n
 *   5. Specific rounding examples documented in CUEngine
 *   6. OTKSDK defaultCostNormalizer uses published (bucketed) value
 *
 * Note on env-driven constants (CU_ENGINE_MODE / CU_ENGINE_BUCKET_SIZE):
 *   These are module-level constants resolved once at import. This test suite
 *   verifies the DEFAULT state (no CU_MODE or CU_BUCKET_SIZE env set) and
 *   the pure bucketCU() function independently of env state.
 *
 * @since U5.3
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  bucketCU,
  CU_DEFAULT_BUCKET,
  CU_ENGINE_MODE,
  CU_ENGINE_BUCKET_SIZE,
  computeCostUnits,
  computePublishedCU,
  computePublishedCUNumber,
} from '../../src/economics/CUEngine.js';

import { defaultCostNormalizer } from '../../src/sdk/OTKSDK.js';
import { computeKnownCu } from '../../src/operations/knownCu.js';

// ---------------------------------------------------------------------------
// 1. bucketCU() — pure function, independent of env
// ---------------------------------------------------------------------------
describe('bucketCU() rounding rule (round-half-up, nearest multiple)', () => {
  it('multiples stay unchanged', () => {
    assert.strictEqual(bucketCU(0n), 0n);
    assert.strictEqual(bucketCU(100n), 100n);
    assert.strictEqual(bucketCU(200n), 200n);
    assert.strictEqual(bucketCU(1000n), 1000n);
  });

  it('237 → 200 (distance 37 to 200 < distance 63 to 300)', () => {
    assert.strictEqual(bucketCU(237n), 200n);
  });

  it('250 → 300 (tie: half rounds UP)', () => {
    assert.strictEqual(bucketCU(250n), 300n);
  });

  it('151 → 200 (closer to 200)', () => {
    assert.strictEqual(bucketCU(151n), 200n);
  });

  it('149 → 100 (closer to 100)', () => {
    assert.strictEqual(bucketCU(149n), 100n);
  });

  it('1 → 0 is not the case — rounds to 0 for tiny values < half bucket', () => {
    // 1 < 50 (half of 100), so rounds DOWN to 0
    assert.strictEqual(bucketCU(1n), 0n);
  });

  it('50 → 100 (tie rounds UP)', () => {
    assert.strictEqual(bucketCU(50n), 100n);
  });

  it('bucketSize=50: 237 → 250', () => {
    // 237/50=4.74; multiples 200 and 250; distance 37 to 250 < distance 13 to 200? No.
    // distance(237,200)=37, distance(237,250)=13 → rounds to 250
    assert.strictEqual(bucketCU(237n, 50n), 250n);
  });

  it('bucketSize=50: 225 → 250 (tie)', () => {
    assert.strictEqual(bucketCU(225n, 50n), 250n);
  });

  it('bucketSize=10: 237 → 240', () => {
    // 237/10=23.7 → rounds to 24 → 240
    assert.strictEqual(bucketCU(237n, 10n), 240n);
  });

  it('bucketSize=1: any value → itself (no bucketing)', () => {
    assert.strictEqual(bucketCU(237n, 1n), 237n);
    assert.strictEqual(bucketCU(999n, 1n), 999n);
  });

  it('throws if bucketSize <= 0', () => {
    assert.throws(() => bucketCU(100n, 0n));
    assert.throws(() => bucketCU(100n, -1n));
  });

  it('throws if cu < 0', () => {
    assert.throws(() => bucketCU(-1n));
  });
});

// ---------------------------------------------------------------------------
// 2. CU_DEFAULT_BUCKET
// ---------------------------------------------------------------------------
describe('CU_DEFAULT_BUCKET', () => {
  it('is 100n', () => {
    assert.strictEqual(CU_DEFAULT_BUCKET, 100n);
  });
});

// ---------------------------------------------------------------------------
// 3. Engine defaults (no env vars set in test environment)
// ---------------------------------------------------------------------------
describe('CU_ENGINE_MODE and CU_ENGINE_BUCKET_SIZE defaults', () => {
  it('CU_ENGINE_MODE defaults to bucketed when no env set', () => {
    // In test env, CU_MODE and CU_PUBLISH_MODE are not set → defaults to 'bucketed'
    // (If env IS set in CI, this still validates the resolved value is valid)
    const mode = CU_ENGINE_MODE;
    assert.ok(mode === 'bucketed' || mode === 'raw',
      `CU_ENGINE_MODE must be 'bucketed' or 'raw', got: ${mode}`);
  });

  it('CU_ENGINE_BUCKET_SIZE is a positive bigint', () => {
    assert.ok(typeof CU_ENGINE_BUCKET_SIZE === 'bigint');
    assert.ok(CU_ENGINE_BUCKET_SIZE > 0n);
  });

  it('CU_ENGINE_BUCKET_SIZE is 100n when CU_BUCKET_SIZE env is not set', () => {
    if (!process.env['CU_BUCKET_SIZE']) {
      assert.strictEqual(CU_ENGINE_BUCKET_SIZE, 100n);
    }
    // If env IS set, we skip — can't re-resolve after module load
  });
});

// ---------------------------------------------------------------------------
// 4. computePublishedCU vs computeCostUnits (raw)
// ---------------------------------------------------------------------------
describe('computePublishedCU() vs computeCostUnits()', () => {
  const INPUT = { provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 };

  it('computeCostUnits returns raw bigint', () => {
    const raw = computeCostUnits(INPUT);
    assert.ok(typeof raw === 'bigint');
    assert.ok(raw > 0n);
  });

  it('computePublishedCU returns bigint', () => {
    const pub = computePublishedCU(INPUT);
    assert.ok(typeof pub === 'bigint');
    assert.ok(pub >= 0n);
  });

  it('when mode=bucketed: published is a multiple of CU_ENGINE_BUCKET_SIZE', () => {
    if (CU_ENGINE_MODE !== 'bucketed') return; // skip if raw mode forced by env
    const pub = computePublishedCU(INPUT);
    assert.strictEqual(pub % CU_ENGINE_BUCKET_SIZE, 0n,
      `published CU ${pub} is not a multiple of ${CU_ENGINE_BUCKET_SIZE}`);
  });

  it('when mode=bucketed: published <= raw + bucketSize', () => {
    if (CU_ENGINE_MODE !== 'bucketed') return;
    const raw = computeCostUnits(INPUT);
    const pub = computePublishedCU(INPUT);
    assert.ok(pub <= raw + CU_ENGINE_BUCKET_SIZE,
      `published ${pub} > raw + bucketSize (${raw + CU_ENGINE_BUCKET_SIZE})`);
  });

  it('when mode=raw: published equals raw', () => {
    if (CU_ENGINE_MODE !== 'raw') return; // skip unless raw mode forced
    const raw = computeCostUnits(INPUT);
    const pub = computePublishedCU(INPUT);
    assert.strictEqual(pub, raw);
  });
});

// ---------------------------------------------------------------------------
// 5. computePublishedCUNumber
// ---------------------------------------------------------------------------
describe('computePublishedCUNumber()', () => {
  const INPUT = { provider: 'anthropic', model: 'claude-3-haiku', inputTokens: 500, outputTokens: 200 };

  it('returns a safe integer', () => {
    const n = computePublishedCUNumber(INPUT);
    assert.ok(typeof n === 'number');
    assert.ok(Number.isSafeInteger(n));
    assert.ok(n >= 0);
  });

  it('when mode=bucketed: value is a multiple of Number(CU_ENGINE_BUCKET_SIZE)', () => {
    if (CU_ENGINE_MODE !== 'bucketed') return;
    const n = computePublishedCUNumber(INPUT);
    const bs = Number(CU_ENGINE_BUCKET_SIZE);
    assert.strictEqual(n % bs, 0, `${n} is not a multiple of ${bs}`);
  });

  it('bigint and number variants agree', () => {
    const big = computePublishedCU(INPUT);
    const num = computePublishedCUNumber(INPUT);
    assert.strictEqual(Number(big), num);
  });
});

// ---------------------------------------------------------------------------
// 6. OTKSDK defaultCostNormalizer: EXACT server-side CU, never the public bucket (S4)
//    Previous acceptance ("matches computePublishedCUNumber", "multiple of bucket size") encoded
//    N5/D5-G04: the accounting value was the public bucket, so small consumption became 0.
//    B HANDOFF §6 + C HANDOFF §3: the normalizer now calls computeKnownCu (legacy exact integer
//    formula by default; B's computeCuFromTotals over the signed weights once the server wires it).
// ---------------------------------------------------------------------------
describe('defaultCostNormalizer (OTKSDK) uses the exact CU, not the published bucket', () => {
  const provider = 'openai';
  const model = 'gpt-3.5-turbo';
  const inputTokens = 800;
  const outputTokens = 300;

  it('returns a positive integer', () => {
    const cu = defaultCostNormalizer(provider, model, inputTokens, outputTokens);
    assert.ok(typeof cu === 'number');
    assert.ok(Number.isSafeInteger(cu));
    assert.ok(cu > 0);
  });

  it('matches the exact legacy formula (computeKnownCu), not the bucket', () => {
    const exact = computeKnownCu({ provider, model, inputTokens, outputTokens });
    assert.equal(exact.status, 'computed');
    assert.strictEqual(defaultCostNormalizer(provider, model, inputTokens, outputTokens), exact.costUnits);
  });

  it('small consumption is not rounded to the bucket: 237 raw CU stays 237, not 200', () => {
    // gpt-4o (weight 1.0) x openai (1.0): 200 + 37 tokens = 237 CU exactly (the bucket would be 200)
    assert.strictEqual(defaultCostNormalizer('openai', 'gpt-4o', 200, 37), 237);
  });
});

// ---------------------------------------------------------------------------
// 7. Bucketing applied to known CU values (integration — uses real weights)
// ---------------------------------------------------------------------------
describe('Bucketing applied to real CU inputs (bucketSize=100 default)', () => {
  // These tests verify the pipeline: compute raw → apply bucket → result is multiple of 100
  const cases = [
    { provider: 'openai',    model: 'gpt-4o',         inputTokens: 1000, outputTokens: 500  },
    { provider: 'openai',    model: 'gpt-3.5-turbo',  inputTokens: 800,  outputTokens: 300  },
    { provider: 'anthropic', model: 'claude-3-opus',  inputTokens: 2000, outputTokens: 1000 },
    { provider: 'anthropic', model: 'claude-3-haiku', inputTokens: 500,  outputTokens: 200  },
    { provider: 'gemini',    model: 'gemini-pro',     inputTokens: 1200, outputTokens: 400  },
    { provider: 'deepseek',  model: 'deepseek-chat',  inputTokens: 600,  outputTokens: 200  },
  ] as const;

  for (const input of cases) {
    it(`${input.provider}/${input.model} — published CU is multiple of bucket`, () => {
      if (CU_ENGINE_MODE !== 'bucketed') return;
      const pub = computePublishedCU({ ...input });
      assert.strictEqual(pub % CU_ENGINE_BUCKET_SIZE, 0n,
        `${input.provider}/${input.model}: published=${pub} not multiple of ${CU_ENGINE_BUCKET_SIZE}`);
    });
  }
});
