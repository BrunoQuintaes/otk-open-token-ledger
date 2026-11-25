/**
 * RV-RUNS-01 (independent adversarial review of RUN-S, 2026-10-10; HIGH, fixed under the Gate B rule "HIGH found during
 * the run is fixed when it fits in one executor day"). Tenant roles (OPERATOR, ADMIN, OWNER; and /signup hands OWNER of
 * a new tenant to anyone) could run platform operations and read platform-wide aggregates: flush the global Merkle
 * batch (root, count and CU bucket of every tenant), read the global chain head, the full health report, the prover
 * status, the GA readiness report and the price table, refresh prices from external sources and write the evidence
 * index to disk; /admin/redis/reproject rebuilt the projection of any tenant, or of all with an empty filter (NF-27).
 * Now these are platform operations (x-admin-key); reproject is allowed to a tenant role only for its own tenant.
 * A0 (auth disabled) keeps the legacy admin-key path. Also covers RV-RUNS-07 (the platform key alone is enough on the
 * D4 and PF-NEW-02 routes) and RV-RUNS-14 (pending dead-letter count awaited in /admin/health/full).
 *
 * Module under test: `src/api/routes.ts` (who may call the platform operations), with the token registry
 * of `src/api/tenantKeyRegistry.ts` and tokens signed by `src/auth/jwt.ts`.
 *
 * Strategy / partitions: every platform operation called by a tenant OWNER and OPERATOR (403); the platform
 * key alone (200); a wrong platform key (401); reproject for another tenant, for every tenant and for the
 * caller's own tenant; reproject with a body that is not an object (400).
 *
 * Needs: no network and no database (the own-tenant reproject case expects the refusal caused by the missing
 * PostgreSQL). Sets `OTK_ADMIN_KEY` and `OTK_JWT_SECRET` for the run and restores them afterwards.
 *
 * Run just this file: `npx tsx --test test/unit/platform_ops_tenant.test.ts`
 *
 * @module test/unit/platform_ops_tenant.test
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerToken, clearRegistry, clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';
import { resetApiKeyMetadataStoreForTest } from '../../src/api/IApiKeyMetadataStore.js';
import { resetTokenStoreForTest } from '../../src/api/ITokenStore.js';
import { signToken } from '../../src/auth/jwt.js';
import { handleRequest } from '../../src/api/routes.js';

function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter(); let sent = false;
  em.on('newListener', (ev: string) => { if (ev === 'end' && !sent) { sent = true; setImmediate(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); }); } });
  return Object.assign(em, { method, url, headers: { 'content-type': 'application/json', ...headers }, destroy: () => {} }) as unknown as IncomingMessage;
}
async function call(method: string, url: string, headers: Record<string, string> = {}, body = '') {
  let code = 200; let out = '';
  const res = { setHeader() {}, writeHead(c: number) { code = c; return res; }, end(d?: string) { if (d) out += String(d); }, get statusCode() { return code; }, set statusCode(c: number) { code = c; } };
  await handleRequest(mockReq(method, url, body, headers), res as unknown as ServerResponse);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(out) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: code, json, body: out };
}
const RUN = Date.now().toString(36);
const A = `po-a-${RUN}`; const B = `po-b-${RUN}`;
const OWNER_A = `po-owner-a-${RUN}`; const OPERATOR_A = `po-op-a-${RUN}`;
const PLATFORM = `po-platform-${RUN}`;
const JWT_SECRET = `po-jwt-${RUN}-0123456789abcdef`;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const PLATFORM_OPS: Array<[string, string]> = [
  ['POST', '/admin/flush-batch'], ['GET', '/admin/chain-head'], ['GET', '/admin/prover/status'], ['GET', '/admin/health/full'],
  ['POST', '/admin/evidence/index'], ['GET', '/v1/v1/admin/prices'], ['POST', '/v1/v1/admin/prices/refresh'], ['GET', '/v1/v1/admin/ga-readiness'],
];
let origKey: string | undefined; let origJwt: string | undefined;
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
  registerToken(OWNER_A, A, 'OWNER'); registerToken(OPERATOR_A, A, 'OPERATOR');
});

describe('RV-RUNS-01: platform operations are not available to tenant roles', () => {
  for (const [m, u] of PLATFORM_OPS) {
    it(`${m} ${u}: OWNER and OPERATOR of a tenant get 403 platform_operation_forbidden`, async () => {
      for (const t of [OWNER_A, OPERATOR_A, signToken({ sub: A, role: 'OWNER' }, JWT_SECRET, 600)]) {
        const r = await call(m, u, bearer(t));
        assert.equal(r.status, 403, `${u} answered ${r.status}`);
        assert.equal(r.json['error'], 'platform_operation_forbidden');
      }
    });
  }
  it('the platform credential alone still reads the chain head and the full health report', async () => {
    assert.equal((await call('GET', '/admin/chain-head', { 'x-admin-key': PLATFORM })).status, 200);
    const h = await call('GET', '/admin/health/full', { 'x-admin-key': PLATFORM });
    assert.equal(h.status, 200);
    const dl = (h.json['components'] as Record<string, { pendingCount?: unknown }>)['deadLetterQueue'];
    assert.equal(typeof dl?.pendingCount, 'number', 'RV-RUNS-14: the pending count is a number, not a serialized Promise');
  });
});

describe('RV-RUNS-01 / NF-27: /admin/redis/reproject is scoped', () => {
  it('a tenant role cannot rebuild another tenant nor every tenant (empty filter)', async () => {
    assert.equal((await call('POST', '/admin/redis/reproject', bearer(OWNER_A), JSON.stringify({ tenantId: B }))).status, 403);
    assert.equal((await call('POST', '/admin/redis/reproject', bearer(OWNER_A), '')).status, 403);
    assert.equal((await call('POST', '/admin/redis/reproject', bearer(OWNER_A), JSON.stringify({}))).status, 403);
  });
  it('a tenant role may ask for its own tenant (refused only because this unit run has no PostgreSQL)', async () => {
    const r = await call('POST', '/admin/redis/reproject', bearer(OWNER_A), JSON.stringify({ tenantId: A }));
    assert.notEqual(r.status, 403);
  });
});

describe('RV-RUNS-07: the platform key alone is enough on the tenant-scoped admin routes', () => {
  for (const u of ['/admin/dead-letters', '/admin/tal-summary', '/v1/billing/cycles']) {
    it(`${u} with only x-admin-key: 200`, async () => {
      assert.equal((await call('GET', u, { 'x-admin-key': PLATFORM })).status, 200);
    });
  }
  it('a wrong platform key alone is still 401', async () => {
    assert.equal((await call('GET', '/admin/dead-letters', { 'x-admin-key': 'wrong' })).status, 401);
  });
});

describe('RV2-RUNS-04 (second review pass): reproject with a non-object body', () => {
  for (const body of ['null', '[]', '"x"', '42']) {
    it(`body ${body} is 400, not a 500 TypeError`, async () => {
      assert.equal((await call('POST', '/admin/redis/reproject', bearer(OWNER_A), body)).status, 400);
      assert.equal((await call('POST', '/admin/redis/reproject', { 'x-admin-key': PLATFORM }, body)).status, 400);
    });
  }
});
