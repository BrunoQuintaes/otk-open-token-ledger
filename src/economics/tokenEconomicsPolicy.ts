/**
 * G3 — Token Economics Policy (pure functions)
 *
 * CU → fiat valuation via a reference rate and a valuation policy.
 * All functions are pure and deterministic.
 * No I/O, no external calls, no hidden global state.
 *
 * INVARIANT: CU != USD.
 *   evaluateTokenValuation returns fiat as a secondary view.
 *   The amountCU field is always the authoritative value.
 *
 * @module src/economics/tokenEconomicsPolicy
 * @since G3
 */

import type {
  OTKTokenValue,
  ReferenceRate,
  ValuationPolicy,
} from './tokenEconomicsTypes.js';
import { DEFAULT_VALUATION_POLICY } from './tokenEconomicsTypes.js';

/**
 * Compute fiat valuation of a CU amount.
 *
 * @param amountCU       - CU amount (deterministic bigint)
 * @param referenceRate  - Oracle/fixed rate snapshot
 * @param policy         - Valuation policy (defaults to DEFAULT_VALUATION_POLICY)
 * @param computedAt     - Evaluation epoch (injectable for tests)
 * @returns The CU amount with its USD valuation (`Number(amountCU) x usdPerCU`, float); `computedAt` defaults to
 *   the rate's snapshot epoch.
 * @throws {Error} When `amountCU` is negative.
 */
export function evaluateTokenValuation(
  amountCU: bigint,
  referenceRate: ReferenceRate,
  policy: ValuationPolicy = DEFAULT_VALUATION_POLICY,
  computedAt?: number,
): OTKTokenValue {
  assertCUInvariant(amountCU);
  const valuationUsd = Number(amountCU) * policy.usdPerCU;
  return {
    amountCU,
    valuationUsd,
    referenceRate,
    computedAt: computedAt ?? referenceRate.snapshotEpoch,
  };
}

/**
 * Convert CU valuation to another currency using a reference rate.
 * Pure function — the rate must be supplied by the caller.
 *
 * @param valuationUsd - USD valuation from evaluateTokenValuation
 * @param rateToCurrency - Multiplier (e.g. 5.10 for USD→BRL)
 * @returns `valuationUsd x rateToCurrency`.
 * @throws {Error} When `rateToCurrency` is 0 or negative.
 */
export function convertValuation(valuationUsd: number, rateToCurrency: number): number {
  if (rateToCurrency <= 0) throw new Error(`convertValuation: rate=${rateToCurrency} must be > 0`);
  return valuationUsd * rateToCurrency;
}

/**
 * Assert the fundamental CU non-negativity invariant.
 * Throws with a descriptive message if violated.
 *
 * @param amountCU - CU amount to check.
 * @throws {Error} When `amountCU` is negative.
 */
export function assertCUInvariant(amountCU: bigint): void {
  if (amountCU < 0n) {
    throw new Error(`CU invariant violation: amountCU=${amountCU} — CU must be non-negative`);
  }
}
