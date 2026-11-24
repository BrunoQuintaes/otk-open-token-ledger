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
 * @module economics/ICUStrategy
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

export type CUStrategyName = 'linear' | 'nonlinear';

export interface ICUStrategy {
  /** Strategy identifier */
  readonly name: CUStrategyName;
  /**
   * Compute raw CU from provider usage input.
   * Returns bigint — float-free and ZK-compatible.
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

export const LinearCUStrategy: ICUStrategy = {
  name: 'linear',
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

export const NonlinearCUStrategy: ICUStrategy = {
  name: 'nonlinear',
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

/** Return the active ICUStrategy based on OTK_CU_STRATEGY env var. Defaults to linear. */
export function getActiveStrategy(): ICUStrategy {
  const name = process.env['OTK_CU_STRATEGY'];
  if (name === 'nonlinear') return NonlinearCUStrategy;
  return LinearCUStrategy;
}
