/**
 * U3.5 — ScenarioEngine (tokens/calls/users → USD cost → margin → BRL)
 *
 * Deterministic, offline simulation.
 * Uses:
 *  - CostBridge.calculateUsdCost() (tokens → USD)
 *  - MarginEngine.calculateMargin() (USD + markup + optional FX)
 *
 * Prices come from the static seed table only (no Redis). Floating-point results; no I/O.
 *
 * @module src/pricing/economics/ScenarioEngine
 */

import { calculateUsdCostSync as calculateUsdCost } from "./CostBridge.js";
import { calculateMargin } from "./MarginEngine.js";

/** A usage scenario: users, call rate, duration, tokens per call and pricing. */
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

/** Totals and per-user values of a scenario (USD; BRL only when an FX rate was given). */
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

/**
 * Simulates cost, price and margin of a usage scenario.
 *
 * Call and token totals are rounded to integers before pricing.
 *
 * @param s - The scenario.
 * @returns Totals and per-user values; provider and model are lower-cased.
 * @throws {Error} When users or days are not positive, a rate or token count is negative, the model is not in
 *   the seed table, or the markup is negative.
 */
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
