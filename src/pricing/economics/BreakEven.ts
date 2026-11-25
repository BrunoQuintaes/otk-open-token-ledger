/**
 * U3.5 — BreakEven (classic contribution margin)
 *
 * N* = fixedCost / (pricePerUser - variableCostPerUser)
 * Deterministic math helper.
 *
 * Floating-point USD per month; no I/O.
 *
 * @module src/pricing/economics/BreakEven
 */

/** Monthly fixed cost and per-user price and variable cost, USD. */
export type BreakEvenInput = {
  fixedCostUsdPerMonth: number;
  priceUsdPerUserPerMonth: number;
  variableCostUsdPerUserPerMonth: number;
};

/** Contribution per user and the break-even number of users (fractional, not rounded). */
export type BreakEvenResult = {
  fixedCostUsdPerMonth: number;
  contributionUsdPerUser: number;
  breakEvenUsers: number;
};

/**
 * Computes the number of users at which revenue covers the fixed cost.
 *
 * @param i - Fixed cost, price and variable cost (all >= 0).
 * @returns The contribution per user and `fixedCost / contribution`.
 * @throws {Error} When any input is negative, or the price does not exceed the variable cost.
 */
export function calculateBreakEven(i: BreakEvenInput): BreakEvenResult {
  if (i.fixedCostUsdPerMonth < 0)         throw new Error("BreakEven: fixedCost must be >= 0");
  if (i.priceUsdPerUserPerMonth < 0)      throw new Error("BreakEven: price must be >= 0");
  if (i.variableCostUsdPerUserPerMonth < 0) throw new Error("BreakEven: variable cost must be >= 0");

  const contribution = i.priceUsdPerUserPerMonth - i.variableCostUsdPerUserPerMonth;
  if (contribution <= 0) {
    throw new Error("BreakEven: contribution must be > 0 (price must exceed variable cost)");
  }

  return {
    fixedCostUsdPerMonth:  i.fixedCostUsdPerMonth,
    contributionUsdPerUser: contribution,
    breakEvenUsers: i.fixedCostUsdPerMonth / contribution,
  };
}
