/**
 * BillingCycleWorker — In-memory billing cycle store (BILL-05)
 *
 * Tracks open/submitted billing cycles per tenant.
 * In production this would be backed by PostgreSQL.
 * For demo/dev: in-memory singleton seeded from indexer data.
 */

import { getIndexer } from '../dashboard/indexer.js';
import { getTenantPlan } from './PlanRegistry.js';

export interface BillingCycle {
  tenantId: string;
  planTier: string;
  cycleStart: string;   // ISO date "YYYY-MM-DD"
  cycleEnd: string;     // ISO date "YYYY-MM-DD"
  totalCU: bigint;
  totalUsd: number;
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

export function getMemStoreCycles(): BillingCycle[] {
  if (_cycles === null) {
    _cycles = buildCycles();
  }
  return _cycles;
}

export function resetCycles(): void {
  _cycles = null;
}
