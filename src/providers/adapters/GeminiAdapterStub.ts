/**
 * GeminiAdapterStub — Stub adapter for Google Gemini API responses (U11.1)
 *
 * STUB: Accepts a simplified GenericUsageInput shape (not the real Gemini API format).
 * Real Gemini API integration is planned for U12.
 *
 * Expected input shape (GenericUsageInput):
 *   { id: string, model: string, inputTokens: number, outputTokens: number }
 *
 * Valid models: 'gemini-2.0-flash', 'gemini-pro', 'gemini-ultra'
 */

import { calculateCostUnitsV1Number } from '../../pricing/CostUnits.js';
import {
  NormalizedUsageEvent,
  AdapterParseError,
  ADAPTER_ERROR,
  GenericUsageInput,
  IProviderAdapter,
} from '../types.js';

function validateInput(raw: unknown): GenericUsageInput {
  const input = raw as Partial<GenericUsageInput>;
  if (!input.model || typeof input.model !== 'string') {
    throw new AdapterParseError(ADAPTER_ERROR.MISSING_MODEL, 'GeminiStub: missing model field');
  }
  if (input.inputTokens === undefined || input.outputTokens === undefined) {
    throw new AdapterParseError(ADAPTER_ERROR.MISSING_USAGE, 'GeminiStub: missing inputTokens/outputTokens');
  }
  if (
    !Number.isInteger(input.inputTokens) || input.inputTokens < 0 ||
    !Number.isInteger(input.outputTokens) || input.outputTokens < 0
  ) {
    throw new AdapterParseError(
      ADAPTER_ERROR.INVALID_TOKENS,
      `GeminiStub: invalid token counts: input=${input.inputTokens}, output=${input.outputTokens}`
    );
  }
  return input as GenericUsageInput;
}

export class GeminiAdapterStub implements IProviderAdapter {
  readonly providerId = 'gemini';

  parseResponse(raw: unknown, latencyMs: number, timestamp: number): NormalizedUsageEvent {
    const input = validateInput(raw);
    const model = input.model.toLowerCase();

    const costUnits = calculateCostUnitsV1Number({
      provider: 'gemini',
      model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
    });

    return {
      provider: 'gemini',
      model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.inputTokens + input.outputTokens,
      latencyMs,
      costUnits,
      timestamp,
      requestId: input.id,
    };
  }
}
