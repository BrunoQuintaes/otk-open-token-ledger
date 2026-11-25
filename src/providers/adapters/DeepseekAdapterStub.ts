/**
 * DeepseekAdapterStub — Stub adapter for DeepSeek API responses (U11.1)
 *
 * STUB: Accepts a simplified GenericUsageInput shape (not the real DeepSeek API format).
 * Real DeepSeek API integration is planned for U12.
 *
 * Expected input shape (GenericUsageInput):
 *   { id: string, model: string, inputTokens: number, outputTokens: number }
 *
 * Valid models: 'deepseek-coder', 'deepseek-chat'
 *
 * Registered by `ProviderRegistry.createDefault()` when `DEEPSEEK_API_KEY` is not set.
 *
 * @module src/providers/adapters/DeepseekAdapterStub
 */

import { calculateCostUnitsV1Number } from '../../pricing/CostUnits.js';
import {
  NormalizedUsageEvent,
  AdapterParseError,
  ADAPTER_ERROR,
  GenericUsageInput,
  IProviderAdapter,
} from '../types.js';

// Throws AdapterParseError (missing model, missing counts, or non-integer/negative counts).
function validateInput(raw: unknown): GenericUsageInput {
  const input = raw as Partial<GenericUsageInput>;
  if (!input.model || typeof input.model !== 'string') {
    throw new AdapterParseError(ADAPTER_ERROR.MISSING_MODEL, 'DeepseekStub: missing model field');
  }
  if (input.inputTokens === undefined || input.outputTokens === undefined) {
    throw new AdapterParseError(ADAPTER_ERROR.MISSING_USAGE, 'DeepseekStub: missing inputTokens/outputTokens');
  }
  if (
    !Number.isInteger(input.inputTokens) || input.inputTokens < 0 ||
    !Number.isInteger(input.outputTokens) || input.outputTokens < 0
  ) {
    throw new AdapterParseError(
      ADAPTER_ERROR.INVALID_TOKENS,
      `DeepseekStub: invalid token counts: input=${input.inputTokens}, output=${input.outputTokens}`
    );
  }
  return input as GenericUsageInput;
}

/**
 * Stub DeepSeek adapter that reads the simplified {@link GenericUsageInput} shape (offline and tests).
 */
export class DeepseekAdapterStub implements IProviderAdapter {
  readonly providerId = 'deepseek';

  /**
   * Validates a {@link GenericUsageInput} and returns the normalized event with the model lowercased.
   *
   * @param raw - Object in the {@link GenericUsageInput} shape.
   * @param latencyMs - Round-trip latency in milliseconds.
   * @param timestamp - Unix timestamp in seconds to put in the event.
   * @returns The normalized usage event; `requestId` is the input `id`.
   * @throws {@link AdapterParseError} When the model or a token count is missing, or a count is not a
   *   non-negative integer.
   */
  parseResponse(raw: unknown, latencyMs: number, timestamp: number): NormalizedUsageEvent {
    const input = validateInput(raw);
    const model = input.model.toLowerCase();

    const costUnits = calculateCostUnitsV1Number({
      provider: 'deepseek',
      model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
    });

    return {
      provider: 'deepseek',
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
