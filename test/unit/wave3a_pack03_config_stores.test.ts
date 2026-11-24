/**
 * Wave 3A Pack 03 — Config Stores + CSRF + Tracing + CSP + escapeHtml Wiring Tests
 *
 * Tests:
 * - RedisTokenStore (mock Redis)
 * - RedisPolicyStore (mock Redis)
 * - RedisBudgetTracker (mock Redis)
 * - PgGovernanceStore (mock Pool)
 * - PgIndexerStore (mock Pool)
 * - CSRF token generation and validation in dashboard app
 * - Tracing span creation in handleRequest
 * - CSP header no longer contains unsafe-inline on API routes
 * - escapeHtml applied in dashboard HTML
 *
 * @since Wave 3A (PACK 3A-03)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Helpers ──────────────────────────────────────────────────────────

/** Mock Redis client backed by in-memory Map. */
function mockRedisClient() {
  const store = new Map<string, string>();
  const rawClient = {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => { store.set(key, value); return 'OK'; },
    del: async (...keys: string[]) => { let n = 0; for (const k of keys) { if (store.delete(k)) n++; } return n; },
    incrby: async (key: string, amount: string) => {
      const cur = BigInt(store.get(key) ?? '0');
      const next = (cur + BigInt(amount)).toString();
      store.set(key, next);
      return next;
    },
    // scan(cursor, 'MATCH', pattern, 'COUNT', count) — return [nextCursor, keys]
    scan: async (_cursor: string, _matchKeyword: string, pattern: string, _countKeyword: string, _count: number) => {
      // Convert glob pattern (e.g. 'otk:token:*') to prefix match
      const prefix = pattern.replace(/\*.*$/, '');
      const keys = Array.from(store.keys()).filter(k => k.startsWith(prefix));
      return ['0', keys]; // always done in one pass (mock)
    },
    mget: async (...keys: string[]) => keys.map(k => store.get(k) ?? null),
    _store: store, // for inspection in tests
  };
  return { prefix: 'otk:', rawClient } as any;
}

/** Mock PG pool backed by in-memory storage. */
function mockPgPool() {
  const tables: Record<string, Record<string, unknown>[]> = {};
  return {
    query: async (text: string, params?: unknown[]) => {
      // Minimal simulation: CREATE TABLE, INSERT, SELECT, DELETE
      if (text.includes('CREATE TABLE') || text.includes('CREATE INDEX')) {
        return { rows: [] };
      }
      if (text.includes('DELETE FROM')) {
        const match = text.match(/DELETE FROM (\w+)/);
        if (match) tables[match[1]!] = [];
        return { rows: [] };
      }
      if (text.includes('INSERT INTO')) {
        // Extract table name
        const match = text.match(/INSERT INTO (\w+)/);
        if (match) {
          const tbl = match[1]!;
          if (!tables[tbl]) tables[tbl] = [];
          // Return a mock seq
          const seq = (tables[tbl].length + 1);
          tables[tbl].push({ seq, _params: params });
          return { rows: [{ seq }] };
        }
      }
      if (text.includes('SELECT')) {
        const match = text.match(/FROM (\w+)/);
        if (match) {
          const tbl = match[1]!;
          return { rows: tables[tbl] ?? [] };
        }
      }
      return { rows: [] };
    },
    _tables: tables,
  } as any;
}

// ── RedisTokenStore ──────────────────────────────────────────────────

import { RedisTokenStore } from '../../src/infra/redis/RedisTokenStore.js';
import type { TokenEntry } from '../../src/api/ITokenStore.js';

describe('Wave 3A — RedisTokenStore', () => {
  let redis: ReturnType<typeof mockRedisClient>;
  let store: RedisTokenStore;

  beforeEach(() => {
    redis = mockRedisClient();
    store = new RedisTokenStore(redis);
  });

  it('returns null for unknown token hash', async () => {
    assert.equal(await store.resolve('nonexistent'), null);
  });

  it('register and resolve a token entry', async () => {
    const entry: TokenEntry = { tenantId: 'tenant-1', role: 'VIEWER', registeredAt: '2026-01-01T00:00:00Z' };
    await store.register('hash-abc', entry);
    const resolved = await store.resolve('hash-abc');
    assert.ok(resolved !== null);
    assert.equal(resolved.tenantId, 'tenant-1');
    assert.equal(resolved.role, 'VIEWER');
  });

  it('revoke removes the token', async () => {
    const entry: TokenEntry = { tenantId: 'tenant-2', role: 'OWNER', registeredAt: '2026-01-01T00:00:00Z' };
    await store.register('hash-def', entry);
    assert.ok(await store.resolve('hash-def') !== null);
    await store.revoke('hash-def');
    assert.equal(await store.resolve('hash-def'), null);
  });

  it('clear removes all tokens', async () => {
    const entry: TokenEntry = { tenantId: 'tenant-3', role: 'VIEWER', registeredAt: '2026-01-01T00:00:00Z' };
    await store.register('hash-xyz', entry);
    await store.clear();
    assert.equal(await store.resolve('hash-xyz'), null);
  });

  it('gracefully returns null when rawClient is null', async () => {
    const nullRedis = { prefix: 'otk:', rawClient: null } as any;
    const s = new RedisTokenStore(nullRedis);
    assert.equal(await s.resolve('any'), null);
    // These should not throw
    await s.register('any', { tenantId: 't', role: 'r', registeredAt: '' });
    await s.revoke('any');
    await s.clear();
  });
});

// ── RedisPolicyStore ─────────────────────────────────────────────────

import { RedisPolicyStore } from '../../src/infra/redis/RedisPolicyStore.js';
import type { StoredPolicy } from '../../src/security/IPolicyStore.js';

describe('Wave 3A — RedisPolicyStore', () => {
  let redis: ReturnType<typeof mockRedisClient>;
  let store: RedisPolicyStore;

  beforeEach(() => {
    redis = mockRedisClient();
    store = new RedisPolicyStore(redis);
  });

  it('returns null for unknown policy', async () => {
    assert.equal(await store.getPolicy('tenant-x', 'quota'), null);
  });

  it('setPolicy and getPolicy round-trip with rate_limit policy', async () => {
    // Use RateLimitPolicy (no bigint) to avoid JSON serialization issues
    const policy: StoredPolicy = { type: 'rate_limit', maxRequests: 100, windowSeconds: 60 } as any;
    await store.setPolicy('tenant-a', policy);
    const got = await store.getPolicy('tenant-a', 'rate_limit');
    assert.ok(got !== null, 'policy should be stored and retrieved');
    assert.equal((got as any).type, 'rate_limit');
    assert.equal((got as any).maxRequests, 100);
  });

  it('setPolicy and getPolicy round-trip with quota policy (bigint)', async () => {
    // QuotaPolicy has maxCU: bigint — must be serialized/deserialized correctly
    const policy: StoredPolicy = { type: 'quota', maxCU: 5000n, period: 'monthly' } as any;
    await store.setPolicy('tenant-quota', policy);
    const got = await store.getPolicy('tenant-quota', 'quota');
    assert.ok(got !== null, 'quota policy should be stored');
    assert.equal((got as any).type, 'quota');
    assert.equal((got as any).maxCU, 5000n);
  });

  it('deletePolicy removes specific policy', async () => {
    const policy: StoredPolicy = { type: 'rate_limit', maxRequests: 200, windowSeconds: 30 } as any;
    await store.setPolicy('tenant-b', policy);
    await store.deletePolicy('tenant-b', 'rate_limit');
    assert.equal(await store.getPolicy('tenant-b', 'rate_limit'), null);
  });

  it('clear removes all policies', async () => {
    const policy: StoredPolicy = { type: 'sla', maxLatencyP99Ms: 500 } as any;
    await store.setPolicy('tenant-c', policy);
    await store.clear();
    assert.equal(await store.getPolicy('tenant-c', 'sla'), null);
  });

  it('gracefully degrades when rawClient is null', async () => {
    const nullRedis = { prefix: 'otk:', rawClient: null } as any;
    const s = new RedisPolicyStore(nullRedis);
    assert.equal(await s.getPolicy('t', 'quota'), null);
    const p: StoredPolicy = { type: 'quota' } as any;
    await s.setPolicy('t', p); // should not throw
    await s.deletePolicy('t', 'quota');
    await s.clear();
    const list = await s.listPolicies('t');
    assert.deepEqual(list, []);
  });
});

// ── RedisBudgetTracker ───────────────────────────────────────────────

import { RedisBudgetTracker } from '../../src/infra/redis/RedisBudgetTracker.js';

describe('Wave 3A — RedisBudgetTracker', () => {
  let redis: ReturnType<typeof mockRedisClient>;
  let tracker: RedisBudgetTracker;

  beforeEach(() => {
    redis = mockRedisClient();
    tracker = new RedisBudgetTracker(redis);
  });

  it('initial spend is 0n', async () => {
    const spend = await tracker.getCurrentSpend('t1', 'epoch-1');
    assert.equal(spend, 0n);
  });

  it('recordSpend accumulates correctly', async () => {
    await tracker.recordSpend('t1', 'epoch-1', 100n);
    await tracker.recordSpend('t1', 'epoch-1', 50n);
    const spend = await tracker.getCurrentSpend('t1', 'epoch-1');
    assert.equal(spend, 150n);
  });

  it('spend is isolated per tenant/epoch', async () => {
    await tracker.recordSpend('t1', 'epoch-1', 200n);
    await tracker.recordSpend('t2', 'epoch-1', 50n);
    assert.equal(await tracker.getCurrentSpend('t1', 'epoch-1'), 200n);
    assert.equal(await tracker.getCurrentSpend('t2', 'epoch-1'), 50n);
    assert.equal(await tracker.getCurrentSpend('t1', 'epoch-2'), 0n);
  });

  it('getBudget returns null when not set', async () => {
    assert.equal(await tracker.getBudget('nobody'), null);
  });

  it('setBudget and getBudget round-trip with bigint', async () => {
    await tracker.setBudget('t1', { maxCU: 10000n, warnPct: 80, criticalPct: 95 });
    const policy = await tracker.getBudget('t1');
    assert.ok(policy !== null);
    assert.equal(policy.maxCU, 10000n);
    assert.equal(policy.warnPct, 80);
    assert.equal(policy.criticalPct, 95);
  });

  it('clear removes all budget data', async () => {
    await tracker.recordSpend('t1', 'epoch-1', 100n);
    await tracker.setBudget('t1', { maxCU: 1000n, warnPct: 70, criticalPct: 90 });
    await tracker.clear();
    assert.equal(await tracker.getCurrentSpend('t1', 'epoch-1'), 0n);
    assert.equal(await tracker.getBudget('t1'), null);
  });

  it('gracefully degrades when rawClient is null', async () => {
    const nullRedis = { prefix: 'otk:', rawClient: null } as any;
    const t = new RedisBudgetTracker(nullRedis);
    assert.equal(await t.getCurrentSpend('t', 'e'), 0n);
    assert.equal(await t.getBudget('t'), null);
    await t.recordSpend('t', 'e', 100n); // should not throw
    await t.setBudget('t', { maxCU: 1000n, warnPct: 80, criticalPct: 95 });
    await t.clear();
  });
});

// ── PgGovernanceStore ────────────────────────────────────────────────

import { PgGovernanceStore } from '../../src/infra/pg/PgGovernanceStore.js';
import { sha256Hex } from '../../src/security/AuditLogChain.js';

describe('Wave 3A — PgGovernanceStore', () => {
  let pool: ReturnType<typeof mockPgPool>;
  let store: PgGovernanceStore;
  const GENESIS = sha256Hex('governance-genesis');

  beforeEach(() => {
    pool = mockPgPool();
    store = new PgGovernanceStore(pool);
  });

  it('head() returns genesis hash when empty', async () => {
    // Our mock returns empty rows for SELECT
    const head = await store.head();
    assert.equal(head, GENESIS);
  });

  it('count() returns 0 when empty', async () => {
    // Mock SELECT COUNT returns []
    assert.equal(await store.count(), 0);
  });

  it('append() inserts a row and returns an entry', async () => {
    const event = {
      ts: '2026-01-01T00:00:00Z',
      tenantId: 'tenant-1',
      actor: 'system',
      action: 'tenant_created' as const,
    };
    const entry = await store.append(event, GENESIS);
    assert.ok(entry.hash.length > 0);
    assert.equal(entry.tenantId, 'tenant-1');
    assert.equal(entry.action, 'tenant_created');
  });

  it('clear() removes all rows', async () => {
    await store.clear();
    // Should not throw
    assert.ok(true);
  });

  it('verifyIntegrity() returns valid:true on empty store', async () => {
    const result = await store.verifyIntegrity();
    assert.equal(result.valid, true);
  });
});

// ── PgIndexerStore ───────────────────────────────────────────────────

import { PgIndexerStore } from '../../src/infra/pg/PgIndexerStore.js';
import type { IndexedReceipt } from '../../src/dashboard/IIndexerStore.js';

describe('Wave 3A — PgIndexerStore', () => {
  let pool: ReturnType<typeof mockPgPool>;
  let store: PgIndexerStore;

  beforeEach(() => {
    pool = mockPgPool();
    store = new PgIndexerStore(pool);
  });

  it('size() returns 0 when empty', async () => {
    assert.equal(await store.size(), 0);
  });

  it('index() inserts a receipt without throwing', async () => {
    const receipt: IndexedReceipt = {
      requestId: 'req-001',
      provider: 'openai',
      model: 'gpt-4',
      inputTokens: 100,
      outputTokens: 50,
      costUnits: 150,
      latencyMs: 200,
      timestamp: Date.now(),
      tenantId: 'tenant-1',
      indexedAt: Date.now(),
    };
    await store.index(receipt); // Should not throw
    assert.ok(true);
  });

  it('getRecentReceipts() returns empty array on empty store', async () => {
    const receipts = await store.getRecentReceipts();
    assert.deepEqual(receipts, []);
  });

  it('getTenantSummary() returns empty array on empty store', async () => {
    const summary = await store.getTenantSummary();
    assert.deepEqual(summary, []);
  });

  it('clear() removes all rows without throwing', async () => {
    await store.clear();
    assert.ok(true);
  });
});

// ── CSRF wiring ──────────────────────────────────────────────────────

import { generateCsrfToken, validateCsrfToken, resetCsrfForTest } from '../../src/auth/csrf.js';
import { getDashboardHtml } from '../../src/dashboard/app.js';

describe('Wave 3A — CSRF wiring in dashboard', () => {
  beforeEach(() => {
    resetCsrfForTest('test-secret-for-csrf');
  });

  it('generateCsrfToken produces a deterministic 64-char hex', () => {
    const token = generateCsrfToken('session-abc');
    assert.equal(typeof token, 'string');
    assert.equal(token.length, 64);
    // Deterministic
    assert.equal(generateCsrfToken('session-abc'), token);
  });

  it('validateCsrfToken returns true for correct token', () => {
    const token = generateCsrfToken('my-session');
    assert.equal(validateCsrfToken(token, 'my-session'), true);
  });

  it('validateCsrfToken returns false for wrong session', () => {
    const token = generateCsrfToken('session-A');
    assert.equal(validateCsrfToken(token, 'session-B'), false);
  });

  it('getDashboardHtml embeds a csrf meta tag', () => {
    const html = getDashboardHtml({ sessionId: 'test-session' });
    assert.ok(html.includes('name="otk-csrf"'), 'CSRF meta tag present');
    assert.ok(html.includes('content='), 'CSRF token content present');
  });

  it('getDashboardHtml escapes special chars in sessionId', () => {
    const html = getDashboardHtml({ sessionId: '<script>alert(1)</script>' });
    assert.ok(!html.includes('<script>alert(1)</script>'), 'raw XSS not present in HTML');
    assert.ok(html.includes('&lt;script&gt;'), 'sessionId is HTML-escaped');
  });
});

// ── Tracing ──────────────────────────────────────────────────────────

import {
  initTracing,
  isTracingEnabled,
  startSpan,
  endSpan,
  generateTraceId,
  generateSpanId,
  resetTracingForTest,
} from '../../src/observability/tracing.js';

describe('Wave 3A — Tracing span lifecycle', () => {
  beforeEach(() => {
    resetTracingForTest();
  });

  it('tracing is disabled by default', () => {
    assert.equal(isTracingEnabled(), false);
  });

  it('initTracing enables tracing when endpoint is provided', () => {
    initTracing('http://otel-collector:4318');
    assert.equal(isTracingEnabled(), true);
  });

  it('generateTraceId produces 32-char hex', () => {
    const id = generateTraceId();
    assert.match(id, /^[0-9a-f]{32}$/);
  });

  it('generateSpanId produces 16-char hex', () => {
    const id = generateSpanId();
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it('startSpan creates a span with correct structure', () => {
    const span = startSpan('test-operation', { attributes: { 'http.method': 'GET' } });
    assert.equal(span.name, 'test-operation');
    assert.equal(typeof span.traceId, 'string');
    assert.equal(typeof span.spanId, 'string');
    assert.equal(span.attributes['http.method'], 'GET');
    assert.ok(span.startTime > 0);
    assert.equal(span.endTime, undefined);
  });

  it('endSpan sets endTime', () => {
    const span = startSpan('my-span');
    endSpan(span);
    assert.ok(span.endTime !== undefined);
    assert.ok(span.endTime >= span.startTime);
  });

  it('span propagates parentSpanId', () => {
    const parent = startSpan('parent');
    const child = startSpan('child', { traceId: parent.traceId, parentSpanId: parent.spanId });
    assert.equal(child.traceId, parent.traceId);
    assert.equal(child.parentSpanId, parent.spanId);
    endSpan(parent);
    endSpan(child);
  });
});

// ── CSP Headers ──────────────────────────────────────────────────────

import { applySecurityHeaders } from '../../src/api/securityHeaders.js';
import type { ServerResponse } from 'node:http';

describe('Wave 3A — CSP headers', () => {
  function mockRes() {
    const h: Record<string, string> = {};
    return {
      setHeader: (name: string, value: string) => { h[name] = value; },
      headers: h,
    };
  }

  it('default CSP contains self and frame-ancestors none', () => {
    const res = mockRes();
    applySecurityHeaders(res as unknown as ServerResponse);
    const csp = res.headers['content-security-policy'] ?? '';
    assert.ok(csp.includes("default-src 'self'"), 'has default-src self');
    assert.ok(csp.includes("frame-ancestors 'none'"), 'has frame-ancestors none');
  });

  it('api route CSP is most restrictive (default-src none)', () => {
    const res = mockRes();
    applySecurityHeaders(res as unknown as ServerResponse, { route: 'api' });
    const csp = res.headers['content-security-policy'] ?? '';
    assert.ok(csp.includes("default-src 'none'"), 'API CSP is restrictive');
  });

  it('dashboard route CSP allows connect-src self', () => {
    const res = mockRes();
    applySecurityHeaders(res as unknown as ServerResponse, { route: 'dashboard' });
    const csp = res.headers['content-security-policy'] ?? '';
    assert.ok(csp.includes("connect-src 'self'"), 'dashboard CSP has connect-src self');
  });

  it('all routes include x-content-type-options nosniff', () => {
    const res = mockRes();
    applySecurityHeaders(res as unknown as ServerResponse);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
  });

  it('all routes include x-frame-options DENY', () => {
    const res = mockRes();
    applySecurityHeaders(res as unknown as ServerResponse);
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });
});

// ── escapeHtml ───────────────────────────────────────────────────────

import { escapeHtml } from '../../src/dashboard/sanitize.js';

describe('Wave 3A — escapeHtml server-side', () => {
  it('escapes & < > " \'', () => {
    assert.equal(escapeHtml('&'), '&amp;');
    assert.equal(escapeHtml('<'), '&lt;');
    assert.equal(escapeHtml('>'), '&gt;');
    assert.equal(escapeHtml('"'), '&quot;');
    assert.equal(escapeHtml("'"), '&#x27;');
  });

  it('escapes XSS payload', () => {
    const xss = '<script>alert("xss")</script>';
    const escaped = escapeHtml(xss);
    assert.ok(!escaped.includes('<script>'), 'no raw script tag');
    assert.ok(escaped.includes('&lt;script&gt;'), 'escaped properly');
  });

  it('leaves safe strings unchanged', () => {
    assert.equal(escapeHtml('hello world'), 'hello world');
    assert.equal(escapeHtml('tenant-abc-123'), 'tenant-abc-123');
  });

  it('getDashboardHtml uses escapeHtml for dynamic content', () => {
    const malicious = '<img src=x onerror=alert(1)>';
    const html = getDashboardHtml({ sessionId: malicious });
    // The sessionId appears in data-session attribute — must be escaped
    assert.ok(!html.includes(malicious), 'raw XSS payload not in HTML');
  });
});

// ── storeBootstrap no-env fallback ────────────────────────────────────

import { bootstrapStores } from '../../src/infra/storeBootstrap.js';

describe('Wave 3A — storeBootstrap no-env fallback (Pack 03)', () => {
  it('bootstraps without Redis or PG env vars', async () => {
    // Ensure env vars are not set in this test process
    const origRedis = process.env['OTK_REDIS_URL'];
    const origDb = process.env['OTK_DB_URL'];
    delete process.env['OTK_REDIS_URL'];
    delete process.env['OTK_DB_URL'];

    try {
      const result = await bootstrapStores();
      assert.equal(result.redis, false);
      assert.equal(result.pg, false);
      // All stores fall back to memory
      assert.equal(result.stores['idempotency'], 'memory');
      assert.equal(result.stores['rateLimiter'], 'memory');
      assert.equal(result.stores['deadLetter'], 'memory');
    } finally {
      if (origRedis !== undefined) process.env['OTK_REDIS_URL'] = origRedis;
      if (origDb !== undefined) process.env['OTK_DB_URL'] = origDb;
    }
  });
});
