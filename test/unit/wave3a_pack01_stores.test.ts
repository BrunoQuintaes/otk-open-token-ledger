/**
 * Wave 3A Pack 01 — Store Bootstrap + Redis/PG Store Tests
 *
 * Tests:
 * - RedisIdempotencyStore (mock Redis)
 * - RedisRateLimiter (mock Redis)
 * - PgDeadLetterStore (mock Pool)
 * - storeBootstrap (no-env fallback)
 * - Prometheus text format on /metrics
 * - IDistributedRateLimiter wiring in routes
 *
 * @since Wave 3A (PACK 3A-01)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── RedisIdempotencyStore ────────────────────────────────────────

import { RedisIdempotencyStore } from '../../src/infra/redis/RedisIdempotencyStore.js';

/** Minimal mock Redis client with in-memory Map. */
function mockRedisClient() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  return {
    prefix: 'otk:',
    rawClient: {
      get: async (key: string) => {
        const entry = store.get(key);
        if (!entry) return null;
        if (Date.now() > entry.expiresAt) { store.delete(key); return null; }
        return entry.value;
      },
      set: async (key: string, value: string, _ex: string, ttl: number) => {
        store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
        return 'OK';
      },
    },
  } as any;
}

describe('Wave 3A — RedisIdempotencyStore', () => {
  let store: RedisIdempotencyStore;

  beforeEach(() => {
    store = new RedisIdempotencyStore(mockRedisClient());
  });

  it('returns null for unknown key', async () => {
    assert.equal(await store.get('unknown'), null);
  });

  it('stores and retrieves a cached response', async () => {
    const response = { status: 201, body: '{"ok":true}', bodyHash: 'abc123' };
    await store.set('key-1', response, 60);
    const found = await store.get('key-1');
    assert.deepEqual(found, response);
  });

  it('returns null when Redis rawClient is null', async () => {
    const brokenRedis = { prefix: 'otk:', rawClient: null } as any;
    const brokenStore = new RedisIdempotencyStore(brokenRedis);
    assert.equal(await brokenStore.get('key'), null);
    // set should not throw
    await brokenStore.set('key', { status: 200, body: '', bodyHash: '' }, 60);
  });
});

// ── RedisRateLimiter ─────────────────────────────────────────────

import { RedisRateLimiter } from '../../src/infra/redis/RedisRateLimiter.js';

function mockRedisClientForRL() {
  // Simulate sorted set with simple Map<key, Set<member>>
  const sets = new Map<string, Map<string, number>>();
  const expiry = new Map<string, number>();

  const pipeline = () => {
    const ops: (() => [null, unknown])[] = [];
    return {
      zremrangebyscore: (key: string, _min: string | number, max: number) => {
        ops.push(() => {
          const s = sets.get(key);
          if (s) {
            for (const [m, score] of s) {
              if (score <= max) s.delete(m);
            }
          }
          return [null, 0];
        });
      },
      zadd: (key: string, score: number, member: string) => {
        ops.push(() => {
          if (!sets.has(key)) sets.set(key, new Map());
          sets.get(key)!.set(member, score);
          return [null, 1];
        });
      },
      zcard: (key: string) => {
        ops.push(() => {
          return [null, sets.get(key)?.size ?? 0];
        });
      },
      expire: (key: string, ttl: number) => {
        ops.push(() => {
          expiry.set(key, Date.now() + ttl * 1000);
          return [null, 1];
        });
      },
      exec: async () => ops.map(fn => fn()),
    };
  };

  return {
    prefix: 'otk:',
    rawClient: {
      pipeline,
      zrem: async (key: string, member: string) => {
        sets.get(key)?.delete(member);
        return 1;
      },
      zrangebyscore: async () => [],
      del: async (key: string) => { sets.delete(key); return 1; },
    },
  } as any;
}

describe('Wave 3A — RedisRateLimiter', () => {
  let limiter: RedisRateLimiter;

  beforeEach(() => {
    limiter = new RedisRateLimiter(mockRedisClientForRL());
  });

  it('allows requests within limit', async () => {
    const result = await limiter.check('tenant-a', { windowSeconds: 60, maxRequests: 10 });
    assert.equal(result.allowed, true);
    assert.ok(result.remaining > 0);
  });

  it('denies requests over limit', async () => {
    for (let i = 0; i < 5; i++) {
      await limiter.check('tenant-b', { windowSeconds: 60, maxRequests: 5 });
    }
    const result = await limiter.check('tenant-b', { windowSeconds: 60, maxRequests: 5 });
    assert.equal(result.allowed, false);
    assert.equal(result.remaining, 0);
  });

  it('allows all when Redis rawClient is null', async () => {
    const brokenLimiter = new RedisRateLimiter({ prefix: 'otk:', rawClient: null } as any);
    const result = await brokenLimiter.check('key', { windowSeconds: 60, maxRequests: 10 });
    assert.equal(result.allowed, true);
  });

  it('reset removes key', async () => {
    await limiter.check('tenant-c', { windowSeconds: 60, maxRequests: 10 });
    await limiter.reset('tenant-c');
    // After reset, should be allowed again
    const result = await limiter.check('tenant-c', { windowSeconds: 60, maxRequests: 1 });
    assert.equal(result.allowed, true);
  });
});

// ── PgDeadLetterStore ────────────────────────────────────────────

import { PgDeadLetterStore } from '../../src/infra/pg/PgDeadLetterStore.js';

function mockPgPool() {
  const rows: Record<string, unknown>[] = [];
  return {
    query: async (text: string, params?: unknown[]) => {
      // CREATE TABLE / CREATE INDEX → no-op
      if (text.startsWith('CREATE')) return { rows: [] };

      // INSERT
      if (text.startsWith('INSERT')) {
        const row: Record<string, unknown> = {
          id: params?.[0],
          original_payload: params?.[1],
          error: params?.[2],
          reason: params?.[3],
          source: params?.[4],
          tenant_id: params?.[5],
          status: 'pending',
          created_at: params?.[6] ?? new Date().toISOString(),
          retried_at: null,
          discarded_at: null,
        };
        rows.push(row);
        return { rows: [] };
      }

      // UPDATE ... SET status = 'retried' (must check BEFORE generic WHERE id =)
      if (text.includes("status = 'retried'")) {
        const row = rows.find(r => r.id === params?.[0]);
        if (row) {
          row.status = 'retried';
          row.retried_at = new Date().toISOString();
          return { rows: [row] };
        }
        return { rows: [] };
      }

      // UPDATE ... SET status = 'discarded'
      if (text.includes("status = 'discarded'")) {
        const row = rows.find(r => r.id === params?.[0]);
        if (row) {
          row.status = 'discarded';
          row.discarded_at = new Date().toISOString();
          return { rows: [row] };
        }
        return { rows: [] };
      }

      // SELECT * ... WHERE id = $1
      if (text.includes('WHERE id =')) {
        const found = rows.filter(r => r.id === params?.[0]);
        return { rows: found };
      }

      // SELECT COUNT
      if (text.includes('COUNT')) {
        const statusFilter = text.includes("status = 'pending'") ? 'pending' : null;
        const filtered = statusFilter ? rows.filter(r => r.status === statusFilter) : rows;
        return { rows: [{ cnt: filtered.length }] };
      }

      // SELECT * (list)
      if (text.startsWith('SELECT *')) {
        return { rows: [...rows].reverse() };
      }

      // DELETE
      if (text.startsWith('DELETE')) {
        rows.length = 0;
        return { rows: [] };
      }

      // SELECT 1 (connectivity check)
      if (text === 'SELECT 1') return { rows: [{ '?column?': 1 }] };

      return { rows: [] };
    },
  };
}

describe('Wave 3A — PgDeadLetterStore', () => {
  let store: PgDeadLetterStore;

  beforeEach(() => {
    store = new PgDeadLetterStore(mockPgPool());
  });

  it('adds and retrieves an entry', async () => {
    const entry = await store.add({
      originalPayload: '{"test":1}',
      error: 'validation_failed',
      reason: 'validation_error',
      source: 'POST /receipts',
      tenantId: 'acme',
    });
    assert.ok(entry.id.startsWith('dl-'));
    assert.equal(entry.status, 'pending');
    assert.equal(entry.tenantId, 'acme');

    const found = await store.get(entry.id);
    assert.ok(found);
    assert.equal(found!.id, entry.id);
  });

  it('returns null for unknown id', async () => {
    assert.equal(await store.get('dl-nonexistent'), null);
  });

  it('marks as retried', async () => {
    const entry = await store.add({
      originalPayload: '',
      error: 'err',
      reason: 'store_error',
      source: 'test',
    });
    const updated = await store.markRetried(entry.id);
    assert.ok(updated);
    assert.equal(updated!.status, 'retried');
  });

  it('marks as discarded', async () => {
    const entry = await store.add({
      originalPayload: '',
      error: 'err',
      reason: 'store_error',
      source: 'test',
    });
    const updated = await store.markDiscarded(entry.id);
    assert.ok(updated);
    assert.equal(updated!.status, 'discarded');
  });

  it('counts entries correctly', async () => {
    await store.add({ originalPayload: '', error: '', reason: 'store_error', source: '' });
    await store.add({ originalPayload: '', error: '', reason: 'store_error', source: '' });
    assert.equal(await store.count(), 2);
    assert.equal(await store.pendingCount(), 2);
  });

  it('clears all entries', async () => {
    await store.add({ originalPayload: '', error: '', reason: 'store_error', source: '' });
    await store.clear();
    assert.equal(await store.count(), 0);
  });
});

// ── Store Bootstrap (no-env mode) ────────────────────────────────

import { bootstrapStores } from '../../src/infra/storeBootstrap.js';

describe('Wave 3A — storeBootstrap (no-env fallback)', () => {
  it('returns all-memory result when no env vars are set', async () => {
    // Ensure no Redis/PG URLs
    const origRedis = process.env['OTK_REDIS_URL'];
    const origDb = process.env['OTK_DB_URL'];
    delete process.env['OTK_REDIS_URL'];
    delete process.env['OTK_DB_URL'];

    try {
      const result = await bootstrapStores();
      assert.equal(result.redis, false);
      assert.equal(result.pg, false);
      assert.equal(result.stores['idempotency'], 'memory');
      assert.equal(result.stores['rateLimiter'], 'memory');
      assert.equal(result.stores['deadLetter'], 'memory');
    } finally {
      if (origRedis) process.env['OTK_REDIS_URL'] = origRedis;
      if (origDb) process.env['OTK_DB_URL'] = origDb;
    }
  });
});

// ── Prometheus /metrics endpoint ─────────────────────────────────

import { handleRequest } from '../../src/api/routes.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

function mockReq(method: string, url: string): IncomingMessage {
  return { method, url, headers: {} } as unknown as IncomingMessage;
}

function mockRes(): ServerResponse & { statusCode: number; body: string; _headers: Record<string, string> } {
  const _headers: Record<string, string> = {};
  const res = {
    statusCode: 200,
    body: '',
    _headers,
    setHeader: (k: string, v: string) => { _headers[k.toLowerCase()] = v; },
    getHeader: (k: string) => _headers[k.toLowerCase()],
    writeHead: (code: number) => { res.statusCode = code; },
    end: (data?: string) => { if (data) { res.body = data; } },
  } as any;
  return res;
}

describe('Wave 3A — Prometheus /metrics endpoint', () => {
  it('GET /metrics returns Prometheus text exposition format', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/metrics'), res);
    assert.equal(res.statusCode, 200);
    // Prometheus text format contains TYPE/HELP lines or metric names
    assert.ok(res.body.length > 0, 'body should not be empty');
    // Should NOT be valid JSON
    let isJson = false;
    try { JSON.parse(res.body); isJson = true; } catch { /* expected */ }
    assert.equal(isJson, false, '/metrics default format should be Prometheus text, not JSON');
  });

  it('GET /metrics?format=json returns JSON', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/metrics?format=json'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok('capturedAt' in body);
  });
});

// ── IDistributedRateLimiter wiring ───────────────────────────────

import { getDistributedRateLimiter, resetDistributedRateLimiterForTest } from '../../src/security/IDistributedRateLimiter.js';

describe('Wave 3A — IDistributedRateLimiter wiring', () => {
  beforeEach(() => { resetDistributedRateLimiterForTest(); });

  it('default limiter is MemoryDistributedRateLimiter', async () => {
    const result = await getDistributedRateLimiter().check('test', { windowSeconds: 60, maxRequests: 10 });
    assert.equal(result.allowed, true);
  });

  it('denies after exceeding maxRequests', async () => {
    const config = { windowSeconds: 60, maxRequests: 2 };
    await getDistributedRateLimiter().check('key-x', config);
    await getDistributedRateLimiter().check('key-x', config);
    const third = await getDistributedRateLimiter().check('key-x', config);
    assert.equal(third.allowed, false);
  });
});
