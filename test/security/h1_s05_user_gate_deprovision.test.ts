/**
 * H1-S05 (SEC02-N03, SEC02-N04): user-level gates.
 *   N03 (POLICY=PENDING_HUMAN_APPROVAL (D3)): a JWT of a user whose e-mail is not verified cannot create or rotate API
 *       keys (403 email_not_verified); after POST /verify-email the same JWT can (positive control). Credentials without
 *       a user (registry tokens, JWTs without userId) are unaffected.
 *   N04: SCIM DELETE deprovisions the user: /login → 401 without token, every JWT carrying its userId → 401; the key
 *       minting route re-reads the user store, so it refuses even without the in-process cache (other replica).
 *       SCIM PUT active=true re-provisions: login works again, JWTs issued before the deprovisioning stay invalid.
 * In-memory stores only; no network.
 *
 * Modules under test: the route handlers of `src/api/routes.ts` called in process (signup, login, key minting and
 * rotation, e-mail verification, SCIM), with `src/auth/subjectStatus.ts`, `src/auth/emailVerification.ts`,
 * `src/auth/jwt.ts`, `src/api/tenantKeyRegistry.ts`, `src/api/tenantCrud.ts` and the memory user and key stores.
 *
 * Needs: nothing external. Before importing it empties `OTK_RECEIPT_LOG`, `OTK_DB_URL` and `OTK_TENANT_LOG`, sets
 * `PROVER_URL=disabled` and removes `OTK_REDIS_URL` and `OTK_TENANTS`; `OTK_ADMIN_KEY`, `OTK_JWT_SECRET` and
 * `OTK_SCIM_BEARER_TOKEN` get fixture values and are restored after the run.
 *
 * Run just this file: `npx tsx --test test/security/h1_s05_user_gate_deprovision.test.ts`
 *
 * @module test/security/h1_s05_user_gate_deprovision.test
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
const OWNER_TOKEN = `s05-static-owner-token-${RUN}-0123456789`;
const PLATFORM = `s05-platform-${RUN}-0123456789abcdef`;
const JWT_SECRET = `s05-jwt-${RUN}-0123456789abcdef0123456789`;
const SCIM_TOKEN = `s05-scim-${RUN}-0123456789abcdef`;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const j = (o: unknown) => JSON.stringify(o);

let routes: any; let registry: any; let jwt: any; let status: any; let ev: any; let tenantCrud: any;

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
async function signup(tag: string) {
  const email = `s05-${tag}-${RUN}@example.invalid`; const password = `s05-pass-${tag}-${RUN}`;
  const s = await call('POST', '/signup', {}, j({ email, password, name: 'S05 synthetic', orgName: `s05 ${tag} ${RUN}` }));
  assert.equal(s.status, 201, s.body);
  return { email, password, userId: s.json.userId as string, orgId: s.json.orgId as string, token: s.json.token as string };
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
  const { MemoryUserStore } = await import('../../src/users/MemoryUserStore.js');
  const { setUserStore } = await import('../../src/users/IUserStore.js');
  const metaStore = await import('../../src/api/IApiKeyMetadataStore.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest(); metaStore.resetApiKeyMetadataStoreForTest();
  tenantCrud.clearTenantsForTest(); jwt.clearBlacklistForTest(); status.clearUserStatusForTest(); setUserStore(new MemoryUserStore());
  registry.registerToken(OWNER_TOKEN, `s05-static-${RUN}`, 'OWNER');
});
after(() => {
  registry.clearRegistry(); registry.clearHashRegistryForTest(); status.clearUserStatusForTest();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('H1-S05 SEC02-N03: e-mail verification gate on key minting (POLICY=PENDING_HUMAN_APPROVAL (D3))', () => {
  it('unverified → 403 on create and rotate; after /verify-email the same JWT creates and rotates (control)', async () => {
    const u = await signup('verify');
    const denied = await call('POST', '/keys', bearer(u.token), j({ label: 'n03', role: 'OWNER' }));
    assert.equal(denied.status, 403, denied.body);
    assert.equal(denied.json.error, 'email_not_verified');
    assert.equal((await call('POST', '/keys', bearer(u.token), j({ label: 'n03m', role: 'MEMBER' }))).status, 403, 'any role');
    const v = await call('POST', '/verify-email', {}, j({ token: ev.generateVerificationToken(u.userId) }));
    assert.equal(v.status, 200, v.body);
    const ok = await call('POST', '/keys', bearer(u.token), j({ label: 'n03-ok', role: 'OWNER' }));
    assert.equal(ok.status, 201, `verified user mints keys: ${ok.body}`);
    const rot = await call('POST', `/keys/${encodeURIComponent(ok.json.key.keyId)}/rotate`, bearer(u.token));
    assert.equal(rot.status, 200, rot.body);
  });

  it('rotate by an unverified user → 403 (a rotation also yields a live raw key)', async () => {
    const u = await signup('rot');
    // a key of the same org minted with a credential that has no user (JWT without userId)
    const k = await call('POST', '/keys', bearer(jwt.signToken({ sub: u.orgId, role: 'OWNER' }, JWT_SECRET, 600)), j({ label: 'n03-r', role: 'MEMBER' }));
    assert.equal(k.status, 201, `control: JWT without userId is not gated: ${k.body}`);
    const r = await call('POST', `/keys/${encodeURIComponent(k.json.key.keyId)}/rotate`, bearer(u.token));
    assert.equal(r.status, 403, r.body);
  });

  it('control: registry token OWNER still mints keys', async () => {
    assert.equal((await call('POST', '/keys', bearer(OWNER_TOKEN), j({ label: 'static', role: 'OWNER' }))).status, 201);
  });
});

describe('H1-S05 SEC02-N04: SCIM deprovisioning', () => {
  it('after SCIM DELETE: login 401 without token, JWT 401 on every route; another user unaffected (control)', async () => {
    const u = await signup('deprov'); const other = await signup('other');
    assert.equal((await call('GET', '/keys', bearer(u.token))).status, 200, 'control before');
    assert.equal((await call('DELETE', `/scim/v2/Users/${u.userId}`, bearer(SCIM_TOKEN))).status, 204);
    const login = await call('POST', '/login', {}, j({ email: u.email, password: u.password }));
    assert.equal(login.status, 401, login.body);
    assert.equal(login.json?.token, undefined);
    assert.equal((await call('GET', '/keys', bearer(u.token))).status, 401);
    const scimGet = await call('GET', `/scim/v2/Users/${u.userId}`, bearer(SCIM_TOKEN));
    assert.equal(JSON.parse(scimGet.body).active, false);
    assert.equal((await call('POST', '/login', {}, j({ email: other.email, password: other.password }))).status, 200);
    assert.equal((await call('GET', '/keys', bearer(other.token))).status, 200);
  });

  it('key minting re-reads the user store: refused even without the in-process cache (another replica)', async () => {
    const u = await signup('replica');
    await call('POST', '/verify-email', {}, j({ token: ev.generateVerificationToken(u.userId) }));
    assert.equal((await call('DELETE', `/scim/v2/Users/${u.userId}`, bearer(SCIM_TOKEN))).status, 204);
    status.clearUserStatusForTest(); // simulate a replica that did not see the SCIM call
    const r = await call('POST', '/keys', bearer(u.token), j({ label: 'replica', role: 'OWNER' }));
    assert.equal(r.status, 401, r.body);
  });

  it('SCIM PUT active=true re-provisions: login works again, a JWT from before the deprovisioning stays invalid', async () => {
    const u = await signup('reprov');
    assert.equal((await call('DELETE', `/scim/v2/Users/${u.userId}`, bearer(SCIM_TOKEN))).status, 204);
    const put = await call('PUT', `/scim/v2/Users/${u.userId}`, bearer(SCIM_TOKEN), j({ schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'], userName: u.email, active: true }));
    assert.equal(put.status, 200, put.body);
    assert.equal((await call('GET', '/keys', bearer(u.token))).status, 401, 'old JWT stays invalid');
    const now = Date.now();
    const m = mock.method(Date, 'now', () => now + 2000);
    try {
      const login = await call('POST', '/login', {}, j({ email: u.email, password: u.password }));
      assert.equal(login.status, 200, login.body);
      assert.equal((await call('GET', '/keys', bearer(login.json.token))).status, 200, 'new JWT works');
    } finally { m.mock.restore(); }
  });
});
