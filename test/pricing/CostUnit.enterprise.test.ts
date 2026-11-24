/**
 * Enterprise Cost Unit Tests (U5)
 *
 * Tests for multi-provider, multi-model weighted cost calculation.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  calculateCostUnits,
  isProviderSupported,
  isModelSupported,
  getSupportedProviders,
  getSupportedModels,
  PROVIDER_WEIGHTS,
  MODEL_WEIGHTS,
} from '../../src/pricing/CostWeights.js';

describe('Enterprise Cost Units (U5)', () => {
  describe('calculateCostUnits', () => {
    it('should calculate cost units with provider and model weights', () => {
      // GPT-4o (weight 1.0) on OpenAI (weight 1.0)
      // 100 input + 50 output = 150 tokens
      // 150 × 1.0 × 1.0 = 150
      const cost = calculateCostUnits('openai', 'gpt-4o', 100, 50);
      assert.strictEqual(cost, 150, 'Baseline calculation should match');
    });

    it('should apply provider weight correctly', () => {
      // Claude Opus 4 (weight 2.0) on Anthropic (weight 1.1)
      // 100 input + 50 output = 150 tokens
      // 150 × 2.0 × 1.1 = 330
      const cost = calculateCostUnits('anthropic', 'claude-opus-4', 100, 50);
      assert.strictEqual(cost, 330, 'Anthropic premium should apply');
    });

    it('should apply model weight correctly', () => {
      // GPT-3.5-turbo (weight 0.5) on OpenAI (weight 1.0)
      // 100 input + 50 output = 150 tokens
      // 150 × 0.5 × 1.0 = 75
      const cost = calculateCostUnits('openai', 'gpt-3.5-turbo', 100, 50);
      assert.strictEqual(cost, 75, 'Efficient model should have lower cost');
    });

    it('should handle discount providers correctly', () => {
      // DeepSeek Coder (weight 1.0) on DeepSeek (weight 0.8)
      // 100 input + 50 output = 150 tokens
      // 150 × 1.0 × 0.8 = 120
      const cost = calculateCostUnits('deepseek', 'deepseek-coder', 100, 50);
      assert.strictEqual(cost, 120, 'DeepSeek discount should apply');
    });

    it('should round to integer cost units', () => {
      // Gemini 2.0 Flash (weight 0.6) on Gemini (weight 0.9)
      // 100 input + 50 output = 150 tokens
      // 150 × 0.6 × 0.9 = 81
      const cost = calculateCostUnits('gemini', 'gemini-2.0-flash', 100, 50);
      assert.strictEqual(cost, 81, 'Should round to integer');
      assert.strictEqual(typeof cost, 'number', 'Should be a number');
      assert.strictEqual(cost % 1, 0, 'Should be integer (no decimals)');
    });

    it('should handle case-insensitive provider names', () => {
      const cost1 = calculateCostUnits('OpenAI', 'gpt-4o', 100, 50);
      const cost2 = calculateCostUnits('openai', 'gpt-4o', 100, 50);
      assert.strictEqual(cost1, cost2, 'Provider name should be case-insensitive');
    });

    it('should handle case-insensitive model names', () => {
      const cost1 = calculateCostUnits('openai', 'GPT-4o', 100, 50);
      const cost2 = calculateCostUnits('openai', 'gpt-4o', 100, 50);
      assert.strictEqual(cost1, cost2, 'Model name should be case-insensitive');
    });

    it('should throw error for unknown provider', () => {
      assert.throws(
        () => calculateCostUnits('unknown-provider', 'gpt-4o', 100, 50),
        /Unknown provider: unknown-provider/,
        'Should reject unknown provider'
      );
    });

    it('should throw error for unknown model', () => {
      assert.throws(
        () => calculateCostUnits('openai', 'unknown-model', 100, 50),
        /Unknown model: unknown-model/,
        'Should reject unknown model'
      );
    });

    it('should handle zero tokens', () => {
      const cost = calculateCostUnits('openai', 'gpt-4o', 0, 0);
      assert.strictEqual(cost, 0, 'Zero tokens should result in zero cost');
    });

    it('should handle large token counts', () => {
      // 1M input + 500K output = 1.5M tokens
      // 1,500,000 × 1.0 × 1.0 = 1,500,000
      const cost = calculateCostUnits('openai', 'gpt-4o', 1_000_000, 500_000);
      assert.strictEqual(cost, 1_500_000, 'Should handle large token counts');
    });
  });

  describe('Provider support checks', () => {
    it('should recognize supported providers', () => {
      assert.strictEqual(isProviderSupported('openai'), true);
      assert.strictEqual(isProviderSupported('anthropic'), true);
      assert.strictEqual(isProviderSupported('gemini'), true);
      assert.strictEqual(isProviderSupported('deepseek'), true);
    });

    it('should reject unsupported providers', () => {
      assert.strictEqual(isProviderSupported('unknown'), false);
      assert.strictEqual(isProviderSupported(''), false);
    });

    it('should be case-insensitive', () => {
      assert.strictEqual(isProviderSupported('OpenAI'), true);
      assert.strictEqual(isProviderSupported('ANTHROPIC'), true);
    });
  });

  describe('Model support checks', () => {
    it('should recognize supported models', () => {
      assert.strictEqual(isModelSupported('gpt-4o'), true);
      assert.strictEqual(isModelSupported('claude-opus-4'), true);
      assert.strictEqual(isModelSupported('gemini-pro'), true);
    });

    it('should reject unsupported models', () => {
      assert.strictEqual(isModelSupported('unknown-model'), false);
      assert.strictEqual(isModelSupported(''), false);
    });

    it('should be case-insensitive', () => {
      assert.strictEqual(isModelSupported('GPT-4O'), true);
      assert.strictEqual(isModelSupported('Claude-Opus-4'), true);
    });
  });

  describe('getSupportedProviders', () => {
    it('should return all provider keys', () => {
      const providers = getSupportedProviders();
      assert.ok(Array.isArray(providers), 'Should return array');
      assert.ok(providers.includes('openai'), 'Should include OpenAI');
      assert.ok(providers.includes('anthropic'), 'Should include Anthropic');
      assert.ok(providers.includes('gemini'), 'Should include Gemini');
      assert.ok(providers.includes('deepseek'), 'Should include DeepSeek');
    });

    it('should match PROVIDER_WEIGHTS keys', () => {
      const providers = getSupportedProviders();
      const expected = Object.keys(PROVIDER_WEIGHTS);
      assert.deepStrictEqual(providers, expected, 'Should match weight keys');
    });
  });

  describe('getSupportedModels', () => {
    it('should return all model keys', () => {
      const models = getSupportedModels();
      assert.ok(Array.isArray(models), 'Should return array');
      assert.ok(models.includes('gpt-4o'), 'Should include GPT-4o');
      assert.ok(models.includes('claude-opus-4'), 'Should include Claude Opus 4');
      assert.ok(models.length >= 20, 'Should have at least 20 models');
    });

    it('should match MODEL_WEIGHTS keys', () => {
      const models = getSupportedModels();
      const expected = Object.keys(MODEL_WEIGHTS);
      assert.deepStrictEqual(models, expected, 'Should match weight keys');
    });
  });

  describe('Real-world scenarios', () => {
    it('should calculate correctly for typical GPT-4 usage', () => {
      // Typical chat: 500 input, 300 output
      const cost = calculateCostUnits('openai', 'gpt-4o', 500, 300);
      // 800 × 1.0 × 1.0 = 800
      assert.strictEqual(cost, 800);
    });

    it('should calculate correctly for long-form Claude generation', () => {
      // Long-form generation: 2000 input, 5000 output
      const cost = calculateCostUnits('anthropic', 'claude-opus-4', 2000, 5000);
      // 7000 × 2.0 × 1.1 = 15,400
      assert.strictEqual(cost, 15_400);
    });

    it('should calculate correctly for cheap Gemini Flash', () => {
      // Fast interaction: 100 input, 50 output
      const cost = calculateCostUnits('gemini', 'gemini-2.0-flash', 100, 50);
      // 150 × 0.6 × 0.9 = 81
      assert.strictEqual(cost, 81);
    });

    it('should show cost difference between providers for same model tier', () => {
      // Compare high-tier models across providers
      const gpt4Turbo = calculateCostUnits('openai', 'gpt-4-turbo', 1000, 500);
      const claudeOpus = calculateCostUnits('anthropic', 'claude-opus-4', 1000, 500);
      const geminiUltra = calculateCostUnits('gemini', 'gemini-ultra', 1000, 500);

      // All should be in similar range but with provider adjustments
      assert.ok(gpt4Turbo > 0, 'GPT-4 Turbo should have cost');
      assert.ok(claudeOpus > gpt4Turbo, 'Claude Opus should be more expensive (Anthropic premium)');
      assert.ok(geminiUltra < claudeOpus, 'Gemini Ultra should be cheaper (Gemini discount)');
    });
  });
});
