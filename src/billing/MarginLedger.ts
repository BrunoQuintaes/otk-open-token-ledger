/**
 * BILL-07 — MarginLedger
 *
 * Computes OTK margin: the difference between what was collected from the
 * tenant and what was paid to the AI provider.
 *
 * Margin rates by plan tier:
 *   FREE:    0%  (no charge, no margin)
 *   STARTER: 30% markup on provider cost (flat plan revenue covers margin)
 *   PRO:     20% markup on provider cost (volume discount)
 *
 * Formula:
 *   marginUsd = providerCostUsd * marginRate
 *   collectedUsd = providerCostUsd * (1 + marginRate)
 *
 * The marginRate is applied to providerCostUsd (not to collectedUsd) to avoid
 * circular dependency. This is a simple cost-plus model.
 *
 * @module billing/MarginLedger
 * @since W7-C (BILL-07)
 */

import type { PlanTier } from './PlanRegistry.js';

/** Margin rates per tier (cost-plus) */
const MARGIN_RATES: Record<PlanTier, number> = {
  FREE:    0.00,
  STARTER: 0.30,
  PRO:     0.20,
};

export interface MarginResult {
  providerCostUsd: number;
  marginRate: number;
  marginUsd: number;
  collectedUsd: number;
}

/**
 * Compute the OTK margin for a given plan tier and provider cost.
 *
 * @param tier            Plan tier
 * @param providerCostUsd Provider cost in USD (from CostBridge)
 */
export function computeMarginDetails(tier: PlanTier, providerCostUsd: number): MarginResult {
  const marginRate = MARGIN_RATES[tier] ?? 0;
  const marginUsd = providerCostUsd * marginRate;
  const collectedUsd = providerCostUsd + marginUsd;
  return { providerCostUsd, marginRate, marginUsd, collectedUsd };
}

/**
 * Convenience: return only the margin USD amount.
 */
export function computeMargin(tier: PlanTier, providerCostUsd: number): number {
  return computeMarginDetails(tier, providerCostUsd).marginUsd;
}

/**
 * Aggregate P&L over a set of billing cycles.
 *
 * @returns { totalProviderCost, totalMargin, totalCollected }
 */
export function aggregatePnL(
  cycles: Array<{ planTier: string; totalUsd: number; marginUsd: number }>,
): { totalProviderCost: number; totalMargin: number; totalCollected: number } {
  let totalProviderCost = 0;
  let totalMargin = 0;
  for (const c of cycles) {
    totalProviderCost += c.totalUsd;
    totalMargin += c.marginUsd;
  }
  return {
    totalProviderCost,
    totalMargin,
    totalCollected: totalProviderCost + totalMargin,
  };
}
