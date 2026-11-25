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
 * Pure functions, no I/O. No caller in `src/` at the evaluated version; `BillingCycleWorker`
 * uses its own margin rates.
 *
 * @module src/billing/MarginLedger
 * @since W7-C (BILL-07)
 */

import type { PlanTier } from './PlanRegistry.js';

/** Margin rates per tier (cost-plus) */
const MARGIN_RATES: Record<PlanTier, number> = {
  FREE:    0.00,
  STARTER: 0.30,
  PRO:     0.20,
};

/** Breakdown of one margin computation; every amount is in USD (float). */
export interface MarginResult {
  providerCostUsd: number;
  /** Fraction applied to the provider cost (0.30 means 30 %). */
  marginRate: number;
  marginUsd: number;
  /** What the tenant pays: `providerCostUsd + marginUsd`. */
  collectedUsd: number;
}

/**
 * Compute the OTK margin for a given plan tier and provider cost.
 *
 * @param tier - Plan tier; an unknown tier gets a 0 margin rate.
 * @param providerCostUsd - Provider cost in USD (from CostBridge).
 * @returns The rate, the margin and the collected total.
 */
export function computeMarginDetails(tier: PlanTier, providerCostUsd: number): MarginResult {
  const marginRate = MARGIN_RATES[tier] ?? 0;
  const marginUsd = providerCostUsd * marginRate;
  const collectedUsd = providerCostUsd + marginUsd;
  return { providerCostUsd, marginRate, marginUsd, collectedUsd };
}

/**
 * Convenience: return only the margin USD amount.
 *
 * @param tier - Plan tier; an unknown tier gets a 0 margin rate.
 * @param providerCostUsd - Provider cost in USD.
 * @returns The margin in USD.
 */
export function computeMargin(tier: PlanTier, providerCostUsd: number): number {
  return computeMarginDetails(tier, providerCostUsd).marginUsd;
}

/**
 * Aggregate P&L over a set of billing cycles.
 *
 * The margin is taken from each cycle as stored, not recomputed; `planTier` is not read.
 *
 * @param cycles - Cycles with `totalUsd` (provider cost) and `marginUsd`, both in USD.
 * @returns Sums in USD: provider cost, margin and their total (`totalCollected`).
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
