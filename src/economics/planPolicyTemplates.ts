/**
 * Plan Policy Templates — canonical Policy[] for each PlanTier (E6.4)
 *
 * Maps PlanTier → Policy[] for use with PolicyEngine.evaluateAll().
 * Quota values mirror PlanRegistry.PLANS.cuQuotaPerEpoch.
 * Rate limits mirror PlanRegistry.PLANS.rateLimitPerMinute.
 *
 * FREE:    10k CU/epoch quota + 60 req/min rate limit
 * STARTER: 1M CU/epoch quota + 300 req/min rate limit
 * PRO:     no hard quota     + 1000 req/min rate limit
 *
 * @module economics/planPolicyTemplates
 * @since Wave 5 (W5-5B01 / E6.4)
 */

import type { PlanTier } from '../billing/PlanRegistry.js';
import type { Policy } from '../security/PolicyEngine.js';

/**
 * Return the canonical policy set for a given plan tier.
 * The returned array is evaluated left-to-right by evaluateAll() — first denial wins.
 */
export function getPoliciesForPlan(tier: PlanTier): Policy[] {
  switch (tier) {
    case 'FREE':
      return [
        { type: 'quota', maxCU: 10_000n, period: 'hourly' },
        { type: 'rate_limit', maxRequests: 60, windowSeconds: 60 },
      ];
    case 'STARTER':
      return [
        { type: 'quota', maxCU: 1_000_000n, period: 'hourly' },
        { type: 'rate_limit', maxRequests: 300, windowSeconds: 60 },
      ];
    case 'PRO':
      // No hard CU quota — usage tracked but not enforced at request time
      return [
        { type: 'rate_limit', maxRequests: 1000, windowSeconds: 60 },
      ];
  }
}

/**
 * Extract only quota policies from a policy set.
 * Used when checking CU budget separately from rate limits.
 */
export function quotaPoliciesOnly(policies: Policy[]): Policy[] {
  return policies.filter(p => p.type === 'quota');
}
