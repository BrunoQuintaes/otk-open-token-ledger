/**
 * ICUStrategy — interface for pluggable Cost Unit calculation strategies.
 *
 * Enables dependency injection of CU models without modifying CUEngine.
 * Strategies must be deterministic and produce bigint output.
 *
 * Used by `CUStrategyFactory`; not to be confused with `src/economics/ICUStrategy.ts` (the linear/nonlinear
 * formula switch used by `CUEngine`).
 *
 * @module src/economics/strategies/ICUStrategy
 * @since U5.2
 */

/** Usage figures given to a CU strategy. */
export interface CUStrategyInput {
  /** Provider id. */
  provider: string;
  /** Model id. */
  model: string;
  /** Input tokens (non-negative integer). */
  inputTokens: number;
  /** Output tokens (non-negative integer). */
  outputTokens: number;
  /** Optional: inference latency in milliseconds (for non-token-based models) */
  latencyMs?: number;
  /** Optional: arbitrary extra metadata for future strategies */
  meta?: Record<string, unknown>;
}

/** A CU formula that declares which provider/model pairs it supports. */
export interface ICUStrategy {
  /** Unique, stable identifier for this strategy version (e.g. 'token_v1', 'inference_v1') */
  readonly strategyId: string;

  /** Human-readable description */
  readonly description: string;

  /**
   * Compute Cost Units for a given input.
   * Must be deterministic, float-free, and return a non-negative bigint.
   *
   * @param input - Usage figures.
   * @returns CU.
   * @throws {@link CUError} On invalid input (unknown provider/model, negative tokens, overflow).
   */
  compute(input: CUStrategyInput): bigint;

  /**
   * Check if this strategy supports a given provider/model combination.
   * Returns false if the strategy cannot handle this input (e.g., provider unknown).
   *
   * @param provider - Provider id.
   * @param model - Model id.
   * @returns True when `compute` can handle the pair.
   */
  supports(provider: string, model: string): boolean;
}
