/**
 * RB-060 — Cost Alert Engine (minimum)
 *
 * Pure evaluator for budget thresholds in CU.
 *
 * @module economics/CostAlertEngine
 * @since RB-060
 */

export type AlertLevel = 'info' | 'warn' | 'critical';

export type BudgetPolicy = {
  maxCU: bigint;
  warnPct: number;     // e.g. 80
  criticalPct: number; // e.g. 95
};

export type AlertResult =
  | { triggered: false; level: null; pctUsed: number }
  | { triggered: true; level: AlertLevel; pctUsed: number };

export function evalBudget(consumedCU: bigint, policy: BudgetPolicy): AlertResult {
  if (policy.maxCU <= 0n) throw new Error('CostAlertEngine: maxCU must be > 0');
  const pctUsed = Number((consumedCU * 10000n) / policy.maxCU) / 100; // 2 decimals
  if (pctUsed >= policy.criticalPct) return { triggered: true, level: 'critical', pctUsed };
  if (pctUsed >= policy.warnPct) return { triggered: true, level: 'warn', pctUsed };
  return { triggered: false, level: null, pctUsed };
}
