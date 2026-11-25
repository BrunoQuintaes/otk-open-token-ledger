/**
 * E1.2 — Live Key Rotation & Token Context Tests
 *
 * Tests for:
 * 1. loadTenantsFromString() — live reload behavior
 * 2. resolveTokenContext() — TokenContext resolution
 * 3. resolveTenantId() backward compatibility after E1.2 changes
 * 4. POST /admin/tenants/reload endpoint
 *
 * Modules under test: `src/api/tenantKeyRegistry.ts` and `handleRequest` in `src/api/routes.ts`
 * for the registry reload route.
 *
 * Strategy / partitions: parsing one pair, several pairs, tokens containing colons, invalid and
 * empty pairs, empty and whitespace-only input (auth off), whitespace trimming, and a reload that
 * replaces the previous registry; token context for unknown tokens, auth off, default role and an
 * explicit role; the older tenant-id lookup before and after a reload; the reload route with a
 * valid body, invalid JSON, a missing field, a wrong platform key, no platform key configured,
 * an empty list while auth is on (refused) and immediate effect of a reload.
 *
 * Needs: no server (mock request/response objects). Individual route tests set or delete
 * `OTK_ADMIN_KEY` and restore the previous value at the end of the test.
 *
 * Run just this file: `npx tsx --test test/unit/enterprise_e1_2.test.ts`
 *
 * @since E1.2 (2026-03-13)
 * @module test/unit/enterprise_e1_2.test
 */

import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  loadTenantsFromString,
  resolveTokenContext,
  resolveTenantId,
  registerToken,
  clearRegistry,
  isAuthEnabled,
} from '../../src/api/tenantKeyRegistry.js';
import { handleRequest } from '../../src/api/routes.js';

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as existing API tests)
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

// ---------------------------------------------------------------------------
// Cleanup between tests to avoid registry state bleed
// ---------------------------------------------------------------------------

before(() => { clearRegistry(); });
afterEach(() => { clearRegistry(); });

// ---------------------------------------------------------------------------
// 1. loadTenantsFromString — core reload logic
// ---------------------------------------------------------------------------

describe('E1.2 — loadTenantsFromString', () => {
  it('parses single tenant:token pair', () => {
    const { loaded } = loadTenantsFromString('acme:secret-token');
    assert.equal(loaded, 1);
    assert.equal(isAuthEnabled(), true);
  });

  it('parses multiple pairs separated by comma', () => {
    const { loaded } = loadTenantsFromString('t1:tok1,t2:tok2,t3:tok3');
    assert.equal(loaded, 3);
    assert.equal(isAuthEnabled(), true);
  });

  it('allows token to contain colons (split on FIRST colon only)', () => {
    const { loaded } = loadTenantsFromString('acme:token:with:colons:inside');
    assert.equal(loaded, 1);
    // token = "token:with:colons:inside"
    const ctx = resolveTokenContext('token:with:colons:inside');
    assert.ok(ctx);
    assert.equal(ctx.tenantId, 'acme');
  });

  it('skips invalid pairs (no colon separator)', () => {
    const { loaded } = loadTenantsFromString('invalidpair,t1:tok1');
    assert.equal(loaded, 1);
  });

  it('skips pairs with empty tenantId or empty token', () => {
    const { loaded } = loadTenantsFromString(':emptyTenant,validTenant:,t1:tok1');
    assert.equal(loaded, 1);
  });

  it('empty string disables auth', () => {
    loadTenantsFromString('t1:tok1'); // enable first
    assert.equal(isAuthEnabled(), true);
    const { loaded } = loadTenantsFromString('');
    assert.equal(loaded, 0);
    assert.equal(isAuthEnabled(), false);
  });

  it('whitespace-only string disables auth', () => {
    loadTenantsFromString('t1:tok1');
    const { loaded } = loadTenantsFromString('   ');
    assert.equal(loaded, 0);
    assert.equal(isAuthEnabled(), false);
  });

  it('reload replaces previous registry atomically', () => {
    loadTenantsFromString('t1:old-token');
    assert.ok(resolveTokenContext('old-token'));

    loadTenantsFromString('t2:new-token');
    assert.equal(resolveTokenContext('old-token'), null); // evicted
    const ctx = resolveTokenContext('new-token');
    assert.ok(ctx);
    assert.equal(ctx.tenantId, 't2');
  });

  it('strips whitespace from tenantId and token', () => {
    const { loaded } = loadTenantsFromString('  acme  :  tok1  ');
    assert.equal(loaded, 1);
    const ctx = resolveTokenContext('tok1');
    assert.ok(ctx);
    assert.equal(ctx.tenantId, 'acme');
  });
});

// ---------------------------------------------------------------------------
// 2. resolveTokenContext — E1.2 addition
// ---------------------------------------------------------------------------

describe('E1.2 — resolveTokenContext', () => {
  it('returns null for unknown token when auth enabled', () => {
    loadTenantsFromString('t1:tok1');
    assert.equal(resolveTokenContext('unknown-tok'), null);
  });

  it('returns { tenantId: default, role: OPERATOR } when auth disabled', () => {
    // clearRegistry() called in afterEach — auth is disabled
    const ctx = resolveTokenContext('any-token');
    assert.ok(ctx);
    assert.equal(ctx.tenantId, 'default');
    assert.equal(ctx.role, 'OPERATOR');
  });

  it('returns correct tenantId and role=OPERATOR for OTK_TENANTS tokens', () => {
    loadTenantsFromString('acme:tok-acme');
    const ctx = resolveTokenContext('tok-acme');
    assert.ok(ctx);
    assert.equal(ctx.tenantId, 'acme');
    assert.equal(ctx.role, 'OPERATOR');
  });

  it('respects role set via registerToken', () => {
    registerToken('admin-tok', 'acme', 'OWNER');
    const ctx = resolveTokenContext('admin-tok');
    assert.ok(ctx);
    assert.equal(ctx.tenantId, 'acme');
    assert.equal(ctx.role, 'OWNER');
  });
});

// ---------------------------------------------------------------------------
// 3. resolveTenantId — backward compatibility
// ---------------------------------------------------------------------------

describe('E1.2 — resolveTenantId backward compat', () => {
  it('returns tenantId string (not null) for known token', () => {
    loadTenantsFromString('myco:my-token');
    const tid = resolveTenantId('my-token');
    assert.equal(tid, 'myco');
  });

  it('returns null for unknown token when auth enabled', () => {
    loadTenantsFromString('myco:my-token');
    assert.equal(resolveTenantId('wrong-token'), null);
  });

  it('returns "default" when auth disabled', () => {
    // auth disabled after clearRegistry()
    assert.equal(resolveTenantId('any-token'), 'default');
  });

  it('still works after reload (live reload backward compat)', () => {
    loadTenantsFromString('t1:old');
    assert.equal(resolveTenantId('old'), 't1');
    loadTenantsFromString('t1:new');
    assert.equal(resolveTenantId('old'), null);
    assert.equal(resolveTenantId('new'), 't1');
  });
});

// ---------------------------------------------------------------------------
// 4. POST /admin/tenants/reload — HTTP endpoint
// ---------------------------------------------------------------------------

describe('E1.2 — POST /admin/tenants/reload endpoint', () => {
  it('returns 200 with loaded count on valid payload', async () => {
    const body = JSON.stringify({ tenants: 'corp1:tok-a,corp2:tok-b' });
    const res = mockRes();
    await handleRequest(mockReq('POST', '/admin/tenants/reload', body), res);
    assert.equal(res.statusCode, 200);
    const parsed = JSON.parse(res.body);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.loaded, 2);
    assert.equal(parsed.authEnabled, true);
  });

  it('returns 400 on invalid JSON body', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/admin/tenants/reload', 'not-json'), res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'invalid_json');
  });

  it('returns 400 when tenants field is missing or not string', async () => {
    const body = JSON.stringify({ tenants: 42 });
    const res = mockRes();
    await handleRequest(mockReq('POST', '/admin/tenants/reload', body), res);
    assert.equal(res.statusCode, 400);
    assert.equal(JSON.parse(res.body).error, 'missing_required_fields');
  });

  it('returns 401 when OTK_ADMIN_KEY is set and x-admin-key is wrong', async () => {
    const orig = process.env['OTK_ADMIN_KEY'];
    process.env['OTK_ADMIN_KEY'] = 'correct-key';
    try {
      const body = JSON.stringify({ tenants: 'corp:tok' });
      const res = mockRes();
      await handleRequest(
        mockReq('POST', '/admin/tenants/reload', body, { 'x-admin-key': 'wrong-key' }),
        res,
      );
      assert.equal(res.statusCode, 401);
    } finally {
      if (orig === undefined) delete process.env['OTK_ADMIN_KEY'];
      else process.env['OTK_ADMIN_KEY'] = orig;
    }
  });

  it('allows access when OTK_ADMIN_KEY is not set (backward compat)', async () => {
    const orig = process.env['OTK_ADMIN_KEY'];
    delete process.env['OTK_ADMIN_KEY'];
    try {
      const body = JSON.stringify({ tenants: 'org:tok-123' });
      const res = mockRes();
      await handleRequest(mockReq('POST', '/admin/tenants/reload', body), res);
      assert.equal(res.statusCode, 200);
    } finally {
      if (orig !== undefined) process.env['OTK_ADMIN_KEY'] = orig;
    }
  });

  it('with auth enabled, an empty tenants string is refused (it would disable auth); registry unchanged', async () => {
    // FINAL CLOSURE AUD-FC-01: before, an OWNER bearer could reload '' and switch auth off for every tenant.
    // Now the reload is a platform operation (OTK_ADMIN_KEY) and a reload loading nothing is refused.
    loadTenantsFromString('corp:tok'); // enable first
    const orig = process.env['OTK_ADMIN_KEY'];
    process.env['OTK_ADMIN_KEY'] = 'platform-key-e6';
    try {
      const res = mockRes();
      await handleRequest(
        mockReq('POST', '/admin/tenants/reload', JSON.stringify({ tenants: '' }), { 'x-admin-key': 'platform-key-e6' }),
        res,
      );
      assert.equal(res.statusCode, 400);
      assert.equal(JSON.parse(res.body).error, 'reload_would_disable_auth');
      assert.equal(isAuthEnabled(), true);
      assert.equal(resolveTenantId('tok'), 'corp');
    } finally {
      if (orig === undefined) delete process.env['OTK_ADMIN_KEY'];
      else process.env['OTK_ADMIN_KEY'] = orig;
    }
  });

  it('live reload is effective immediately — registry reflects new state', async () => {
    // Load initial tokens
    loadTenantsFromString('old-tenant:old-tok');
    assert.equal(resolveTenantId('old-tok'), 'old-tenant');
    // FINAL CLOSURE AUD-FC-01: the reload is a platform operation (OTK_ADMIN_KEY), not a tenant OWNER action
    const orig = process.env['OTK_ADMIN_KEY'];
    process.env['OTK_ADMIN_KEY'] = 'platform-key-e7';
    const body = JSON.stringify({ tenants: 'new-tenant:new-tok' });
    const res = mockRes();
    try {
      await handleRequest(
        mockReq('POST', '/admin/tenants/reload', body, { 'x-admin-key': 'platform-key-e7' }),
        res,
      );
    } finally {
      if (orig === undefined) delete process.env['OTK_ADMIN_KEY'];
      else process.env['OTK_ADMIN_KEY'] = orig;
    }
    assert.equal(res.statusCode, 200);

    // Old token should be gone, new token active
    assert.equal(resolveTenantId('old-tok'), null);
    assert.equal(resolveTenantId('new-tok'), 'new-tenant');
  });
});
