/**
 * ADAPT-02 — MistralAdapter
 * Mistral AI chat completions adapter.
 *
 * Completions endpoint: POST https://api.mistral.ai/v1/chat/completions
 * Response format: OpenAI-compatible (prompt_tokens / completion_tokens in usage)
 *
 * IMPORTANT: This adapter does NOT call the Mistral API.
 * It parses the JSON response AFTER it has been received.
 * API key management is the caller's responsibility.
 *
 * @module providers/adapters/MistralAdapter
 * @since W8-D ADAPT-02
 */

import { calculateCostUnitsV1Number } from '../../pricing/CostUnits.js';
import {
  NormalizedUsageEvent,
  AdapterParseError,
  ADAPTER_ERROR,
  IProviderAdapter,
} from '../types.js';

/**
 * Mistral /v1/chat/completions API response shape (OpenAI-compatible, subset for metering).
 * Reference: https://docs.mistral.ai/api/
 */
export interface MistralChatCompletionResponse {
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
 * Parse a Mistral /v1/chat/completions response into a NormalizedUsageEvent.
 * Mistral uses the same OpenAI-compatible field names.
 *
 * @param response   Raw Mistral API JSON response
 * @param latencyMs  Request latency in milliseconds
 * @returns NormalizedUsageEvent
 * @throws AdapterParseError if required fields are missing or invalid
 */
export function parseMistralResponse(
  response: MistralChatCompletionResponse,
  latencyMs: number,
): NormalizedUsageEvent {
  if (!response.model || typeof response.model !== 'string') {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_MODEL,
      'Mistral response missing "model" field',
    );
  }

  if (!response.usage) {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_USAGE,
      'Mistral response missing "usage" field',
    );
  }

  const { prompt_tokens, completion_tokens } = response.usage;

  if (
    typeof prompt_tokens !== 'number' || !Number.isInteger(prompt_tokens) || prompt_tokens < 0 ||
    typeof completion_tokens !== 'number' || !Number.isInteger(completion_tokens) || completion_tokens < 0
  ) {
    throw new AdapterParseError(
      ADAPTER_ERROR.INVALID_TOKENS,
      `Mistral response has invalid token counts: prompt_tokens=${prompt_tokens}, completion_tokens=${completion_tokens}`,
    );
  }

  const model = response.model.toLowerCase();

  const costUnits = calculateCostUnitsV1Number({
    provider: 'mistral',
    model,
    inputTokens: prompt_tokens,
    outputTokens: completion_tokens,
  });

  return {
    provider: 'mistral',
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
 * MistralAdapter — IProviderAdapter implementation for Mistral API responses.
 * Used by ProviderRegistry when MISTRAL_API_KEY is set.
 */
export class MistralAdapter implements IProviderAdapter {
  readonly providerId = 'mistral';

  parseResponse(raw: unknown, latencyMs: number, _timestamp: number): NormalizedUsageEvent {
    return parseMistralResponse(raw as MistralChatCompletionResponse, latencyMs);
  }
}
