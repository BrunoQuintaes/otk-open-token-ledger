/**
 * F-PF-SEC-01 / PF-NEW-02 (POST-FREEZE independent review, 2026-10-07). With auth enabled GET /billing/cycles returned
 * the billing cycle (plan, CU, USD, margin) of every tenant to any tenant role holding admin:billing. A tenant now sees
 * only its own cycle; the platform credential still sees all.
 * RUN-S 2026-10-09: the first block is the validated proposal (unchanged); the second block adds the credential origins
 * (key created by /keys, JWT, revoked key) and attempts to choose the tenant through the query string or headers.
 *
 * Modules under test: `handleRequest` in `src/api/routes.ts` for the billing cycles route, with
 * the token registry, the API key manager, `signToken` from `src/auth/jwt.ts`, the dashboard
 * indexer and `src/billing/BillingCycleWorker.ts` used to create credentials and cycles.
 *
 * Strategy / partitions: OWNER of tenant A and of tenant B (each sees only its own cycle); a
 * MEMBER (refused) and no credential (401); the platform key (sees all) and a wrong platform key;
 * an ADMIN API key, an OWNER JWT and a revoked key; a tenant id in the query string or in
 * headers (ignored); a tenant with no cycles (empty list); no amount of another tenant in the
 * response.
 *
 * Needs: no server (mock request/response objects). Sets `OTK_ADMIN_KEY` and `OTK_JWT_SECRET`
 * to per-run test values in `before` and restores the previous values in `after`; stores and
 * indexer are reset before every test.
 *
 * Run just this file: `npx tsx --test test/unit/billing_cycles_tenant.test.ts`
 *
 * @module test/unit/billing_cycles_tenant.test
 */
import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerToken, clearRegistry, clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';
import { createApiKey, revokeApiKey } from '../../src/api/apiKeyManager.js';
import { resetApiKeyMetadataStoreForTest } from '../../src/api/IApiKeyMetadataStore.js';
import { resetTokenStoreForTest } from '../../src/api/ITokenStore.js';
import { signToken } from '../../src/auth/jwt.js';
import { handleRequest } from '../../src/api/routes.js';
import { getIndexer, resetIndexerForTest } from '../../src/dashboard/indexer.js';
import { resetCycles } from '../../src/billing/BillingCycleWorker.js';

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
const A = `bc-a-${RUN}`; const B = `bc-b-${RUN}`; const C = `bc-c-${RUN}`;
const OWNER_A = `bc-owner-a-${RUN}`; const MEMBER_A = `bc-member-a-${RUN}`; const OWNER_B = `bc-owner-b-${RUN}`;
const OWNER_C = `bc-owner-c-${RUN}`;
const PLATFORM = `bc-platform-${RUN}`;
const JWT_SECRET = `bc-jwt-secret-${RUN}-0123456789abcdef`;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const tenantsOf = (j: Record<string, unknown>) => (j['cycles'] as Array<{ tenantId: string }>).map((c) => c.tenantId);
let origKey: string | undefined;
let origJwt: string | undefined;

before(() => {
  origKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  origJwt = process.env['OTK_JWT_SECRET']; process.env['OTK_JWT_SECRET'] = JWT_SECRET;
});
after(() => {
  if (origKey === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origKey;
  if (origJwt === undefined) delete process.env['OTK_JWT_SECRET']; else process.env['OTK_JWT_SECRET'] = origJwt;
});
beforeEach(() => {
  clearRegistry(); clearHashRegistryForTest(); resetApiKeyMetadataStoreForTest(); resetTokenStoreForTest();
  registerToken(OWNER_A, A, 'OWNER'); registerToken(MEMBER_A, A, 'MEMBER'); registerToken(OWNER_B, B, 'OWNER');
  registerToken(OWNER_C, C, 'OWNER');
  resetIndexerForTest();
  const base = { provider: 'openai', model: 'gpt-4o-mini', inputTokens: 10, outputTokens: 2, costUnits: 5, latencyMs: 1, timestamp: Date.now() };
  getIndexer().index({ ...base, requestId: `ra-${RUN}`, tenantId: A });
  getIndexer().index({ ...base, requestId: `rb-${RUN}`, tenantId: B });
  resetCycles();
});

describe('F-PF-SEC-01: /billing/cycles is scoped to the caller tenant', () => {
  it('OWNER of A sees only the cycle of A, never the cycle of B', async () => {
    const r = await call('GET', '/v1/billing/cycles', bearer(OWNER_A));
    assert.equal(r.status, 200);
    assert.deepEqual(tenantsOf(r.json), [A]);
  });
  it('OWNER of B sees only the cycle of B', async () => {
    const r = await call('GET', '/v1/billing/cycles', bearer(OWNER_B));
    assert.equal(r.status, 200);
    assert.deepEqual(tenantsOf(r.json), [B]);
  });
  it('MEMBER (no admin:billing) is refused and no credential is 401', async () => {
    assert.equal((await call('GET', '/v1/billing/cycles', bearer(MEMBER_A))).status, 403);
    assert.equal((await call('GET', '/v1/billing/cycles')).status, 401);
  });
  it('the platform credential still sees every tenant', async () => {
    const r = await call('GET', '/v1/billing/cycles', { ...bearer(OWNER_A), 'x-admin-key': PLATFORM });
    assert.equal(r.status, 200);
    const t = tenantsOf(r.json);
    assert.ok(t.includes(A) && t.includes(B));
  });
  it('a wrong platform credential gives no platform view', async () => {
    const r = await call('GET', '/v1/billing/cycles', { ...bearer(OWNER_A), 'x-admin-key': 'wrong' });
    assert.equal(r.status, 200);
    assert.deepEqual(tenantsOf(r.json), [A]);
  });
});

describe('PF-NEW-02 (RUN-S): other credential origins and tenant chosen by the client', () => {
  it('ADMIN key created by POST /keys logic sees only its own tenant', async () => {
    const k = await createApiKey(A, 'a-admin', 'ADMIN');
    const r = await call('GET', '/v1/billing/cycles', bearer(k.rawKey));
    assert.equal(r.status, 200);
    assert.deepEqual(tenantsOf(r.json), [A]);
  });
  it('OWNER JWT of B sees only the cycle of B', async () => {
    const jwt = signToken({ sub: B, role: 'OWNER' }, JWT_SECRET, 600);
    const r = await call('GET', '/v1/billing/cycles', bearer(jwt));
    assert.equal(r.status, 200);
    assert.deepEqual(tenantsOf(r.json), [B]);
  });
  it('a revoked key is 401 and returns no cycle', async () => {
    const k = await createApiKey(A, 'a-revoked', 'OWNER');
    await revokeApiKey(k.keyId);
    const r = await call('GET', '/v1/billing/cycles', bearer(k.rawKey));
    assert.equal(r.status, 401);
    assert.equal(r.json['cycles'], undefined);
  });
  it('tenantId in the query string does not select another tenant', async () => {
    for (const q of [`?tenantId=${B}`, `?tenant=${B}`, `?tenantId=${B}&tenantId=${A}`]) {
      const r = await call('GET', `/v1/billing/cycles${q}`, bearer(OWNER_A));
      assert.equal(r.status, 200);
      assert.deepEqual(tenantsOf(r.json), [A], `query ${q}`);
    }
  });
  it('tenant headers do not select another tenant', async () => {
    const r = await call('GET', '/v1/billing/cycles', { ...bearer(OWNER_A), 'x-tenant-id': B, 'x-otk-tenant': B, 'x-otk-team-id': B });
    assert.equal(r.status, 200);
    assert.deepEqual(tenantsOf(r.json), [A]);
  });
  it('a tenant without cycles receives an empty list, never the others', async () => {
    const r = await call('GET', '/v1/billing/cycles', bearer(OWNER_C));
    assert.equal(r.status, 200);
    assert.deepEqual(tenantsOf(r.json), []);
    assert.ok(!r.body.includes(A) && !r.body.includes(B), 'no other tenant id in the body');
  });
  it('the response of A carries no amount of B (aggregates are per tenant)', async () => {
    const all = await call('GET', '/v1/billing/cycles', { ...bearer(OWNER_A), 'x-admin-key': PLATFORM });
    const cycleB = (all.json['cycles'] as Array<Record<string, unknown>>).find((c) => c['tenantId'] === B);
    assert.ok(cycleB, 'platform view has B');
    const r = await call('GET', '/v1/billing/cycles', bearer(OWNER_A));
    assert.equal((r.json['cycles'] as unknown[]).length, 1);
    assert.ok(!r.body.includes(B));
  });
});
