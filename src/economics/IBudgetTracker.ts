/**
 * H2.5 — Budget Tracker Interface
 *
 * Tracks spend per tenant per epoch. CostAlertEngine evaluator remains pure.
 *
 * The default backend is `MemoryBudgetTracker`; `setBudgetTracker()` swaps it (a Redis version lives in
 * `src/infra/redis/RedisBudgetTracker.ts`). Spend is keyed by tenant and epoch; budgets by tenant only.
 *
 * @module src/economics/IBudgetTracker
 * @since Wave 2H (H2.5)
 */

import type { BudgetPolicy, AlertResult } from './CostAlertEngine.js';
import { evalBudget } from './CostAlertEngine.js';

/** Storage contract for per-tenant CU spend and budgets. */
export interface IBudgetTracker {
  /**
   * Adds CU to the tenant's spend in one epoch.
   *
   * @param tenantId - Tenant.
   * @param epochId - Accounting epoch.
   * @param cuAmount - CU to add.
   */
  recordSpend(tenantId: string, epochId: string, cuAmount: bigint): Promise<void>;
  /**
   * Reads the tenant's spend in one epoch.
   *
   * @param tenantId - Tenant.
   * @param epochId - Accounting epoch.
   * @returns CU spent; 0n when nothing was recorded.
   */
  getCurrentSpend(tenantId: string, epochId: string): Promise<bigint>;
  /**
   * Reads the tenant's budget.
   *
   * @param tenantId - Tenant.
   * @returns The policy, or null when none is set.
   */
  getBudget(tenantId: string): Promise<BudgetPolicy | null>;
  /**
   * Sets (replaces) the tenant's budget.
   *
   * @param tenantId - Tenant.
   * @param policy - New policy.
   */
  setBudget(tenantId: string, policy: BudgetPolicy): Promise<void>;
  /** Removes every spend record and budget. */
  clear(): Promise<void>;
}

/** In-memory budget tracker (default fallback). */
export class MemoryBudgetTracker implements IBudgetTracker {
  private _spend = new Map<string, bigint>();
  private _budgets = new Map<string, BudgetPolicy>();

  private spendKey(tenantId: string, epochId: string): string {
    return `${tenantId}::${epochId}`;
  }

  /**
   * See {@link IBudgetTracker.recordSpend}.
   *
   * @param tenantId - Tenant.
   * @param epochId - Accounting epoch.
   * @param cuAmount - CU to add.
   */
  async recordSpend(tenantId: string, epochId: string, cuAmount: bigint): Promise<void> {
    const key = this.spendKey(tenantId, epochId);
    const current = this._spend.get(key) ?? 0n;
    this._spend.set(key, current + cuAmount);
  }

  /**
   * See {@link IBudgetTracker.getCurrentSpend}.
   *
   * @param tenantId - Tenant.
   * @param epochId - Accounting epoch.
   * @returns CU spent; 0n when nothing was recorded.
   */
  async getCurrentSpend(tenantId: string, epochId: string): Promise<bigint> {
    return this._spend.get(this.spendKey(tenantId, epochId)) ?? 0n;
  }

  /**
   * See {@link IBudgetTracker.getBudget}.
   *
   * @param tenantId - Tenant.
   * @returns The policy, or null when none is set.
   */
  async getBudget(tenantId: string): Promise<BudgetPolicy | null> {
    return this._budgets.get(tenantId) ?? null;
  }

  /**
   * See {@link IBudgetTracker.setBudget}.
   *
   * @param tenantId - Tenant.
   * @param policy - New policy (kept by reference).
   */
  async setBudget(tenantId: string, policy: BudgetPolicy): Promise<void> {
    this._budgets.set(tenantId, policy);
  }

  /** See {@link IBudgetTracker.clear}. */
  async clear(): Promise<void> {
    this._spend.clear();
    this._budgets.clear();
  }
}

/**
 * Check budget for a tenant. Loads spend + budget, evaluates via CostAlertEngine.
 * Returns null if no budget is set for the tenant.
 *
 * @param tenantId - Tenant.
 * @param epochId - Accounting epoch whose spend is checked.
 * @param tracker - Backend to read from.
 * @returns The alert result, or null when the tenant has no budget.
 * @throws {Error} When the backend fails or the budget's `maxCU` is not positive.
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

/**
 * Returns the active budget tracker.
 *
 * @returns The current backend (in-memory by default).
 */
export function getBudgetTracker(): IBudgetTracker { return _tracker; }
/**
 * Replaces the active budget tracker.
 *
 * @param tracker - New backend; data in the old one is not copied.
 */
export function setBudgetTracker(tracker: IBudgetTracker): void { _tracker = tracker; }
/** Restores a fresh in-memory tracker (tests). */
export function resetBudgetTrackerForTest(): void { _tracker = new MemoryBudgetTracker(); }
