/**
 * CUStrategyFactory — registry and DI container for ICUStrategy implementations.
 *
 * Resolves the appropriate strategy for a given provider/model pair.
 * Falls back to TokenBasedStrategy for all registered providers.
 *
 * Usage:
 *   const cu = CUStrategyFactory.default().compute({ provider, model, ... })
 *
 * @module CUStrategyFactory
 * @since U5.2
 */

import type { ICUStrategy, CUStrategyInput } from './strategies/ICUStrategy.js';
import { tokenBasedStrategy } from './strategies/TokenBasedStrategy.js';
import { inferenceBasedStrategy } from './strategies/InferenceBasedStrategy.js';

/**
 * Registry entry: ordered list of strategies to try for a given provider.
 * First strategy that supports(provider, model) wins.
 */
const STRATEGY_REGISTRY: ICUStrategy[] = [
  inferenceBasedStrategy,  // checked first (inference-only providers)
  tokenBasedStrategy,      // fallback for all token-based providers
];

export class CUStrategyFactory {
  private readonly strategies: ICUStrategy[];

  constructor(strategies: ICUStrategy[] = STRATEGY_REGISTRY) {
    this.strategies = strategies;
  }

  /**
   * Resolve the best strategy for a given provider+model.
   * Returns the first strategy that supports this combination.
   * Throws if none match (should not happen with default registry).
   */
  resolve(provider: string, model: string): ICUStrategy {
    for (const s of this.strategies) {
      if (s.supports(provider, model)) {
        return s;
      }
    }
    throw new Error(
      `No CU strategy found for provider=${provider} model=${model}. ` +
      `Registered: ${this.strategies.map(s => s.strategyId).join(', ')}`
    );
  }

  /**
   * Compute CU using auto-resolved strategy.
   */
  compute(input: CUStrategyInput): bigint {
    const strategy = this.resolve(input.provider, input.model);
    return strategy.compute(input);
  }

  /**
   * List all registered strategy IDs.
   */
  listStrategies(): string[] {
    return this.strategies.map(s => s.strategyId);
  }

  /** Default factory (singleton) */
  private static _default: CUStrategyFactory | null = null;
  static default(): CUStrategyFactory {
    if (!CUStrategyFactory._default) {
      CUStrategyFactory._default = new CUStrategyFactory();
    }
    return CUStrategyFactory._default;
  }
}
