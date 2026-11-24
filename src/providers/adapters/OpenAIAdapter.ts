/**
 * OpenAI Adapter — Parse OpenAI API responses into NormalizedUsageEvent (U7.5)
 *
 * Supports Chat Completions API response format.
 * Reference: https://platform.openai.com/docs/api-reference/chat/create
 *
 * IMPORTANT: This adapter does NOT call the OpenAI API.
 * It parses the JSON response AFTER it has been received.
 * API key management is the caller's responsibility.
 */

import { calculateCostUnitsV1Number, isModelSupported } from '../../pricing/CostUnits.js';
import {
  NormalizedUsageEvent,
  AdapterParseError,
  ADAPTER_ERROR,
} from '../types.js';

/**
 * Normalize OpenAI model name by stripping date-based snapshot suffixes.
 *
 * OpenAI API returns versioned model IDs (e.g., "gpt-4o-2024-08-06")
 * when you request "gpt-4o". This function strips the date suffix
 * to match canonical weight table entries.
 *
 * Pattern: model-YYYY-MM-DD → model
 */
function normalizeOpenAIModel(rawModel: string): string {
  const lower = rawModel.toLowerCase();
  // Strip trailing date suffix: -YYYY-MM-DD
  const stripped = lower.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  // If the stripped name is a known model, use it; otherwise keep original
  return isModelSupported(stripped) ? stripped : lower;
}

/**
 * OpenAI Chat Completion response shape (subset relevant for metering).
 * See: https://platform.openai.com/docs/api-reference/chat/object
 */
export interface OpenAIChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  [key: string]: unknown;
}

/**
 * Parse an OpenAI Chat Completion response into a NormalizedUsageEvent.
 *
 * @param response Raw OpenAI API JSON response
 * @param latencyMs Request latency in milliseconds
 * @returns NormalizedUsageEvent
 * @throws AdapterParseError if required fields are missing or invalid
 */
export function parseOpenAIResponse(
  response: OpenAIChatCompletionResponse,
  latencyMs: number
): NormalizedUsageEvent {
  // --- Validate model ---
  if (!response.model || typeof response.model !== 'string') {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_MODEL,
      'OpenAI response missing "model" field'
    );
  }

  // --- Validate usage ---
  if (!response.usage) {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_USAGE,
      'OpenAI response missing "usage" field'
    );
  }

  const { prompt_tokens, completion_tokens } = response.usage;

  if (
    typeof prompt_tokens !== 'number' || !Number.isInteger(prompt_tokens) || prompt_tokens < 0 ||
    typeof completion_tokens !== 'number' || !Number.isInteger(completion_tokens) || completion_tokens < 0
  ) {
    throw new AdapterParseError(
      ADAPTER_ERROR.INVALID_TOKENS,
      `OpenAI response has invalid token counts: prompt_tokens=${prompt_tokens}, completion_tokens=${completion_tokens}`
    );
  }

  // --- Normalize model name (strip date snapshots like -2024-08-06) ---
  const model = normalizeOpenAIModel(response.model);

  // --- Compute CU via canonical engine ---
  const costUnits = calculateCostUnitsV1Number({
    provider: 'openai',
    model,
    inputTokens: prompt_tokens,
    outputTokens: completion_tokens,
  });

  return {
    provider: 'openai',
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
