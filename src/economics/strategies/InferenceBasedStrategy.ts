/**
 * InferenceBasedStrategy — placeholder for non-token-based CU models.
 *
 * Supports models that charge by inference time (e.g., image diffusion,
 * audio processing, embeddings with no token count).
 *
 * Formula (v0 — stub, future work):
 *   CU = round(latencyMs × W_provider × LATENCY_SCALE)
 *
 * This is a scaffold. The actual formula and weight tables will be
 * determined in U12/future research (non-linear CU model).
 *
 * Supported providers (case-insensitive): stability, runway, elevenlabs, whisper-local. At the evaluated version
 * the formula is CU = round(latencyMs) x 10, uncalibrated.
 *
 * @module src/economics/strategies/InferenceBasedStrategy
 * @since U5.2
 */

import type { ICUStrategy, CUStrategyInput } from './ICUStrategy.js';
import { CUError, CU_ERROR } from '../../pricing/CostUnits.js';

/** Strategy id of this placeholder (`inference_v0`). */
export const INFERENCE_STRATEGY_ID = 'inference_v0' as const;

/** Providers that offer latency-based billing (no token count) */
const INFERENCE_PROVIDERS = new Set(['stability', 'runway', 'elevenlabs', 'whisper-local']);

/**
 * Latency scale factor: 1 ms latency ≡ LATENCY_CU_SCALE CU (stub value)
 * Needs empirical calibration against real pricing.
 */
const LATENCY_CU_SCALE = 10n;
const LATENCY_SCALE_DENOM = 1n;

/** Latency-based CU placeholder for providers that bill by inference time. */
export class InferenceBasedStrategy implements ICUStrategy {
  readonly strategyId = INFERENCE_STRATEGY_ID;
  readonly description =
    'Inference-time CU (CU_MODEL_inference_v0): CU = latencyMs × LATENCY_SCALE (stub — future work)';

  /**
   * Computes CU from latency.
   *
   * @param input - Usage figures; `latencyMs` is required.
   * @returns round(latencyMs) x 10.
   * @throws {@link CUError} `UNKNOWN_PROVIDER` for an unsupported provider; `NEGATIVE_TOKENS` when `latencyMs` is
   *   missing or negative.
   */
  compute(input: CUStrategyInput): bigint {
    if (!this.supports(input.provider, input.model)) {
      throw new CUError(
        CU_ERROR.UNKNOWN_PROVIDER,
        `InferenceBasedStrategy does not support provider=${input.provider}`
      );
    }
    if (input.latencyMs === undefined || input.latencyMs < 0) {
      throw new CUError(
        CU_ERROR.NEGATIVE_TOKENS,
        `InferenceBasedStrategy requires latencyMs >= 0, got ${input.latencyMs}`
      );
    }
    // CU = round(latencyMs × LATENCY_CU_SCALE)
    const latencyBigint = BigInt(Math.round(input.latencyMs));
    return (latencyBigint * LATENCY_CU_SCALE) / LATENCY_SCALE_DENOM;
  }

  /**
   * Tells whether the provider bills by inference time.
   *
   * @param provider - Provider id (case-insensitive).
   * @param _model - Ignored.
   * @returns True for the four inference providers.
   */
  supports(provider: string, _model: string): boolean {
    return INFERENCE_PROVIDERS.has(provider.toLowerCase());
  }
}

/** Singleton instance */
export const inferenceBasedStrategy = new InferenceBasedStrategy();
