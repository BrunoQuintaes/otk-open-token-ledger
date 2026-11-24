/**
 * ProviderRegistry Tests (U11.1)
 *
 * Tests for the pluggable adapter registry:
 * - Resolve adapters by provider ID (openai, anthropic, gemini, deepseek)
 * - Error handling: PROVIDER_NOT_FOUND, DUPLICATE_PROVIDER
 * - IProviderAdapter contract: each adapter returns NormalizedUsageEvent
 * - listProviders / isRegistered
 * - Case-insensitive resolution
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ProviderRegistry } from '../../src/providers/ProviderRegistry.js';
import { RegistryError, REGISTRY_ERROR } from '../../src/providers/types.js';

// -----------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------

const TS = 1700000000; // Unix seconds (fixed for determinism)

const OPENAI_FIXTURE = {
  id: 'chatcmpl-u11test',
  object: 'chat.completion',
  created: TS,
  model: 'gpt-4o',
  usage: { prompt_tokens: 200, completion_tokens: 100, total_tokens: 300 },
};

const ANTHROPIC_FIXTURE = {
  id: 'msg-u11test',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4',
  usage: { input_tokens: 200, output_tokens: 100 },
  content: [],
  stop_reason: 'end_turn',
};

const GEMINI_FIXTURE = {
  id: 'gemini-u11test',
  model: 'gemini-pro',
  inputTokens: 200,
  outputTokens: 100,
};

const DEEPSEEK_FIXTURE = {
  id: 'ds-u11test',
  model: 'deepseek-chat',
  inputTokens: 200,
  outputTokens: 100,
};

// -----------------------------------------------------------------------
// ProviderRegistry Tests
// -----------------------------------------------------------------------

describe('ProviderRegistry (U11.1)', () => {
  describe('createDefault()', () => {
    it('should register all built-in providers', () => {
      const registry = ProviderRegistry.createDefault();
      const providers = registry.listProviders();
      assert.deepStrictEqual(providers, ['anthropic', 'cohere', 'deepseek', 'gemini', 'meta', 'mistral', 'openai']);
    });

    it('should list providers in alphabetical order', () => {
      const registry = ProviderRegistry.createDefault();
      const providers = registry.listProviders();
      const sorted = [...providers].sort();
      assert.deepStrictEqual(providers, sorted);
    });
  });

  describe('isRegistered()', () => {
    it('should return true for registered providers', () => {
      const registry = ProviderRegistry.createDefault();
      assert.strictEqual(registry.isRegistered('openai'), true);
      assert.strictEqual(registry.isRegistered('anthropic'), true);
      assert.strictEqual(registry.isRegistered('gemini'), true);
      assert.strictEqual(registry.isRegistered('deepseek'), true);
    });

    it('should return false for unknown provider', () => {
      const registry = ProviderRegistry.createDefault();
      assert.strictEqual(registry.isRegistered('unknown-provider'), false);
      assert.strictEqual(registry.isRegistered('totally-unknown-xyz'), false);
    });

    it('should be case-insensitive', () => {
      const registry = ProviderRegistry.createDefault();
      assert.strictEqual(registry.isRegistered('OpenAI'), true);
      assert.strictEqual(registry.isRegistered('ANTHROPIC'), true);
      assert.strictEqual(registry.isRegistered('Gemini'), true);
    });
  });

  describe('resolve() — success cases', () => {
    it('should resolve openai adapter', () => {
      const registry = ProviderRegistry.createDefault();
      const adapter = registry.resolve('openai');
      assert.strictEqual(adapter.providerId, 'openai');
    });

    it('should resolve anthropic adapter', () => {
      const registry = ProviderRegistry.createDefault();
      const adapter = registry.resolve('anthropic');
      assert.strictEqual(adapter.providerId, 'anthropic');
    });

    it('should resolve gemini adapter', () => {
      const registry = ProviderRegistry.createDefault();
      const adapter = registry.resolve('gemini');
      assert.strictEqual(adapter.providerId, 'gemini');
    });

    it('should resolve deepseek adapter', () => {
      const registry = ProviderRegistry.createDefault();
      const adapter = registry.resolve('deepseek');
      assert.strictEqual(adapter.providerId, 'deepseek');
    });

    it('should resolve case-insensitively', () => {
      const registry = ProviderRegistry.createDefault();
      const adapter = registry.resolve('OpenAI');
      assert.strictEqual(adapter.providerId, 'openai');
    });
  });

  describe('resolve() — error cases', () => {
    it('should throw RegistryError for unknown provider', () => {
      const registry = ProviderRegistry.createDefault();
      try {
        registry.resolve('unknown-provider');
        assert.fail('Expected RegistryError');
      } catch (err) {
        assert.ok(err instanceof RegistryError);
        assert.strictEqual((err as RegistryError).code, REGISTRY_ERROR.PROVIDER_NOT_FOUND);
        assert.ok((err as RegistryError).message.includes('unknown-provider'));
      }
    });

    it('should throw RegistryError for empty registry', () => {
      const registry = new ProviderRegistry();
      try {
        registry.resolve('openai');
        assert.fail('Expected RegistryError');
      } catch (err) {
        assert.ok(err instanceof RegistryError);
        assert.strictEqual((err as RegistryError).code, REGISTRY_ERROR.PROVIDER_NOT_FOUND);
      }
    });
  });

  describe('register() — duplicate detection', () => {
    it('should throw RegistryError on duplicate registration', () => {
      const registry = ProviderRegistry.createDefault();
      const duplicateAdapter = {
        providerId: 'openai',
        parseResponse: () => { throw new Error('should not be called'); },
      };
      try {
        registry.register(duplicateAdapter);
        assert.fail('Expected RegistryError');
      } catch (err) {
        assert.ok(err instanceof RegistryError);
        assert.strictEqual((err as RegistryError).code, REGISTRY_ERROR.DUPLICATE_PROVIDER);
      }
    });

    it('should detect duplicate case-insensitively', () => {
      const registry = new ProviderRegistry();
      registry.register({ providerId: 'openai', parseResponse: () => { throw new Error(); } });
      try {
        registry.register({ providerId: 'OpenAI', parseResponse: () => { throw new Error(); } });
        assert.fail('Expected RegistryError');
      } catch (err) {
        assert.ok(err instanceof RegistryError);
        assert.strictEqual((err as RegistryError).code, REGISTRY_ERROR.DUPLICATE_PROVIDER);
      }
    });
  });
});

// -----------------------------------------------------------------------
// Adapter Output Tests — each adapter must return valid NormalizedUsageEvent
// -----------------------------------------------------------------------

describe('ProviderRegistry — adapter output (U11.1)', () => {
  const registry = ProviderRegistry.createDefault();

  it('OpenAI adapter: correct provider/model/tokens/CU', () => {
    const event = registry.resolve('openai').parseResponse(OPENAI_FIXTURE, 250, TS);
    assert.strictEqual(event.provider, 'openai');
    assert.strictEqual(event.model, 'gpt-4o');
    assert.strictEqual(event.inputTokens, 200);
    assert.strictEqual(event.outputTokens, 100);
    assert.strictEqual(event.totalTokens, 300);
    assert.strictEqual(event.latencyMs, 250);
    // CU: gpt-4o(1.0) × openai(1.0) × 300 = 300
    assert.strictEqual(event.costUnits, 300);
    assert.strictEqual(event.timestamp, TS);
    assert.strictEqual(event.requestId, 'chatcmpl-u11test');
  });

  it('Anthropic adapter: correct provider/model/tokens/CU', () => {
    const event = registry.resolve('anthropic').parseResponse(ANTHROPIC_FIXTURE, 350, TS);
    assert.strictEqual(event.provider, 'anthropic');
    assert.strictEqual(event.model, 'claude-sonnet-4');
    assert.strictEqual(event.inputTokens, 200);
    assert.strictEqual(event.outputTokens, 100);
    assert.strictEqual(event.totalTokens, 300);
    assert.strictEqual(event.latencyMs, 350);
    // CU: claude-sonnet-4(1.5) × anthropic(1.1) × 300 = 495
    assert.strictEqual(event.costUnits, 495);
    assert.strictEqual(event.timestamp, TS);
    assert.strictEqual(event.requestId, 'msg-u11test');
  });

  it('Gemini stub: correct provider/model/tokens/CU', () => {
    const event = registry.resolve('gemini').parseResponse(GEMINI_FIXTURE, 180, TS);
    assert.strictEqual(event.provider, 'gemini');
    assert.strictEqual(event.model, 'gemini-pro');
    assert.strictEqual(event.inputTokens, 200);
    assert.strictEqual(event.outputTokens, 100);
    assert.strictEqual(event.totalTokens, 300);
    assert.strictEqual(event.latencyMs, 180);
    // CU: gemini-pro(1.2) × gemini(0.9) × 300 = round(324.0) = 324
    assert.strictEqual(event.costUnits, 324);
    assert.strictEqual(event.timestamp, TS);
    assert.strictEqual(event.requestId, 'gemini-u11test');
  });

  it('DeepSeek stub: correct provider/model/tokens/CU', () => {
    const event = registry.resolve('deepseek').parseResponse(DEEPSEEK_FIXTURE, 120, TS);
    assert.strictEqual(event.provider, 'deepseek');
    assert.strictEqual(event.model, 'deepseek-chat');
    assert.strictEqual(event.inputTokens, 200);
    assert.strictEqual(event.outputTokens, 100);
    assert.strictEqual(event.totalTokens, 300);
    assert.strictEqual(event.latencyMs, 120);
    // CU: deepseek-chat(0.9) × deepseek(0.8) × 300 = round(216.0) = 216
    assert.strictEqual(event.costUnits, 216);
    assert.strictEqual(event.timestamp, TS);
    assert.strictEqual(event.requestId, 'ds-u11test');
  });

  it('all adapters produce NormalizedUsageEvent with identical key shape', () => {
    const openaiEvent = registry.resolve('openai').parseResponse(OPENAI_FIXTURE, 100, TS);
    const anthropicEvent = registry.resolve('anthropic').parseResponse(ANTHROPIC_FIXTURE, 100, TS);
    const geminiEvent = registry.resolve('gemini').parseResponse(GEMINI_FIXTURE, 100, TS);
    const deepseekEvent = registry.resolve('deepseek').parseResponse(DEEPSEEK_FIXTURE, 100, TS);

    const expectedKeys = [
      'provider', 'model', 'inputTokens', 'outputTokens',
      'totalTokens', 'latencyMs', 'costUnits', 'timestamp', 'requestId',
    ].sort();

    for (const event of [openaiEvent, anthropicEvent, geminiEvent, deepseekEvent]) {
      const keys = Object.keys(event).sort();
      assert.deepStrictEqual(keys, expectedKeys, `Event shape mismatch for ${event.provider}`);
    }
  });

  it('CU is deterministic and matches expected values per CU_MODEL_v1', () => {
    const openaiEvent  = registry.resolve('openai').parseResponse(OPENAI_FIXTURE, 100, TS);
    const anthropicEvent = registry.resolve('anthropic').parseResponse(ANTHROPIC_FIXTURE, 100, TS);
    const geminiEvent  = registry.resolve('gemini').parseResponse(GEMINI_FIXTURE, 100, TS);
    const deepseekEvent = registry.resolve('deepseek').parseResponse(DEEPSEEK_FIXTURE, 100, TS);

    // CU = round(tokens × W_m × W_p) for 300 total tokens each:
    // openai:    gpt-4o(1.0)       × openai(1.0)    × 300 = 300
    // anthropic: claude-sonnet-4(1.5) × anthropic(1.1) × 300 = 495
    // gemini:    gemini-pro(1.2)   × gemini(0.9)    × 300 = 324
    // deepseek:  deepseek-chat(0.9) × deepseek(0.8) × 300 = 216
    assert.strictEqual(openaiEvent.costUnits, 300);
    assert.strictEqual(anthropicEvent.costUnits, 495);
    assert.strictEqual(geminiEvent.costUnits, 324);
    assert.strictEqual(deepseekEvent.costUnits, 216);

    // Ordering: deepseek < openai < gemini < anthropic (combined model+provider weight)
    assert.ok(deepseekEvent.costUnits < openaiEvent.costUnits);
    assert.ok(openaiEvent.costUnits < geminiEvent.costUnits);
    assert.ok(geminiEvent.costUnits < anthropicEvent.costUnits);
  });
});

// -----------------------------------------------------------------------
// Stub adapter error handling
// -----------------------------------------------------------------------

describe('ProviderRegistry — stub error handling (U11.1)', () => {
  const registry = ProviderRegistry.createDefault();

  it('Gemini stub: throws on missing model', () => {
    const badInput = { id: 'x', inputTokens: 100, outputTokens: 50 };
    try {
      registry.resolve('gemini').parseResponse(badInput, 100, TS);
      assert.fail('Expected AdapterParseError');
    } catch (err: any) {
      assert.strictEqual(err.code, 'ADAPTER_MISSING_MODEL');
    }
  });

  it('Gemini stub: throws on negative tokens', () => {
    const badInput = { id: 'x', model: 'gemini-pro', inputTokens: -1, outputTokens: 50 };
    try {
      registry.resolve('gemini').parseResponse(badInput, 100, TS);
      assert.fail('Expected AdapterParseError');
    } catch (err: any) {
      assert.strictEqual(err.code, 'ADAPTER_INVALID_TOKENS');
    }
  });

  it('DeepSeek stub: throws on missing usage', () => {
    const badInput = { id: 'x', model: 'deepseek-chat' };
    try {
      registry.resolve('deepseek').parseResponse(badInput, 100, TS);
      assert.fail('Expected AdapterParseError');
    } catch (err: any) {
      assert.strictEqual(err.code, 'ADAPTER_MISSING_USAGE');
    }
  });
});
