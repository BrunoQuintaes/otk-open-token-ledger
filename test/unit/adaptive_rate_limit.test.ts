/**
 * F4 — Adaptive Rate Limit behavioral tests
 *
 * Validates:
 *   - buildRateLimitKey produces canonical string
 *   - AdaptiveRateLimiter: allow / throttle / deny decisions
 *   - sliding window expiry (injectable clock)
 *   - reset per-key and all keys
 *   - GET /ratelimit/status route
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  buildRateLimitKey,
  AdaptiveRateLimiter,
  getLimiter,
} from '../../src/security/index.js';
import { handleRequest } from '../../src/api/routes.js';
import type { AdaptiveRateLimitConfig } from '../../src/security/rateLimitTypes.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url }) as unknown as IncomingMessage;
  process.nextTick(() => em.emit('end'));
  return req;
}

type MockRes = ServerResponse & { body: string };
function mockRes(): MockRes {
  let body = '';
  return {
    statusCode: 200,
    setHeader: () => {},
    end: (data: string) => { body = data; },
    get body() { return body; },
  } as unknown as MockRes;
}

const CFG: AdaptiveRateLimitConfig = { windowSeconds: 60, maxRequests: 5, throttleAt: 0.8 };
// softLimit = floor(5 * 0.8) = 4

// ---------------------------------------------------------------------------
// buildRateLimitKey
// ---------------------------------------------------------------------------

describe('buildRateLimitKey', () => {
  it('produces canonical format with all fields', () => {
    const k = buildRateLimitKey({ tenantId: 't1', userId: 'u1', provider: 'openai' });
    assert.equal(k, 't1::u1::openai');
  });

  it('uses wildcards for absent optional fields', () => {
    const k = buildRateLimitKey({ tenantId: 't2' });
    assert.equal(k, 't2::*::*');
  });
});

// ---------------------------------------------------------------------------
// AdaptiveRateLimiter — allow / throttle / deny
// ---------------------------------------------------------------------------

describe('AdaptiveRateLimiter — allow zone', () => {
  it('empty key → allow with remaining=maxRequests', () => {
    const limiter = new AdaptiveRateLimiter();
    const d = limiter.evaluate('k1', CFG, 1_000_000);
    assert.equal(d.decision, 'allow');
    assert.equal(d.usedInWindow, 0);
    assert.equal(d.remaining, 5);
    assert.equal(d.retryAfterMs, undefined);
  });

  it('below softLimit (3 requests) → allow', () => {
    const limiter = new AdaptiveRateLimiter();
    const now = 1_000_000;
    limiter.record('k2', now);
    limiter.record('k2', now + 100);
    limiter.record('k2', now + 200);
    const d = limiter.evaluate('k2', CFG, now + 300);
    assert.equal(d.decision, 'allow');
    assert.equal(d.usedInWindow, 3);
  });
});

describe('AdaptiveRateLimiter — throttle zone', () => {
  it('at softLimit (4 requests) → throttle', () => {
    const limiter = new AdaptiveRateLimiter();
    const now = 2_000_000;
    for (let i = 0; i < 4; i++) limiter.record('k3', now + i * 10);
    const d = limiter.evaluate('k3', CFG, now + 50);
    assert.equal(d.decision, 'throttle');
    assert.ok(d.reason?.includes('Approaching'));
    assert.equal(d.retryAfterMs, 0);
  });
});

describe('AdaptiveRateLimiter — deny zone', () => {
  it('at hardLimit (5+ requests) → deny with retryAfterMs > 0', () => {
    const limiter = new AdaptiveRateLimiter();
    const now = 3_000_000;
    for (let i = 0; i < 5; i++) limiter.record('k4', now + i * 10);
    const d = limiter.evaluate('k4', CFG, now + 100);
    assert.equal(d.decision, 'deny');
    assert.equal(d.remaining, 0);
    assert.ok(typeof d.retryAfterMs === 'number' && d.retryAfterMs > 0);
  });
});

describe('AdaptiveRateLimiter — sliding window expiry', () => {
  it('requests outside the window are not counted', () => {
    const limiter = new AdaptiveRateLimiter();
    const now = 4_000_000;
    // Record 5 requests at t=0
    for (let i = 0; i < 5; i++) limiter.record('k5', now + i * 10);
    // Advance time by 61 seconds — all requests are outside the 60s window
    const later = now + 61_000;
    const d = limiter.evaluate('k5', CFG, later);
    assert.equal(d.decision, 'allow');
    assert.equal(d.usedInWindow, 0);
  });
});

describe('AdaptiveRateLimiter — reset', () => {
  it('reset(key) clears specific key only', () => {
    const limiter = new AdaptiveRateLimiter();
    const now = 5_000_000;
    limiter.record('ka', now);
    limiter.record('kb', now);
    limiter.reset('ka');
    assert.equal(limiter.evaluate('ka', CFG, now).usedInWindow, 0);
    assert.equal(limiter.evaluate('kb', CFG, now).usedInWindow, 1);
  });

  it('reset() clears all keys', () => {
    const limiter = new AdaptiveRateLimiter();
    limiter.record('kx', 6_000_000);
    limiter.record('ky', 6_000_000);
    limiter.reset();
    assert.equal(limiter.keys().length, 0);
  });
});

// ---------------------------------------------------------------------------
// GET /ratelimit/status — route smoke
// ---------------------------------------------------------------------------

describe('GET /ratelimit/status — route smoke', () => {
  beforeEach(() => { getLimiter().reset(); });

  it('returns 200 with ok=true and status=distributed', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/ratelimit/status'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.status, 'distributed');
  });
});
