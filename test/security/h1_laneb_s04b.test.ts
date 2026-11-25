/**
 * H1 lane B — S04 residual (INF05-F01): tenant deactivation survives replicas and restarts; reactivation policy (D4).
 *
 * Replicas: replica A is this process (routes, auth path, proxy registry). Replica B is a SECOND, independent instance
 * of auth/subjectStatus (imported with a query string, so it has its own in-memory state) using the same durable
 * backend (one MemorySubjectStatusStore shared by both clients) — the shape of two processes over one PostgreSQL table.
 * A restart is simulated by clearing A's in-memory state and hydrating it from the store, as storeBootstrap does.
 *
 *   - B deactivates T → after the bounded staleness (OTK_SUBJECT_STATUS_TTL_MS) A refuses T's registry token, dynamic
 *     key, JWT issued before the deactivation and bound refresh token, without any explicit sync call;
 *   - A deactivates T2 through the API → restart → still refused (hydrated); a JWT from before stays refused after a
 *     reactivation and a restart;
 *   - store failure: a tenant seen as deactivated stays deactivated (fail closed), and the API answers 503 when the
 *     deactivation cannot be written (the local replica still refuses the tenant);
 *   - POLICY PENDING (D4): reactivation does NOT restore dynamic keys minted before the deactivation unless
 *     restoreKeys:true; the registry token is restored; a key minted after the reactivation works; the policy also
 *     holds when the reactivation is made by the other replica.
 * In-memory stores only; no network.
 *
 * Also covered: a SCIM user deprovisioning on replica B makes replica A refuse a JWT carrying that user's id.
 *
 * Modules under test: the route handlers of `src/api/routes.ts` called in process, with `src/auth/subjectStatus.ts`
 * (two instances), `src/api/tenantKeyRegistry.ts`, `src/auth/jwt.ts`, `src/api/tenantCrud.ts`,
 * `src/api/apiKeyManager.ts` and the memory key, token and user stores.
 *
 * Needs: nothing external. Before importing it empties `OTK_RECEIPT_LOG`, `OTK_DB_URL` and `OTK_TENANT_LOG`, sets
 * `PROVER_URL=disabled` and `OTK_SUBJECT_STATUS_TTL_MS=50` (so the staleness bound is 50 ms) and removes
 * `OTK_REDIS_URL` and `OTK_TENANTS`; `OTK_ADMIN_KEY` and `OTK_JWT_SECRET` get fixture values and are restored after
 * the run. Short real-time waits (tens of ms) let the TTL expire.
 *
 * Run just this file: `npx tsx --test test/security/h1_laneb_s04b.test.ts`
 *
 * @module test/security/h1_laneb_s04b.test
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_SUBJECT_STATUS_TTL_MS'] = '50';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];

/* eslint-disable @typescript-eslint/no-explicit-any */
const RUN = Date.now().toString(36);
const PLATFORM = `lb-s04-platform-${RUN}-0123456789abcdef`;
const JWT_SECRET = `lb-s04-jwt-${RUN}-0123456789abcdef0123456789`;
const platform = { 'x-admin-key': PLATFORM };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const j = (o: unknown) => JSON.stringify(o);
const tok = (tag: string) => `lb-s04-${tag}-token-${RUN}-9f3c7a1e5b`;

let routes: any; let registry: any; let jwt: any; let statusA: any; let statusB: any; let tenantCrud: any; let keys: any; let users: any;
let backend: any;

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
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * a time later than "now" by more than one second (iat/createdAt have second granularity)
 *
 * @param fn - Work to run while `Date.now` is mocked 2000 ms ahead; the mock is restored when it settles.
 * @returns The result of `fn`.
 */
function later<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const m = mock.method(Date, 'now', () => now + 2000);
  return fn().finally(() => m.mock.restore());
}

/**
 * tenant with registry token, a dynamic key, an access JWT and a refresh token bound to a member user
 *
 * @param tag - Short label that makes the tenant, user and token names unique within the run.
 */
async function tenantWithCredentials(tag: string) {
  const T = `lb-s04-${tag}-${RUN}`; const regTok = tok(tag);
  assert.equal((await call('POST', '/admin/tenants', platform, j({ tenantId: T, token: regTok, role: 'OWNER' }))).status, 201);
  const k = await call('POST', '/keys', bearer(regTok), j({ label: `lb-s04-${tag}`, role: 'OWNER' }));
  assert.equal(k.status, 201, k.body);
  const uid = `usr_lb_s04_${tag}_${RUN}`; const nowIso = new Date().toISOString();
  await users.getUserStore().createUser({ id: uid, email: `${uid}@example.invalid`, emailVerified: true, name: uid, passwordHash: null, createdAt: nowIso, updatedAt: nowIso });
  await users.getUserStore().addMembership({ userId: uid, orgId: T, role: 'OWNER', joinedAt: nowIso });
  return {
    T, regTok, keyId: k.json.key.keyId as string, keyRaw: k.json.key.rawKey as string,
    jwt: jwt.signToken({ sub: T, role: 'OWNER', userId: uid }, JWT_SECRET, 600) as string,
    refresh: () => jwt.signRefreshToken(T, JWT_SECRET, uid) as string,
  };
}
async function allRefused(c: { regTok: string; keyRaw: string; jwt: string; refresh: () => string }, why: string) {
  for (const [name, t] of [['registry token', c.regTok], ['dynamic key', c.keyRaw], ['JWT', c.jwt]] as const) {
    assert.equal((await call('GET', '/keys', bearer(t))).status, 401, `${why}: ${name}`);
  }
  const r = await call('POST', '/auth/refresh', {}, j({ refreshToken: c.refresh() }));
  assert.equal(r.status, 401, `${why}: refresh token ${r.body}`);
}

const saved: Record<string, string | undefined> = {};
before(async () => {
  for (const k of ['OTK_ADMIN_KEY', 'OTK_JWT_SECRET']) saved[k] = process.env[k];
  process.env['OTK_ADMIN_KEY'] = PLATFORM; process.env['OTK_JWT_SECRET'] = JWT_SECRET;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  jwt = await import('../../src/auth/jwt.js');
  statusA = await import('../../src/auth/subjectStatus.js');
  statusB = await import('../../src/auth/subjectStatus.js?replica=b' as string);
  assert.notEqual(statusA, statusB, 'replica B is an independent module instance');
  tenantCrud = await import('../../src/api/tenantCrud.js');
  keys = await import('../../src/api/apiKeyManager.js');
  users = await import('../../src/users/IUserStore.js');
  const { MemoryUserStore } = await import('../../src/users/MemoryUserStore.js');
  const metaStore = await import('../../src/api/IApiKeyMetadataStore.js');
  const tokenStore = await import('../../src/api/ITokenStore.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest(); metaStore.resetApiKeyMetadataStoreForTest(); tokenStore.resetTokenStoreForTest();
  tenantCrud.clearTenantsForTest(); jwt.clearBlacklistForTest(); statusA.clearUserStatusForTest(); users.setUserStore(new MemoryUserStore());
  backend = new statusA.MemorySubjectStatusStore();
  assert.equal(await statusA.setSubjectStatusStore(backend), true);
  assert.equal(await statusB.setSubjectStatusStore(backend), true);
});
after(async () => {
  statusA.resetSubjectStatusStoreForTest(); statusB.resetSubjectStatusStoreForTest();
  registry.clearRegistry(); registry.clearHashRegistryForTest(); tenantCrud.clearTenantsForTest(); statusA.clearUserStatusForTest();
  users.resetUserStoreForTest();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

describe('S04b revocation across replicas and restarts (durable status store, bounded staleness)', () => {
  it('replica B deactivates the tenant → replica A refuses every credential within the TTL (no explicit sync)', async () => {
    const c = await tenantWithCredentials('xrep');
    for (const t of [c.regTok, c.keyRaw, c.jwt]) assert.equal((await call('GET', '/keys', bearer(t))).status, 200, 'control before');
    statusB.markTenantInactive(c.T);
    assert.equal((await statusB.flushSubjectStatus()).ok, true);
    // bounded staleness: the first check after the TTL starts a refresh; the next check sees it
    await sleep(80);
    await call('GET', '/keys', bearer(c.regTok));
    await sleep(20);
    await allRefused(c, 'after deactivation on replica B');
    assert.equal(registry.resolveTokenContext(c.regTok)?.tenantId, c.T, 'replica A registry untouched: refusal comes from the shared status');
  });

  it('deactivation through the API is durable: a restart (empty cache hydrated from the store) still refuses; reactivation and restart keep old JWTs refused', async () => {
    const c = await tenantWithCredentials('restart');
    assert.equal((await call('DELETE', `/admin/tenants/${encodeURIComponent(c.T)}`, platform)).status, 200);
    // restart of replica A: in-memory status lost, hydrated from the store
    statusA.clearTenantStatusForTest();
    assert.equal(statusA.isTenantInactive(c.T), false, 'cache empty after the simulated restart');
    assert.equal(await statusA.syncSubjectStatusNow(), true);
    await allRefused(c, 'after restart');
    // reactivation (registry token restored), then another restart: the JWT from before the deactivation stays refused
    assert.equal((await call('PUT', `/admin/tenants/${encodeURIComponent(c.T)}`, platform, j({ active: true }))).status, 200);
    statusA.clearTenantStatusForTest(); assert.equal(await statusA.syncSubjectStatusNow(), true);
    assert.equal((await call('GET', '/keys', bearer(c.regTok))).status, 200, 'registry token restored');
    assert.equal((await call('GET', '/keys', bearer(c.jwt))).status, 401, 'JWT from before the deactivation');
    assert.equal((await call('POST', '/auth/refresh', {}, j({ refreshToken: c.refresh() }))).status, 401, 'refresh token from before');
    await later(async () => {
      const fresh = jwt.signToken({ sub: c.T, role: 'OWNER' }, JWT_SECRET, 600);
      assert.equal((await call('GET', '/keys', bearer(fresh))).status, 200, 'JWT issued after the reactivation');
    });
  });

  it('store failure: a tenant seen as deactivated stays deactivated even if the store would say otherwise (fail closed)', async () => {
    const c = await tenantWithCredentials('failclosed');
    assert.equal((await call('DELETE', `/admin/tenants/${encodeURIComponent(c.T)}`, platform)).status, 200);
    // another replica reactivates it, but replica A cannot read the store
    assert.equal(await statusB.syncSubjectStatusNow(), true);
    statusB.markTenantActive(c.T, { restoreKeys: true }); await statusB.flushSubjectStatus();
    const m = mock.method(backend, 'listAll', async () => { throw new Error('store down'); });
    try {
      assert.equal(await statusA.syncSubjectStatusNow(), false);
      assert.equal((await call('GET', '/keys', bearer(c.regTok))).status, 401, 'still refused while the store is down');
      assert.equal(statusA.subjectStatusHealth().lastSyncError, 'store down');
    } finally { m.mock.restore(); }
    assert.equal(await statusA.syncSubjectStatusNow(), true);
    assert.equal(statusA.isTenantInactive(c.T), false, 'the reactivation applies once the store answers');
  });

  it('store failure on write: DELETE answers 503 and the tenant is refused on this replica anyway', async () => {
    const c = await tenantWithCredentials('writefail');
    const m = mock.method(backend, 'put', async () => { throw new Error('store down'); });
    try {
      const r = await call('DELETE', `/admin/tenants/${encodeURIComponent(c.T)}`, platform);
      assert.equal(r.status, 503, r.body);
      assert.equal(r.json?.error, 'subject_status_unavailable');
      assert.equal((await call('GET', '/keys', bearer(c.keyRaw))).status, 401, 'fail closed locally');
    } finally { m.mock.restore(); }
    // retry once the store is back: 200 and the other replica sees it
    assert.equal((await call('DELETE', `/admin/tenants/${encodeURIComponent(c.T)}`, platform)).status, 200);
    assert.equal(await statusB.syncSubjectStatusNow(), true);
    assert.equal(statusB.isTenantInactive(c.T), true);
  });

  it('SCIM-style user deprovisioning on replica B reaches replica A (JWT carrying the userId refused)', async () => {
    const uid = `usr_lb_s04_scim_${RUN}`; const T = `lb-s04-u-${RUN}`;
    registry.registerToken(tok('u'), T, 'OWNER');
    const userJwt = jwt.signToken({ sub: T, role: 'OWNER', userId: uid }, JWT_SECRET, 600);
    assert.equal((await call('GET', '/keys', bearer(userJwt))).status, 200, 'control');
    statusB.markUserDeprovisioned(uid); await statusB.flushSubjectStatus();
    assert.equal(await statusA.syncSubjectStatusNow(), true);
    assert.equal((await call('GET', '/keys', bearer(userJwt))).status, 401);
  });
});

describe('S04b reactivation policy (POLICY PENDING D4): old dynamic keys are not restored by default', () => {
  it('PUT {active:true}: registry token works, the dynamic key minted before the deactivation stays refused (revoked in the key store), a new key works', async () => {
    const c = await tenantWithCredentials('react');
    assert.equal((await call('DELETE', `/admin/tenants/${encodeURIComponent(c.T)}`, platform)).status, 200);
    const r = await call('PUT', `/admin/tenants/${encodeURIComponent(c.T)}`, platform, j({ active: true }));
    assert.equal(r.status, 200, r.body);
    assert.equal((await call('GET', '/keys', bearer(c.regTok))).status, 200, 'registry token restored');
    assert.equal((await call('GET', '/keys', bearer(c.keyRaw))).status, 401, 'old dynamic key not restored');
    assert.ok((await keys.getApiKey(c.keyId))?.revokedAt, 'old key revoked in the key store');
    await sleep(1100); // key creation instants have second granularity
    const k2 = await call('POST', '/keys', bearer(c.regTok), j({ label: 'after-reactivation', role: 'OWNER' }));
    assert.equal(k2.status, 201, k2.body);
    assert.equal((await call('GET', '/keys', bearer(k2.json.key.rawKey))).status, 200, 'a key minted after the reactivation works');
  });

  it('PUT {active:true, restoreKeys:true}: the old dynamic key works again (explicit policy)', async () => {
    const c = await tenantWithCredentials('restore');
    assert.equal((await call('DELETE', `/admin/tenants/${encodeURIComponent(c.T)}`, platform)).status, 200);
    assert.equal((await call('PUT', `/admin/tenants/${encodeURIComponent(c.T)}`, platform, j({ active: true, restoreKeys: true }))).status, 200);
    assert.equal((await call('GET', '/keys', bearer(c.keyRaw))).status, 200);
    assert.equal((await keys.getApiKey(c.keyId))?.revokedAt, null);
  });

  it('reactivation made by the other replica (default policy) → replica A restores the registry token but not the old key', async () => {
    const c = await tenantWithCredentials('xreact');
    assert.equal((await call('DELETE', `/admin/tenants/${encodeURIComponent(c.T)}`, platform)).status, 200);
    assert.equal(await statusB.syncSubjectStatusNow(), true);
    statusB.markTenantActive(c.T); await statusB.flushSubjectStatus();
    assert.equal(await statusA.syncSubjectStatusNow(), true);
    assert.equal(statusA.isTenantInactive(c.T), false);
    assert.equal((await call('GET', '/keys', bearer(c.keyRaw))).status, 401, 'old dynamic key refused on replica A');
  });
});
