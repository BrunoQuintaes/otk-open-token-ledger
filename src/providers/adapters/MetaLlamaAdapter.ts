/**
 * ADAPT-03 — MetaLlamaAdapter
 * Meta Llama API adapter (via llama-api.com / Meta AI Inference API).
 *
 * Completions endpoint: POST https://api.llama-api.com/chat/completions
 * Response format: OpenAI-compatible (prompt_tokens / completion_tokens in usage)
 *
 * IMPORTANT: This adapter does NOT call the Meta Llama API.
 * It parses the JSON response AFTER it has been received.
 * API key management is the caller's responsibility.
 *
 * @module providers/adapters/MetaLlamaAdapter
 * @since W8-D ADAPT-03
 */

import { calculateCostUnitsV1Number } from '../../pricing/CostUnits.js';
import {
  NormalizedUsageEvent,
  AdapterParseError,
  ADAPTER_ERROR,
  IProviderAdapter,
} from '../types.js';

/**
 * Meta Llama API response shape (OpenAI-compatible, subset for metering).
 * Reference: https://llama.meta.com/docs/llama-everywhere/running-meta-llama-on-cloud-providers/
 */
export interface MetaLlamaChatCompletionResponse {
  id: string;
  object?: string;
  created?: number;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  [key: string]: unknown;
}

/**
 * Parse a Meta Llama API chat completion response into a NormalizedUsageEvent.
 * Meta Llama uses OpenAI-compatible response fields.
 *
 * @param response   Raw Meta Llama API JSON response
 * @param latencyMs  Request latency in milliseconds
 * @returns NormalizedUsageEvent
 * @throws AdapterParseError if required fields are missing or invalid
 * @throws {@link CUError} From the cost engine, when the lowercased model is not in the weight table.
 */
export function parseMetaLlamaResponse(
  response: MetaLlamaChatCompletionResponse,
  latencyMs: number,
): NormalizedUsageEvent {
  if (!response.model || typeof response.model !== 'string') {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_MODEL,
      'Meta Llama response missing "model" field',
    );
  }

  if (!response.usage) {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_USAGE,
      'Meta Llama response missing "usage" field',
    );
  }

  const { prompt_tokens, completion_tokens } = response.usage;

  if (
    typeof prompt_tokens !== 'number' || !Number.isInteger(prompt_tokens) || prompt_tokens < 0 ||
    typeof completion_tokens !== 'number' || !Number.isInteger(completion_tokens) || completion_tokens < 0
  ) {
    throw new AdapterParseError(
      ADAPTER_ERROR.INVALID_TOKENS,
      `Meta Llama response has invalid token counts: prompt_tokens=${prompt_tokens}, completion_tokens=${completion_tokens}`,
    );
  }

  const model = response.model.toLowerCase();

  const costUnits = calculateCostUnitsV1Number({
    provider: 'meta',
    model,
    inputTokens: prompt_tokens,
    outputTokens: completion_tokens,
  });

  return {
    provider: 'meta',
    model,
    inputTokens: prompt_tokens,
    outputTokens: completion_tokens,
    totalTokens: prompt_tokens + completion_tokens,
    latencyMs,
    costUnits,
    timestamp: typeof response.created === 'number' ? response.created : Math.floor(Date.now() / 1000),
    requestId: response.id,
  };
}

/**
 * MetaLlamaAdapter — IProviderAdapter implementation for Meta Llama API responses.
 * Used by ProviderRegistry when META_API_KEY is set.
 *
 * Note: `ProviderRegistry.createDefault()` registers this adapter unconditionally; it does not read
 * `META_API_KEY`.
 */
export class MetaLlamaAdapter implements IProviderAdapter {
  readonly providerId = 'meta';

  /**
   * Parses a raw Meta Llama response; the event time is `created` or, when absent, the current time.
   *
   * @param raw - Parsed JSON body of the response.
   * @param latencyMs - Round-trip latency in milliseconds.
   * @param _timestamp - Ignored.
   * @returns The normalized usage event.
   * @throws {@link AdapterParseError} See {@link parseMetaLlamaResponse}.
   */
  parseResponse(raw: unknown, latencyMs: number, _timestamp: number): NormalizedUsageEvent {
    return parseMetaLlamaResponse(raw as MetaLlamaChatCompletionResponse, latencyMs);
  }
}
