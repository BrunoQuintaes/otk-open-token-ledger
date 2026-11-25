/**
 * ADAPT-01 — CohereAdapter
 * Cohere Command/R models adapter.
 *
 * Completions endpoint: POST https://api.cohere.ai/v1/chat
 * Input fields: message, model
 * Usage: response.meta.tokens.{ input_tokens, output_tokens }
 *
 * IMPORTANT: This adapter does NOT call the Cohere API.
 * It parses the JSON response AFTER it has been received.
 * API key management is the caller's responsibility.
 *
 * @module providers/adapters/CohereAdapter
 * @since W8-D ADAPT-01
 */

import { calculateCostUnitsV1Number } from '../../pricing/CostUnits.js';
import {
  NormalizedUsageEvent,
  AdapterParseError,
  ADAPTER_ERROR,
  IProviderAdapter,
} from '../types.js';

/**
 * Cohere /v1/chat API response shape (subset relevant for metering).
 * Reference: https://docs.cohere.com/reference/chat
 */
export interface CohereChatResponse {
  /** Response text */
  text?: string;
  /** Generation ID (request identifier) */
  generation_id?: string;
  /** Model used (may not always be present) */
  model?: string;
  meta?: {
    tokens?: {
      input_tokens: number;
      output_tokens: number;
    };
    billed_units?: {
      input_tokens: number;
      output_tokens: number;
    };
  };
  [key: string]: unknown;
}

/**
 * Parse a Cohere /v1/chat API response into a NormalizedUsageEvent.
 *
 * @param response   Raw Cohere API JSON response
 * @param model      Model name as sent in the request (Cohere doesn't always echo it)
 * @param latencyMs  Request latency in milliseconds
 * @param timestamp  Unix timestamp in seconds
 * @returns The normalized event; the model is lowercased and `requestId` is a random UUID when the
 *   response has no `generation_id`.
 * @throws {@link AdapterParseError} When no model name is available, `meta.tokens`/`meta.billed_units` are both
 *   missing, or a token count is not a non-negative integer.
 * @throws {@link CUError} From the cost engine, when the model is not in the weight table.
 */
export function parseCohereResponse(
  response: CohereChatResponse,
  model: string,
  latencyMs: number,
  timestamp: number,
): NormalizedUsageEvent {
  // Cohere echoes model in some response variants; fall back to caller-supplied name
  const responseModel = typeof response.model === 'string' && response.model
    ? response.model
    : model;

  if (!responseModel) {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_MODEL,
      'Cohere response missing model identifier',
    );
  }

  // Token counts: prefer meta.tokens, fall back to meta.billed_units
  const tokens = response.meta?.tokens ?? response.meta?.billed_units;
  if (!tokens) {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_USAGE,
      'Cohere response missing "meta.tokens" or "meta.billed_units"',
    );
  }

  const { input_tokens, output_tokens } = tokens;

  if (
    typeof input_tokens !== 'number' || !Number.isInteger(input_tokens) || input_tokens < 0 ||
    typeof output_tokens !== 'number' || !Number.isInteger(output_tokens) || output_tokens < 0
  ) {
    throw new AdapterParseError(
      ADAPTER_ERROR.INVALID_TOKENS,
      `Cohere response has invalid token counts: input_tokens=${input_tokens}, output_tokens=${output_tokens}`,
    );
  }

  const costUnits = calculateCostUnitsV1Number({
    provider: 'cohere',
    model: responseModel.toLowerCase(),
    inputTokens: input_tokens,
    outputTokens: output_tokens,
  });

  return {
    provider: 'cohere',
    model: responseModel.toLowerCase(),
    inputTokens: input_tokens,
    outputTokens: output_tokens,
    totalTokens: input_tokens + output_tokens,
    latencyMs,
    costUnits,
    timestamp,
    requestId: response.generation_id ?? crypto.randomUUID(),
  };
}

/**
 * CohereAdapter — IProviderAdapter implementation for Cohere API responses.
 * Used by ProviderRegistry when COHERE_API_KEY is set.
 *
 * Note: `ProviderRegistry.createDefault()` registers this adapter unconditionally; it does not read
 * `COHERE_API_KEY`.
 */
export class CohereAdapter implements IProviderAdapter {
  readonly providerId = 'cohere';

  /**
   * Parses a raw Cohere chat response; when it carries no model name, `command-r` is assumed.
   *
   * @param raw - Parsed JSON body of the Cohere response.
   * @param latencyMs - Round-trip latency in milliseconds.
   * @param timestamp - Unix timestamp in seconds to put in the event.
   * @returns The normalized usage event.
   * @throws {@link AdapterParseError} See {@link parseCohereResponse}.
   */
  parseResponse(raw: unknown, latencyMs: number, timestamp: number): NormalizedUsageEvent {
    const body = raw as CohereChatResponse;
    const model = typeof body.model === 'string' ? body.model : 'command-r';
    return parseCohereResponse(body, model, latencyMs, timestamp);
  }
}
