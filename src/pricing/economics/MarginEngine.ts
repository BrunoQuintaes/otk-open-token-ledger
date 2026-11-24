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
 */

export type MarginInput = {
  costUsd: number;
  markupPercent: number;   // e.g. 30 for 30%
  fxRate?: number;         // optional USD→BRL
};

export type MarginResult = {
  costUsd: number;
  finalPriceUsd: number;
  marginUsd: number;
  marginPercent: number;
  finalPriceBrl?: number;
};

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
