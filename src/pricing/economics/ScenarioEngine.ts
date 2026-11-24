/**
 * U3.5 — ScenarioEngine (tokens/calls/users → USD cost → margin → BRL)
 *
 * Deterministic, offline simulation.
 * Uses:
 *  - CostBridge.calculateUsdCost() (tokens → USD)
 *  - MarginEngine.calculateMargin() (USD + markup + optional FX)
 */

import { calculateUsdCostSync as calculateUsdCost } from "./CostBridge.js";
import { calculateMargin } from "./MarginEngine.js";

export type ScenarioInput = {
  provider: string;
  model: string;
  users: number;
  callsPerUserPerDay: number;
  days: number;
  inputTokensPerCall: number;
  outputTokensPerCall: number;
  markupPercent: number;
  fxRate?: number; // USD→BRL snapshot
};

export type ScenarioResult = {
  provider: string;
  model: string;

  users: number;
  callsTotal: number;

  inputTokensTotal: number;
  outputTokensTotal: number;

  costUsdTotal: number;       // variable cost (LLM)
  priceUsdTotal: number;      // final price after markup
  marginUsdTotal: number;

  costUsdPerUser: number;
  priceUsdPerUser: number;
  marginUsdPerUser: number;

  priceBrlTotal?: number;
  priceBrlPerUser?: number;
};

export function simulateScenario(s: ScenarioInput): ScenarioResult {
  if (s.users <= 0) throw new Error("ScenarioEngine: users must be > 0");
  if (s.callsPerUserPerDay < 0 || s.days <= 0) throw new Error("ScenarioEngine: invalid calls/day or days");
  if (s.inputTokensPerCall < 0 || s.outputTokensPerCall < 0) throw new Error("ScenarioEngine: tokens/call must be >= 0");

  const callsTotal = Math.round(s.users * s.callsPerUserPerDay * s.days);

  const inputTokensTotal  = Math.round(callsTotal * s.inputTokensPerCall);
  const outputTokensTotal = Math.round(callsTotal * s.outputTokensPerCall);

  const usd = calculateUsdCost({
    provider: s.provider,
    model: s.model,
    inputTokens: inputTokensTotal,
    outputTokens: outputTokensTotal,
  });

  const margin = calculateMargin({
    costUsd: usd.totalCostUsd,
    markupPercent: s.markupPercent,
    fxRate: s.fxRate,
  });

  const result: ScenarioResult = {
    provider: s.provider.toLowerCase(),
    model: s.model.toLowerCase(),
    users: s.users,
    callsTotal,
    inputTokensTotal,
    outputTokensTotal,
    costUsdTotal:     usd.totalCostUsd,
    priceUsdTotal:    margin.finalPriceUsd,
    marginUsdTotal:   margin.marginUsd,
    costUsdPerUser:   usd.totalCostUsd   / s.users,
    priceUsdPerUser:  margin.finalPriceUsd / s.users,
    marginUsdPerUser: margin.marginUsd   / s.users,
  };

  if (margin.finalPriceBrl !== undefined) {
    result.priceBrlTotal    = margin.finalPriceBrl;
    result.priceBrlPerUser  = margin.finalPriceBrl / s.users;
  }

  return result;
}
