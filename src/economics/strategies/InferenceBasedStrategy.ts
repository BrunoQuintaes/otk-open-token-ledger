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
 * @module InferenceBasedStrategy
 * @since U5.2
 */

import type { ICUStrategy, CUStrategyInput } from './ICUStrategy.js';
import { CUError, CU_ERROR } from '../../pricing/CostUnits.js';

export const INFERENCE_STRATEGY_ID = 'inference_v0' as const;

/** Providers that offer latency-based billing (no token count) */
const INFERENCE_PROVIDERS = new Set(['stability', 'runway', 'elevenlabs', 'whisper-local']);

/**
 * Latency scale factor: 1 ms latency ≡ LATENCY_CU_SCALE CU (stub value)
 * Needs empirical calibration against real pricing.
 */
const LATENCY_CU_SCALE = 10n;
const LATENCY_SCALE_DENOM = 1n;

export class InferenceBasedStrategy implements ICUStrategy {
  readonly strategyId = INFERENCE_STRATEGY_ID;
  readonly description =
    'Inference-time CU (CU_MODEL_inference_v0): CU = latencyMs × LATENCY_SCALE (stub — future work)';

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

  supports(provider: string, _model: string): boolean {
    return INFERENCE_PROVIDERS.has(provider.toLowerCase());
  }
}

/** Singleton instance */
export const inferenceBasedStrategy = new InferenceBasedStrategy();
