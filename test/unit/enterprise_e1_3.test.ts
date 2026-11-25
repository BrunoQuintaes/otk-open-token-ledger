/**
 * E1.3 — RBAC Enforcement Tests
 *
 * Validates per-endpoint authorization using role-based access control.
 *
 * Coverage:
 * 1. hasPermission() matrix — unit tests for src/security/rbac.ts
 * 2. OPERATOR can access receipts:write/read, accounting:read, admin (flush/chain-head/tal-summary)
 * 3. OPERATOR CANNOT access admin:keys (POST /admin/tenants/reload)
 * 4. OWNER can access everything including admin:keys
 * 5. MEMBER: receipts:write/read + accounting:read; NO admin endpoints
 * 6. VIEWER: receipts:read + accounting:read; NO write or admin endpoints
 * 7. Auth disabled: full backward compat (all endpoints open)
 * 8. 401 on missing/invalid token when auth enabled
 * 9. 403 on insufficient permission (authenticated but role too low)
 * 10. Zero regression on existing suites
 *
 * Later security fixes changed items 2 and 4: batch flush and chain head are now platform
 * operations (403 for every tenant role, including OPERATOR), and replacing the tenant registry
 * is refused for a tenant OWNER too; the tests assert the current answers.
 *
 * Modules under test: `hasPermission` from `src/security/rbac.ts`, and `handleRequest` in
 * `src/api/routes.ts` with tokens from `src/api/tenantKeyRegistry.ts`.
 *
 * Strategy / partitions: the permission matrix for OWNER, ADMIN, OPERATOR, MEMBER and VIEWER;
 * for each role, the receipt, accounting and admin routes it may and may not call; auth off
 * with no platform key (open) and with a platform key (still enforced on admin routes); auth on
 * with no token or an unknown token (401).
 *
 * Needs: no server (mock request/response objects). A few tests set or delete `OTK_ADMIN_KEY`
 * and restore the previous value at the end of the test.
 *
 * Run just this file: `npx tsx --test test/unit/enterprise_e1_3.test.ts`
 *
 * @since E1.3 (2026-03-14)
 * @module test/unit/enterprise_e1_3.test
 */

import { describe, it, before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  registerToken,
  clearRegistry,
  isAuthEnabled,
  resolveTokenContext,
} from '../../src/api/tenantKeyRegistry.js';
import { hasPermission } from '../../src/security/rbac.js';
import { handleRequest } from '../../src/api/routes.js';
import { flushAll } from '../../src/api/receiptStore.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockReq(
  method: string,
  url: string,
  body = '',
  headers: Record<string, string> = {},
): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers }) as unknown as IncomingMessage;
  process.nextTick(() => {
    if (body) em.emit('data', Buffer.from(body));
    em.emit('end');
  });
  return req;
}

type MockRes = ServerResponse & { body: string };

function mockRes(): MockRes {
  let body = '';
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (data: string) => { body = data; },
    get body() { return body; },
  } as unknown as MockRes;
  return res;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_RECEIPT = JSON.stringify({
  requestId: `req-e13-${Date.now()}`,
  provider: 'openai',
  model: 'gpt-4',
  inputTokens: 10,
  outputTokens: 5,
  costUnits: 15,
  latencyMs: 100,
  timestamp: Math.floor(Date.now() / 1000),
  userId: '1',
  nonce: '1',
});

const TENANTS_RELOAD_BODY = JSON.stringify({ tenants: 'newco:tok-new' });

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------

before(() => { clearRegistry(); flushAll(); });
afterEach(() => { clearRegistry(); });

// ---------------------------------------------------------------------------
// 1. hasPermission() unit tests
// ---------------------------------------------------------------------------

describe('E1.3 — hasPermission() matrix', () => {
  it('OWNER has all permissions', () => {
    const perms = [
      'receipts:write', 'receipts:read', 'accounting:read',
      'admin:flush', 'admin:chain-head', 'admin:tal-summary', 'admin:keys',
    ] as const;
    for (const p of perms) {
      assert.equal(hasPermission('OWNER', p), true, `OWNER should have ${p}`);
    }
  });

  it('ADMIN has all except admin:keys', () => {
    assert.equal(hasPermission('ADMIN', 'receipts:write'), true);
    assert.equal(hasPermission('ADMIN', 'admin:flush'), true);
    assert.equal(hasPermission('ADMIN', 'admin:tal-summary'), true);
    assert.equal(hasPermission('ADMIN', 'admin:keys'), false);
  });

  it('OPERATOR has receipts + accounting + admin ops, no admin:keys', () => {
    assert.equal(hasPermission('OPERATOR', 'receipts:write'), true);
    assert.equal(hasPermission('OPERATOR', 'receipts:read'), true);
    assert.equal(hasPermission('OPERATOR', 'accounting:read'), true);
    assert.equal(hasPermission('OPERATOR', 'admin:flush'), true);
    assert.equal(hasPermission('OPERATOR', 'admin:chain-head'), true);
    assert.equal(hasPermission('OPERATOR', 'admin:tal-summary'), true);
    assert.equal(hasPermission('OPERATOR', 'admin:keys'), false);
  });

  it('MEMBER has receipts:write + receipts:read + accounting:read, no admin', () => {
    assert.equal(hasPermission('MEMBER', 'receipts:write'), true);
    assert.equal(hasPermission('MEMBER', 'receipts:read'), true);
    assert.equal(hasPermission('MEMBER', 'accounting:read'), true);
    assert.equal(hasPermission('MEMBER', 'admin:flush'), false);
    assert.equal(hasPermission('MEMBER', 'admin:chain-head'), false);
    assert.equal(hasPermission('MEMBER', 'admin:tal-summary'), false);
    assert.equal(hasPermission('MEMBER', 'admin:keys'), false);
  });

  it('VIEWER has receipts:read + accounting:read only', () => {
    assert.equal(hasPermission('VIEWER', 'receipts:read'), true);
    assert.equal(hasPermission('VIEWER', 'accounting:read'), true);
    assert.equal(hasPermission('VIEWER', 'receipts:write'), false);
    assert.equal(hasPermission('VIEWER', 'admin:flush'), false);
    assert.equal(hasPermission('VIEWER', 'admin:keys'), false);
  });
});

// ---------------------------------------------------------------------------
// 2. OPERATOR — allowed endpoints
// ---------------------------------------------------------------------------

describe('E1.3 — OPERATOR: allowed endpoints', () => {
  beforeEach(() => {
    registerToken('op-token', 'tenant-op', 'OPERATOR');
    assert.equal(isAuthEnabled(), true);
  });

  it('POST /receipts → 201 (receipts:write)', async () => {
    const body = JSON.stringify({
      requestId: `req-op-write-${Date.now()}`,
      provider: 'openai', model: 'gpt-4',
      inputTokens: 5, outputTokens: 3, costUnits: 8,
      latencyMs: 50, timestamp: Math.floor(Date.now() / 1000),
      userId: '1', nonce: '2',
    });
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', body, bearer('op-token')), res);
    assert.equal(res.statusCode, 201);
    assert.equal(JSON.parse(res.body).ok, true);
  });

  it('GET /receipts/:id → 404 or 200 (receipts:read — not 401/403)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/receipts/unknown-req-id', '', bearer('op-token')), res);
    // 404 means auth passed; the receipt simply doesn't exist
    assert.ok(res.statusCode === 404 || res.statusCode === 200);
    assert.notEqual(res.statusCode, 401);
    assert.notEqual(res.statusCode, 403);
  });

  it('GET /accounting/balance → 200 (accounting:read)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/accounting/balance', '', bearer('op-token')), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });

  // RV-RUNS-01 (RUN-S 2026-10-10): hardened, not relaxed. This assertion expected 200 and encoded the defect: a tenant
  // OPERATOR ran a platform-wide operation. It is now refused like /admin/finance (platform credential required).
  it('POST /admin/flush-batch → 403 platform operation (admin:flush is not enough; was 200 before RV-RUNS-01)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/admin/flush-batch', '', bearer('op-token')), res);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'platform_operation_forbidden');
  });

  // RV-RUNS-01 (RUN-S 2026-10-10): hardened, not relaxed. This assertion expected 200 and encoded the defect: a tenant
  // OPERATOR ran a platform-wide operation. It is now refused like /admin/finance (platform credential required).
  it('GET /admin/chain-head → 403 platform operation (admin:chain-head is not enough; was 200 before RV-RUNS-01)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/chain-head', '', bearer('op-token')), res);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'platform_operation_forbidden');
  });

  it('GET /admin/tal-summary → 200 (admin:tal-summary)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/tal-summary', '', bearer('op-token')), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });
});

// ---------------------------------------------------------------------------
// 3. OPERATOR — denied endpoint (admin:keys)
// ---------------------------------------------------------------------------

describe('E1.3 — OPERATOR: denied admin:keys', () => {
  beforeEach(() => {
    registerToken('op-token2', 'tenant-op2', 'OPERATOR');
  });

  it('POST /admin/tenants/reload → 403 (OPERATOR lacks admin:keys)', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('POST', '/admin/tenants/reload', TENANTS_RELOAD_BODY, bearer('op-token2')),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'forbidden');
  });
});

// ---------------------------------------------------------------------------
// 4. OWNER — can do everything including admin:keys
// ---------------------------------------------------------------------------

describe('E1.3 — OWNER: full access including admin:keys', () => {
  beforeEach(() => {
    registerToken('owner-token', 'tenant-owner', 'OWNER');
  });

  it('POST /admin/tenants/reload → 403 for a tenant OWNER (replacing the registry is a platform operation, AUD-FC-01)', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('POST', '/admin/tenants/reload', TENANTS_RELOAD_BODY, bearer('owner-token')),
      res,
    );
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'platform_operation_forbidden');
    // the registry was not replaced: the OWNER token still authenticates
    assert.equal(resolveTokenContext('owner-token')?.tenantId, 'tenant-owner');
  });
});

// ---------------------------------------------------------------------------
// 5. MEMBER — receipts + accounting, no admin
// ---------------------------------------------------------------------------

describe('E1.3 — MEMBER: receipts + accounting, no admin', () => {
  beforeEach(() => {
    registerToken('member-token', 'tenant-member', 'MEMBER');
  });

  it('POST /receipts → 201 (receipts:write)', async () => {
    const body = JSON.stringify({
      requestId: `req-member-${Date.now()}`,
      provider: 'openai', model: 'gpt-4',
      inputTokens: 3, outputTokens: 2, costUnits: 5,
      latencyMs: 30, timestamp: Math.floor(Date.now() / 1000),
      userId: '2', nonce: '3',
    });
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', body, bearer('member-token')), res);
    assert.equal(res.statusCode, 201);
  });

  it('GET /receipts/:id → not 401/403 (receipts:read)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/receipts/nonexistent', '', bearer('member-token')), res);
    assert.notEqual(res.statusCode, 401);
    assert.notEqual(res.statusCode, 403);
  });

  it('GET /accounting/balance → 200 (accounting:read)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/accounting/balance', '', bearer('member-token')), res);
    assert.equal(res.statusCode, 200);
  });

  it('POST /admin/flush-batch → 403 (no admin:flush)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/admin/flush-batch', '', bearer('member-token')), res);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'forbidden');
  });

  it('GET /admin/chain-head → 403 (no admin:chain-head)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/chain-head', '', bearer('member-token')), res);
    assert.equal(res.statusCode, 403);
  });

  it('GET /admin/tal-summary → 403 (no admin:tal-summary)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/tal-summary', '', bearer('member-token')), res);
    assert.equal(res.statusCode, 403);
  });

  it('POST /admin/tenants/reload → 403 (no admin:keys)', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('POST', '/admin/tenants/reload', TENANTS_RELOAD_BODY, bearer('member-token')),
      res,
    );
    assert.equal(res.statusCode, 403);
  });
});

// ---------------------------------------------------------------------------
// 6. VIEWER — read-only
// ---------------------------------------------------------------------------

describe('E1.3 — VIEWER: read-only access', () => {
  beforeEach(() => {
    registerToken('viewer-token', 'tenant-viewer', 'VIEWER');
  });

  it('GET /receipts/:id → not 401/403 (receipts:read)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/receipts/nonexistent', '', bearer('viewer-token')), res);
    assert.notEqual(res.statusCode, 401);
    assert.notEqual(res.statusCode, 403);
  });

  it('GET /accounting/balance → 200 (accounting:read)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/accounting/balance', '', bearer('viewer-token')), res);
    assert.equal(res.statusCode, 200);
  });

  it('POST /receipts → 403 (no receipts:write)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', VALID_RECEIPT, bearer('viewer-token')), res);
    assert.equal(res.statusCode, 403);
    assert.equal(JSON.parse(res.body).error, 'forbidden');
  });

  it('POST /admin/flush-batch → 403 (no admin:flush)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/admin/flush-batch', '', bearer('viewer-token')), res);
    assert.equal(res.statusCode, 403);
  });

  it('GET /admin/chain-head → 403 (no admin:chain-head)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/chain-head', '', bearer('viewer-token')), res);
    assert.equal(res.statusCode, 403);
  });

  it('POST /admin/tenants/reload → 403 (no admin:keys)', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('POST', '/admin/tenants/reload', TENANTS_RELOAD_BODY, bearer('viewer-token')),
      res,
    );
    assert.equal(res.statusCode, 403);
  });
});

// ---------------------------------------------------------------------------
// 7. Auth disabled — backward compat (all endpoints open)
// ---------------------------------------------------------------------------

describe('E1.3 — auth disabled: backward compat', () => {
  before(() => {
    clearRegistry();
    assert.equal(isAuthEnabled(), false);
  });

  it('POST /receipts without token → 201 (open when auth disabled)', async () => {
    const body = JSON.stringify({
      requestId: `req-noauth-${Date.now()}`,
      provider: 'openai', model: 'gpt-4',
      inputTokens: 1, outputTokens: 1, costUnits: 2,
      latencyMs: 10, timestamp: Math.floor(Date.now() / 1000),
      userId: '9', nonce: '9',
    });
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', body), res);
    assert.equal(res.statusCode, 201);
  });

  it('GET /accounting/balance without token → 200 (open when auth disabled)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/accounting/balance'), res);
    assert.equal(res.statusCode, 200);
  });

  it('POST /admin/flush-batch without token → 200 (open when OTK_ADMIN_KEY unset)', async () => {
    const orig = process.env['OTK_ADMIN_KEY'];
    delete process.env['OTK_ADMIN_KEY'];
    try {
      const res = mockRes();
      await handleRequest(mockReq('POST', '/admin/flush-batch'), res);
      assert.equal(res.statusCode, 200);
    } finally {
      if (orig !== undefined) process.env['OTK_ADMIN_KEY'] = orig;
    }
  });

  it('POST /admin/tenants/reload without token → 200 (open when OTK_ADMIN_KEY unset)', async () => {
    const orig = process.env['OTK_ADMIN_KEY'];
    delete process.env['OTK_ADMIN_KEY'];
    try {
      const res = mockRes();
      await handleRequest(mockReq('POST', '/admin/tenants/reload', TENANTS_RELOAD_BODY), res);
      assert.equal(res.statusCode, 200);
    } finally {
      if (orig !== undefined) process.env['OTK_ADMIN_KEY'] = orig;
    }
  });

  it('legacy OTK_ADMIN_KEY still enforced for admin endpoints when auth disabled', async () => {
    const orig = process.env['OTK_ADMIN_KEY'];
    process.env['OTK_ADMIN_KEY'] = 'secret-admin';
    try {
      const res = mockRes();
      await handleRequest(
        mockReq('POST', '/admin/flush-batch', '', { 'x-admin-key': 'wrong' }),
        res,
      );
      assert.equal(res.statusCode, 401);
    } finally {
      if (orig === undefined) delete process.env['OTK_ADMIN_KEY'];
      else process.env['OTK_ADMIN_KEY'] = orig;
    }
  });
});

// ---------------------------------------------------------------------------
// 8. 401 — missing/invalid token when auth enabled
// ---------------------------------------------------------------------------

describe('E1.3 — 401: missing/invalid bearer token when auth enabled', () => {
  beforeEach(() => {
    registerToken('valid-token', 'tenant-x', 'OPERATOR');
  });

  it('POST /receipts without token → 401', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', VALID_RECEIPT), res);
    assert.equal(res.statusCode, 401);
    assert.equal(JSON.parse(res.body).error, 'unauthorized');
  });

  it('POST /receipts with unknown token → 401', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('POST', '/receipts', VALID_RECEIPT, bearer('wrong-token-xxx')),
      res,
    );
    assert.equal(res.statusCode, 401);
  });

  it('GET /receipts/:id without token → 401', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/receipts/any-id'), res);
    assert.equal(res.statusCode, 401);
  });

  it('GET /accounting/balance without token → 401', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/accounting/balance'), res);
    assert.equal(res.statusCode, 401);
  });

  it('POST /admin/flush-batch without token → 401', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/admin/flush-batch'), res);
    assert.equal(res.statusCode, 401);
  });

  it('GET /admin/chain-head without token → 401', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/chain-head'), res);
    assert.equal(res.statusCode, 401);
  });

  it('GET /admin/tal-summary without token → 401', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/tal-summary'), res);
    assert.equal(res.statusCode, 401);
  });

  it('POST /admin/tenants/reload without token → 401', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/admin/tenants/reload', TENANTS_RELOAD_BODY), res);
    assert.equal(res.statusCode, 401);
  });
});
