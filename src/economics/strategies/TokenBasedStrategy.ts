/**
 * TokenBasedStrategy — CU_MODEL_v1 wrapped as an ICUStrategy.
 *
 * Delegates to calculateCostUnitsV1() from CostUnits.ts.
 * Supports all providers and models registered in the weight tables.
 *
 * @module src/economics/strategies/TokenBasedStrategy
 * @since U5.2
 */

import { calculateCostUnitsV1, isProviderSupported, isModelSupported } from '../../pricing/CostUnits.js';
import type { ICUStrategy, CUStrategyInput } from './ICUStrategy.js';

/** Strategy id (`token_v1`). */
export const TOKEN_STRATEGY_ID = 'token_v1' as const;

/** CU_MODEL_v1 as a strategy for every provider and model of the static weight tables. */
export class TokenBasedStrategy implements ICUStrategy {
  readonly strategyId = TOKEN_STRATEGY_ID;
  readonly description = 'Token-based CU (CU_MODEL_v1): CU = (inputTokens + outputTokens) × W_model × W_provider';

  /**
   * Computes CU with `calculateCostUnitsV1` (latency and metadata are ignored).
   *
   * @param input - Usage figures.
   * @returns CU.
   * @throws {@link CUError} For an unknown provider or model, negative tokens or overflow.
   */
  compute(input: CUStrategyInput): bigint {
    return calculateCostUnitsV1({
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
    });
  }

  /**
   * Tells whether both the provider and the model are in the static weight tables.
   *
   * @param provider - Provider id.
   * @param model - Model id.
   * @returns True when both are known.
   */
  supports(provider: string, model: string): boolean {
    return isProviderSupported(provider) && isModelSupported(model);
  }
}

/** Singleton instance (stateless, safe to share) */
export const tokenBasedStrategy = new TokenBasedStrategy();
