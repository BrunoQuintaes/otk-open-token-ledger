/**
 * PF-NEW-05 and NF-21 (RUN-S 2026-10-09, Gate S-04/S-05; prompt §10: data exposure is fixed, unsafe use is blocked).
 * GET /events/latest answered anyone, without a credential, with the dispatcher events of every tenant (key_created,
 * key_revoked, key_rotated, usage_metered: tenant ids, key ids, labels, roles). GET /flags/evaluate evaluated the flags
 * of any tenantId given in the query, also without a credential. With authentication enabled both now need a
 * credential and are scoped to the caller tenant; the platform credential sees all. The auth-disabled development
 * mode (A0) is unchanged (the historical devex/event tests run there and are not modified).
 *
 * Modules under test: `handleRequest` in `src/api/routes.ts` for the latest-events and flag
 * evaluation routes, with events seeded through `src/publisher/runtime.ts` and credentials from
 * the token registry and the API key manager.
 *
 * Strategy / partitions: latest events with no credential (401), as a VIEWER of tenant A (only
 * A's events) and with the platform key (all); flag evaluation with no credential (401), for
 * another tenant (403) and for the own tenant given explicitly or implicitly; key lifecycle
 * events hidden from a VIEWER and shown to an OWNER of the same tenant.
 *
 * Needs: no server (mock request/response objects). Sets `OTK_ADMIN_KEY` in `before` and
 * restores the previous value in `after`; stores and dispatcher are reset before every test.
 *
 * Run just this file: `npx tsx --test test/unit/events_flags_tenant.test.ts`
 *
 * @module test/unit/events_flags_tenant.test
 */
import { describe, it, beforeEach, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerToken, clearRegistry, clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';
import { createApiKey } from '../../src/api/apiKeyManager.js';
import { resetApiKeyMetadataStoreForTest } from '../../src/api/IApiKeyMetadataStore.js';
import { resetTokenStoreForTest } from '../../src/api/ITokenStore.js';
import { handleRequest } from '../../src/api/routes.js';
import { getDispatcher } from '../../src/publisher/runtime.js';
import { buildEnvelope } from '../../src/publisher/deliveryTypes.js';

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
async function call(url: string, headers: Record<string, string> = {}) {
  const res = mockRes();
  await handleRequest(mockReq('GET', url, headers), res);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(res.body) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.statusCode, json, body: res.body };
}
const RUN = Date.now().toString(36);
const A = `ev-a-${RUN}`; const B = `ev-b-${RUN}`;
const VIEWER_A = `ev-viewer-a-${RUN}`; const PLATFORM = `ev-platform-${RUN}`;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
let origKey: string | undefined;
before(() => { origKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM; });
after(() => { if (origKey === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origKey; });
beforeEach(async () => {
  clearRegistry(); clearHashRegistryForTest(); resetApiKeyMetadataStoreForTest(); resetTokenStoreForTest();
  registerToken(VIEWER_A, A, 'VIEWER');
  await createApiKey(B, `label-of-b-${RUN}`, 'OWNER');
  getDispatcher().emit(buildEnvelope('usage_metered', 'test', { tenantId: A, requestId: `req-a-${RUN}` }));
});

describe('PF-NEW-05: /events/latest needs a credential and is scoped to the caller tenant', () => {
  it('without a credential: 401 and no event', async () => {
    const r = await call('/events/latest?n=100');
    assert.equal(r.status, 401);
    assert.equal(r.json['events'], undefined);
  });
  it('a VIEWER of A sees events of A and none of B (no tenant id, key id or label of B)', async () => {
    const r = await call('/events/latest?n=100', bearer(VIEWER_A));
    assert.equal(r.status, 200);
    const evs = r.json['events'] as Array<{ payload: { tenantId?: string } }>;
    assert.ok(evs.some((e) => e.payload.tenantId === A));
    assert.ok(evs.every((e) => e.payload.tenantId === A));
    assert.ok(!r.body.includes(B) && !r.body.includes(`label-of-b-${RUN}`));
  });
  it('the platform credential still sees every tenant', async () => {
    const r = await call('/events/latest?n=100', { 'x-admin-key': PLATFORM });
    assert.equal(r.status, 200);
    assert.ok(r.body.includes(B) && r.body.includes(A));
  });
});

describe('NF-21: /flags/evaluate needs a credential and does not evaluate another tenant', () => {
  it('without a credential: 401', async () => {
    assert.equal((await call(`/flags/evaluate?key=any&tenantId=${B}`)).status, 401);
  });
  it('a tenant asking for the flags of another tenant: 403', async () => {
    assert.equal((await call(`/flags/evaluate?key=any&tenantId=${B}`, bearer(VIEWER_A))).status, 403);
  });
  it('a tenant evaluates its own flags (explicit or implicit tenant)', async () => {
    assert.equal((await call(`/flags/evaluate?key=any&tenantId=${A}`, bearer(VIEWER_A))).status, 200);
    assert.equal((await call('/flags/evaluate?key=any', bearer(VIEWER_A))).status, 200);
  });
});

describe('RV-RUNS-09 (adversarial review): key events need admin:keys', () => {
  it('a VIEWER of A does not receive key_created/key_revoked/key_rotated events, even of its own tenant', async () => {
    await createApiKey(A, `label-of-a-${RUN}`, 'VIEWER');
    const r = await call('/events/latest?n=100', bearer(VIEWER_A));
    assert.equal(r.status, 200);
    const kinds = (r.json['events'] as Array<{ eventKind: string }>).map((e) => e.eventKind);
    assert.ok(kinds.length > 0, 'usage events still visible');
    assert.ok(kinds.every((k) => !k.startsWith('key_')), kinds.join(','));
    assert.ok(!r.body.includes(`label-of-a-${RUN}`));
  });
  it('an OWNER of A (admin:keys) still sees the key events of its tenant', async () => {
    const OWNER_A = `ev-owner-a-${RUN}`; registerToken(OWNER_A, A, 'OWNER');
    await createApiKey(A, `label-of-a2-${RUN}`, 'VIEWER');
    const r = await call('/events/latest?n=100', bearer(OWNER_A));
    assert.ok((r.json['events'] as Array<{ eventKind: string }>).some((e) => e.eventKind === 'key_created'));
  });
});
