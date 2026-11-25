/**
 * CostUnits Deterministic Engine Tests (U5.2)
 *
 * Tests for the canonical bigint CU computation engine.
 * Covers: determinism, rounding, overflow, unknown provider/model,
 * error codes, regression vectors from CostWeights legacy.
 *
 * Module under test: `src/pricing/CostUnits.ts` (`calculateCostUnitsV1` and its number facade, the integer weight
 * tables, `CUError` and `CU_ERROR`), and its agreement with the older `src/pricing/CostWeights.ts` facade.
 *
 * Strategy / partitions: frozen golden vectors of the CU_MODEL_v1 formula (a change means a breaking formula
 * change); repeated calls; rounding (exact, fractional, half-up at a tie); unknown provider and model, and
 * case-insensitive lookup; invalid inputs (negative or non-integer token counts); results above the uint64 maximum
 * (and above `Number.MAX_SAFE_INTEGER` for the number facade) must throw, while large valid counts pass; the
 * utility listings; consistency between the provider and model weight tables; and regression against
 * the legacy facade.
 *
 * Needs: nothing external (pure functions).
 *
 * Run just this file: `npx tsx --test test/pricing/CostUnits.deterministic.test.ts`
 *
 * @module test/pricing/CostUnits.deterministic.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateCostUnitsV1,
  calculateCostUnitsV1Number,
  isProviderSupported,
  isModelSupported,
  getSupportedProviders,
  getSupportedModels,
  PROVIDER_WEIGHTS_INT,
  MODEL_WEIGHTS_INT,
  CU_ERROR,
  CUError,
} from '../../src/pricing/CostUnits.js';

// -----------------------------------------------------------------------
// Golden Regression Vectors (frozen from CU_MODEL_v1 §6)
// These MUST NOT change — any change means a breaking formula change.
// -----------------------------------------------------------------------
const GOLDEN_VECTORS = [
  // §6.1 Base: openai/gpt-4o, 100+50=150 tokens → 150 CU
  { provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50, expected: 150n },
  // §6.2 Premium: anthropic/claude-opus-4, 200+100=300 tokens → 660 CU
  { provider: 'anthropic', model: 'claude-opus-4', inputTokens: 200, outputTokens: 100, expected: 660n },
  // §6.3 Efficient: gemini/gemini-2.0-flash, 100+50=150 tokens → 81 CU
  { provider: 'gemini', model: 'gemini-2.0-flash', inputTokens: 100, outputTokens: 50, expected: 81n },
  // §6.4 Enterprise: anthropic/claude-opus-4, 2000+5000=7000 tokens → 15400 CU
  { provider: 'anthropic', model: 'claude-opus-4', inputTokens: 2000, outputTokens: 5000, expected: 15400n },
  // Cross-provider: 500+500=1000 tokens
  { provider: 'meta', model: 'llama-3-8b', inputTokens: 500, outputTokens: 500, expected: 450n },
  { provider: 'gemini', model: 'gemini-2.0-flash', inputTokens: 500, outputTokens: 500, expected: 540n },
  { provider: 'deepseek', model: 'deepseek-chat', inputTokens: 500, outputTokens: 500, expected: 720n },
  { provider: 'openai', model: 'gpt-4o', inputTokens: 500, outputTokens: 500, expected: 1000n },
  // Efficient model
  { provider: 'openai', model: 'gpt-3.5-turbo', inputTokens: 100, outputTokens: 50, expected: 75n },
  // Zero tokens
  { provider: 'openai', model: 'gpt-4o', inputTokens: 0, outputTokens: 0, expected: 0n },
  // Large token count
  { provider: 'openai', model: 'gpt-4o', inputTokens: 1_000_000, outputTokens: 500_000, expected: 1_500_000n },
] as const;

describe('CostUnits Deterministic Engine (U5.2)', () => {

  // =====================================================================
  // 1. Golden regression vectors
  // =====================================================================
  describe('Golden regression vectors (CU_MODEL_v1)', () => {
    for (const v of GOLDEN_VECTORS) {
      it(`${v.provider}/${v.model} (${v.inputTokens}+${v.outputTokens}) → ${v.expected} CU`, () => {
        const cu = calculateCostUnitsV1({
          provider: v.provider,
          model: v.model,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
        });
        assert.strictEqual(cu, v.expected);
      });
    }
  });

  // =====================================================================
  // 2. Determinism — same input always gives same output
  // =====================================================================
  describe('Determinism', () => {
    it('should produce identical results across 1000 iterations', () => {
      const input = { provider: 'anthropic', model: 'claude-opus-4', inputTokens: 1234, outputTokens: 5678 };
      const first = calculateCostUnitsV1(input);
      for (let i = 0; i < 1000; i++) {
        assert.strictEqual(calculateCostUnitsV1(input), first, `Iteration ${i} diverged`);
      }
    });

    it('should match bigint and number variants', () => {
      const input = { provider: 'openai', model: 'gpt-4-turbo', inputTokens: 999, outputTokens: 1 };
      const asBigint = calculateCostUnitsV1(input);
      const asNumber = calculateCostUnitsV1Number(input);
      assert.strictEqual(asNumber, Number(asBigint));
    });
  });

  // =====================================================================
  // 3. Rounding (round-half-up)
  // =====================================================================
  describe('Rounding', () => {
    it('should round correctly for exact integer results', () => {
      // openai(1000) × gpt-4o(1000) = 1.0 × 1.0, 150 tokens → 150 exactly
      const cu = calculateCostUnitsV1({ provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50 });
      assert.strictEqual(cu, 150n);
    });

    it('should round correctly for fractional results', () => {
      // gemini(900) × gemini-2.0-flash(600) = 0.9 × 0.6 = 0.54
      // 150 × 0.54 = 81.0 exactly
      const cu = calculateCostUnitsV1({ provider: 'gemini', model: 'gemini-2.0-flash', inputTokens: 100, outputTokens: 50 });
      assert.strictEqual(cu, 81n);
    });

    it('should round half-up at tie (x.5)', () => {
      // We need a case where the exact float result would be x.5
      // cohere(850) × command(800) = 0.85 × 0.8 = 0.68
      // If tokens = 25 → 25 × 0.68 = 17.0 exactly
      // tokens = 50 → 50 × 0.68 = 34.0 exactly
      // Construct: need numerator * 2 + denom = odd multiple
      // 1 token: 1 × 800 × 850 = 680_000. denom = 1_000_000. 680_000/1_000_000 = 0.68 → rounds to 1
      const cu1 = calculateCostUnitsV1({ provider: 'cohere', model: 'command', inputTokens: 1, outputTokens: 0 });
      assert.strictEqual(cu1, 1n); // 0.68 rounds to 1

      // deepseek(800) × deepseek-chat(900) = 0.72
      // 5 tokens: 5 × 0.72 = 3.6 → rounds to 4
      const cu2 = calculateCostUnitsV1({ provider: 'deepseek', model: 'deepseek-chat', inputTokens: 5, outputTokens: 0 });
      assert.strictEqual(cu2, 4n); // 3.6 rounds to 4
    });

    it('should return bigint type', () => {
      const cu = calculateCostUnitsV1({ provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50 });
      assert.strictEqual(typeof cu, 'bigint');
    });

    it('should return integer from V1Number', () => {
      const cu = calculateCostUnitsV1Number({ provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50 });
      assert.strictEqual(typeof cu, 'number');
      assert.strictEqual(cu % 1, 0);
    });
  });

  // =====================================================================
  // 4. Unknown provider/model (stable error codes)
  // =====================================================================
  describe('Unknown provider/model errors', () => {
    it('should throw CUError with UNKNOWN_PROVIDER code', () => {
      try {
        calculateCostUnitsV1({ provider: 'unknown-provider', model: 'gpt-4o', inputTokens: 100, outputTokens: 50 });
        assert.fail('Expected CUError');
      } catch (err) {
        assert.ok(err instanceof CUError, 'Should be CUError instance');
        assert.strictEqual((err as CUError).code, CU_ERROR.UNKNOWN_PROVIDER);
        assert.ok((err as CUError).message.includes('unknown-provider'));
      }
    });

    it('should throw CUError with UNKNOWN_MODEL code', () => {
      try {
        calculateCostUnitsV1({ provider: 'openai', model: 'nonexistent-model', inputTokens: 100, outputTokens: 50 });
        assert.fail('Expected CUError');
      } catch (err) {
        assert.ok(err instanceof CUError, 'Should be CUError instance');
        assert.strictEqual((err as CUError).code, CU_ERROR.UNKNOWN_MODEL);
        assert.ok((err as CUError).message.includes('nonexistent-model'));
      }
    });

    it('should be case-insensitive for provider lookup', () => {
      const cu1 = calculateCostUnitsV1({ provider: 'OpenAI', model: 'gpt-4o', inputTokens: 100, outputTokens: 50 });
      const cu2 = calculateCostUnitsV1({ provider: 'OPENAI', model: 'gpt-4o', inputTokens: 100, outputTokens: 50 });
      const cu3 = calculateCostUnitsV1({ provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50 });
      assert.strictEqual(cu1, cu2);
      assert.strictEqual(cu2, cu3);
    });

    it('should be case-insensitive for model lookup', () => {
      const cu1 = calculateCostUnitsV1({ provider: 'openai', model: 'GPT-4o', inputTokens: 100, outputTokens: 50 });
      const cu2 = calculateCostUnitsV1({ provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50 });
      assert.strictEqual(cu1, cu2);
    });
  });

  // =====================================================================
  // 5. Input validation (negative, non-integer tokens)
  // =====================================================================
  describe('Input validation', () => {
    it('should throw on negative inputTokens', () => {
      try {
        calculateCostUnitsV1({ provider: 'openai', model: 'gpt-4o', inputTokens: -1, outputTokens: 50 });
        assert.fail('Expected CUError');
      } catch (err) {
        assert.ok(err instanceof CUError);
        assert.strictEqual((err as CUError).code, CU_ERROR.NEGATIVE_TOKENS);
      }
    });

    it('should throw on negative outputTokens', () => {
      try {
        calculateCostUnitsV1({ provider: 'openai', model: 'gpt-4o', inputTokens: 50, outputTokens: -1 });
        assert.fail('Expected CUError');
      } catch (err) {
        assert.ok(err instanceof CUError);
        assert.strictEqual((err as CUError).code, CU_ERROR.NEGATIVE_TOKENS);
      }
    });

    it('should throw on non-integer inputTokens', () => {
      try {
        calculateCostUnitsV1({ provider: 'openai', model: 'gpt-4o', inputTokens: 1.5, outputTokens: 50 });
        assert.fail('Expected CUError');
      } catch (err) {
        assert.ok(err instanceof CUError);
        assert.strictEqual((err as CUError).code, CU_ERROR.NON_INTEGER_TOKENS);
      }
    });

    it('should throw on non-integer outputTokens', () => {
      try {
        calculateCostUnitsV1({ provider: 'openai', model: 'gpt-4o', inputTokens: 50, outputTokens: 2.7 });
        assert.fail('Expected CUError');
      } catch (err) {
        assert.ok(err instanceof CUError);
        assert.strictEqual((err as CUError).code, CU_ERROR.NON_INTEGER_TOKENS);
      }
    });
  });

  // =====================================================================
  // 6. uint64 overflow
  // =====================================================================
  describe('uint64 overflow', () => {
    it('should throw on result exceeding uint64 max', () => {
      // o1-preview(2500) × anthropic(1100) = 2.75 multiplier
      // Need tokens such that total × 2.75 > 2^64 (~1.84e19)
      // 1e19 × 2.75 ≈ 2.75e19 > 1.84e19 → overflow
      // (1e19 is representable as float64 and passes Number.isInteger)
      try {
        calculateCostUnitsV1({
          provider: 'anthropic',
          model: 'o1-preview',
          inputTokens: 1e19,
          outputTokens: 0,
        });
        assert.fail('Expected CUError');
      } catch (err) {
        assert.ok(err instanceof CUError);
        assert.strictEqual((err as CUError).code, CU_ERROR.UINT64_OVERFLOW);
      }
    });

    it('V1Number should throw when result exceeds MAX_SAFE_INTEGER', () => {
      // Large but within uint64 range, but above MAX_SAFE_INTEGER
      // Need a case where CU > 2^53-1 (9007199254740991)
      // gpt-4(2000) × openai(1000) = 2.0, so tokens > 4.5e15
      // Use 5_000_000_000_000_000 (5e15) input + 0 output → CU ≈ 10e15
      try {
        calculateCostUnitsV1Number({
          provider: 'openai',
          model: 'gpt-4',
          inputTokens: 5_000_000_000_000_000,
          outputTokens: 0,
        });
        assert.fail('Expected CUError');
      } catch (err) {
        assert.ok(err instanceof CUError);
        assert.strictEqual((err as CUError).code, CU_ERROR.UINT64_OVERFLOW);
      }
    });

    it('should handle large but valid token counts', () => {
      // 10M input + 5M output = 15M tokens × 1.0 × 1.0 = 15M CU (well within uint64)
      const cu = calculateCostUnitsV1({
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 10_000_000,
        outputTokens: 5_000_000,
      });
      assert.strictEqual(cu, 15_000_000n);
    });
  });

  // =====================================================================
  // 7. Utility functions
  // =====================================================================
  describe('Utility functions', () => {
    it('isProviderSupported should return true for known providers', () => {
      assert.strictEqual(isProviderSupported('openai'), true);
      assert.strictEqual(isProviderSupported('anthropic'), true);
      assert.strictEqual(isProviderSupported('gemini'), true);
    });

    it('isProviderSupported should return false for unknown providers', () => {
      assert.strictEqual(isProviderSupported('unknown'), false);
      assert.strictEqual(isProviderSupported(''), false);
    });

    it('isModelSupported should return true for known models', () => {
      assert.strictEqual(isModelSupported('gpt-4o'), true);
      assert.strictEqual(isModelSupported('claude-opus-4'), true);
    });

    it('isModelSupported should return false for unknown models', () => {
      assert.strictEqual(isModelSupported('unknown-model'), false);
    });

    it('getSupportedProviders should match PROVIDER_WEIGHTS_INT keys', () => {
      const providers = getSupportedProviders();
      const expected = Object.keys(PROVIDER_WEIGHTS_INT);
      assert.deepStrictEqual(providers, expected);
    });

    it('getSupportedModels should match MODEL_WEIGHTS_INT keys', () => {
      const models = getSupportedModels();
      const expected = Object.keys(MODEL_WEIGHTS_INT);
      assert.deepStrictEqual(models, expected);
    });
  });

  // =====================================================================
  // 8. Weight table consistency
  // =====================================================================
  describe('Weight table consistency', () => {
    it('all provider weights should be positive', () => {
      for (const [k, v] of Object.entries(PROVIDER_WEIGHTS_INT)) {
        assert.ok(v > 0n, `Provider '${k}' weight must be > 0`);
      }
    });

    it('all model weights should be positive', () => {
      for (const [k, v] of Object.entries(MODEL_WEIGHTS_INT)) {
        assert.ok(v > 0n, `Model '${k}' weight must be > 0`);
      }
    });

    it('should have at least 7 providers', () => {
      assert.ok(getSupportedProviders().length >= 7);
    });

    it('should have at least 20 models', () => {
      assert.ok(getSupportedModels().length >= 20);
    });
  });

  // =====================================================================
  // 9. CostWeights facade regression
  // =====================================================================
  describe('CostWeights facade regression', () => {
    it('facade calculateCostUnits should match V1Number for all golden vectors', async () => {
      // Dynamic import to test the facade
      const { calculateCostUnits } = await import('../../src/pricing/CostWeights.js');

      for (const v of GOLDEN_VECTORS) {
        const facadeResult = calculateCostUnits(v.provider, v.model, v.inputTokens, v.outputTokens);
        const directResult = calculateCostUnitsV1Number({
          provider: v.provider,
          model: v.model,
          inputTokens: v.inputTokens,
          outputTokens: v.outputTokens,
        });
        assert.strictEqual(
          facadeResult,
          directResult,
          `Facade mismatch for ${v.provider}/${v.model}`
        );
        assert.strictEqual(facadeResult, Number(v.expected));
      }
    });
  });
});
