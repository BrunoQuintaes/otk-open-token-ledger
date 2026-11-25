/**
 * AUD-FC-12..16 (FINAL CLOSURE exhaustive re-audit, 2026-10-07). With auth enabled:
 * - /analytics/cu-trend and the dashboard JSON API (/app/api/*, /app/webhooks) no longer answer without a credential;
 *   tenant callers get only their own usage, receipts and trend; platform-wide aggregates need the platform credential;
 * - /invoices?tenantId= of another tenant is refused; /v1/reports/teams lists only the caller's own teams;
 * - the global reconciliation report and the platform-wide reconciliation run are platform operations.
 *
 * Module under test: `src/api/routes.ts` (tenant scoping of the analytics, dashboard, invoice, team report and
 * reconciliation routes), with `src/api/tenantKeyRegistry.ts`, `src/dashboard/indexer.ts` and
 * `src/users/teamStore.ts` as fixtures.
 *
 * Strategy / partitions: per route, no credential (401), another tenant (403 or refused), the caller's own
 * tenant (200) and the platform credential (200 on aggregates).
 *
 * Needs: nothing external; requests are in-memory mocks. Sets `OTK_ADMIN_KEY` for the run and restores it.
 *
 * Run just this file: `npx tsx --test test/unit/tenant_boundary_pass4.test.ts`
 *
 * @module test/unit/tenant_boundary_pass4.test
 */
import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerToken, clearRegistry } from '../../src/api/tenantKeyRegistry.js';
import { handleRequest } from '../../src/api/routes.js';
import { getIndexer, resetIndexerForTest } from '../../src/dashboard/indexer.js';
import { getTeamStore } from '../../src/users/teamStore.js';

function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers }) as unknown as IncomingMessage;
  process.nextTick(() => { em.emit('end'); });
  return req;
}
type MockRes = ServerResponse & { body: string };
function mockRes(): MockRes {
  let body = '';
  return { statusCode: 200, setHeader: () => {}, writeHead(c: number) { (this as { statusCode: number }).statusCode = c; return this; }, end: (d: string) => { body = d; }, get body() { return body; } } as unknown as MockRes;
}
async function call(method: string, url: string, headers: Record<string, string> = {}) {
  const res = mockRes();
  await handleRequest(mockReq(method, url, headers), res);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(res.body) as Record<string, unknown>; } catch { /* html or empty */ }
  return { status: res.statusCode, json, body: res.body };
}
const RUN = Date.now().toString(36);
const A = `p4-a-${RUN}`; const B = `p4-b-${RUN}`;
const OWNER_A = `p4-owner-a-${RUN}`; const MEMBER_A = `p4-member-a-${RUN}`;
const PLATFORM = `p4-platform-${RUN}`;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
let origKey: string | undefined;

before(() => { origKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM; });
after(() => { if (origKey === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origKey; });
beforeEach(() => {
  clearRegistry();
  registerToken(OWNER_A, A, 'OWNER'); registerToken(MEMBER_A, A, 'MEMBER');
  resetIndexerForTest();
  const base = { provider: 'openai', model: 'gpt-4o-mini', inputTokens: 10, outputTokens: 2, costUnits: 5, latencyMs: 1, timestamp: Date.now() };
  getIndexer().index({ ...base, requestId: `ra-${RUN}`, tenantId: A, teamId: `team-a-${RUN}` });
  getIndexer().index({ ...base, requestId: `rb-${RUN}`, tenantId: B, teamId: `team-b-${RUN}` });
});

describe('AUD-FC-12: /analytics/cu-trend', () => {
  it('no credential → 401; another tenant → 403; own tenant → 200; platform credential → 200 for all', async () => {
    assert.equal((await call('GET', `/v1/analytics/cu-trend?tenantId=${B}`)).status, 401);
    const x = await call('GET', `/v1/analytics/cu-trend?tenantId=${B}`, bearer(OWNER_A));
    assert.equal(x.status, 403); assert.equal(x.json['error'], 'cross_tenant_forbidden');
    assert.equal((await call('GET', '/v1/analytics/cu-trend', bearer(MEMBER_A))).status, 200);
    assert.equal((await call('GET', '/v1/analytics/cu-trend', { 'x-admin-key': PLATFORM })).status, 200);
  });
});

describe('AUD-FC-13: dashboard JSON API and webhook page', () => {
  it('without a credential every dashboard API route answers 401', async () => {
    for (const u of ['/app/api/overview', '/app/api/receipts', '/app/api/tenants', '/app/api/usage', '/app/api/admin/summary', '/app/api/dead-letters', '/app/api/providers/health', '/app/webhooks']) {
      assert.equal((await call('GET', u)).status, 401, u);
    }
  });
  it('a tenant OWNER gets 403 on platform-wide aggregates', async () => {
    for (const u of ['/app/api/overview', '/app/api/tenants', '/app/api/admin/summary', '/app/api/dead-letters', '/app/webhooks']) {
      const r = await call('GET', u, bearer(OWNER_A));
      assert.equal(r.status, 403, u); assert.equal(r.json['error'], 'platform_operation_forbidden');
    }
  });
  it('a tenant sees only its own receipts and usage; asking for another tenant usage is refused', async () => {
    const rec = await call('GET', '/app/api/receipts', bearer(MEMBER_A));
    assert.equal(rec.status, 200);
    const ids = (rec.json['receipts'] as Array<{ requestId: string }>).map((x) => x.requestId);
    assert.ok(ids.includes(`ra-${RUN}`)); assert.ok(!ids.includes(`rb-${RUN}`), 'receipt of B not visible');
    assert.equal((await call('GET', '/app/api/usage', bearer(MEMBER_A))).status, 200);
    assert.equal((await call('GET', `/app/api/usage?tenantId=${B}`, bearer(MEMBER_A))).status, 403);
  });
  it('the platform credential still reads the aggregates', async () => {
    assert.equal((await call('GET', '/app/api/overview', { 'x-admin-key': PLATFORM })).status, 200);
    assert.equal((await call('GET', '/app/api/tenants', { 'x-admin-key': PLATFORM })).status, 200);
  });
});

describe('AUD-FC-14: /invoices of another tenant', () => {
  it('a tenant cannot generate the invoice of another tenant; its own works', async () => {
    const x = await call('GET', `/v1/invoices?tenantId=${B}&epochId=0`, bearer(MEMBER_A));
    assert.equal(x.status, 403); assert.equal(x.json['invoice'], undefined);
    assert.equal((await call('GET', '/v1/invoices?epochId=0', bearer(MEMBER_A))).status, 200);
  });
});

describe('AUD-FC-15: /v1/reports/teams', () => {
  it('a tenant sees only the teams it owns', async () => {
    await getTeamStore().createTeam({ id: `team-a-${RUN}`, name: 'a', ownerId: A, createdAt: new Date().toISOString() });
    await getTeamStore().createTeam({ id: `team-b-${RUN}`, name: 'b', ownerId: B, createdAt: new Date().toISOString() });
    const r = await call('GET', '/v1/v1/reports/teams', bearer(MEMBER_A));
    assert.equal(r.status, 200);
    const teams = (r.json['teams'] as Array<{ teamId: string }>).map((t) => t.teamId);
    assert.ok(teams.includes(`team-a-${RUN}`)); assert.ok(!teams.includes(`team-b-${RUN}`), 'team of B not visible');
  });
});

describe('AUD-FC-16: global reconciliation report and run', () => {
  it('a tenant OWNER cannot read the global report nor trigger the platform-wide run', async () => {
    for (const [m, u] of [['GET', '/v1/v1/reconciliation/reports'], ['GET', '/v1/v1/reconciliation/reports/x'], ['POST', '/v1/v1/reconciliation/run']] as const) {
      const r = await call(m, u, bearer(OWNER_A));
      assert.equal(r.status, 403, u); assert.equal(r.json['error'], 'platform_operation_forbidden');
    }
  });
});
