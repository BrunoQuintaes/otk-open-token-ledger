/**
 * RB-060 — Cost Alert Engine (minimum)
 *
 * Pure evaluator for budget thresholds in CU.
 *
 * Used by `IBudgetTracker.checkBudget` and by the enterprise evaluator (`src/enterprise/`). No I/O and no state.
 *
 * @module src/economics/CostAlertEngine
 * @since RB-060
 */

/** Severity of a budget alert (`evalBudget` returns only `warn` or `critical`). */
export type AlertLevel = 'info' | 'warn' | 'critical';

/** Budget of one tenant in CU, with alert thresholds in percent of `maxCU`. */
export type BudgetPolicy = {
  /** Budget in CU; must be greater than 0. */
  maxCU: bigint;
  warnPct: number;     // e.g. 80
  criticalPct: number; // e.g. 95
};

/** Result of `evalBudget`; `pctUsed` is the share of the budget used, in percent with 2 decimals (truncated). */
export type AlertResult =
  | { triggered: false; level: null; pctUsed: number }
  | { triggered: true; level: AlertLevel; pctUsed: number };

/**
 * Compares consumed CU with a budget policy.
 *
 * @param consumedCU - CU consumed so far.
 * @param policy - Budget and thresholds.
 * @returns `critical` at or above `criticalPct`, `warn` at or above `warnPct`, otherwise not triggered.
 * @throws {Error} When `policy.maxCU` is 0 or negative.
 */
export function evalBudget(consumedCU: bigint, policy: BudgetPolicy): AlertResult {
  if (policy.maxCU <= 0n) throw new Error('CostAlertEngine: maxCU must be > 0');
  const pctUsed = Number((consumedCU * 10000n) / policy.maxCU) / 100; // 2 decimals
  if (pctUsed >= policy.criticalPct) return { triggered: true, level: 'critical', pctUsed };
  if (pctUsed >= policy.warnPct) return { triggered: true, level: 'warn', pctUsed };
  return { triggered: false, level: null, pctUsed };
}
