/**
 * U3.7 — CostReconciliation
 *
 * Compares estimated cost (CostBridge / static price table) against
 * the real cost returned by the provider (when available in the UsageLedger).
 *
 * Decision logic:
 *   if (event.cost != null && event.currency === "USD")  → use real cost
 *   else                                                  → fallback to CostBridge estimate
 *
 * Academic value:
 *   Generates usdCostDelta and deltaPercent columns that quantify
 *   the estimation error of the static price table vs actual billing —
 *   a direct empirical contribution for the FGV dissertation.
 */

import { calculateUsdCostSync as calculateUsdCost } from "./CostBridge.js";

export type ReconciliationInput = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Real cost from provider (from UsageLedger event.cost) */
  realCostUsd?: number | null;
  /** Currency of the real cost (must be "USD" to be used) */
  currency?: string | null;
};

export type ReconciliationResult = {
  /** Estimated cost from static price table (CostBridge) */
  usdCostEstimated: number;
  /** Real cost from provider (if available); null if not reported */
  usdCostReal: number | null;
  /** Source used: "real" | "estimated" */
  source: "real" | "estimated";
  /** Absolute difference: real - estimated (null if real not available) */
  usdCostDelta: number | null;
  /** Relative error: (real - estimated) / estimated × 100 (null if not available) */
  deltaPercent: number | null;
};

export function reconcileCost(input: ReconciliationInput): ReconciliationResult {
  const usdCostEstimated = calculateUsdCost({
    provider: input.provider,
    model: input.model,
    inputTokens: input.inputTokens,
    outputTokens: input.outputTokens,
  }).totalCostUsd;

  const hasRealCost =
    input.realCostUsd != null &&
    Number.isFinite(input.realCostUsd) &&
    input.realCostUsd >= 0 &&
    input.currency?.toUpperCase() === "USD";

  if (!hasRealCost) {
    return {
      usdCostEstimated,
      usdCostReal: null,
      source: "estimated",
      usdCostDelta: null,
      deltaPercent: null,
    };
  }

  const usdCostReal = input.realCostUsd as number;
  const usdCostDelta = usdCostReal - usdCostEstimated;
  const deltaPercent =
    usdCostEstimated !== 0
      ? (usdCostDelta / usdCostEstimated) * 100
      : null;

  return {
    usdCostEstimated,
    usdCostReal,
    source: "real",
    usdCostDelta,
    deltaPercent,
  };
}
