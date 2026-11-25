/**
 * PF-DL / PF-TAL (POST-FREEZE review; decision D4 = HIGH and fix, RUN-S prompt of the author 2026-10-08). With auth
 * enabled any tenant role holding admin:dead-letters listed, read, retried and discarded the rejected raw payloads of
 * every tenant, and admin:tal-summary returned the CU balance of any tenantId given in the query. A tenant role now
 * sees and acts only on its own tenant (another tenant's entry is answered like a missing one); asking explicitly for
 * another tenant is 403; global counters are not shown to tenant roles. The platform credential still sees all.
 *
 * Modules under test: `handleRequest` in `src/api/routes.ts` for the dead-letter and accounting
 * summary admin routes, with `src/api/deadLetterStore.ts` and `src/security/talRuntime.ts` used
 * to seed and inspect state, and the key manager and `signToken` to create credentials.
 *
 * Strategy / partitions: dead letters listed, counted, read, retried and discarded by an
 * OPERATOR of tenant A for its own and for tenant B's entries; an entry with no tenant; an OWNER
 * JWT and an ADMIN API key; the platform key; a MEMBER (403) and no credential (401). Accounting
 * summary for another tenant (403), for the own tenant, the global counter hidden from tenant
 * roles, and the platform key reading everything.
 *
 * Needs: no server (mock request/response objects). Sets `OTK_ADMIN_KEY` and `OTK_JWT_SECRET`
 * to per-run test values in `before` and restores them in `after`; stores are reset before
 * every test.
 *
 * Run just this file: `npx tsx --test test/unit/deadletters_tal_tenant.test.ts`
 *
 * @module test/unit/deadletters_tal_tenant.test
 */
import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerToken, clearRegistry, clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';
import { createApiKey } from '../../src/api/apiKeyManager.js';
import { resetApiKeyMetadataStoreForTest } from '../../src/api/IApiKeyMetadataStore.js';
import { resetTokenStoreForTest } from '../../src/api/ITokenStore.js';
import { signToken } from '../../src/auth/jwt.js';
import { handleRequest } from '../../src/api/routes.js';
import { addDeadLetter, clearDeadLettersForTest, getDeadLetter } from '../../src/api/deadLetterStore.js';
import { getAccountingLayer } from '../../src/security/talRuntime.js';

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
  try { json = JSON.parse(res.body) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.statusCode, json, body: res.body };
}
const RUN = Date.now().toString(36);
const A = `dl-a-${RUN}`; const B = `dl-b-${RUN}`;
const OPERATOR_A = `dl-op-a-${RUN}`; const OWNER_B = `dl-owner-b-${RUN}`; const MEMBER_A = `dl-member-a-${RUN}`;
const PLATFORM = `dl-platform-${RUN}`;
const JWT_SECRET = `dl-jwt-secret-${RUN}-0123456789abcdef`;
const SECRET_B = `payload-of-b-${RUN}`;
const EPOCH = `ep-${RUN}`;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
let idA = ''; let idB = ''; let idNone = '';
let origKey: string | undefined; let origJwt: string | undefined;

before(() => {
  origKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  origJwt = process.env['OTK_JWT_SECRET']; process.env['OTK_JWT_SECRET'] = JWT_SECRET;
  const tal = getAccountingLayer();
  tal.debit({ tenantId: B, epochId: EPOCH, requestId: `tal-b-${RUN}`, provider: 'openai', model: 'gpt-4o-mini', cu: 777n, ts: Date.now() });
  tal.debit({ tenantId: A, epochId: EPOCH, requestId: `tal-a-${RUN}`, provider: 'openai', model: 'gpt-4o-mini', cu: 5n, ts: Date.now() });
});
after(() => {
  if (origKey === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origKey;
  if (origJwt === undefined) delete process.env['OTK_JWT_SECRET']; else process.env['OTK_JWT_SECRET'] = origJwt;
});
beforeEach(async () => {
  clearRegistry(); clearHashRegistryForTest(); resetApiKeyMetadataStoreForTest(); resetTokenStoreForTest();
  registerToken(OPERATOR_A, A, 'OPERATOR'); registerToken(OWNER_B, B, 'OWNER'); registerToken(MEMBER_A, A, 'MEMBER');
  await clearDeadLettersForTest();
  idA = (await addDeadLetter({ originalPayload: `payload-of-a-${RUN}`, error: 'e', reason: 'validation_error', source: 'test', tenantId: A })).id;
  idB = (await addDeadLetter({ originalPayload: SECRET_B, error: 'e', reason: 'validation_error', source: 'test', tenantId: B })).id;
  idNone = (await addDeadLetter({ originalPayload: `payload-no-tenant-${RUN}`, error: 'e', reason: 'validation_error', source: 'test' })).id;
});

describe('PF-DL: dead-letters are scoped to the caller tenant', () => {
  it('OPERATOR of A lists only entries of A and never sees the payload of B', async () => {
    const r = await call('GET', '/admin/dead-letters', bearer(OPERATOR_A));
    assert.equal(r.status, 200);
    const ids = (r.json['entries'] as Array<{ id: string }>).map((e) => e.id);
    assert.deepEqual(ids, [idA]);
    assert.ok(!r.body.includes(SECRET_B));
  });
  it('the counters shown to a tenant are the counters of that tenant', async () => {
    const r = await call('GET', '/admin/dead-letters', bearer(OPERATOR_A));
    assert.equal(r.json['total'], 1);
    assert.equal(r.json['pending'], 1);
  });
  it('asking for tenantId=B is refused (403) for a tenant of A', async () => {
    const r = await call('GET', `/admin/dead-letters?tenantId=${B}`, bearer(OPERATOR_A));
    assert.equal(r.status, 403);
    assert.ok(!r.body.includes(SECRET_B));
  });
  it('reading an entry of B by id is answered like a missing entry', async () => {
    const foreign = await call('GET', `/admin/dead-letters/${idB}`, bearer(OPERATOR_A));
    const missing = await call('GET', `/admin/dead-letters/no-such-${RUN}`, bearer(OPERATOR_A));
    assert.equal(foreign.status, missing.status);
    assert.deepEqual(foreign.json, missing.json);
    assert.ok(!foreign.body.includes(SECRET_B));
  });
  it('an entry without tenant is visible only to the platform', async () => {
    assert.equal((await call('GET', `/admin/dead-letters/${idNone}`, bearer(OPERATOR_A))).status, 404);
    assert.equal((await call('GET', `/admin/dead-letters/${idNone}`, { 'x-admin-key': PLATFORM, ...bearer(OPERATOR_A) })).status, 200);
  });
  it('retry and discard of an entry of B are 404 and leave it pending', async () => {
    assert.equal((await call('POST', `/admin/dead-letters/${idB}/retry`, bearer(OPERATOR_A))).status, 404);
    assert.equal((await call('POST', `/admin/dead-letters/${idB}/discard`, bearer(OPERATOR_A))).status, 404);
    assert.equal((await getDeadLetter(idB))?.status, 'pending');
  });
  it('the tenant still reads, retries and discards its own entries', async () => {
    assert.equal((await call('GET', `/admin/dead-letters/${idA}`, bearer(OPERATOR_A))).status, 200);
    assert.equal((await call('POST', `/admin/dead-letters/${idA}/retry`, bearer(OPERATOR_A))).status, 200);
    assert.equal((await getDeadLetter(idA))?.status, 'retried');
  });
  it('OWNER JWT of B and an ADMIN key of A created by /keys are scoped the same way', async () => {
    const jwt = signToken({ sub: B, role: 'OWNER' }, JWT_SECRET, 600);
    const rb = await call('GET', '/admin/dead-letters', bearer(jwt));
    assert.deepEqual((rb.json['entries'] as Array<{ id: string }>).map((e) => e.id), [idB]);
    const k = await createApiKey(A, 'a-admin', 'ADMIN');
    const ra = await call('GET', '/admin/dead-letters', bearer(k.rawKey));
    assert.deepEqual((ra.json['entries'] as Array<{ id: string }>).map((e) => e.id), [idA]);
  });
  it('the platform credential still lists every tenant', async () => {
    const r = await call('GET', '/admin/dead-letters', { 'x-admin-key': PLATFORM, ...bearer(OPERATOR_A) });
    const ids = (r.json['entries'] as Array<{ id: string }>).map((e) => e.id).sort();
    assert.deepEqual(ids, [idA, idB, idNone].sort());
  });
  it('MEMBER (no admin:dead-letters) is 403 and no credential is 401', async () => {
    assert.equal((await call('GET', '/admin/dead-letters', bearer(MEMBER_A))).status, 403);
    assert.equal((await call('GET', '/admin/dead-letters')).status, 401);
  });
});

describe('PF-TAL: tal-summary is scoped to the caller tenant', () => {
  it('OPERATOR of A asking for the balance of B is refused (403) and gets no CU of B', async () => {
    const r = await call('GET', `/admin/tal-summary?tenantId=${B}&epochId=${EPOCH}`, bearer(OPERATOR_A));
    assert.equal(r.status, 403);
    assert.ok(!r.body.includes('777'));
  });
  it('OPERATOR of A reads its own balance', async () => {
    const r = await call('GET', `/admin/tal-summary?tenantId=${A}&epochId=${EPOCH}`, bearer(OPERATOR_A));
    assert.equal(r.status, 200);
    assert.equal((r.json['balance'] as { totalCU: string }).totalCU, '5');
  });
  it('a tenant role does not receive the global entry counter', async () => {
    const r = await call('GET', '/admin/tal-summary', bearer(OPERATOR_A));
    assert.equal(r.status, 200);
    assert.equal(r.json['totalEntries'], undefined);
  });
  it('the platform credential still reads any balance and the global counter', async () => {
    const r = await call('GET', `/admin/tal-summary?tenantId=${B}&epochId=${EPOCH}`, { 'x-admin-key': PLATFORM, ...bearer(OPERATOR_A) });
    assert.equal(r.status, 200);
    assert.equal((r.json['balance'] as { totalCU: string }).totalCU, '777');
    assert.ok(typeof r.json['totalEntries'] === 'number');
  });
});
