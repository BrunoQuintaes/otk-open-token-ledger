/**
 * Anthropic Adapter — Parse Anthropic Messages API responses into NormalizedUsageEvent (U7.5)
 *
 * Supports Messages API response format.
 * Reference: https://docs.anthropic.com/en/docs/api-reference/messages
 *
 * IMPORTANT: This adapter does NOT call the Anthropic API.
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
 * Normalize Anthropic model name by stripping date-based snapshot suffixes.
 *
 * Anthropic API returns versioned model IDs (e.g., "claude-sonnet-4-20250514")
 * when you request "claude-sonnet-4". This function strips the date suffix
 * to match canonical weight table entries.
 *
 * Pattern: model-YYYYMMDD → model
 */
function normalizeAnthropicModel(rawModel: string): string {
  const lower = rawModel.toLowerCase();
  // Strip trailing date suffix: -YYYYMMDD (8 digits, no hyphens)
  const stripped = lower.replace(/-\d{8}$/, '');
  // If the stripped name is a known model, use it; otherwise keep original
  return isModelSupported(stripped) ? stripped : lower;
}

/**
 * Anthropic Messages API response shape (subset relevant for metering).
 * See: https://docs.anthropic.com/en/docs/api-reference/messages
 */
export interface AnthropicMessageResponse {
  id: string;
  type: string;
  role: string;
  model: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
  [key: string]: unknown;
}

/**
 * Parse an Anthropic Messages API response into a NormalizedUsageEvent.
 *
 * @param response Raw Anthropic API JSON response
 * @param latencyMs Request latency in milliseconds
 * @param timestamp Unix timestamp in seconds (Anthropic responses don't include created timestamp)
 * @returns NormalizedUsageEvent
 * @throws AdapterParseError if required fields are missing or invalid
 */
export function parseAnthropicResponse(
  response: AnthropicMessageResponse,
  latencyMs: number,
  timestamp: number
): NormalizedUsageEvent {
  // --- Validate model ---
  if (!response.model || typeof response.model !== 'string') {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_MODEL,
      'Anthropic response missing "model" field'
    );
  }

  // --- Validate usage ---
  if (!response.usage) {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_USAGE,
      'Anthropic response missing "usage" field'
    );
  }

  const { input_tokens, output_tokens } = response.usage;

  if (
    typeof input_tokens !== 'number' || !Number.isInteger(input_tokens) || input_tokens < 0 ||
    typeof output_tokens !== 'number' || !Number.isInteger(output_tokens) || output_tokens < 0
  ) {
    throw new AdapterParseError(
      ADAPTER_ERROR.INVALID_TOKENS,
      `Anthropic response has invalid token counts: input_tokens=${input_tokens}, output_tokens=${output_tokens}`
    );
  }

  // --- Normalize model name (strip date snapshots like -20250514) ---
  const model = normalizeAnthropicModel(response.model);

  // --- Compute CU via canonical engine ---
  const costUnits = calculateCostUnitsV1Number({
    provider: 'anthropic',
    model,
    inputTokens: input_tokens,
    outputTokens: output_tokens,
  });

  return {
    provider: 'anthropic',
    model,
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    totalTokens: input_tokens + output_tokens,
    latencyMs,
    costUnits,
    timestamp,
    requestId: response.id,
  };
}
