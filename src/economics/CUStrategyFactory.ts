/**
 * CUStrategyFactory — registry and DI container for ICUStrategy implementations.
 *
 * Resolves the appropriate strategy for a given provider/model pair.
 * Falls back to TokenBasedStrategy for all registered providers.
 *
 * Usage:
 *   const cu = CUStrategyFactory.default().compute({ provider, model, ... })
 *
 * The default registry tries `InferenceBasedStrategy` first, then `TokenBasedStrategy`.
 *
 * @module src/economics/CUStrategyFactory
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

/** Picks the first registered CU strategy that supports a provider and model. */
export class CUStrategyFactory {
  private readonly strategies: ICUStrategy[];

  /**
   * Creates a factory over an ordered strategy list.
   *
   * @param strategies - Strategies in priority order (default: the module registry, shared, not copied).
   */
  constructor(strategies: ICUStrategy[] = STRATEGY_REGISTRY) {
    this.strategies = strategies;
  }

  /**
   * Resolve the best strategy for a given provider+model.
   * Returns the first strategy that supports this combination.
   * Throws if none match (should not happen with default registry).
   *
   * @param provider - Provider id.
   * @param model - Model id.
   * @returns The first matching strategy.
   * @throws {Error} When no registered strategy supports the pair.
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
   *
   * @param input - Provider, model and usage figures.
   * @returns CU computed by the resolved strategy.
   * @throws {Error} When no strategy supports the pair, or when the strategy rejects the input.
   */
  compute(input: CUStrategyInput): bigint {
    const strategy = this.resolve(input.provider, input.model);
    return strategy.compute(input);
  }

  /**
   * List all registered strategy IDs.
   *
   * @returns Strategy ids in priority order.
   */
  listStrategies(): string[] {
    return this.strategies.map(s => s.strategyId);
  }

  /** Default factory (singleton) */
  private static _default: CUStrategyFactory | null = null;
  /**
   * Returns the shared factory with the default registry, creating it on first call.
   *
   * @returns The singleton factory.
   */
  static default(): CUStrategyFactory {
    if (!CUStrategyFactory._default) {
      CUStrategyFactory._default = new CUStrategyFactory();
    }
    return CUStrategyFactory._default;
  }
}
