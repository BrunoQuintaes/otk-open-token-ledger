/**
 * Real Adapter Tests (U11.3)
 *
 * Tests for GeminiAdapter (real Gemini API response shape) and
 * DeepSeekAdapter (real OpenAI-compatible response shape).
 *
 * Verifies:
 * - Correct parsing of real API response shapes
 * - CU determinism: same weights as U11.1 stubs (just different input shape)
 * - Error handling: MISSING_MODEL, MISSING_USAGE, INVALID_TOKENS
 * - ProviderRegistry fallback: stub when no API key, real when key present
 *
 * Modules under test: `src/providers/adapters/GeminiAdapter.ts`,
 * `src/providers/adapters/DeepSeekAdapter.ts` and `src/providers/ProviderRegistry.ts`.
 *
 * Strategy / partitions: a native response per provider; each missing or invalid field (model,
 * usage block, negative tokens); the fallback request id when the response id is absent;
 * DeepSeek cache fields that must not change the CU; registry built with the API key variables
 * unset vs set to a fake value, with the same CU either way.
 *
 * Needs: no network (only response parsing). The fallback block temporarily sets or deletes
 * `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` in `process.env` and restores the previous values in
 * its `after` hook.
 *
 * Run just this file: `npx tsx --test test/unit/RealAdapters.test.ts`
 *
 * @module test/unit/RealAdapters.test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { parseGeminiResponse } from '../../src/providers/adapters/GeminiAdapter.js';
import { parseDeepSeekResponse } from '../../src/providers/adapters/DeepSeekAdapter.js';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry.js';

const TS = 1700000000;

// ---------------------------------------------------------------------------
// GeminiAdapter (real Gemini API response shape)
// ---------------------------------------------------------------------------

describe('GeminiAdapter — real response parsing (U11.3)', () => {
  const realGeminiResponse = {
    modelVersion: 'gemini-pro',
    usageMetadata: {
      promptTokenCount: 200,
      candidatesTokenCount: 100,
      totalTokenCount: 300,
    },
    candidates: [],
    responseId: 'gemini-real-u11test',
  };

  it('parses real Gemini API response shape correctly', () => {
    const event = parseGeminiResponse(realGeminiResponse, 180, TS);
    assert.strictEqual(event.provider, 'gemini');
    assert.strictEqual(event.model, 'gemini-pro');
    assert.strictEqual(event.inputTokens, 200);
    assert.strictEqual(event.outputTokens, 100);
    assert.strictEqual(event.totalTokens, 300);
    assert.strictEqual(event.latencyMs, 180);
    // CU: gemini-pro(1.2) × gemini(0.9) × 300 = 324 — same as stub
    assert.strictEqual(event.costUnits, 324);
    assert.strictEqual(event.timestamp, TS);
    assert.strictEqual(event.requestId, 'gemini-real-u11test');
  });

  it('CU matches stub output for identical token counts (deterministic)', () => {
    const event = parseGeminiResponse(realGeminiResponse, 100, TS);
    // Must equal GeminiAdapterStub output for same provider/model/tokens
    assert.strictEqual(event.costUnits, 324);
  });

  it('throws MISSING_MODEL when modelVersion absent', () => {
    const bad = { usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 } };
    try {
      parseGeminiResponse(bad as any, 100, TS);
      assert.fail('Expected AdapterParseError');
    } catch (err: any) {
      assert.strictEqual(err.code, 'ADAPTER_MISSING_MODEL');
    }
  });

  it('throws MISSING_USAGE when usageMetadata absent', () => {
    const bad = { modelVersion: 'gemini-pro' };
    try {
      parseGeminiResponse(bad as any, 100, TS);
      assert.fail('Expected AdapterParseError');
    } catch (err: any) {
      assert.strictEqual(err.code, 'ADAPTER_MISSING_USAGE');
    }
  });

  it('throws INVALID_TOKENS on negative token counts', () => {
    const bad = {
      modelVersion: 'gemini-pro',
      usageMetadata: { promptTokenCount: -1, candidatesTokenCount: 50, totalTokenCount: 49 },
    };
    try {
      parseGeminiResponse(bad as any, 100, TS);
      assert.fail('Expected AdapterParseError');
    } catch (err: any) {
      assert.strictEqual(err.code, 'ADAPTER_INVALID_TOKENS');
    }
  });

  it('uses fallback requestId when responseId absent', () => {
    const noId = {
      modelVersion: 'gemini-pro',
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
    };
    const event = parseGeminiResponse(noId as any, 100, TS);
    assert.ok(event.requestId.startsWith('gemini-'), `Expected fallback requestId, got: ${event.requestId}`);
  });
});

// ---------------------------------------------------------------------------
// DeepSeekAdapter (real OpenAI-compatible response shape)
// ---------------------------------------------------------------------------

describe('DeepSeekAdapter — real response parsing (U11.3)', () => {
  const realDeepSeekResponse = {
    id: 'deepseek-real-u11test',
    object: 'chat.completion',
    created: TS,
    model: 'deepseek-chat',
    usage: {
      prompt_tokens: 200,
      completion_tokens: 100,
      total_tokens: 300,
    },
  };

  it('parses real DeepSeek API response shape correctly', () => {
    const event = parseDeepSeekResponse(realDeepSeekResponse, 120);
    assert.strictEqual(event.provider, 'deepseek');
    assert.strictEqual(event.model, 'deepseek-chat');
    assert.strictEqual(event.inputTokens, 200);
    assert.strictEqual(event.outputTokens, 100);
    assert.strictEqual(event.totalTokens, 300);
    assert.strictEqual(event.latencyMs, 120);
    // CU: deepseek-chat(0.9) × deepseek(0.8) × 300 = 216 — same as stub
    assert.strictEqual(event.costUnits, 216);
    assert.strictEqual(event.timestamp, TS);
    assert.strictEqual(event.requestId, 'deepseek-real-u11test');
  });

  it('CU matches stub output for identical token counts (deterministic)', () => {
    const event = parseDeepSeekResponse(realDeepSeekResponse, 100);
    assert.strictEqual(event.costUnits, 216);
  });

  it('includes DeepSeek cache fields without affecting CU', () => {
    const withCache = {
      ...realDeepSeekResponse,
      usage: {
        ...realDeepSeekResponse.usage,
        prompt_cache_hit_tokens: 50,
        prompt_cache_miss_tokens: 150,
      },
    };
    const event = parseDeepSeekResponse(withCache, 100);
    // CU is based on prompt_tokens + completion_tokens only
    assert.strictEqual(event.costUnits, 216);
  });

  it('throws MISSING_MODEL when model absent', () => {
    const bad = { id: 'x', created: TS, usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } };
    try {
      parseDeepSeekResponse(bad as any, 100);
      assert.fail('Expected AdapterParseError');
    } catch (err: any) {
      assert.strictEqual(err.code, 'ADAPTER_MISSING_MODEL');
    }
  });

  it('throws MISSING_USAGE when usage absent', () => {
    const bad = { id: 'x', model: 'deepseek-chat', created: TS };
    try {
      parseDeepSeekResponse(bad as any, 100);
      assert.fail('Expected AdapterParseError');
    } catch (err: any) {
      assert.strictEqual(err.code, 'ADAPTER_MISSING_USAGE');
    }
  });

  it('throws INVALID_TOKENS on negative prompt_tokens', () => {
    const bad = { id: 'x', model: 'deepseek-chat', created: TS, usage: { prompt_tokens: -5, completion_tokens: 50, total_tokens: 45 } };
    try {
      parseDeepSeekResponse(bad as any, 100);
      assert.fail('Expected AdapterParseError');
    } catch (err: any) {
      assert.strictEqual(err.code, 'ADAPTER_INVALID_TOKENS');
    }
  });
});

// ---------------------------------------------------------------------------
// ProviderRegistry fallback logic (U11.3)
// ---------------------------------------------------------------------------

describe('ProviderRegistry — real adapter fallback (U11.3)', () => {
  let savedGemini: string | undefined;
  let savedDeepSeek: string | undefined;

  before(() => {
    savedGemini = process.env.GEMINI_API_KEY;
    savedDeepSeek = process.env.DEEPSEEK_API_KEY;
  });

  after(() => {
    // Restore env
    if (savedGemini !== undefined) process.env.GEMINI_API_KEY = savedGemini;
    else delete process.env.GEMINI_API_KEY;
    if (savedDeepSeek !== undefined) process.env.DEEPSEEK_API_KEY = savedDeepSeek;
    else delete process.env.DEEPSEEK_API_KEY;
  });

  it('uses stub adapters when API keys absent', () => {
    delete process.env.GEMINI_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const registry = ProviderRegistry.createDefault();
    // Stubs accept GenericUsageInput
    const geminiEvent = registry.resolve('gemini').parseResponse(
      { id: 'g1', model: 'gemini-pro', inputTokens: 100, outputTokens: 50 },
      100, TS
    );
    assert.strictEqual(geminiEvent.provider, 'gemini');
    assert.strictEqual(geminiEvent.costUnits, 162); // round(150 × 1.2 × 0.9) = 162
  });

  it('uses real adapters when API keys present', () => {
    process.env.GEMINI_API_KEY = 'test-key-u11';
    process.env.DEEPSEEK_API_KEY = 'test-key-u11';
    const registry = ProviderRegistry.createDefault();
    // Real adapters accept native API response shapes
    const geminiEvent = registry.resolve('gemini').parseResponse(
      {
        modelVersion: 'gemini-pro',
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 },
        responseId: 'gr-test',
      },
      100, TS
    );
    assert.strictEqual(geminiEvent.provider, 'gemini');
    assert.strictEqual(geminiEvent.costUnits, 162); // same CU — weights unchanged
  });

  it('CU is identical whether stub or real adapter is used (determinism)', () => {
    // Without key → stub
    delete process.env.GEMINI_API_KEY;
    const registryStub = ProviderRegistry.createDefault();
    const stubEvent = registryStub.resolve('gemini').parseResponse(
      { id: 'x', model: 'gemini-pro', inputTokens: 200, outputTokens: 100 },
      100, TS
    );

    // With key → real
    process.env.GEMINI_API_KEY = 'test-key-u11';
    const registryReal = ProviderRegistry.createDefault();
    const realEvent = registryReal.resolve('gemini').parseResponse(
      {
        modelVersion: 'gemini-pro',
        usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 100, totalTokenCount: 300 },
      },
      100, TS
    );

    assert.strictEqual(stubEvent.costUnits, realEvent.costUnits,
      `CU must be identical: stub=${stubEvent.costUnits} real=${realEvent.costUnits}`);
    assert.strictEqual(realEvent.costUnits, 324);
  });
});
