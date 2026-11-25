/**
 * AUD-FC-05 (FINAL CLOSURE re-audit, 2026-10-07): API keys addressed by id belong to one tenant. A tenant OWNER must
 * not read, revoke or rotate another tenant's key (rotation would hand over a live token of the other tenant). A key
 * of another tenant is answered like a key that does not exist (404). The caller's own keys keep working.
 *
 * Modules under test: `handleRequest` in `src/api/routes.ts` for the key-by-id routes, with
 * `src/api/apiKeyManager.ts` to create keys and `src/api/tenantKeyRegistry.ts` to check that a
 * key still resolves.
 *
 * Strategy / partitions: an OWNER of tenant A reading, revoking and rotating a key of tenant B
 * (404, key unchanged, no token returned); a missing key id vs a key of another tenant (same
 * answer); the same three operations on the caller's own key (allowed).
 *
 * Needs: nothing external. Uses the in-memory key metadata and token stores, reset before every
 * test; tenant ids get a per-run suffix so they never collide with other files.
 *
 * Run just this file: `npx tsx --test test/unit/api_key_cross_tenant.test.ts`
 *
 * @module test/unit/api_key_cross_tenant.test
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createApiKey, getApiKey } from '../../src/api/apiKeyManager.js';
import { resetApiKeyMetadataStoreForTest } from '../../src/api/IApiKeyMetadataStore.js';
import { resetTokenStoreForTest } from '../../src/api/ITokenStore.js';
import { clearRegistry, clearHashRegistryForTest, registerToken, resolveTokenContext } from '../../src/api/tenantKeyRegistry.js';
import { handleRequest } from '../../src/api/routes.js';

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
async function call(method: string, url: string, token: string) {
  const res = mockRes();
  await handleRequest(mockReq(method, url, { authorization: `Bearer ${token}` }), res);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(res.body) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.statusCode, json };
}
const RUN = Date.now().toString(36);
const A = `key-ten-a-${RUN}`; const B = `key-ten-b-${RUN}`;
const OWNER_A = `owner-a-keys-${RUN}`;

beforeEach(() => {
  resetApiKeyMetadataStoreForTest(); resetTokenStoreForTest(); clearRegistry(); clearHashRegistryForTest();
  registerToken(OWNER_A, A, 'OWNER');
});

describe('AUD-FC-05: /keys/:id is tenant-scoped', () => {
  it('OWNER of A cannot read a key of B (404, like a missing key)', async () => {
    const kb = await createApiKey(B, 'b-key', 'OWNER');
    const r = await call('GET', `/v1/keys/${encodeURIComponent(kb.keyId)}`, OWNER_A);
    assert.equal(r.status, 404);
    assert.equal(r.json['key'], undefined);
  });
  it('OWNER of A cannot revoke a key of B; the key keeps working', async () => {
    const kb = await createApiKey(B, 'b-key', 'OWNER');
    const r = await call('DELETE', `/v1/keys/${encodeURIComponent(kb.keyId)}`, OWNER_A);
    assert.equal(r.status, 404);
    assert.equal((await getApiKey(kb.keyId))?.revokedAt ?? null, null, 'B key not revoked');
  });
  it('OWNER of A cannot rotate a key of B and receives no token', async () => {
    const kb = await createApiKey(B, 'b-key', 'OWNER');
    const r = await call('POST', `/v1/keys/${encodeURIComponent(kb.keyId)}/rotate`, OWNER_A);
    assert.equal(r.status, 404);
    assert.equal(r.json['key'], undefined, 'no new raw key handed over');
    assert.equal((await getApiKey(kb.keyId))?.revokedAt ?? null, null, 'B key not revoked by a rotation');
  });
  it('a key id that does not exist and a key of another tenant give the same answer', async () => {
    const kb = await createApiKey(B, 'b-key', 'OWNER');
    const foreign = await call('GET', `/v1/keys/${encodeURIComponent(kb.keyId)}`, OWNER_A);
    const missing = await call('GET', `/v1/keys/no-such-key-${RUN}`, OWNER_A);
    assert.equal(foreign.status, missing.status);
    assert.deepEqual(foreign.json, missing.json);
  });
  it('OWNER of A still reads, rotates and revokes its own key', async () => {
    const ka = await createApiKey(A, 'a-key', 'OWNER');
    assert.equal((await call('GET', `/v1/keys/${encodeURIComponent(ka.keyId)}`, OWNER_A)).status, 200);
    const rot = await call('POST', `/v1/keys/${encodeURIComponent(ka.keyId)}/rotate`, OWNER_A);
    assert.equal(rot.status, 200);
    const newId = (rot.json['key'] as { keyId: string }).keyId;
    assert.equal((await call('DELETE', `/v1/keys/${encodeURIComponent(newId)}`, OWNER_A)).status, 200);
    assert.equal(resolveTokenContext(OWNER_A)?.tenantId, A);
  });
});
