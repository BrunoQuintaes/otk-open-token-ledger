/**
 * H2.5 — Budget Tracker Interface
 *
 * Tracks spend per tenant per epoch. CostAlertEngine evaluator remains pure.
 *
 * @module economics/IBudgetTracker
 * @since Wave 2H (H2.5)
 */

import type { BudgetPolicy, AlertResult } from './CostAlertEngine.js';
import { evalBudget } from './CostAlertEngine.js';

export interface IBudgetTracker {
  recordSpend(tenantId: string, epochId: string, cuAmount: bigint): Promise<void>;
  getCurrentSpend(tenantId: string, epochId: string): Promise<bigint>;
  getBudget(tenantId: string): Promise<BudgetPolicy | null>;
  setBudget(tenantId: string, policy: BudgetPolicy): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory budget tracker (default fallback). */
export class MemoryBudgetTracker implements IBudgetTracker {
  private _spend = new Map<string, bigint>();
  private _budgets = new Map<string, BudgetPolicy>();

  private spendKey(tenantId: string, epochId: string): string {
    return `${tenantId}::${epochId}`;
  }

  async recordSpend(tenantId: string, epochId: string, cuAmount: bigint): Promise<void> {
    const key = this.spendKey(tenantId, epochId);
    const current = this._spend.get(key) ?? 0n;
    this._spend.set(key, current + cuAmount);
  }

  async getCurrentSpend(tenantId: string, epochId: string): Promise<bigint> {
    return this._spend.get(this.spendKey(tenantId, epochId)) ?? 0n;
  }

  async getBudget(tenantId: string): Promise<BudgetPolicy | null> {
    return this._budgets.get(tenantId) ?? null;
  }

  async setBudget(tenantId: string, policy: BudgetPolicy): Promise<void> {
    this._budgets.set(tenantId, policy);
  }

  async clear(): Promise<void> {
    this._spend.clear();
    this._budgets.clear();
  }
}

/**
 * Check budget for a tenant. Loads spend + budget, evaluates via CostAlertEngine.
 * Returns null if no budget is set for the tenant.
 */
export async function checkBudget(
  tenantId: string,
  epochId: string,
  tracker: IBudgetTracker,
): Promise<AlertResult | null> {
  const budget = await tracker.getBudget(tenantId);
  if (!budget) return null;
  const spend = await tracker.getCurrentSpend(tenantId, epochId);
  return evalBudget(spend, budget);
}

// Singleton
let _tracker: IBudgetTracker = new MemoryBudgetTracker();

export function getBudgetTracker(): IBudgetTracker { return _tracker; }
export function setBudgetTracker(tracker: IBudgetTracker): void { _tracker = tracker; }
export function resetBudgetTrackerForTest(): void { _tracker = new MemoryBudgetTracker(); }
