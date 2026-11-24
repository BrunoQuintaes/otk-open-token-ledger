/**
 * AdaptiveRateLimiter — stateful sliding-window rate limit engine (F4.2)
 *
 * Maintains a per-key request log and evaluates allow/throttle/deny decisions.
 *
 * Design:
 *   - Sliding window: only timestamps within [now - windowMs, now] are counted.
 *   - Lazy GC: stale entries are pruned on each evaluate() call.
 *   - Injectable clock: pass nowMs to evaluate()/record() for deterministic tests.
 *   - Throttle threshold: configurable via config.throttleAt (default 0.8).
 *     At ≥ softLimit requests → throttle.
 *     At ≥ maxRequests      → deny.
 *
 * Usage (gate pattern):
 *   const key = buildRateLimitKey({ tenantId, provider: 'openai' });
 *   const decision = limiter.evaluate(key, config);
 *   if (decision.decision !== 'deny') {
 *     limiter.record(key);
 *     // proceed with request
 *   }
 *
 * @module security/AdaptiveRateLimiter
 * @since F4.2
 */

import type { AdaptiveRateLimitConfig, AdaptiveRateLimitDecision } from './rateLimitTypes.js';

export class AdaptiveRateLimiter {
  /** key → sorted array of request timestamps in ms */
  private readonly _windows = new Map<string, number[]>();

  /**
   * Evaluate the current rate limit state for a key.
   *
   * Prunes stale entries (lazy GC) before returning the decision.
   * Does NOT record a new request — call record() after allowing.
   *
   * @param key      Canonical key string (from buildRateLimitKey)
   * @param config   Rate limit configuration
   * @param nowMs    Current time in ms (injectable for determinism; defaults to Date.now())
   */
  evaluate(key: string, config: AdaptiveRateLimitConfig, nowMs?: number): AdaptiveRateLimitDecision {
    const now = nowMs ?? Date.now();
    const windowMs = config.windowSeconds * 1000;
    const cutoff = now - windowMs;
    const throttleAt = config.throttleAt ?? 0.8;

    // Prune stale entries (lazy GC)
    const pruned = (this._windows.get(key) ?? []).filter(t => t > cutoff);
    this._windows.set(key, pruned);

    const used = pruned.length;
    const hardLimit = config.maxRequests;
    const softLimit = Math.max(1, Math.floor(hardLimit * throttleAt));

    // When window resets: oldest surviving timestamp + window
    const resetAt = pruned.length > 0
      ? Math.floor((pruned[0] + windowMs) / 1000)
      : Math.floor((now + windowMs) / 1000);

    const remaining = Math.max(0, hardLimit - used);

    if (used >= hardLimit) {
      const retryAfterMs = pruned.length > 0 ? Math.max(0, pruned[0] + windowMs - now) : windowMs;
      return {
        decision: 'deny',
        reason: `Rate limit exceeded: ${used}/${hardLimit} req in ${config.windowSeconds}s`,
        usedInWindow: used,
        remaining: 0,
        resetAt,
        retryAfterMs,
      };
    }

    if (used >= softLimit) {
      return {
        decision: 'throttle',
        reason: `Approaching rate limit: ${used}/${hardLimit} req (throttle at ${softLimit})`,
        usedInWindow: used,
        remaining,
        resetAt,
        retryAfterMs: 0,
      };
    }

    return { decision: 'allow', usedInWindow: used, remaining, resetAt };
  }

  /**
   * Record a new request for a key.
   *
   * Call after a successful evaluate() that returns allow or throttle.
   *
   * @param key    Canonical key string
   * @param nowMs  Current time in ms (injectable for determinism)
   */
  record(key: string, nowMs?: number): void {
    const now = nowMs ?? Date.now();
    const ts = this._windows.get(key) ?? [];
    ts.push(now);
    this._windows.set(key, ts);
  }

  /** List all currently-tracked key strings (for monitoring). */
  keys(): string[] {
    return Array.from(this._windows.keys());
  }

  /**
   * Reset state for a specific key, or all keys if omitted.
   * Useful for tests and graceful restart.
   */
  reset(key?: string): void {
    if (key !== undefined) {
      this._windows.delete(key);
    } else {
      this._windows.clear();
    }
  }
}
