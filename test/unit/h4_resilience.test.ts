/**
 * H-PACK-06 Tests — H4.1-H4.4 Rate Limiting & Resilience
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { CircuitBreaker, CircuitOpenError } from '../../src/infra/circuitBreaker.js';
import { MemoryDistributedRateLimiter, resetDistributedRateLimiterForTest } from '../../src/security/IDistributedRateLimiter.js';

// ═══════════════════════════════════════════
// H4.2/H4.3 — Circuit Breaker
// ═══════════════════════════════════════════
describe('H4.2 — Circuit Breaker', () => {
  it('starts in CLOSED state', () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100 });
    assert.equal(cb.state, 'CLOSED');
  });

  it('stays CLOSED on success', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100 });
    await cb.execute(() => Promise.resolve('ok'));
    assert.equal(cb.state, 'CLOSED');
  });

  it('transitions CLOSED → OPEN after failureThreshold consecutive failures', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 100 });
    for (let i = 0; i < 3; i++) {
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    }
    assert.equal(cb.state, 'OPEN');
  });

  it('OPEN state throws CircuitOpenError (fast-fail)', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    assert.equal(cb.state, 'OPEN');
    await assert.rejects(
      cb.execute(() => Promise.resolve('should not run')),
      (err: unknown) => err instanceof CircuitOpenError,
    );
  });

  it('OPEN → HALF_OPEN after resetTimeout', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50, halfOpenMaxAttempts: 1 });
    await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    assert.equal(cb.state, 'OPEN');
    await new Promise(r => setTimeout(r, 60));
    // Next call should transition to HALF_OPEN and succeed
    await cb.execute(() => Promise.resolve('probe'));
    assert.equal(cb.state, 'CLOSED'); // success in HALF_OPEN → CLOSED
  });

  it('HALF_OPEN → OPEN if probe fails', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 50, halfOpenMaxAttempts: 1 });
    await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    await new Promise(r => setTimeout(r, 60));
    await cb.execute(() => Promise.reject(new Error('probe fail'))).catch(() => {});
    assert.equal(cb.state, 'OPEN');
  });

  it('onStateChange callback fires', async () => {
    const transitions: string[] = [];
    const cb = new CircuitBreaker({
      failureThreshold: 1,
      resetTimeoutMs: 100,
      onStateChange: (from, to) => transitions.push(`${from}->${to}`),
    });
    await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    assert.deepEqual(transitions, ['CLOSED->OPEN']);
  });

  it('reset() returns to CLOSED', async () => {
    const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
    cb.reset();
    assert.equal(cb.state, 'CLOSED');
    assert.equal(cb.failCount, 0);
  });

  it('CircuitOpenError has retryAfterMs', () => {
    const err = new CircuitOpenError(5000);
    assert.equal(err.retryAfterMs, 5000);
    assert.equal(err.name, 'CircuitOpenError');
  });
});

// ═══════════════════════════════════════════
// H4.1 — Distributed Rate Limiter
// ═══════════════════════════════════════════
describe('H4.1 — Distributed Rate Limiter', () => {
  beforeEach(() => resetDistributedRateLimiterForTest());

  it('allows requests within limit', async () => {
    const limiter = new MemoryDistributedRateLimiter();
    const result = await limiter.check('key1', { windowSeconds: 60, maxRequests: 10 });
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 9);
  });

  it('denies requests over limit', async () => {
    const limiter = new MemoryDistributedRateLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.check('key2', { windowSeconds: 60, maxRequests: 5 });
    }
    const result = await limiter.check('key2', { windowSeconds: 60, maxRequests: 5 });
    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
    assert.ok(typeof result.retryAfterMs === 'number');
  });

  it('window expires and allows again', async () => {
    const limiter = new MemoryDistributedRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.check('key3', { windowSeconds: 0.05, maxRequests: 3 }); // 50ms window
    }
    const denied = await limiter.check('key3', { windowSeconds: 0.05, maxRequests: 3 });
    assert.equal(denied.allowed, false);

    await new Promise(r => setTimeout(r, 60));
    const allowed = await limiter.check('key3', { windowSeconds: 0.05, maxRequests: 3 });
    assert.equal(allowed.allowed, true);
  });

  it('different keys are independent', async () => {
    const limiter = new MemoryDistributedRateLimiter();
    for (let i = 0; i < 3; i++) {
      await limiter.check('keyA', { windowSeconds: 60, maxRequests: 3 });
    }
    const resultA = await limiter.check('keyA', { windowSeconds: 60, maxRequests: 3 });
    assert.equal(resultA.allowed, false);

    const resultB = await limiter.check('keyB', { windowSeconds: 60, maxRequests: 3 });
    assert.equal(resultB.allowed, true);
  });

  it('reset clears specific key', async () => {
    const limiter = new MemoryDistributedRateLimiter();
    for (let i = 0; i < 5; i++) {
      await limiter.check('key4', { windowSeconds: 60, maxRequests: 5 });
    }
    await limiter.reset('key4');
    const result = await limiter.check('key4', { windowSeconds: 60, maxRequests: 5 });
    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 4);
  });
});
