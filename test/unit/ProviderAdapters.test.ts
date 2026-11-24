/**
 * Provider Adapter Tests (U7.5)
 *
 * Tests for OpenAI and Anthropic adapters with realistic JSON fixtures.
 * Validates: token parsing, CU computation, error handling, determinism.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  parseOpenAIResponse,
  type OpenAIChatCompletionResponse,
} from '../../src/providers/adapters/OpenAIAdapter.js';
import {
  parseAnthropicResponse,
  type AnthropicMessageResponse,
} from '../../src/providers/adapters/AnthropicAdapter.js';
import { AdapterParseError, ADAPTER_ERROR } from '../../src/providers/types.js';

// -----------------------------------------------------------------------
// Fixtures — realistic (sanitized) API response shapes
// -----------------------------------------------------------------------

const OPENAI_CHAT_FIXTURE: OpenAIChatCompletionResponse = {
  id: 'chatcmpl-abc123def456',
  object: 'chat.completion',
  created: 1700000000,
  model: 'gpt-4o',
  usage: {
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
  },
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content: 'Hello!' },
      finish_reason: 'stop',
    },
  ],
};

const OPENAI_TURBO_FIXTURE: OpenAIChatCompletionResponse = {
  id: 'chatcmpl-turbo-789',
  object: 'chat.completion',
  created: 1700000100,
  model: 'gpt-4-turbo',
  usage: {
    prompt_tokens: 500,
    completion_tokens: 300,
    total_tokens: 800,
  },
};

const ANTHROPIC_MESSAGE_FIXTURE: AnthropicMessageResponse = {
  id: 'msg_01XFDUDYJgAACzvnptvVoYEL',
  type: 'message',
  role: 'assistant',
  model: 'claude-sonnet-4',
  usage: {
    input_tokens: 200,
    output_tokens: 100,
  },
  content: [{ type: 'text', text: 'Hello from Claude!' }],
  stop_reason: 'end_turn',
};

const ANTHROPIC_OPUS_FIXTURE: AnthropicMessageResponse = {
  id: 'msg_02ABCopus456',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-4',
  usage: {
    input_tokens: 2000,
    output_tokens: 5000,
  },
  content: [{ type: 'text', text: 'Long response...' }],
  stop_reason: 'end_turn',
};

// -----------------------------------------------------------------------
// OpenAI Adapter Tests
// -----------------------------------------------------------------------

describe('OpenAI Adapter (U7.5)', () => {
  it('should parse a standard chat completion response', () => {
    const event = parseOpenAIResponse(OPENAI_CHAT_FIXTURE, 250);

    assert.strictEqual(event.provider, 'openai');
    assert.strictEqual(event.model, 'gpt-4o');
    assert.strictEqual(event.inputTokens, 100);
    assert.strictEqual(event.outputTokens, 50);
    assert.strictEqual(event.totalTokens, 150);
    assert.strictEqual(event.latencyMs, 250);
    assert.strictEqual(event.timestamp, 1700000000);
    assert.strictEqual(event.requestId, 'chatcmpl-abc123def456');
    // CU: gpt-4o(1.0) × openai(1.0) × 150 tokens = 150
    assert.strictEqual(event.costUnits, 150);
  });

  it('should parse gpt-4-turbo with correct CU', () => {
    const event = parseOpenAIResponse(OPENAI_TURBO_FIXTURE, 500);

    assert.strictEqual(event.model, 'gpt-4-turbo');
    assert.strictEqual(event.inputTokens, 500);
    assert.strictEqual(event.outputTokens, 300);
    assert.strictEqual(event.totalTokens, 800);
    // CU: gpt-4-turbo(1.5) × openai(1.0) × 800 tokens = 1200
    assert.strictEqual(event.costUnits, 1200);
  });

  it('should normalize model name to lowercase', () => {
    const fixture = { ...OPENAI_CHAT_FIXTURE, model: 'GPT-4o' };
    const event = parseOpenAIResponse(fixture, 100);
    assert.strictEqual(event.model, 'gpt-4o');
  });

  it('should strip date snapshot suffix from model name', () => {
    // OpenAI API returns versioned names like "gpt-4o-2024-08-06"
    const fixture = { ...OPENAI_CHAT_FIXTURE, model: 'gpt-4o-2024-08-06' };
    const event = parseOpenAIResponse(fixture, 100);
    assert.strictEqual(event.model, 'gpt-4o');
    // CU should match gpt-4o weights
    assert.strictEqual(event.costUnits, 150);
  });

  it('should strip date suffix from turbo model', () => {
    const fixture = { ...OPENAI_TURBO_FIXTURE, model: 'gpt-4-turbo-2024-04-09' };
    const event = parseOpenAIResponse(fixture, 100);
    assert.strictEqual(event.model, 'gpt-4-turbo');
  });

  it('should throw on missing usage field', () => {
    const noUsage = { ...OPENAI_CHAT_FIXTURE, usage: undefined };
    try {
      parseOpenAIResponse(noUsage as any, 100);
      assert.fail('Expected AdapterParseError');
    } catch (err) {
      assert.ok(err instanceof AdapterParseError);
      assert.strictEqual((err as AdapterParseError).code, ADAPTER_ERROR.MISSING_USAGE);
    }
  });

  it('should throw on missing model field', () => {
    const noModel = { ...OPENAI_CHAT_FIXTURE, model: '' };
    try {
      parseOpenAIResponse(noModel, 100);
      assert.fail('Expected AdapterParseError');
    } catch (err) {
      assert.ok(err instanceof AdapterParseError);
      assert.strictEqual((err as AdapterParseError).code, ADAPTER_ERROR.MISSING_MODEL);
    }
  });

  it('should throw on negative token counts', () => {
    const negTokens = {
      ...OPENAI_CHAT_FIXTURE,
      usage: { prompt_tokens: -1, completion_tokens: 50, total_tokens: 49 },
    };
    try {
      parseOpenAIResponse(negTokens, 100);
      assert.fail('Expected AdapterParseError');
    } catch (err) {
      assert.ok(err instanceof AdapterParseError);
      assert.strictEqual((err as AdapterParseError).code, ADAPTER_ERROR.INVALID_TOKENS);
    }
  });

  it('should throw on non-integer token counts', () => {
    const floatTokens = {
      ...OPENAI_CHAT_FIXTURE,
      usage: { prompt_tokens: 1.5, completion_tokens: 50, total_tokens: 51.5 },
    };
    try {
      parseOpenAIResponse(floatTokens, 100);
      assert.fail('Expected AdapterParseError');
    } catch (err) {
      assert.ok(err instanceof AdapterParseError);
      assert.strictEqual((err as AdapterParseError).code, ADAPTER_ERROR.INVALID_TOKENS);
    }
  });

  it('should handle zero tokens', () => {
    const zeroTokens = {
      ...OPENAI_CHAT_FIXTURE,
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    };
    const event = parseOpenAIResponse(zeroTokens, 50);
    assert.strictEqual(event.costUnits, 0);
    assert.strictEqual(event.totalTokens, 0);
  });

  it('should be deterministic across repeated calls', () => {
    const first = parseOpenAIResponse(OPENAI_CHAT_FIXTURE, 250);
    for (let i = 0; i < 100; i++) {
      const result = parseOpenAIResponse(OPENAI_CHAT_FIXTURE, 250);
      assert.deepStrictEqual(result, first, `Iteration ${i} diverged`);
    }
  });
});

// -----------------------------------------------------------------------
// Anthropic Adapter Tests
// -----------------------------------------------------------------------

describe('Anthropic Adapter (U7.5)', () => {
  const TS = 1700000000;

  it('should parse a standard message response', () => {
    const event = parseAnthropicResponse(ANTHROPIC_MESSAGE_FIXTURE, 300, TS);

    assert.strictEqual(event.provider, 'anthropic');
    assert.strictEqual(event.model, 'claude-sonnet-4');
    assert.strictEqual(event.inputTokens, 200);
    assert.strictEqual(event.outputTokens, 100);
    assert.strictEqual(event.totalTokens, 300);
    assert.strictEqual(event.latencyMs, 300);
    assert.strictEqual(event.timestamp, TS);
    assert.strictEqual(event.requestId, 'msg_01XFDUDYJgAACzvnptvVoYEL');
    // CU: claude-sonnet-4(1.5) × anthropic(1.1) × 300 tokens = 495
    assert.strictEqual(event.costUnits, 495);
  });

  it('should parse claude-opus-4 with correct CU', () => {
    const event = parseAnthropicResponse(ANTHROPIC_OPUS_FIXTURE, 1200, TS);

    assert.strictEqual(event.model, 'claude-opus-4');
    assert.strictEqual(event.inputTokens, 2000);
    assert.strictEqual(event.outputTokens, 5000);
    assert.strictEqual(event.totalTokens, 7000);
    // CU: claude-opus-4(2.0) × anthropic(1.1) × 7000 tokens = 15400
    assert.strictEqual(event.costUnits, 15400);
  });

  it('should normalize model name to lowercase', () => {
    const fixture = { ...ANTHROPIC_MESSAGE_FIXTURE, model: 'Claude-Sonnet-4' };
    const event = parseAnthropicResponse(fixture, 100, TS);
    assert.strictEqual(event.model, 'claude-sonnet-4');
  });

  it('should strip date snapshot suffix from model name', () => {
    // Anthropic API returns versioned names like "claude-sonnet-4-20250514"
    const fixture = { ...ANTHROPIC_MESSAGE_FIXTURE, model: 'claude-sonnet-4-20250514' };
    const event = parseAnthropicResponse(fixture, 100, TS);
    assert.strictEqual(event.model, 'claude-sonnet-4');
    // CU should match claude-sonnet-4 weights
    assert.strictEqual(event.costUnits, 495);
  });

  it('should strip date suffix from opus model', () => {
    const fixture = { ...ANTHROPIC_OPUS_FIXTURE, model: 'claude-opus-4-20250514' };
    const event = parseAnthropicResponse(fixture, 100, TS);
    assert.strictEqual(event.model, 'claude-opus-4');
  });

  it('should throw on missing usage field', () => {
    const noUsage = { ...ANTHROPIC_MESSAGE_FIXTURE, usage: undefined };
    try {
      parseAnthropicResponse(noUsage as any, 100, TS);
      assert.fail('Expected AdapterParseError');
    } catch (err) {
      assert.ok(err instanceof AdapterParseError);
      assert.strictEqual((err as AdapterParseError).code, ADAPTER_ERROR.MISSING_USAGE);
    }
  });

  it('should throw on missing model field', () => {
    const noModel = { ...ANTHROPIC_MESSAGE_FIXTURE, model: '' };
    try {
      parseAnthropicResponse(noModel, 100, TS);
      assert.fail('Expected AdapterParseError');
    } catch (err) {
      assert.ok(err instanceof AdapterParseError);
      assert.strictEqual((err as AdapterParseError).code, ADAPTER_ERROR.MISSING_MODEL);
    }
  });

  it('should throw on negative token counts', () => {
    const negTokens = {
      ...ANTHROPIC_MESSAGE_FIXTURE,
      usage: { input_tokens: 100, output_tokens: -5 },
    };
    try {
      parseAnthropicResponse(negTokens, 100, TS);
      assert.fail('Expected AdapterParseError');
    } catch (err) {
      assert.ok(err instanceof AdapterParseError);
      assert.strictEqual((err as AdapterParseError).code, ADAPTER_ERROR.INVALID_TOKENS);
    }
  });

  it('should handle zero tokens', () => {
    const zeroTokens = {
      ...ANTHROPIC_MESSAGE_FIXTURE,
      usage: { input_tokens: 0, output_tokens: 0 },
    };
    const event = parseAnthropicResponse(zeroTokens, 50, TS);
    assert.strictEqual(event.costUnits, 0);
    assert.strictEqual(event.totalTokens, 0);
  });

  it('should be deterministic across repeated calls', () => {
    const first = parseAnthropicResponse(ANTHROPIC_MESSAGE_FIXTURE, 300, TS);
    for (let i = 0; i < 100; i++) {
      const result = parseAnthropicResponse(ANTHROPIC_MESSAGE_FIXTURE, 300, TS);
      assert.deepStrictEqual(result, first, `Iteration ${i} diverged`);
    }
  });

  it('should use provided timestamp (not response-derived)', () => {
    const customTS = 1600000000;
    const event = parseAnthropicResponse(ANTHROPIC_MESSAGE_FIXTURE, 100, customTS);
    assert.strictEqual(event.timestamp, customTS);
  });
});

// -----------------------------------------------------------------------
// Cross-adapter consistency
// -----------------------------------------------------------------------

describe('Cross-adapter consistency (U7.5)', () => {
  it('should produce same CU for equivalent usage across adapters', () => {
    // Same tokens, but different providers → different CU (expected!)
    const openaiEvent = parseOpenAIResponse({
      ...OPENAI_CHAT_FIXTURE,
      model: 'gpt-4o',
      usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
    }, 100);

    // openai × gpt-4o: 1500 × 1.0 × 1.0 = 1500
    assert.strictEqual(openaiEvent.costUnits, 1500);
    assert.strictEqual(openaiEvent.provider, 'openai');

    const anthropicEvent = parseAnthropicResponse({
      ...ANTHROPIC_OPUS_FIXTURE,
      model: 'claude-opus-4',
      usage: { input_tokens: 1000, output_tokens: 500 },
    }, 100, 1700000000);

    // anthropic × claude-opus-4: 1500 × 2.0 × 1.1 = 3300
    assert.strictEqual(anthropicEvent.costUnits, 3300);
    assert.strictEqual(anthropicEvent.provider, 'anthropic');

    // Provider premium should make Anthropic more expensive
    assert.ok(anthropicEvent.costUnits > openaiEvent.costUnits);
  });

  it('NormalizedUsageEvent shape should be identical across adapters', () => {
    const openaiEvent = parseOpenAIResponse(OPENAI_CHAT_FIXTURE, 100);
    const anthropicEvent = parseAnthropicResponse(ANTHROPIC_MESSAGE_FIXTURE, 100, 1700000000);

    // Both should have exactly the same keys
    const openaiKeys = Object.keys(openaiEvent).sort();
    const anthropicKeys = Object.keys(anthropicEvent).sort();
    assert.deepStrictEqual(openaiKeys, anthropicKeys, 'Events must have identical shape');
  });
});
