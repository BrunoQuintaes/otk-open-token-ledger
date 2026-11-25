/**
 * H1-S04 (INF05-F01): tenant deactivation is enforced at authentication time for EVERY credential of the tenant, and
 * reactivation restores only what it should.
 *   - while inactive: registry token, dynamic /keys key, access JWT and refresh token → 401; no key can be minted;
 *   - after PUT /admin/tenants/:id {active:true}: the registry token works again; dynamic keys, JWTs and refresh tokens
 *     issued BEFORE the deactivation stay invalid (dynamic keys: H1 lane B POLICY PENDING D4, unless restoreKeys:true);
 *     a JWT issued after the reactivation works (positive control).
 * In-memory stores only; no network.
 *
 * Also covered: a tenant role cannot reactivate its own tenant; the platform can.
 *
 * Modules under test: the route handlers of `src/api/routes.ts` called in process, with `src/api/tenantKeyRegistry.ts`,
 * `src/auth/jwt.ts`, `src/api/tenantCrud.ts` and the memory key metadata, token and user stores.
 *
 * Needs: nothing external. Before importing it empties `OTK_RECEIPT_LOG`, `OTK_DB_URL` and `OTK_TENANT_LOG`, sets
 * `PROVER_URL=disabled` and removes `OTK_REDIS_URL` and `OTK_TENANTS`; `OTK_ADMIN_KEY` and `OTK_JWT_SECRET` get
 * fixture values and are restored after the run.
 *
 * Run just this file: `npx tsx --test test/security/h1_s04_tenant_deactivation.test.ts`
 *
 * @module test/security/h1_s04_tenant_deactivation.test
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
const T = `s04-t-${RUN}`; const OTHER = `s04-o-${RUN}`;
const T_TOKEN = `s04-tenant-owner-token-${RUN}-0123456789`;
const O_TOKEN = `s04-other-owner-token-${RUN}-0123456789`;
const PLATFORM = `s04-platform-${RUN}-0123456789abcdef`;
const JWT_SECRET = `s04-jwt-${RUN}-0123456789abcdef0123456789`;
const platform = { 'x-admin-key': PLATFORM };
const T_USER = `usr_s04_t_${RUN}`; const O_USER = `usr_s04_o_${RUN}`;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const j = (o: unknown) => JSON.stringify(o);

let routes: any; let registry: any; let jwt: any; let tenantCrud: any; let metaStore: any; let tokenStore: any;

function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter(); let sent = false;
  em.on('newListener', (ev: string) => { if (ev === 'end' && !sent) { sent = true; setImmediate(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); }); } });
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

let origKey: string | undefined; let origJwt: string | undefined;
before(async () => {
  origKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  origJwt = process.env['OTK_JWT_SECRET']; process.env['OTK_JWT_SECRET'] = JWT_SECRET;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  jwt = await import('../../src/auth/jwt.js');
  tenantCrud = await import('../../src/api/tenantCrud.js');
  metaStore = await import('../../src/api/IApiKeyMetadataStore.js');
  tokenStore = await import('../../src/api/ITokenStore.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest(); metaStore.resetApiKeyMetadataStoreForTest(); tokenStore.resetTokenStoreForTest();
  tenantCrud.clearTenantsForTest(); jwt.clearBlacklistForTest();
  registry.registerToken(O_TOKEN, OTHER, 'OWNER');
  // F-H1-10 (H1 lane B): refresh tokens must be bound to a user that is a member of the tenant
  const { MemoryUserStore } = await import('../../src/users/MemoryUserStore.js');
  const users = await import('../../src/users/IUserStore.js');
  const store = new MemoryUserStore(); users.setUserStore(store);
  const nowIso = new Date().toISOString();
  for (const [uid, org] of [[T_USER, T], [O_USER, OTHER]] as const) {
    await store.createUser({ id: uid, email: `${uid}@example.invalid`, emailVerified: true, name: uid, passwordHash: null, createdAt: nowIso, updatedAt: nowIso });
    await store.addMembership({ userId: uid, orgId: org, role: 'OWNER', joinedAt: nowIso });
  }
});
after(async () => {
  registry.clearRegistry(); registry.clearHashRegistryForTest(); tenantCrud.clearTenantsForTest();
  (await import('../../src/users/IUserStore.js')).resetUserStoreForTest();
  for (const [k, v] of [['OTK_ADMIN_KEY', origKey], ['OTK_JWT_SECRET', origJwt]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

describe('H1-S04 tenant deactivation and reactivation', () => {
  let keyRaw = ''; let oldJwt = ''; let oldRefresh = ''; let oldRefresh2 = '';
  before(async () => {
    assert.equal((await call('POST', '/admin/tenants', platform, j({ tenantId: T, token: T_TOKEN, role: 'OWNER' }))).status, 201);
    const k = await call('POST', '/keys', bearer(T_TOKEN), j({ label: `s04-${RUN}`, role: 'OWNER' }));
    assert.equal(k.status, 201, k.body);
    keyRaw = k.json.key.rawKey;
    oldJwt = jwt.signToken({ sub: T, role: 'OWNER' }, JWT_SECRET, 600);
    oldRefresh = jwt.signRefreshToken(T, JWT_SECRET, T_USER);
    oldRefresh2 = jwt.signRefreshToken(T, JWT_SECRET, T_USER);
    // controls while active
    for (const t of [T_TOKEN, keyRaw, oldJwt]) assert.equal((await call('GET', '/keys', bearer(t))).status, 200);
    const r = await call('POST', '/auth/refresh', {}, j({ refreshToken: oldRefresh }));
    assert.equal(r.status, 200, `control: refresh works while active: ${r.body}`);
    assert.equal((await call('DELETE', `/admin/tenants/${encodeURIComponent(T)}`, platform)).status, 200);
  });

  it('while inactive: no credential of the tenant authenticates and no key can be minted', async () => {
    for (const t of [T_TOKEN, keyRaw, oldJwt]) {
      assert.equal((await call('GET', '/keys', bearer(t))).status, 401);
      assert.equal((await call('POST', '/keys', bearer(t), j({ label: 'x', role: 'OWNER' }))).status, 401);
    }
    const fresh = jwt.signToken({ sub: T, role: 'OWNER' }, JWT_SECRET, 600);
    assert.equal((await call('POST', '/keys', bearer(fresh), j({ label: 'x', role: 'OWNER' }))).status, 401, 'a JWT signed while inactive is refused');
    // control: another tenant is unaffected
    assert.equal((await call('GET', '/keys', bearer(O_TOKEN))).status, 200);
  });

  it('while inactive: a refresh token of the tenant mints no access token', async () => {
    const r = await call('POST', '/auth/refresh', {}, j({ refreshToken: oldRefresh2 }));
    assert.equal(r.status, 401, r.body);
    assert.equal(r.json?.token, undefined);
    // control: a refresh token of an active tenant still works
    const o = await call('POST', '/auth/refresh', {}, j({ refreshToken: jwt.signRefreshToken(OTHER, JWT_SECRET, O_USER) }));
    assert.equal(o.status, 200, o.body);
  });

  it('a tenant role cannot reactivate itself; the platform can', async () => {
    assert.equal((await call('PUT', `/admin/tenants/${encodeURIComponent(T)}`, bearer(O_TOKEN), j({ active: true }))).status, 403);
    assert.equal(tenantCrud.getTenant(T)?.active, false);
    const r = await call('PUT', `/admin/tenants/${encodeURIComponent(T)}`, platform, j({ active: true }));
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.tenant.active, true);
  });

  it('after reactivation: registry token works again; dynamic key, JWT and refresh token issued before deactivation stay invalid', async () => {
    assert.equal((await call('GET', '/keys', bearer(T_TOKEN))).status, 200);
    // H1 lane B, POLICY PENDING (D4): reactivation without restoreKeys:true no longer restores the dynamic keys minted
    // before the deactivation (was 200; restoreKeys:true is covered in h1_laneb_s04b)
    assert.equal((await call('GET', '/keys', bearer(keyRaw))).status, 401, 'pre-deactivation dynamic key not restored by default');
    assert.equal((await call('GET', '/keys', bearer(oldJwt))).status, 401, 'pre-deactivation JWT stays invalid');
    const r = await call('POST', '/auth/refresh', {}, j({ refreshToken: oldRefresh2 }));
    assert.equal(r.status, 401, 'pre-deactivation refresh token stays invalid');
    // a JWT issued after the reactivation (one second later: iat has second granularity) works
    const now = Date.now();
    const m = mock.method(Date, 'now', () => now + 2000);
    try {
      const fresh = jwt.signToken({ sub: T, role: 'OWNER' }, JWT_SECRET, 600);
      assert.equal((await call('GET', '/keys', bearer(fresh))).status, 200, 'new JWT accepted after reactivation');
    } finally { m.mock.restore(); }
  });
});
