/**
 * RB-056 — Policy Engine (Quotas, Rate Limits, SLA)
 *
 * Pure evaluator — no I/O, no side effects.
 * All state is passed in by the caller (snapshot pattern).
 *
 * Evaluates:
 *   1. Quota policy (CU budget per period)
 *   2. Rate limit policy (requests per window)
 *   3. SLA policy (max latency assertion)
 *
 * @module security/PolicyEngine
 * @since RB-056
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Accounting period of a quota.
 */
export type PolicyPeriod = 'hourly' | 'daily' | 'monthly';

/**
 * Limit on cost units (CU) consumed per period.
 */
export type QuotaPolicy = {
  type: 'quota';
  /** Max CU allowed per period */
  maxCU: bigint;
  period: PolicyPeriod;
};

/**
 * Limit on requests per time window.
 */
export type RateLimitPolicy = {
  type: 'rate_limit';
  /** Max requests per window */
  maxRequests: number;
  /** Window size in seconds */
  windowSeconds: number;
};

/**
 * Maximum acceptable p99 latency.
 */
export type SLAPolicy = {
  type: 'sla';
  /** Max allowed p99 latency in ms */
  maxLatencyP99Ms: number;
};

/**
 * Any policy the engine evaluates.
 */
export type Policy = QuotaPolicy | RateLimitPolicy | SLAPolicy;

/**
 * Snapshot of the state a policy is evaluated against; absent counters count as 0, absent latency passes.
 */
export type PolicyEvalContext = {
  /** CU consumed so far in the current period */
  consumedCU?: bigint;
  /** Number of requests in current window */
  requestsInWindow?: number;
  /** Observed p99 latency in ms */
  observedP99Ms?: number;
};

/**
 * Result of a policy evaluation: allowed, or refused with a reason and the policy type.
 */
export type PolicyDecision =
  | { allowed: true }
  | { allowed: false; reason: string; policy: Policy['type'] };

// ---------------------------------------------------------------------------
// Evaluators
// ---------------------------------------------------------------------------

function evalQuota(policy: QuotaPolicy, ctx: PolicyEvalContext): PolicyDecision {
  const consumed = ctx.consumedCU ?? 0n;
  if (consumed >= policy.maxCU) {
    return {
      allowed: false,
      reason: `Quota exceeded: ${consumed}/${policy.maxCU} CU (${policy.period})`,
      policy: 'quota',
    };
  }
  return { allowed: true };
}

function evalRateLimit(policy: RateLimitPolicy, ctx: PolicyEvalContext): PolicyDecision {
  const requests = ctx.requestsInWindow ?? 0;
  if (requests >= policy.maxRequests) {
    return {
      allowed: false,
      reason: `Rate limit exceeded: ${requests}/${policy.maxRequests} req per ${policy.windowSeconds}s`,
      policy: 'rate_limit',
    };
  }
  return { allowed: true };
}

function evalSLA(policy: SLAPolicy, ctx: PolicyEvalContext): PolicyDecision {
  const p99 = ctx.observedP99Ms;
  if (p99 !== undefined && p99 > policy.maxLatencyP99Ms) {
    return {
      allowed: false,
      reason: `SLA breach: p99=${p99}ms > max=${policy.maxLatencyP99Ms}ms`,
      policy: 'sla',
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Evaluate a single policy against context.
 *
 * @param policy - Policy to evaluate.
 * @param ctx - Current counters.
 * @returns The decision; quota and rate limit refuse at `>=` the limit, SLA refuses at `>` the maximum.
 */
export function evaluatePolicy(policy: Policy, ctx: PolicyEvalContext): PolicyDecision {
  switch (policy.type) {
    case 'quota':      return evalQuota(policy, ctx);
    case 'rate_limit': return evalRateLimit(policy, ctx);
    case 'sla':        return evalSLA(policy, ctx);
  }
}

/**
 * Evaluate all policies. Returns first denial or allowed if all pass.
 *
 * @param policies - Policies in evaluation order.
 * @param ctx - Current counters.
 * @returns The first refusal, or `allowed: true` (also for an empty list).
 */
export function evaluateAll(policies: Policy[], ctx: PolicyEvalContext): PolicyDecision {
  for (const p of policies) {
    const d = evaluatePolicy(p, ctx);
    if (!d.allowed) return d;
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Context Builder (E6.4 — W5-5B01)
// ---------------------------------------------------------------------------

import type { IBudgetTracker } from '../economics/IBudgetTracker.js';

/**
 * Build a PolicyEvalContext for a tenant from live infrastructure state.
 *
 * Reads consumedCU from the budget tracker (Redis-backed in production).
 * requestsInWindow is omitted — the caller's rate limiter handles that separately.
 *
 * @param tenantId  Tenant identifier
 * @param epochId   Current epoch ID (string, e.g. "709")
 * @param budgetTracker  Injected budget tracker (getBudgetTracker() in production)
 * @returns A context with only `consumedCU` set.
 */
export async function buildContextForTenant(
  tenantId: string,
  epochId: string,
  budgetTracker: IBudgetTracker,
): Promise<PolicyEvalContext> {
  const consumedCU = await budgetTracker.getCurrentSpend(tenantId, epochId);
  return { consumedCU };
}
