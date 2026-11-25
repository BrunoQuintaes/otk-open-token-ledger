/**
 * BillingCycleWorker — In-memory billing cycle store (BILL-05)
 *
 * Tracks open/submitted billing cycles per tenant.
 * In production this would be backed by PostgreSQL.
 * For demo/dev: in-memory singleton seeded from indexer data.
 *
 * Builds one open cycle per tenant for the current calendar month from the dashboard indexer's
 * tenant summary, with the tenant's plan tier from `PlanRegistry`. The result is cached in memory
 * until `resetCycles()` is called. Read by the billing endpoints in `src/api/routes.ts`.
 *
 * It does NOT write to PostgreSQL, submit cycles or charge anyone; every cycle it builds has
 * status `'open'`. Its margin rates (10/15/20 %) are its own and differ from `MarginLedger`.
 *
 * @module src/billing/BillingCycleWorker
 */

import { getIndexer } from '../dashboard/indexer.js';
import { getTenantPlan } from './PlanRegistry.js';

/** One tenant's billing period with its usage, cost and margin totals. */
export interface BillingCycle {
  /** Tenant the cycle belongs to. */
  tenantId: string;
  /** Plan tier name at build time (`'FREE'`, `'STARTER'` or `'PRO'`). */
  planTier: string;
  cycleStart: string;   // ISO date "YYYY-MM-DD"
  cycleEnd: string;     // ISO date "YYYY-MM-DD"
  /** Compute units consumed in the period. */
  totalCU: bigint;
  /** Provider cost of the period in USD (float). */
  totalUsd: number;
  /** Platform margin in USD (float): `totalUsd` times the tier's margin rate. */
  marginUsd: number;
  status: 'open' | 'submitted' | 'paid' | 'failed';
}

// In-memory store — rebuilt from indexer data on first access
let _cycles: BillingCycle[] | null = null;

/**
 * Build billing cycles from indexer data.
 * Groups receipts by tenant, creates one cycle per tenant for the current period.
 */
function buildCycles(): BillingCycle[] {
  const indexer = getIndexer();
  const tenants = indexer.getTenantSummary();

  const now = new Date();
  const cycleStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
  const cycleEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().slice(0, 10);

  return tenants.map(t => {
    const tier = getTenantPlan(t.tenantId);
    // OTK margin: 15% on STARTER, 20% on PRO, 10% on FREE
    const marginPct = tier === 'PRO' ? 0.20 : tier === 'STARTER' ? 0.15 : 0.10;
    const marginUsd = t.totalCostUsd * marginPct;
    return {
      tenantId: t.tenantId,
      planTier: tier,
      cycleStart,
      cycleEnd,
      totalCU: BigInt(t.totalCU),
      totalUsd: t.totalCostUsd,
      marginUsd,
      status: 'open' as const,
    };
  });
}

/**
 * Returns the in-memory billing cycles, building them from the indexer on first call.
 *
 * @returns The cached array (shared, not a copy; callers must not mutate it).
 */
export function getMemStoreCycles(): BillingCycle[] {
  if (_cycles === null) {
    _cycles = buildCycles();
  }
  return _cycles;
}

/**
 * Drops the cached cycles so the next `getMemStoreCycles()` call rebuilds them. Used by tests.
 */
export function resetCycles(): void {
  _cycles = null;
}
