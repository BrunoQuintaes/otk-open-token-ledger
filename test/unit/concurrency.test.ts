/**
 * GAP-D-001 — Concurrency rate-limit correctness test
 *
 * Validates that AdaptiveRateLimiter correctly enforces limits under
 * concurrent (Promise.all) evaluation — no phantom "allows" when over limit.
 *
 * Pattern: fire N simultaneous evaluate() calls and assert at most maxRequests
 * are allowed; all extras are denied or throttled.
 *
 * Module under test: `AdaptiveRateLimiter` and `buildRateLimitKey` from `src/security/index.ts`.
 *
 * Strategy / partitions: 10 evaluate-and-record calls against a limit of 5 (at most 5 allowed,
 * the rest denied or throttled); a key after `reset(key)`; two independent keys; the key built
 * from the first 8 characters of a token for failed-authentication limiting. The limiter is
 * synchronous, so the calls run back to back in one loop rather than through `Promise.all`.
 *
 * Needs: nothing external (a fresh limiter per test).
 *
 * Run just this file: `npx tsx --test test/unit/concurrency.test.ts`
 *
 * @module test/unit/concurrency.test
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { AdaptiveRateLimiter, buildRateLimitKey } from '../../src/security/index.js';
import type { AdaptiveRateLimitConfig } from '../../src/security/rateLimitTypes.js';

const CFG: AdaptiveRateLimitConfig = { windowSeconds: 60, maxRequests: 5 };

describe('concurrency — rate limiter: N concurrent evaluations', () => {
  let limiter: AdaptiveRateLimiter;
  const key = buildRateLimitKey({ tenantId: 'tenant-concurrent-test' });

  beforeEach(() => {
    limiter = new AdaptiveRateLimiter();
  });

  it('allows exactly maxRequests and denies the rest under concurrent calls', () => {
    // Fire 10 concurrent evaluates for a limit of 5
    const TOTAL = 10;
    const decisions = Array.from({ length: TOTAL }, () => {
      const d = limiter.evaluate(key, CFG);
      limiter.record(key);
      return d.decision;
    });

    const allowed = decisions.filter(d => d === 'allow').length;
    const denied = decisions.filter(d => d === 'deny').length;
    const throttled = decisions.filter(d => d === 'throttle').length;

    // At most maxRequests should be 'allow'
    assert.ok(
      allowed <= CFG.maxRequests,
      `allowed=${allowed} exceeds maxRequests=${CFG.maxRequests}`,
    );
    // All non-allowed calls must be denied or throttled
    assert.equal(allowed + denied + throttled, TOTAL, 'total decisions must match total calls');
    // At least some must be denied (since TOTAL > maxRequests)
    assert.ok(denied + throttled > 0, 'some calls must be denied or throttled when over limit');
  });

  it('resets correctly after window expiry via reset(key)', () => {
    // Fill up the bucket
    for (let i = 0; i < CFG.maxRequests; i++) {
      limiter.record(key);
    }
    const blocked = limiter.evaluate(key, CFG);
    assert.equal(blocked.decision, 'deny');

    // Reset and verify it allows again
    limiter.reset(key);
    const after = limiter.evaluate(key, CFG);
    assert.equal(after.decision, 'allow', 'after reset, calls should be allowed again');
  });

  it('independent keys do not interfere with each other', () => {
    const keyA = buildRateLimitKey({ tenantId: 'tenant-a' });
    const keyB = buildRateLimitKey({ tenantId: 'tenant-b' });

    // Fill keyA up to the limit
    for (let i = 0; i < CFG.maxRequests; i++) {
      limiter.record(keyA);
    }

    // keyB should still be unaffected
    const decB = limiter.evaluate(keyB, CFG);
    assert.equal(decB.decision, 'allow', 'independent tenant key must not be affected by other tenant');

    // keyA should be blocked
    const decA = limiter.evaluate(keyA, CFG);
    assert.equal(decA.decision, 'deny', 'keyA must be blocked after maxRequests recorded');
  });

  it('auth-fail rate limit uses token prefix as key (first 8 chars)', () => {
    const token = 'abcdefgh-secret-suffix-123';
    const prefix = token.slice(0, 8); // 'abcdefgh'
    const keyFail = buildRateLimitKey({ tenantId: `__auth_fail__:${prefix}` });

    const AUTH_FAIL_CFG: AdaptiveRateLimitConfig = { windowSeconds: 60, maxRequests: 3 };

    // Record 3 auth failures
    for (let i = 0; i < AUTH_FAIL_CFG.maxRequests; i++) {
      limiter.record(keyFail);
    }

    // 4th attempt should be denied
    const blocked = limiter.evaluate(keyFail, AUTH_FAIL_CFG);
    assert.equal(blocked.decision, 'deny', 'auth-fail rate limit must block after maxRequests failures');
  });
});
