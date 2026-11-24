/**
 * U3.5 — BreakEven (classic contribution margin)
 *
 * N* = fixedCost / (pricePerUser - variableCostPerUser)
 * Deterministic math helper.
 */

export type BreakEvenInput = {
  fixedCostUsdPerMonth: number;
  priceUsdPerUserPerMonth: number;
  variableCostUsdPerUserPerMonth: number;
};

export type BreakEvenResult = {
  fixedCostUsdPerMonth: number;
  contributionUsdPerUser: number;
  breakEvenUsers: number;
};

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
