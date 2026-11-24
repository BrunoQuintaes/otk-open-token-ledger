/**
 * Tests — PolicyEngine (RB-056)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluatePolicy, evaluateAll, type QuotaPolicy, type RateLimitPolicy, type SLAPolicy } from '../../src/security/PolicyEngine.js';

const quotaPolicy: QuotaPolicy = { type: 'quota', maxCU: 1000n, period: 'daily' };
const rateLimitPolicy: RateLimitPolicy = { type: 'rate_limit', maxRequests: 10, windowSeconds: 60 };
const slaPolicy: SLAPolicy = { type: 'sla', maxLatencyP99Ms: 500 };

describe('PolicyEngine — quota', () => {
  it('allows when under quota', () => {
    const d = evaluatePolicy(quotaPolicy, { consumedCU: 500n });
    assert.equal(d.allowed, true);
  });
  it('denies when at quota', () => {
    const d = evaluatePolicy(quotaPolicy, { consumedCU: 1000n });
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.policy, 'quota');
  });
  it('denies when over quota', () => {
    const d = evaluatePolicy(quotaPolicy, { consumedCU: 1500n });
    assert.equal(d.allowed, false);
  });
  it('allows with no consumption (undefined)', () => {
    const d = evaluatePolicy(quotaPolicy, {});
    assert.equal(d.allowed, true);
  });
});

describe('PolicyEngine — rate_limit', () => {
  it('allows when under limit', () => {
    const d = evaluatePolicy(rateLimitPolicy, { requestsInWindow: 5 });
    assert.equal(d.allowed, true);
  });
  it('denies when at limit', () => {
    const d = evaluatePolicy(rateLimitPolicy, { requestsInWindow: 10 });
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.policy, 'rate_limit');
  });
  it('allows with no requests (undefined)', () => {
    const d = evaluatePolicy(rateLimitPolicy, {});
    assert.equal(d.allowed, true);
  });
});

describe('PolicyEngine — sla', () => {
  it('allows when within SLA', () => {
    const d = evaluatePolicy(slaPolicy, { observedP99Ms: 300 });
    assert.equal(d.allowed, true);
  });
  it('denies on SLA breach', () => {
    const d = evaluatePolicy(slaPolicy, { observedP99Ms: 600 });
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.policy, 'sla');
  });
  it('allows when no observation provided', () => {
    const d = evaluatePolicy(slaPolicy, {});
    assert.equal(d.allowed, true);
  });
});

describe('PolicyEngine — evaluateAll', () => {
  const policies = [quotaPolicy, rateLimitPolicy, slaPolicy];

  it('allows when all pass', () => {
    const d = evaluateAll(policies, { consumedCU: 100n, requestsInWindow: 3, observedP99Ms: 100 });
    assert.equal(d.allowed, true);
  });
  it('denies on first violation (quota)', () => {
    const d = evaluateAll(policies, { consumedCU: 2000n, requestsInWindow: 3, observedP99Ms: 100 });
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.policy, 'quota');
  });
  it('denies on rate_limit violation', () => {
    const d = evaluateAll(policies, { consumedCU: 100n, requestsInWindow: 15, observedP99Ms: 100 });
    assert.equal(d.allowed, false);
    if (!d.allowed) assert.equal(d.policy, 'rate_limit');
  });
  it('allows empty policies list', () => {
    const d = evaluateAll([], {});
    assert.equal(d.allowed, true);
  });
});

// --- QA1 edge cases ---
describe('PolicyEngine — QA1 edge cases', () => {
  it('quota reason contains consumed/max/period', () => {
    const d = evaluatePolicy({ type: 'quota', maxCU: 100n, period: 'daily' }, { consumedCU: 100n });
    assert.equal(d.allowed, false);
    if (!d.allowed) {
      assert.match(d.reason, /100/);
      assert.match(d.reason, /daily/);
    }
  });

  it('sla at exact limit (p99 == max) → allowed (strict >)', () => {
    const d = evaluatePolicy({ type: 'sla', maxLatencyP99Ms: 500 }, { observedP99Ms: 500 });
    assert.equal(d.allowed, true);
  });

  it('rate_limit reason contains req count and window', () => {
    const d = evaluatePolicy({ type: 'rate_limit', maxRequests: 5, windowSeconds: 30 }, { requestsInWindow: 5 });
    assert.equal(d.allowed, false);
    if (!d.allowed) {
      assert.match(d.reason, /5/);
      assert.match(d.reason, /30/);
    }
  });
});
