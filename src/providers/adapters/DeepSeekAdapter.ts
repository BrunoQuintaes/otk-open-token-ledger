/**
 * DeepSeekAdapter — Parse real DeepSeek API responses into NormalizedUsageEvent (U11.3)
 *
 * DeepSeek uses an OpenAI-compatible REST API.
 * Reference: https://api-docs.deepseek.com/
 *
 * IMPORTANT: This adapter does NOT call the DeepSeek API.
 * It parses the JSON response AFTER it has been received.
 * API key management (process.env.DEEPSEEK_API_KEY) is the caller's responsibility.
 *
 * Fallback: ProviderRegistry.createDefault() uses DeepseekAdapterStub when
 * DEEPSEEK_API_KEY is absent. This adapter is selected when key is present.
 *
 * @module src/providers/adapters/DeepSeekAdapter
 */

import { calculateCostUnitsV1Number, isModelSupported } from '../../pricing/CostUnits.js';
import {
  NormalizedUsageEvent,
  AdapterParseError,
  ADAPTER_ERROR,
  IProviderAdapter,
} from '../types.js';

/**
 * DeepSeek API response shape (OpenAI-compatible, subset for metering).
 * See: https://api-docs.deepseek.com/api/create-chat-completion
 */
export interface DeepSeekChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** DeepSeek may include cache-related fields — ignored for CU */
    prompt_cache_hit_tokens?: number;
    prompt_cache_miss_tokens?: number;
  };
  [key: string]: unknown;
}

/**
 * Normalize DeepSeek model name to canonical weight table entry.
 * Maps variants like "deepseek-chat-v3" → "deepseek-chat".
 * @param rawModel - Model ID as returned by the API.
 * @returns The lowercase ID without a `-vN` suffix when that name is in the weight table, else the lowercase original.
 */
function normalizeDeepSeekModel(rawModel: string): string {
  const lower = rawModel.toLowerCase();
  // Strip trailing version suffix -v2, -v3, etc.
  const stripped = lower.replace(/-v\d+$/, '');
  return isModelSupported(stripped) ? stripped : (isModelSupported(lower) ? lower : lower);
}

/**
 * Parse a real DeepSeek API response into a NormalizedUsageEvent.
 * DeepSeek uses OpenAI-compatible field names (prompt_tokens, completion_tokens).
 *
 * @param response   Raw DeepSeek API JSON response
 * @param latencyMs  Request latency in milliseconds
 * @returns NormalizedUsageEvent
 * @throws AdapterParseError if required fields are missing or invalid
 * @throws {@link CUError} From the cost engine, when the normalized model is not in the weight table.
 */
export function parseDeepSeekResponse(
  response: DeepSeekChatCompletionResponse,
  latencyMs: number
): NormalizedUsageEvent {
  // --- Validate model ---
  if (!response.model || typeof response.model !== 'string') {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_MODEL,
      'DeepSeek response missing "model" field'
    );
  }

  // --- Validate usage ---
  if (!response.usage) {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_USAGE,
      'DeepSeek response missing "usage" field'
    );
  }

  const { prompt_tokens, completion_tokens } = response.usage;

  if (
    typeof prompt_tokens !== 'number' || !Number.isInteger(prompt_tokens) || prompt_tokens < 0 ||
    typeof completion_tokens !== 'number' || !Number.isInteger(completion_tokens) || completion_tokens < 0
  ) {
    throw new AdapterParseError(
      ADAPTER_ERROR.INVALID_TOKENS,
      `DeepSeek response has invalid token counts: prompt_tokens=${prompt_tokens}, completion_tokens=${completion_tokens}`
    );
  }

  const model = normalizeDeepSeekModel(response.model);

  const costUnits = calculateCostUnitsV1Number({
    provider: 'deepseek',
    model,
    inputTokens: prompt_tokens,
    outputTokens: completion_tokens,
  });

  return {
    provider: 'deepseek',
    model,
    inputTokens: prompt_tokens,
    outputTokens: completion_tokens,
    totalTokens: prompt_tokens + completion_tokens,
    latencyMs,
    costUnits,
    timestamp: response.created,
    requestId: response.id,
  };
}

/**
 * DeepSeekAdapter — IProviderAdapter implementation for real DeepSeek API responses.
 * Used by ProviderRegistry when DEEPSEEK_API_KEY is set.
 */
export class DeepSeekAdapter implements IProviderAdapter {
  readonly providerId = 'deepseek';

  /**
   * Parses a raw DeepSeek response; the event time comes from the response's `created` field.
   *
   * @param raw - Parsed JSON body of the DeepSeek response.
   * @param latencyMs - Round-trip latency in milliseconds.
   * @param _timestamp - Ignored (the response carries its own timestamp).
   * @returns The normalized usage event.
   * @throws {@link AdapterParseError} See {@link parseDeepSeekResponse}.
   */
  parseResponse(raw: unknown, latencyMs: number, _timestamp: number): NormalizedUsageEvent {
    return parseDeepSeekResponse(raw as DeepSeekChatCompletionResponse, latencyMs);
  }
}
