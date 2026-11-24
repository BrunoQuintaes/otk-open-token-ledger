/**
 * RB-E4 — Enterprise Evaluator (pure composition)
 *
 * Composes all enterprise governance modules in a single pure function:
 *   1. requireTenantId      — tenant boundary guard
 *   2. evaluateAll(policies) — quota / rate_limit / sla snapshot check
 *   3. debitToken           — billing debit (throws on failure)
 *   4. computePricingV2     — tier-based pricing
 *   5. chainHash            — append-only audit record
 *   6. evalBudget           — cost alert threshold
 *
 * Deterministic: all time/seed inputs are injectable via EnterpriseRequest.
 * No I/O, no side effects.
 *
 * @module enterprise/EnterpriseEvaluator
 * @since E4
 */

import { requireTenantId } from '../security/TenantIsolation.js';
import { evaluateAll } from '../security/PolicyEngine.js';
import { debitToken } from '../economics/BillingToken.js';
import { computePricingV2 } from '../pricing/PricingEngineV2.js';
import { chainHash, type AuditRecord } from '../security/AuditLogChain.js';
import { evalBudget } from '../economics/CostAlertEngine.js';
import type { EnterpriseRequest, EnterpriseResult } from './EnterpriseContext.js';

/**
 * Pure composite enterprise evaluation.
 *
 * Policy denied path:
 *   - tenantCtx validated
 *   - policyDecision: { allowed: false, reason, policy }
 *   - tokenAfterDebit: null (no debit attempted)
 *   - pricing: null
 *   - auditHash: updated (denial is audited)
 *   - budgetAlert: evaluated on consumedCU (unchanged)
 *
 * Allowed path:
 *   - all fields populated
 *   - budgetAlert evaluated on consumedCU + costCU (post-debit total)
 */
export function evaluateEnterprise(req: EnterpriseRequest): EnterpriseResult {
  // 1. Tenant guard (throws if tenantId missing/blank)
  const tenantCtx = requireTenantId(req.tenant);

  // 2. Policy check (pure snapshot evaluation)
  const policyDecision = evaluateAll(req.policies, req.policyCtx);

  if (!policyDecision.allowed) {
    // Denied path — audit the denial; do not debit or price
    const denialRecord: AuditRecord = {
      ts: req.nowIso,
      tenantId: tenantCtx.tenantId,
      actor: tenantCtx.userId ?? 'system',
      action: 'policy_denied',
      meta: { reason: policyDecision.reason, policy: String(policyDecision.policy) },
    };
    const auditHash = chainHash(req.prevAuditHash, denialRecord);
    const budgetAlert = evalBudget(req.consumedCU, req.budgetPolicy);
    return { tenantCtx, policyDecision, tokenAfterDebit: null, pricing: null, auditHash, budgetAlert };
  }

  // 3. Billing debit — throws BillingToken error on expired/insufficient balance
  const tokenAfterDebit = debitToken(req.token, req.costCU, req.nowEpoch);

  // 4. Pricing
  const pricing = computePricingV2(req.pricing);

  // 5. Audit hash (success path)
  const successRecord: AuditRecord = {
    ts: req.nowIso,
    tenantId: tenantCtx.tenantId,
    actor: tenantCtx.userId ?? 'system',
    action: 'metered',
    meta: {
      costCU: String(req.costCU),
      model: req.pricing.model,
      finalPriceUsd: pricing.finalPriceUsd,
    },
  };
  const auditHash = chainHash(req.prevAuditHash, successRecord);

  // 6. Budget alert (post-debit: consumedCU + costCU)
  const budgetAlert = evalBudget(req.consumedCU + req.costCU, req.budgetPolicy);

  return { tenantCtx, policyDecision, tokenAfterDebit, pricing, auditHash, budgetAlert };
}
