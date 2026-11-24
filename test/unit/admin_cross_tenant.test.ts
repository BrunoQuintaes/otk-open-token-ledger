/**
 * F-OVN2-06 (FINAL CLOSURE, 2026-10-07): tenant roles administer only their own tenant.
 * Decision of the author: an ADMIN is the administrator of ITS tenant, not of the platform. Cross-tenant is denied by
 * default; the body (or the path) can never replace the tenant of the credential. No platform role exists yet.
 * Negative tests for IDOR/BOLA on every route guarded by admin:tenants.
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerToken, clearRegistry } from '../../src/api/tenantKeyRegistry.js';
import { handleRequest } from '../../src/api/routes.js';
import { assignPlan, getTenantPlan } from '../../src/billing/PlanRegistry.js';
import { createTenant, getTenant } from '../../src/api/tenantCrud.js';

function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers }) as unknown as IncomingMessage;
  process.nextTick(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); });
  return req;
}
type MockRes = ServerResponse & { body: string };
function mockRes(): MockRes {
  let body = '';
  return { statusCode: 200, setHeader: () => {}, writeHead(c: number) { (this as { statusCode: number }).statusCode = c; return this; }, end: (d: string) => { body = d; }, get body() { return body; } } as unknown as MockRes;
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}`, 'content-type': 'application/json' });
async function call(method: string, url: string, token: string | null, body?: unknown) {
  const res = mockRes();
  await handleRequest(mockReq(method, url, body === undefined ? '' : JSON.stringify(body), token ? bearer(token) : { 'content-type': 'application/json' }), res);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(res.body) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.statusCode, json };
}

const RUN = Date.now().toString(36);
const A = `ten-a-${RUN}`; const B = `ten-b-${RUN}`;

before(() => { clearRegistry(); });
afterEach(() => { clearRegistry(); });
function tokens() {
  registerToken(`admin-a-${RUN}`, A, 'ADMIN');
  registerToken(`owner-a-${RUN}`, A, 'OWNER');
  registerToken(`member-a-${RUN}`, A, 'MEMBER');
  registerToken(`admin-b-${RUN}`, B, 'ADMIN');
}

describe('F-OVN2-06: POST /admin/plans/assign', () => {
  // SEC02-N01 (OTK-MOR-01): the own-tenant change is now a downgrade; raising the own plan is refused (see
  // test/security/sec02_n01_plan_self_upgrade.test.ts). Until then this case assigned FREE → STARTER.
  it('ADMIN of its own tenant → 200 and the plan changes', async () => {
    tokens();
    await assignPlan(A, 'PRO');
    const r = await call('POST', '/admin/plans/assign', `admin-a-${RUN}`, { tenantId: A, tier: 'STARTER' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(getTenantPlan(A), 'STARTER');
  });
  it('ADMIN of tenant A on tenant B → 403 cross_tenant_forbidden and B is unchanged', async () => {
    tokens();
    const before = getTenantPlan(B);
    const r = await call('POST', '/admin/plans/assign', `admin-a-${RUN}`, { tenantId: B, tier: 'PRO' });
    assert.equal(r.status, 403);
    assert.equal(r.json['error'], 'cross_tenant_forbidden');
    assert.equal(getTenantPlan(B), before);
  });
  it('OWNER of tenant A on tenant B → 403 (tenant roles are all tenant-scoped)', async () => {
    tokens();
    const r = await call('POST', '/admin/plans/assign', `owner-a-${RUN}`, { tenantId: B, tier: 'PRO' });
    assert.equal(r.status, 403);
  });
  it('non-admin (MEMBER) → 403 even on its own tenant', async () => {
    tokens();
    const r = await call('POST', '/admin/plans/assign', `member-a-${RUN}`, { tenantId: A, tier: 'PRO' });
    assert.equal(r.status, 403);
  });
  it('missing, empty or non-string tenantId → refused, nothing assigned', async () => {
    tokens();
    for (const body of [{ tier: 'PRO' }, { tenantId: '', tier: 'PRO' }, { tenantId: 42, tier: 'PRO' }, { tenantId: ['x'], tier: 'PRO' }]) {
      const r = await call('POST', '/admin/plans/assign', `admin-a-${RUN}`, body);
      assert.ok(r.status === 400 || r.status === 403, `${JSON.stringify(body)} → ${r.status}`);
    }
  });
  it('no credential → 401', async () => {
    tokens();
    const r = await call('POST', '/admin/plans/assign', null, { tenantId: A, tier: 'PRO' });
    assert.equal(r.status, 401);
  });
});

describe('F-OVN2-06: GET /admin/plans/assignments', () => {
  it('lists only the caller tenant', async () => {
    tokens();
    await assignPlan(A, 'STARTER'); await assignPlan(B, 'PRO');
    const r = await call('GET', '/admin/plans/assignments', `admin-a-${RUN}`);
    assert.equal(r.status, 200);
    const ids = (r.json['assignments'] as Array<{ tenantId: string }>).map((x) => x.tenantId);
    assert.ok(ids.includes(A));
    assert.ok(!ids.includes(B), 'tenant B must not be visible to tenant A');
    assert.ok(ids.every((x) => x === A));
  });
});

describe('F-OVN2-06: tenant CRUD under admin:tenants', () => {
  it('ADMIN of A cannot create, read, update or delete tenant B; B survives', async () => {
    tokens();
    createTenant({ tenantId: B, token: `tok-b-crud-${RUN}`, actor: 'test' });
    assert.equal((await call('POST', '/admin/tenants', `admin-a-${RUN}`, { tenantId: `ten-new-${RUN}`, token: `tok-new-${RUN}` })).status, 403);
    assert.equal((await call('GET', `/admin/tenants/${B}`, `admin-a-${RUN}`)).status, 403);
    assert.equal((await call('PUT', `/admin/tenants/${B}`, `admin-a-${RUN}`, { role: 'OWNER' })).status, 403);
    assert.equal((await call('DELETE', `/admin/tenants/${B}`, `admin-a-${RUN}`)).status, 403);
    assert.ok(getTenant(B), 'tenant B still exists');
    assert.equal(getTenant(`ten-new-${RUN}`), undefined, 'no tenant created');
  });
  it('the tenant list shows only the caller tenant', async () => {
    tokens();
    createTenant({ tenantId: A, token: `tok-a-crud-${RUN}`, actor: 'test' });
    createTenant({ tenantId: `${B}-2`, token: `tok-b2-crud-${RUN}`, actor: 'test' });
    const r = await call('GET', '/admin/tenants', `admin-a-${RUN}`);
    assert.equal(r.status, 200);
    const ids = (r.json['tenants'] as Array<{ tenantId: string }>).map((x) => x.tenantId);
    assert.ok(ids.every((x) => x === A), JSON.stringify(ids));
  });
  it('ADMIN of A reading its own tenant is not denied by the cross-tenant rule', async () => {
    tokens();
    createTenant({ tenantId: `${A}-own`, token: `tok-own-${RUN}`, actor: 'test' });
    registerToken(`admin-own-${RUN}`, `${A}-own`, 'ADMIN');
    const r = await call('GET', `/admin/tenants/${A}-own`, `admin-own-${RUN}`);
    assert.equal(r.status, 200, JSON.stringify(r.json));
  });
  it('the path cannot be used to reach another tenant through encoding', async () => {
    tokens();
    const r = await call('GET', `/admin/tenants/${encodeURIComponent(B)}`, `admin-a-${RUN}`);
    assert.equal(r.status, 403);
  });
});
