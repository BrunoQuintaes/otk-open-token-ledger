/**
 * GeminiAdapter — Parse real Gemini API responses into NormalizedUsageEvent (U11.3)
 *
 * Supports Gemini generateContent API response format.
 * Reference: https://ai.google.dev/api/generate-content
 *
 * IMPORTANT: This adapter does NOT call the Gemini API.
 * It parses the JSON response AFTER it has been received.
 * API key management (process.env.GEMINI_API_KEY) is the caller's responsibility.
 *
 * Fallback: ProviderRegistry.createDefault() uses GeminiAdapterStub when
 * GEMINI_API_KEY is absent. This adapter is selected when key is present.
 *
 * @module src/providers/adapters/GeminiAdapter
 */

import { calculateCostUnitsV1Number, isModelSupported } from '../../pricing/CostUnits.js';
import {
  NormalizedUsageEvent,
  AdapterParseError,
  ADAPTER_ERROR,
  IProviderAdapter,
} from '../types.js';

/**
 * Real Gemini generateContent API response shape (subset relevant for metering).
 * See: https://ai.google.dev/api/generate-content#v1beta.GenerateContentResponse
 */
export interface GeminiGenerateContentResponse {
  /** Model version used (e.g. "gemini-pro", "gemini-1.5-pro-002") */
  modelVersion?: string;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
  candidates?: unknown[];
  /** Response ID (may be absent in some API versions) */
  responseId?: string;
  [key: string]: unknown;
}

/**
 * Normalize Gemini model name to canonical weight table entry.
 * Strips version suffixes (e.g., "gemini-1.5-pro-002" → "gemini-1.5-pro").
 * Falls through to lowercase original if unknown.
 * @param rawModel - Model version as returned by the API.
 * @returns The lowercase name without a 3-digit suffix when that name is in the weight table, else the lowercase original.
 */
function normalizeGeminiModel(rawModel: string): string {
  const lower = rawModel.toLowerCase();
  // Strip trailing -NNN version number
  const stripped = lower.replace(/-\d{3}$/, '');
  return isModelSupported(stripped) ? stripped : (isModelSupported(lower) ? lower : lower);
}

/**
 * Parse a real Gemini generateContent API response into a NormalizedUsageEvent.
 *
 * @param response   Raw Gemini API JSON response
 * @param latencyMs  Request latency in milliseconds
 * @param timestamp  Unix timestamp in seconds (caller-supplied, Gemini doesn't embed one)
 * @returns NormalizedUsageEvent
 * @throws AdapterParseError if required fields are missing or invalid
 * @throws {@link CUError} From the cost engine, when the normalized model is not in the weight table.
 */
export function parseGeminiResponse(
  response: GeminiGenerateContentResponse,
  latencyMs: number,
  timestamp: number
): NormalizedUsageEvent {
  // --- Validate model ---
  if (!response.modelVersion || typeof response.modelVersion !== 'string') {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_MODEL,
      'Gemini response missing "modelVersion" field'
    );
  }

  // --- Validate usageMetadata ---
  if (!response.usageMetadata) {
    throw new AdapterParseError(
      ADAPTER_ERROR.MISSING_USAGE,
      'Gemini response missing "usageMetadata" field'
    );
  }

  const { promptTokenCount, candidatesTokenCount } = response.usageMetadata;

  if (
    typeof promptTokenCount !== 'number' || !Number.isInteger(promptTokenCount) || promptTokenCount < 0 ||
    typeof candidatesTokenCount !== 'number' || !Number.isInteger(candidatesTokenCount) || candidatesTokenCount < 0
  ) {
    throw new AdapterParseError(
      ADAPTER_ERROR.INVALID_TOKENS,
      `Gemini response has invalid token counts: promptTokenCount=${promptTokenCount}, candidatesTokenCount=${candidatesTokenCount}`
    );
  }

  const model = normalizeGeminiModel(response.modelVersion);

  const costUnits = calculateCostUnitsV1Number({
    provider: 'gemini',
    model,
    inputTokens: promptTokenCount,
    outputTokens: candidatesTokenCount,
  });

  return {
    provider: 'gemini',
    model,
    inputTokens: promptTokenCount,
    outputTokens: candidatesTokenCount,
    totalTokens: promptTokenCount + candidatesTokenCount,
    latencyMs,
    costUnits,
    timestamp,
    requestId: response.responseId ?? `gemini-${timestamp}`,
  };
}

/**
 * GeminiAdapter — IProviderAdapter implementation for real Gemini API responses.
 * Used by ProviderRegistry when GEMINI_API_KEY is set.
 */
export class GeminiAdapter implements IProviderAdapter {
  readonly providerId = 'gemini';

  /**
   * Parses a raw Gemini generateContent response.
   *
   * @param raw - Parsed JSON body of the Gemini response.
   * @param latencyMs - Round-trip latency in milliseconds.
   * @param timestamp - Unix timestamp in seconds (Gemini responses carry none).
   * @returns The normalized usage event.
   * @throws {@link AdapterParseError} See {@link parseGeminiResponse}.
   */
  parseResponse(raw: unknown, latencyMs: number, timestamp: number): NormalizedUsageEvent {
    return parseGeminiResponse(raw as GeminiGenerateContentResponse, latencyMs, timestamp);
  }
}
