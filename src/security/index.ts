/**
 * Security public API (F4)
 *
 * Re-exports the adaptive rate limiting layer.
 * Existing PolicyEngine, AuditLogChain, TenantIsolation, etc. retain direct imports.
 *
 * @since F4
 */

export type { RateLimitKey, AdaptiveRateLimitConfig, AdaptiveRateLimitDecision } from './rateLimitTypes.js';
export { buildRateLimitKey } from './rateLimitTypes.js';

export { AdaptiveRateLimiter } from './AdaptiveRateLimiter.js';
export { getLimiter } from './rateLimitRuntime.js';
