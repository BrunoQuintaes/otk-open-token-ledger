/**
 * ICUStrategy — Polymorphic CU computation strategy (S5.3)
 *
 * Implementations:
 *   - linear:    CU = round((t_in + t_out) × W_m × W_p)  [default — current behaviour]
 *   - nonlinear: CU = floor(sqrt(t_in + t_out) × W_m × W_p / scale)  [volume discount]
 *
 * Selected via OTK_CU_STRATEGY env var (read at call time for hot-switch).
 * Defaults to 'linear' — preserves all existing behaviour.
 *
 * `CUEngine.computePublishedCU` calls `getActiveStrategy()` on every computation. Environment variable read:
 * `OTK_CU_STRATEGY` (`nonlinear` selects the sqrt strategy; any other value or none gives linear). The nonlinear
 * strategy uses weight 1000 (neutral) for an unknown provider or model instead of refusing it, unlike linear.
 * Not to be confused with `strategies/ICUStrategy.ts`, the provider-capability strategies of `CUStrategyFactory`.
 *
 * @module src/economics/ICUStrategy
 * @since Wave 4 (4A-PACK-4A02 / S5.3)
 */

import type { CostUnitsInput } from '../pricing/CostUnits.js';
import {
  calculateCostUnitsV1,
  PROVIDER_WEIGHTS_INT,
  MODEL_WEIGHTS_INT,
} from '../pricing/CostUnits.js';

/** Weight scale factor (1000 = weights stored as integer millis, matching CostUnits.ts). */
const _WEIGHT_SCALE = 1000n;

// ──────────────────────────────────────────────────────────
// Interface
// ──────────────────────────────────────────────────────────

/** Names of the selectable CU formulas. */
export type CUStrategyName = 'linear' | 'nonlinear';

/** One CU formula: maps provider usage to raw (unbucketed) CU. */
export interface ICUStrategy {
  /** Strategy identifier */
  readonly name: CUStrategyName;
  /**
   * Compute raw CU from provider usage input.
   * Returns bigint — float-free and ZK-compatible.
   *
   * @param input - Provider, model and token counts.
   * @returns Raw CU.
   */
  compute(input: CostUnitsInput): bigint;
}

// ──────────────────────────────────────────────────────────
// Integer square root (Newton's method — bigint)
// ──────────────────────────────────────────────────────────

function bigintSqrt(n: bigint): bigint {
  if (n < 0n) throw new RangeError('bigintSqrt: negative input');
  if (n === 0n) return 0n;
  let x = n;
  let y = (x + 1n) >> 1n;
  while (y < x) {
    x = y;
    y = (x + n / x) >> 1n;
  }
  return x;
}

// ──────────────────────────────────────────────────────────
// LinearCUStrategy — wraps calculateCostUnitsV1 (no change)
// ──────────────────────────────────────────────────────────

/** The CU_MODEL_v1 formula (`calculateCostUnitsV1`); throws `CUError` for an unknown provider or model. */
export const LinearCUStrategy: ICUStrategy = {
  name: 'linear',
  /**
   * Computes CU with `calculateCostUnitsV1`.
   *
   * @param input - Provider, model and token counts.
   * @returns Raw CU.
   * @throws {@link CUError} For an unknown provider or model, or on overflow.
   */
  compute(input: CostUnitsInput): bigint {
    return calculateCostUnitsV1(input);
  },
};

// ──────────────────────────────────────────────────────────
// NonlinearCUStrategy — sqrt-scaled volume discount
//
// Formula: CU = floor(sqrt(t_total) × W_p × W_m) / scale
//
// This gives sub-linear growth with token count — useful for
// volume pricing where large batches should cost less per-CU.
// ──────────────────────────────────────────────────────────

/** Square-root volume discount: floor(isqrt(t_in + t_out) x W_p x W_m / 1000). */
export const NonlinearCUStrategy: ICUStrategy = {
  name: 'nonlinear',
  /**
   * Computes the square-root-discounted CU.
   *
   * @param input - Provider, model and token counts.
   * @returns Raw CU.
   */
  compute(input: CostUnitsInput): bigint {
    const total = BigInt(input.inputTokens + input.outputTokens);
    const sqrtTokens = bigintSqrt(total);

    const pKey = input.provider.toLowerCase();
    const mKey = input.model.toLowerCase();
    const wp = (PROVIDER_WEIGHTS_INT as Record<string, bigint>)[pKey] ?? _WEIGHT_SCALE;
    const wm = (MODEL_WEIGHTS_INT as Record<string, bigint>)[mKey] ?? _WEIGHT_SCALE;

    // Divide by scale to keep units comparable to linear strategy
    return (sqrtTokens * wp * wm) / _WEIGHT_SCALE;
  },
};

// ──────────────────────────────────────────────────────────
// Strategy factory — reads OTK_CU_STRATEGY at call time
// ──────────────────────────────────────────────────────────

/**
 * Return the active ICUStrategy based on OTK_CU_STRATEGY env var. Defaults to linear.
 *
 * @returns `NonlinearCUStrategy` when the variable is exactly `nonlinear`, otherwise `LinearCUStrategy`.
 */
export function getActiveStrategy(): ICUStrategy {
  const name = process.env['OTK_CU_STRATEGY'];
  if (name === 'nonlinear') return NonlinearCUStrategy;
  return LinearCUStrategy;
}
