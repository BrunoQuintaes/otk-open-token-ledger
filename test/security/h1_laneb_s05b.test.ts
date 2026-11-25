/**
 * H1 lane B — S05 residual (SEC02-N04): API keys minted by a user are revoked when the user is deprovisioned.
 *   - a key minted with a user JWT records its author (`createdBy`); keys minted with a registry token or a dynamic key
 *     have no author (null) and are NOT guessed: deprovisioning leaves them alone and lists them
 *     (listUnattributedApiKeys) so an operator can review them;
 *   - SCIM DELETE (and PUT active=false) revokes the user's keys durably (metadata revokedAt) and the auth path refuses a
 *     key whose author is deprovisioned or was deprovisioned after the key was minted, also on a replica whose hash
 *     registry still holds the key (simulated by updating only the subject status), and also after re-provisioning;
 *   - a rotation by a user makes that user the author of the new key;
 *   - user store failure on the key-minting routes → 503, no key (fail closed);
 *   - role change: a registry token downgraded by the platform loses the permission at once (control).
 * In-memory stores only; no network.
 *
 * Also covered: a key minted or rotated with a user's key inherits that user as author (no laundering through a
 * second key), and a SCIM PATCH that sets the user inactive deprovisions like DELETE (unknown operations → 400).
 *
 * Modules under test: the route handlers of `src/api/routes.ts` called in process, with `src/api/apiKeyManager.ts`,
 * `src/auth/subjectStatus.ts`, `src/auth/jwt.ts`, `src/auth/emailVerification.ts`, `src/api/tenantKeyRegistry.ts`,
 * `src/api/tenantCrud.ts` and the memory key metadata, token and user stores.
 *
 * Needs: nothing external. Before importing it empties `OTK_RECEIPT_LOG`, `OTK_DB_URL` and `OTK_TENANT_LOG`, sets
 * `PROVER_URL=disabled` and removes `OTK_REDIS_URL` and `OTK_TENANTS`; `OTK_ADMIN_KEY`, `OTK_JWT_SECRET` and
 * `OTK_SCIM_BEARER_TOKEN` get fixture values and are restored after the run.
 *
 * Run just this file: `npx tsx --test test/security/h1_laneb_s05b.test.ts`
 *
 * @module test/security/h1_laneb_s05b.test
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];

/* eslint-disable @typescript-eslint/no-explicit-any */
const RUN = Date.now().toString(36);
const PLATFORM = `lb-s05-platform-${RUN}-0123456789abcdef`;
const JWT_SECRET = `lb-s05-jwt-${RUN}-0123456789abcdef0123456789`;
const SCIM_TOKEN = `lb-s05-scim-${RUN}-0123456789abcdef`;
const platform = { 'x-admin-key': PLATFORM };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const j = (o: unknown) => JSON.stringify(o);

let routes: any; let registry: any; let jwt: any; let status: any; let ev: any; let tenantCrud: any; let keys: any; let users: any;

function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter(); let sent = false;
  em.on('newListener', (e: string) => { if (e === 'end' && !sent) { sent = true; setImmediate(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); }); } });
  return Object.assign(em, { method, url, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' }, destroy: () => {} }) as unknown as IncomingMessage;
}
class MockRes extends EventEmitter {
  statusCode = 200; body = ''; headersSent = false; hdrs: Record<string, unknown> = {};
  setHeader(k: string, v: unknown) { this.hdrs[k.toLowerCase()] = v; }
  getHeader(k: string) { return this.hdrs[k.toLowerCase()]; }
  removeHeader() { /* noop */ }
  writeHead(c: number, h?: unknown) { this.statusCode = c; if (h && typeof h === 'object') Object.assign(this.hdrs, h); this.headersSent = true; return this; }
  flushHeaders() { /* noop */ }
  write(d: unknown) { this.body += String(d); return true; }
  end(d?: unknown) { if (d !== undefined && d !== null) this.body += String(d); this.headersSent = true; this.emit('finish'); return this; }
}
async function call(method: string, url: string, headers: Record<string, string> = {}, body = ''): Promise<{ status: number; body: string; json: any }> {
  const res = new MockRes();
  await routes.handleRequest(mockReq(method, url, body, headers), res as unknown as ServerResponse);
  let json: any; try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.statusCode, body: res.body, json };
}
/**
 * signup + verified e-mail: the JWT can mint keys
 *
 * @param tag - Short label that makes the e-mail and organization unique within the run.
 * @returns The new user's id, organization id and signup JWT.
 */
async function verifiedUser(tag: string) {
  const email = `lb-s05-${tag}-${RUN}@example.invalid`; const password = `lb-s05-pass-${tag}-${RUN}`;
  const s = await call('POST', '/signup', {}, j({ email, password, name: 'S05b synthetic', orgName: `lb s05 ${tag} ${RUN}` }));
  assert.equal(s.status, 201, s.body);
  assert.equal((await call('POST', '/verify-email', {}, j({ token: ev.generateVerificationToken(s.json.userId) }))).status, 200);
  return { userId: s.json.userId as string, orgId: s.json.orgId as string, token: s.json.token as string };
}
async function mint(cred: string, label: string) {
  const r = await call('POST', '/keys', bearer(cred), j({ label, role: 'OWNER' }));
  assert.equal(r.status, 201, r.body);
  return r.json.key as { keyId: string; rawKey: string };
}

const saved: Record<string, string | undefined> = {};
before(async () => {
  for (const k of ['OTK_ADMIN_KEY', 'OTK_JWT_SECRET', 'OTK_SCIM_BEARER_TOKEN']) saved[k] = process.env[k];
  process.env['OTK_ADMIN_KEY'] = PLATFORM; process.env['OTK_JWT_SECRET'] = JWT_SECRET; process.env['OTK_SCIM_BEARER_TOKEN'] = SCIM_TOKEN;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  jwt = await import('../../src/auth/jwt.js');
  status = await import('../../src/auth/subjectStatus.js');
  ev = await import('../../src/auth/emailVerification.js');
  tenantCrud = await import('../../src/api/tenantCrud.js');
  keys = await import('../../src/api/apiKeyManager.js');
  users = await import('../../src/users/IUserStore.js');
  const { MemoryUserStore } = await import('../../src/users/MemoryUserStore.js');
  const metaStore = await import('../../src/api/IApiKeyMetadataStore.js');
  const tokenStore = await import('../../src/api/ITokenStore.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest(); metaStore.resetApiKeyMetadataStoreForTest(); tokenStore.resetTokenStoreForTest();
  tenantCrud.clearTenantsForTest(); jwt.clearBlacklistForTest(); status.clearUserStatusForTest(); users.setUserStore(new MemoryUserStore());
});
after(() => {
  registry.clearRegistry(); registry.clearHashRegistryForTest(); status.clearUserStatusForTest(); users.resetUserStoreForTest();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('S05b keys minted by a user follow the user lifecycle', () => {
  it('SCIM DELETE revokes the keys the user minted; registry-token keys of the same org and keys of other users stay (not guessed)', async () => {
    const u = await verifiedUser('del'); const v = await verifiedUser('other');
    const orgToken = `lb-s05-org-token-${RUN}-${Math.random().toString(36).slice(2)}9f3c`;
    registry.registerToken(orgToken, u.orgId, 'OWNER');
    const k1 = await mint(u.token, 'by-user');
    const k0 = await mint(orgToken, 'by-registry-token');
    const k2 = await mint(v.token, 'by-other-user');
    const listed = await call('GET', '/keys', bearer(orgToken));
    const byId = new Map<string, any>(listed.json.keys.map((k: any) => [k.keyId, k]));
    assert.equal(byId.get(k1.keyId)?.createdBy, u.userId, 'author recorded');
    assert.equal(byId.get(k0.keyId)?.createdBy ?? null, null, 'no author for a registry-token key');
    for (const k of [k1, k0, k2]) assert.equal((await call('GET', '/keys', bearer(k.rawKey))).status, 200, 'control before');

    assert.equal((await call('DELETE', `/scim/v2/Users/${u.userId}`, bearer(SCIM_TOKEN))).status, 204);
    assert.equal((await call('GET', '/keys', bearer(k1.rawKey))).status, 401, 'key minted by the deprovisioned user');
    assert.ok((await keys.getApiKey(k1.keyId))?.revokedAt, 'revoked durably in the metadata store');
    assert.equal((await call('GET', '/keys', bearer(k0.rawKey))).status, 200, 'unattributed key is not guessed');
    assert.equal((await call('GET', '/keys', bearer(k2.rawKey))).status, 200, 'other user unaffected');
    const unattributed = await keys.listUnattributedApiKeys(u.orgId);
    assert.deepEqual(unattributed.map((k: any) => k.keyId), [k0.keyId], 'unattributed keys are listed for review');
  });

  it('another replica (hash registry still holds the key, only the subject status changed) refuses the key; re-provisioning does not restore it', async () => {
    const u = await verifiedUser('replica');
    const k = await mint(u.token, 'replica');
    assert.equal((await call('GET', '/keys', bearer(k.rawKey))).status, 200, 'control before');
    status.markUserDeprovisioned(u.userId, Date.now() + 1000); // propagated status; metadata/registry untouched
    assert.equal((await call('GET', '/keys', bearer(k.rawKey))).status, 401);
    status.markUserActive(u.userId);
    assert.equal((await call('GET', '/keys', bearer(k.rawKey))).status, 401, 'minted before the deprovisioning: stays refused');
  });

  it('H1 R-06: a key minted or rotated WITH a user key inherits its author and dies with the user (no laundering)', async () => {
    const u = await verifiedUser('launder');
    const k1 = await mint(u.token, 'by-user-jwt');
    const k2 = await mint(k1.rawKey, 'minted-with-k1');
    const rot = await call('POST', `/keys/${k1.keyId}/rotate`, bearer(k2.rawKey));
    assert.equal(rot.status, 200, rot.body);
    const k3raw = rot.json.key?.rawKey ?? rot.json.rawKey;
    assert.equal((await keys.getApiKey(k2.keyId))?.createdBy, u.userId, 'author inherited from the authenticating key');
    assert.equal((await call('GET', '/keys', bearer(k2.rawKey))).status, 200, 'control before');
    assert.equal((await call('DELETE', `/scim/v2/Users/${u.userId}`, bearer(SCIM_TOKEN))).status, 204);
    assert.equal((await call('GET', '/keys', bearer(k2.rawKey))).status, 401, 'the laundered key dies with its author');
    if (k3raw) assert.equal((await call('GET', '/keys', bearer(k3raw))).status, 401, 'the rotated key too');
  });

  it('H1 R-09: SCIM PATCH (Entra-style "Replace" active "False") deprovisions like DELETE; unknown ops → 400', async () => {
    const u = await verifiedUser('patch');
    const k = await mint(u.token, 'patch');
    const bad = await call('PATCH', `/scim/v2/Users/${u.userId}`, bearer(SCIM_TOKEN), j({ Operations: [{ op: 'remove', path: 'emails' }] }));
    assert.equal(bad.status, 400, 'unsupported op is refused, never a silent success');
    assert.equal((await call('GET', '/keys', bearer(k.rawKey))).status, 200, 'control: still active');
    const r = await call('PATCH', `/scim/v2/Users/${u.userId}`, bearer(SCIM_TOKEN),
      j({ schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'], Operations: [{ op: 'Replace', path: 'active', value: 'False' }] }));
    assert.equal(r.status, 200, r.body);
    assert.equal((await call('GET', '/keys', bearer(k.rawKey))).status, 401, 'the user keys are revoked');
    assert.equal(status.isUserDeprovisioned(u.userId), true);
  });

  it('SCIM PUT active=false also revokes the user keys', async () => {
    const u = await verifiedUser('put');
    const k = await mint(u.token, 'put');
    const r = await call('PUT', `/scim/v2/Users/${u.userId}`, bearer(SCIM_TOKEN), j({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: 'x', active: false }));
    assert.equal(r.status, 200, r.body);
    assert.ok((await keys.getApiKey(k.keyId))?.revokedAt);
  });

  it('a rotation by a user makes that user the author of the new key', async () => {
    const u = await verifiedUser('rot');
    const orgToken = `lb-s05-rot-token-${RUN}-${Math.random().toString(36).slice(2)}7e1d`;
    registry.registerToken(orgToken, u.orgId, 'OWNER');
    const k0 = await mint(orgToken, 'rot-src');
    const rot = await call('POST', `/keys/${encodeURIComponent(k0.keyId)}/rotate`, bearer(u.token));
    assert.equal(rot.status, 200, rot.body);
    assert.equal((await keys.getApiKey(rot.json.key.keyId))?.createdBy, u.userId);
  });

  it('user store failure on the key-minting routes → 503, no key minted (fail closed)', async () => {
    const u = await verifiedUser('storefail');
    const before = (await keys.listApiKeys(u.orgId)).length;
    const m = mock.method(users.getUserStore(), 'getUser', async () => { throw new Error('store down'); });
    try {
      const r = await call('POST', '/keys', bearer(u.token), j({ label: 'x', role: 'OWNER' }));
      assert.equal(r.status, 503, r.body);
      assert.equal(r.json?.key, undefined);
    } finally { m.mock.restore(); }
    assert.equal((await keys.listApiKeys(u.orgId)).length, before);
  });

  it('role change: a registry token downgraded by the platform loses admin:keys at once (control)', async () => {
    const tid = `lb-s05-role-${RUN}`; const tok = `lb-s05-role-token-${RUN}-9a7f3c1e5b`;
    assert.equal((await call('POST', '/admin/tenants', platform, j({ tenantId: tid, token: tok, role: 'OWNER' }))).status, 201);
    assert.equal((await call('POST', '/keys', bearer(tok), j({ label: 'r', role: 'MEMBER' }))).status, 201);
    assert.equal((await call('PUT', `/admin/tenants/${tid}`, platform, j({ role: 'VIEWER' }))).status, 200);
    assert.equal((await call('POST', '/keys', bearer(tok), j({ label: 'r2', role: 'MEMBER' }))).status, 403);
  });
});
