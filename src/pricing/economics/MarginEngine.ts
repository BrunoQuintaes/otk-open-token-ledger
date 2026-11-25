/**
 * U3.4 — Margin & Simulation Engine
 *
 * Computes:
 *  - Final price with markup
 *  - Margin in USD
 *  - Margin %
 *  - BRL conversion (optional)
 *
 * Pure math layer — no provider coupling.
 *
 * Floating-point USD; no I/O. Note that `marginPercent` is the markup over cost, not the margin as a share
 * of the final price. Used by `PricingEngineV2.ts`, `ScenarioEngine.ts` and `EconomicReport.ts`.
 *
 * @module src/pricing/economics/MarginEngine
 */

/** Inputs of {@link calculateMargin}. */
export type MarginInput = {
  costUsd: number;
  markupPercent: number;   // e.g. 30 for 30%
  fxRate?: number;         // optional USD→BRL
};

/** Price, margin and optional BRL price; `marginPercent` equals the input markup percent. */
export type MarginResult = {
  costUsd: number;
  finalPriceUsd: number;
  marginUsd: number;
  marginPercent: number;
  finalPriceBrl?: number;
};

/**
 * Applies a markup to a cost.
 *
 * @param input - Cost in USD, markup in percent and optional USD→BRL rate.
 * @returns The final price and margin; `finalPriceBrl` only when `fxRate` is positive.
 * @throws {Error} When `costUsd` or `markupPercent` is negative.
 */
export function calculateMargin(input: MarginInput): MarginResult {
  if (input.costUsd < 0) {
    throw new Error("MarginEngine: costUsd must be >= 0");
  }
  if (input.markupPercent < 0) {
    throw new Error("MarginEngine: markupPercent must be >= 0");
  }

  const multiplier = 1 + input.markupPercent / 100;
  const finalPriceUsd = input.costUsd * multiplier;
  const marginUsd = finalPriceUsd - input.costUsd;

  const result: MarginResult = {
    costUsd: input.costUsd,
    finalPriceUsd,
    marginUsd,
    marginPercent: input.markupPercent,
  };

  if (input.fxRate && input.fxRate > 0) {
    result.finalPriceBrl = finalPriceUsd * input.fxRate;
  }

  return result;
}
