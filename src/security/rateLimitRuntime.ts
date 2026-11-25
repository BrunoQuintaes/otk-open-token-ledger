/**
 * Rate Limit Runtime — process-level AdaptiveRateLimiter singleton (F4.2)
 *
 * Canonical access point for adaptive rate limiting across the process.
 * Call-sites use getLimiter() to evaluate and record requests.
 *
 * The limiter is created when this module is first imported.
 *
 * @module src/security/rateLimitRuntime
 *
 * @since F4.2
 */

import { AdaptiveRateLimiter } from './AdaptiveRateLimiter.js';

const _limiter = new AdaptiveRateLimiter();

/**
 * Returns the process-level AdaptiveRateLimiter singleton.
 * Same instance on every call — guaranteed by module scope.
 *
 * @returns The shared in-memory limiter.
 */
export function getLimiter(): AdaptiveRateLimiter {
  return _limiter;
}
