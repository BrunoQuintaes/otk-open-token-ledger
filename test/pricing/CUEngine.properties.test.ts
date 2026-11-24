/**
 * CUEngine — Property-based tests (F5 / U1.8)
 *
 * Tests:
 * 1. Interface isolation: CUEngine exports match CostUnits.ts semantics
 * 2. Determinism: same input → same output across calls
 * 3. Monotonicity: more tokens → more CU
 * 4. Non-negativity: CU >= 0 for valid inputs
 * 5. Bigint purity: computeCostUnits always returns bigint
 * 6. Version tag: CU_VERSION is frozen
 * 7. Error propagation: unknown provider/model throw CUError with stable code
 * 8. CU_VERSION = 'CU_MODEL_v1'
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeCostUnits,
  computeCostUnitsNumber,
  isProviderSupported,
  isModelSupported,
  getSupportedProviders,
  getSupportedModels,
  CU_VERSION,
  CU_WEIGHT_SCALE,
  CU_ERROR,
  CUError,
  type CUInput,
} from '../../src/economics/CUEngine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID: CUInput = {
  provider: 'openai',
  model: 'gpt-4o',
  inputTokens: 1000,
  outputTokens: 500,
};

// ---------------------------------------------------------------------------
// 1. Metadata
// ---------------------------------------------------------------------------

describe('CUEngine — metadata', () => {
  it('CU_VERSION is CU_MODEL_v1', () => {
    assert.equal(CU_VERSION, 'CU_MODEL_v1');
  });

  it('CU_WEIGHT_SCALE is 1000n', () => {
    assert.equal(CU_WEIGHT_SCALE, 1000n);
  });
});

// ---------------------------------------------------------------------------
// 2. Interface isolation
// ---------------------------------------------------------------------------

describe('CUEngine — interface', () => {
  it('computeCostUnits is a function', () => {
    assert.equal(typeof computeCostUnits, 'function');
  });

  it('computeCostUnitsNumber is a function', () => {
    assert.equal(typeof computeCostUnitsNumber, 'function');
  });

  it('isProviderSupported / isModelSupported are functions', () => {
    assert.equal(typeof isProviderSupported, 'function');
    assert.equal(typeof isModelSupported, 'function');
  });

  it('getSupportedProviders returns non-empty array', () => {
    const providers = getSupportedProviders();
    assert.ok(providers.length > 0);
    assert.ok(providers.includes('openai'));
    assert.ok(providers.includes('anthropic'));
  });

  it('getSupportedModels returns non-empty array', () => {
    const models = getSupportedModels();
    assert.ok(models.length > 0);
    assert.ok(models.includes('gpt-4o'));
    assert.ok(models.includes('claude-3-opus'));
  });
});

// ---------------------------------------------------------------------------
// 3. Bigint purity
// ---------------------------------------------------------------------------

describe('CUEngine — bigint purity', () => {
  it('computeCostUnits returns bigint', () => {
    const cu = computeCostUnits(VALID);
    assert.equal(typeof cu, 'bigint');
  });

  it('result is non-negative bigint', () => {
    const cu = computeCostUnits(VALID);
    assert.ok(cu >= 0n);
  });

  it('computeCostUnitsNumber returns number', () => {
    const cu = computeCostUnitsNumber(VALID);
    assert.equal(typeof cu, 'number');
    assert.ok(Number.isInteger(cu));
  });
});

// ---------------------------------------------------------------------------
// 4. Determinism
// ---------------------------------------------------------------------------

describe('CUEngine — determinism', () => {
  it('same input → same output (100 calls)', () => {
    const first = computeCostUnits(VALID);
    for (let i = 0; i < 100; i++) {
      assert.equal(computeCostUnits(VALID), first);
    }
  });

  it('bigint and number facades agree', () => {
    const cuBig = computeCostUnits(VALID);
    const cuNum = BigInt(computeCostUnitsNumber(VALID));
    assert.equal(cuBig, cuNum);
  });
});

// ---------------------------------------------------------------------------
// 5. Monotonicity
// ---------------------------------------------------------------------------

describe('CUEngine — monotonicity', () => {
  it('more total tokens → more or equal CU', () => {
    const low = computeCostUnits({ ...VALID, inputTokens: 100, outputTokens: 100 });
    const mid = computeCostUnits({ ...VALID, inputTokens: 500, outputTokens: 500 });
    const high = computeCostUnits({ ...VALID, inputTokens: 1000, outputTokens: 1000 });
    assert.ok(low <= mid, `low(${low}) <= mid(${mid})`);
    assert.ok(mid <= high, `mid(${mid}) <= high(${high})`);
  });

  it('zero tokens → zero CU', () => {
    const cu = computeCostUnits({ ...VALID, inputTokens: 0, outputTokens: 0 });
    assert.equal(cu, 0n);
  });

  it('heavier model → more CU (same tokens)', () => {
    const light = computeCostUnits({ ...VALID, model: 'gpt-3.5-turbo' });
    const heavy = computeCostUnits({ ...VALID, model: 'gpt-4-turbo' });
    assert.ok(light < heavy, `gpt-3.5-turbo(${light}) < gpt-4-turbo(${heavy})`);
  });

  it('heavier provider → more CU (same tokens, same model via anthropic)', () => {
    const cheaper = computeCostUnits({ ...VALID, provider: 'deepseek', model: 'deepseek-chat' });
    const pricier = computeCostUnits({ ...VALID, provider: 'anthropic', model: 'claude-3-opus' });
    assert.ok(cheaper < pricier, `deepseek(${cheaper}) < anthropic(${pricier})`);
  });
});

// ---------------------------------------------------------------------------
// 6. Error propagation
// ---------------------------------------------------------------------------

describe('CUEngine — errors', () => {
  it('unknown provider throws CUError with UNKNOWN_PROVIDER code', () => {
    assert.throws(
      () => computeCostUnits({ ...VALID, provider: 'unknown_xyz' }),
      (err: unknown) => {
        assert.ok(err instanceof CUError);
        assert.equal(err.code, CU_ERROR.UNKNOWN_PROVIDER);
        return true;
      }
    );
  });

  it('unknown model throws CUError with UNKNOWN_MODEL code', () => {
    assert.throws(
      () => computeCostUnits({ ...VALID, model: 'gpt-999-ultra-turbo' }),
      (err: unknown) => {
        assert.ok(err instanceof CUError);
        assert.equal(err.code, CU_ERROR.UNKNOWN_MODEL);
        return true;
      }
    );
  });

  it('negative inputTokens throws CUError with NEGATIVE_TOKENS', () => {
    assert.throws(
      () => computeCostUnits({ ...VALID, inputTokens: -1 }),
      (err: unknown) => {
        assert.ok(err instanceof CUError);
        assert.equal(err.code, CU_ERROR.NEGATIVE_TOKENS);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// 7. Golden values (regression anchors)
// ---------------------------------------------------------------------------

describe('CUEngine — golden values', () => {
  it('openai/gpt-4o 1000+500 = 1500 CU', () => {
    // (1000+500) * 1000 * 1000 / 1_000_000 = 1500
    assert.equal(computeCostUnits(VALID), 1500n);
  });

  it('anthropic/claude-3-opus 1000+1000 = 3960 CU', () => {
    // (2000) * 1800 * 1100 / 1_000_000 = 3960
    const cu = computeCostUnits({ provider: 'anthropic', model: 'claude-3-opus', inputTokens: 1000, outputTokens: 1000 });
    assert.equal(cu, 3960n);
  });

  it('CU_VERSION is stable across imports', async () => {
    const { CU_VERSION: v2 } = await import('../../src/economics/CUEngine.js');
    assert.equal(v2, 'CU_MODEL_v1');
  });
});
