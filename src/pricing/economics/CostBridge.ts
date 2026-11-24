/**
 * U3.3 — CU ↔ USD Bridge
 *
 * Maps raw token usage (provider + model + tokens) to a USD cost.
 *
 * Price resolution order (PI-07):
 *   1. PriceStore (Redis live prices — refreshed every 24h by PriceScheduler)
 *   2. PROVIDER_PRICE_TABLE (static seed — deterministic fallback)
 *   3. Error if provider/model unknown in both
 *
 * This is a complementary layer to CostUnits.ts:
 *   CostUnits  → deterministic internal CU (ZK-compatible, bigint, cross-provider index)
 *   CostBridge → fiat USD cost (economic reporting, FGV dissertation evidence)
 */

import { PROVIDER_PRICE_TABLE } from "./ProviderPriceTable.js";
import { getPrice } from "../PriceStore.js";

export type CostBridgeInput = {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

export type CostBridgeResult = {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  provider: string;
  model: string;
  priceSource: 'live' | 'seed';
};

/**
 * Calculate USD cost for a token usage record.
 * Checks PriceStore first (live Redis prices), falls back to static seed.
 * Async to support PriceStore Redis lookup.
 */
export async function calculateUsdCost(input: CostBridgeInput): Promise<CostBridgeResult> {
  const providerLower = input.provider.toLowerCase();
  const modelLower = input.model.toLowerCase();

  // 1. Try live prices from PriceStore (Redis)
  const livePrice = await getPrice(providerLower, modelLower);
  if (livePrice) {
    const inputCostUsd  = (input.inputTokens  / 1000) * livePrice.inputUsdPer1K;
    const outputCostUsd = (input.outputTokens / 1000) * livePrice.outputUsdPer1K;
    return {
      inputCostUsd,
      outputCostUsd,
      totalCostUsd: inputCostUsd + outputCostUsd,
      provider: providerLower,
      model: modelLower,
      priceSource: 'live',
    };
  }

  // 2. Fallback to static seed
  const providerTable = PROVIDER_PRICE_TABLE[providerLower];
  if (!providerTable) {
    throw new Error(
      `CostBridge: unknown provider '${input.provider}'. Known: ${Object.keys(PROVIDER_PRICE_TABLE).join(", ")}`
    );
  }

  const modelPrice = providerTable[modelLower];
  if (!modelPrice) {
    throw new Error(
      `CostBridge: unknown model '${input.model}' for provider '${input.provider}'. Known: ${Object.keys(providerTable).join(", ")}`
    );
  }

  const inputCostUsd  = (input.inputTokens  / 1000) * modelPrice.inputUsdPer1K;
  const outputCostUsd = (input.outputTokens / 1000) * modelPrice.outputUsdPer1K;

  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
    provider: providerLower,
    model: modelLower,
    priceSource: 'seed',
  };
}

/**
 * Synchronous version using seed only (for backward compat with callers that can't await).
 * Does NOT consult PriceStore. Use calculateUsdCost() for live prices.
 */
export function calculateUsdCostSync(input: CostBridgeInput): Omit<CostBridgeResult, 'priceSource'> & { priceSource: 'seed' } {
  const providerLower = input.provider.toLowerCase();
  const modelLower = input.model.toLowerCase();

  const providerTable = PROVIDER_PRICE_TABLE[providerLower];
  if (!providerTable) {
    throw new Error(
      `CostBridge: unknown provider '${input.provider}'. Known: ${Object.keys(PROVIDER_PRICE_TABLE).join(", ")}`
    );
  }

  const modelPrice = providerTable[modelLower];
  if (!modelPrice) {
    throw new Error(
      `CostBridge: unknown model '${input.model}' for provider '${input.provider}'. Known: ${Object.keys(providerTable).join(", ")}`
    );
  }

  const inputCostUsd  = (input.inputTokens  / 1000) * modelPrice.inputUsdPer1K;
  const outputCostUsd = (input.outputTokens / 1000) * modelPrice.outputUsdPer1K;

  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
    provider: providerLower,
    model: modelLower,
    priceSource: 'seed',
  };
}
