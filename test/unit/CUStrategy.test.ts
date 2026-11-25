/**
 * CU Strategy Pattern + CU Bucketing — unit tests
 *
 * Checks how a Compute Unit (CU) amount is computed per provider family and how CU values are
 * rounded into privacy buckets.
 *
 * Modules under test: `src/economics/strategies/TokenBasedStrategy.ts`,
 * `src/economics/strategies/InferenceBasedStrategy.ts`, `src/economics/CUStrategyFactory.ts` and
 * `bucketCU` from `src/pricing/CostUnits.ts`.
 *
 * Strategy / partitions: token strategy (supported and unknown provider/model, bigint result,
 * `CUError` on an unknown model); latency-based inference strategy (supported provider, missing
 * `latencyMs`, unsupported provider); factory dispatch per provider and unknown provider;
 * `bucketCU` at exact multiples, just below, at and above half a bucket, zero, small values,
 * custom and default bucket size, negative CU and zero bucket size (both throw).
 *
 * Needs: nothing external (pure computation).
 *
 * Run just this file: `npx tsx --test test/unit/CUStrategy.test.ts`
 *
 * @since U5.2 / U8.6.3
 * @module test/unit/CUStrategy.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenBasedStrategy } from '../../src/economics/strategies/TokenBasedStrategy.js';
import { InferenceBasedStrategy } from '../../src/economics/strategies/InferenceBasedStrategy.js';
import { CUStrategyFactory } from '../../src/economics/CUStrategyFactory.js';
import { bucketCU, CU_DEFAULT_BUCKET } from '../../src/pricing/CostUnits.js';

// ---------------------------------------------------------------------------
// TokenBasedStrategy
// ---------------------------------------------------------------------------
describe('TokenBasedStrategy', () => {
  const strategy = new TokenBasedStrategy();

  it('strategyId is token_v1', () => {
    assert.strictEqual(strategy.strategyId, 'token_v1');
  });

  it('supports known openai+gpt-4o', () => {
    assert.ok(strategy.supports('openai', 'gpt-4o'));
  });

  it('supports anthropic+claude-3-haiku', () => {
    assert.ok(strategy.supports('anthropic', 'claude-3-haiku'));
  });

  it('does not support unknown provider', () => {
    assert.ok(!strategy.supports('unknown-llm', 'some-model'));
  });

  it('compute returns correct CU for gpt-4o (1000 in, 500 out)', () => {
    // CU = (1000+500) × W_gpt-4o(1000) × W_openai(1000) / 1e6 = 1500 × 1 × 1 = 1500
    const cu = strategy.compute({ provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 });
    assert.strictEqual(cu, 1500n);
  });

  it('compute returns bigint', () => {
    const cu = strategy.compute({ provider: 'anthropic', model: 'claude-3-opus', inputTokens: 100, outputTokens: 50 });
    assert.ok(typeof cu === 'bigint');
  });

  it('throws CUError on unknown model', () => {
    assert.throws(
      () => strategy.compute({ provider: 'openai', model: 'gpt-99', inputTokens: 10, outputTokens: 5 }),
      { name: 'CUError' }
    );
  });
});

// ---------------------------------------------------------------------------
// InferenceBasedStrategy
// ---------------------------------------------------------------------------
describe('InferenceBasedStrategy', () => {
  const strategy = new InferenceBasedStrategy();

  it('strategyId is inference_v0', () => {
    assert.strictEqual(strategy.strategyId, 'inference_v0');
  });

  it('supports stability provider', () => {
    assert.ok(strategy.supports('stability', 'sdxl'));
  });

  it('does NOT support openai (token-based provider)', () => {
    assert.ok(!strategy.supports('openai', 'gpt-4o'));
  });

  it('compute returns latency × scale', () => {
    // CU = round(100ms) × 10 / 1 = 1000
    const cu = strategy.compute({ provider: 'stability', model: 'sdxl', inputTokens: 0, outputTokens: 0, latencyMs: 100 });
    assert.strictEqual(cu, 1000n);
  });

  it('throws when latencyMs is missing', () => {
    assert.throws(
      () => strategy.compute({ provider: 'stability', model: 'sdxl', inputTokens: 0, outputTokens: 0 }),
      { name: 'CUError' }
    );
  });

  it('throws when provider not supported', () => {
    assert.throws(
      () => strategy.compute({ provider: 'openai', model: 'gpt-4o', inputTokens: 0, outputTokens: 0, latencyMs: 50 }),
      { name: 'CUError' }
    );
  });
});

// ---------------------------------------------------------------------------
// CUStrategyFactory
// ---------------------------------------------------------------------------
describe('CUStrategyFactory', () => {
  const factory = CUStrategyFactory.default();

  it('listStrategies() returns registered IDs', () => {
    const ids = factory.listStrategies();
    assert.ok(ids.includes('token_v1'), 'has token_v1');
    assert.ok(ids.includes('inference_v0'), 'has inference_v0');
  });

  it('resolve() picks inference strategy for stability', () => {
    const s = factory.resolve('stability', 'sdxl');
    assert.strictEqual(s.strategyId, 'inference_v0');
  });

  it('resolve() picks token strategy for openai', () => {
    const s = factory.resolve('openai', 'gpt-4o');
    assert.strictEqual(s.strategyId, 'token_v1');
  });

  it('compute() dispatches correctly for openai', () => {
    const cu = factory.compute({ provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 500 });
    assert.strictEqual(cu, 1500n);
  });

  it('throws for completely unknown provider', () => {
    assert.throws(
      () => factory.resolve('totally-unknown', 'model-x'),
      /No CU strategy found/
    );
  });
});

// ---------------------------------------------------------------------------
// CU Bucketing (U8.6.3)
// ---------------------------------------------------------------------------
describe('bucketCU', () => {
  it('exact multiple unchanged', () => {
    assert.strictEqual(bucketCU(1000n), 1000n);
    assert.strictEqual(bucketCU(500n), 500n);
  });

  it('rounds up at exactly half bucket', () => {
    // 1050 → 1100 (round half up, bucket=100)
    assert.strictEqual(bucketCU(1050n, 100n), 1100n);
  });

  it('rounds down below half', () => {
    // 1049 → 1000
    assert.strictEqual(bucketCU(1049n, 100n), 1000n);
  });

  it('rounds up above half', () => {
    // 1051 → 1100
    assert.strictEqual(bucketCU(1051n, 100n), 1100n);
  });

  it('zero returns zero', () => {
    assert.strictEqual(bucketCU(0n), 0n);
  });

  it('small values bucket correctly', () => {
    // 1 → 0 if bucket=100? No — round-half-up: (1×2+100)/(200) = 102/200 = 0 → 0
    assert.strictEqual(bucketCU(1n, 100n), 0n);
    // 50 → 100
    assert.strictEqual(bucketCU(50n, 100n), 100n);
  });

  it('custom bucket size (10)', () => {
    assert.strictEqual(bucketCU(15n, 10n), 20n);
    assert.strictEqual(bucketCU(14n, 10n), 10n);
  });

  it('default bucket is CU_DEFAULT_BUCKET (100)', () => {
    assert.strictEqual(CU_DEFAULT_BUCKET, 100n);
  });

  it('throws on negative CU', () => {
    assert.throws(() => bucketCU(-1n), { name: 'CUError' });
  });

  it('throws on zero bucket size', () => {
    assert.throws(() => bucketCU(100n, 0n), { name: 'CUError' });
  });
});
