/**
 * ICUStrategy — interface for pluggable Cost Unit calculation strategies.
 *
 * Enables dependency injection of CU models without modifying CUEngine.
 * Strategies must be deterministic and produce bigint output.
 *
 * @module ICUStrategy
 * @since U5.2
 */

export interface CUStrategyInput {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Optional: inference latency in milliseconds (for non-token-based models) */
  latencyMs?: number;
  /** Optional: arbitrary extra metadata for future strategies */
  meta?: Record<string, unknown>;
}

export interface ICUStrategy {
  /** Unique, stable identifier for this strategy version (e.g. 'token_v1', 'inference_v1') */
  readonly strategyId: string;

  /** Human-readable description */
  readonly description: string;

  /**
   * Compute Cost Units for a given input.
   * Must be deterministic, float-free, and return a non-negative bigint.
   * @throws CUError on invalid input (unknown provider/model, negative tokens, overflow)
   */
  compute(input: CUStrategyInput): bigint;

  /**
   * Check if this strategy supports a given provider/model combination.
   * Returns false if the strategy cannot handle this input (e.g., provider unknown).
   */
  supports(provider: string, model: string): boolean;
}
