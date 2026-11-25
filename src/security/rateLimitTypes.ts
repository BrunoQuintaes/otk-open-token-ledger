/**
 * Adaptive Rate Limit Types — canonical contract for rate limiting decisions (F4.1)
 *
 * Distinguishes from the existing PolicyEngine.RateLimitPolicy:
 *   PolicyEngine    = stateless, snapshot-based (caller provides requestsInWindow)
 *   AdaptiveRateLimiter = stateful, sliding-window, allow/throttle/deny with hints
 *
 * Key dimensions: tenantId + optional userId + optional provider.
 * Decision: allow | throttle | deny — with reason, remaining, resetAt, retryAfterMs.
 *
 * "Adaptive" in this context:
 *   - configurable throttle threshold (throttleAt fraction of hard limit)
 *   - allows operators to tune the soft limit based on operational data
 *   - future extension: auto-lower threshold under elevated error pressure
 *
 * Scope (in-scope for F4):
 *   - canonical types and key builder
 *   - allow/throttle/deny decision contract
 *   - stateful sliding-window engine
 *   - GET /ratelimit/status monitoring surface
 *
 * Scope (out-of-scope for F4):
 *   - Redis / distributed counters / multi-instance coordination
 *   - quota-based financial billing limits (handled by PolicyEngine + BillingToken)
 *   - ML-based adaptive prediction / autoscaling
 *   - webhook / notification on threshold breach
 *
 * @module security/rateLimitTypes
 * @since F4.1
 */

/** Composite key dimensions for rate limiting. */
export type RateLimitKey = {
  tenantId: string;
  userId?: string;   // optional — per-user limits
  provider?: string; // optional — per-provider limits
};

/**
 * Build a canonical string key from RateLimitKey parts.
 * Format: `tenantId::userId::provider` (wildcards where absent).
 *
 * @param parts - Tenant (required), optional user and provider.
 * @returns The key text; parts are joined without escaping, so values containing `::` can collide.
 */
export function buildRateLimitKey(parts: RateLimitKey): string {
  return [
    parts.tenantId,
    parts.userId   ?? '*',
    parts.provider ?? '*',
  ].join('::');
}

/** Configuration for an adaptive rate limit evaluation. */
export type AdaptiveRateLimitConfig = {
  /** Sliding window duration in seconds. */
  windowSeconds: number;
  /** Hard limit: requests at or above this → deny. */
  maxRequests: number;
  /**
   * Throttle threshold as fraction of maxRequests (0–1, default 0.8).
   * Requests at or above `floor(maxRequests * throttleAt)` → throttle.
   * Operators tune this based on operational pressure data.
   */
  throttleAt?: number;
};

/** Result of evaluating an adaptive rate limit decision. */
export type AdaptiveRateLimitDecision = {
  /** Canonical decision outcome. */
  decision: 'allow' | 'throttle' | 'deny';
  /** Human-readable reason (present for throttle and deny). */
  reason?: string;
  /** Number of requests recorded in the current window. */
  usedInWindow: number;
  /** Requests remaining before hard limit (0 for deny). */
  remaining: number;
  /** Unix seconds when the oldest request in the window expires. */
  resetAt: number;
  /** Suggested retry delay in ms (present for throttle/deny). */
  retryAfterMs?: number;
};
