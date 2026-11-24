/**
 * RB-E4 — Enterprise Context (canonical types for composition)
 *
 * Aggregates input/output types for the enterprise evaluation pipeline:
 *   requireTenantId → evaluateAll(policies) → debitToken → computePricingV2 → chainHash → evalBudget
 *
 * All timestamps and seeds are injectable for determinism.
 * Pure types — no I/O.
 *
 * @module enterprise/EnterpriseContext
 * @since E4
 */

import type { TenantContext } from '../security/TenantIsolation.js';
import type { BillingToken } from '../economics/BillingToken.js';
import type { Policy, PolicyEvalContext, PolicyDecision } from '../security/PolicyEngine.js';
import type { PricingV2Input, PricingV2Result } from '../pricing/PricingEngineV2.js';
import type { BudgetPolicy, AlertResult } from '../economics/CostAlertEngine.js';

export type { TenantContext, BillingToken, Policy, PolicyEvalContext, PolicyDecision };
export type { PricingV2Input, PricingV2Result, BudgetPolicy, AlertResult };

/**
 * Input to the enterprise evaluation pipeline.
 * All injectable fields (nowEpoch, nowIso, prevAuditHash) are required
 * to ensure the composite function is pure and deterministic.
 */
export type EnterpriseRequest = {
  /** Tenant context — tenantId required */
  tenant: { tenantId?: string; userId?: string };
  /** Policies to evaluate (quota / rate_limit / sla) */
  policies: Policy[];
  /** Snapshot of current usage metrics for policy evaluation */
  policyCtx: PolicyEvalContext;
  /** Pre-funded billing token */
  token: BillingToken;
  /** CU amount to debit for this request */
  costCU: bigint;
  /**
   * Total CU consumed so far this period (for budget alert, excluding this request).
   *
   * INVARIANT: must be the same snapshot used to populate `policyCtx.consumedCU`.
   * If these diverge (stale policy snapshot vs fresh budget snapshot) the pipeline
   * can produce inconsistent deny/alert decisions. Callers must read both from the
   * same atomic snapshot of the usage store.
   */
  consumedCU: bigint;
  /** Pricing inputs for this request */
  pricing: PricingV2Input;
  /** Budget threshold policy */
  budgetPolicy: BudgetPolicy;
  /** Previous audit hash (genesis: '0'.repeat(64)) — injectable */
  prevAuditHash: string;
  /** Current epoch in unix seconds — injectable for determinism */
  nowEpoch: number;
  /** Current timestamp ISO — injectable for determinism */
  nowIso: string;
};

/**
 * Output from the enterprise evaluation pipeline.
 */
export type EnterpriseResult = {
  /** Validated tenant context */
  tenantCtx: TenantContext;
  /** Policy gate result */
  policyDecision: PolicyDecision;
  /** Token after debit; null when policy denied (debit not attempted) */
  tokenAfterDebit: BillingToken | null;
  /** Pricing computation; null when policy denied */
  pricing: PricingV2Result | null;
  /** New audit hash (includes this event) */
  auditHash: string;
  /** Budget alert state post-event */
  budgetAlert: AlertResult;
};
