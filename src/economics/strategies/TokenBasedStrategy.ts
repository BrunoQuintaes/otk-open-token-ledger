/**
 * TokenBasedStrategy — CU_MODEL_v1 wrapped as an ICUStrategy.
 *
 * Delegates to calculateCostUnitsV1() from CostUnits.ts.
 * Supports all providers and models registered in the weight tables.
 *
 * @module TokenBasedStrategy
 * @since U5.2
 */

import { calculateCostUnitsV1, isProviderSupported, isModelSupported } from '../../pricing/CostUnits.js';
import type { ICUStrategy, CUStrategyInput } from './ICUStrategy.js';

export const TOKEN_STRATEGY_ID = 'token_v1' as const;

export class TokenBasedStrategy implements ICUStrategy {
  readonly strategyId = TOKEN_STRATEGY_ID;
  readonly description = 'Token-based CU (CU_MODEL_v1): CU = (inputTokens + outputTokens) × W_model × W_provider';

  compute(input: CUStrategyInput): bigint {
    return calculateCostUnitsV1({
      provider: input.provider,
      model: input.model,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
    });
  }

  supports(provider: string, model: string): boolean {
    return isProviderSupported(provider) && isModelSupported(model);
  }
}

/** Singleton instance (stateless, safe to share) */
export const tokenBasedStrategy = new TokenBasedStrategy();
