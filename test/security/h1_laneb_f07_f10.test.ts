/**
 * H1 lane B (OTK-H1-MEGA-S01-S24-20261013) — findings F-H1-07..F-H1-10 on the API auth path.
 *   F-H1-07: the API auth-failure limiter (POST /receipts, GET /receipts/:id) was keyed by the first 8 characters of the
 *            presented token: guesses with distinct prefixes were never throttled, and wrong tokens sharing a victim
 *            token's prefix throttled that prefix for every source. It is now keyed by source address.
 *   F-H1-08: the SCIM bearer was compared with ===; now a constant-time comparison (crypto.timingSafeEqual on digests).
 *   F-H1-09: /login answered an unknown e-mail without hashing (timing oracle for account existence); now a dummy scrypt
 *            runs in that path too (asserted by counting scrypt calls, not by wall-clock timing).
 *   F-H1-10: /auth/refresh minted a MEMBER JWT from a refresh token bound only to a tenant; a refresh token must now carry
 *            a userId of an existing, provisioned member of the tenant, and the access JWT carries that userId.
 * In-memory stores only; no network.
 *
 * Modules under test: the route handlers of `src/api/routes.ts` called in process, with `src/api/tenantKeyRegistry.ts`,
 * `src/auth/jwt.ts`, `src/auth/subjectStatus.ts`, `src/security/IDistributedRateLimiter.ts`, `src/users/IUserStore.ts`
 * (memory user store) and `src/api/tenantCrud.ts`.
 *
 * Needs: nothing external. Before importing the modules it empties `OTK_RECEIPT_LOG`, `OTK_DB_URL` and
 * `OTK_TENANT_LOG`, sets `PROVER_URL=disabled` and removes `OTK_REDIS_URL`, `OTK_TENANTS`, `OTK_AUTH_FAIL_MAX` and
 * `OTK_PROXY_TRUSTED_HOPS`; it sets `OTK_ADMIN_KEY`, `OTK_JWT_SECRET` and `OTK_SCIM_BEARER_TOKEN` to fixture values
 * for the run and restores them afterwards.
 *
 * Run just this file: `npx tsx --test test/security/h1_laneb_f07_f10.test.ts`
 *
 * @module test/security/h1_laneb_f07_f10.test
 */
import { describe, it, before, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];
delete process.env['OTK_AUTH_FAIL_MAX'];
delete process.env['OTK_PROXY_TRUSTED_HOPS'];

/* eslint-disable @typescript-eslint/no-explicit-any */
const RUN = Date.now().toString(36);
const T = `lb-f-${RUN}`;
const T_TOKEN = `lb-f-owner-token-${RUN}-0123456789`;
const PLATFORM = `lb-f-platform-${RUN}-0123456789abcdef`;
const JWT_SECRET = `lb-f-jwt-${RUN}-0123456789abcdef0123456789`;
const SCIM_TOKEN = `lb-f-scim-${RUN}-0123456789abcdef`;
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const j = (o: unknown) => JSON.stringify(o);

let routes: any; let registry: any; let jwt: any; let status: any; let rl: any; let users: any; let tenantCrud: any;

function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}, remoteAddress = '127.0.0.1'): IncomingMessage {
  const em = new EventEmitter(); let sent = false;
  em.on('newListener', (e: string) => { if (e === 'end' && !sent) { sent = true; setImmediate(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); }); } });
  return Object.assign(em, { method, url, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress }, destroy: () => {} }) as unknown as IncomingMessage;
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
async function call(method: string, url: string, headers: Record<string, string> = {}, body = '', remote = '127.0.0.1'): Promise<{ status: number; body: string; json: any }> {
  const res = new MockRes();
  await routes.handleRequest(mockReq(method, url, body, headers, remote), res as unknown as ServerResponse);
  let json: any; try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.statusCode, body: res.body, json };
}

const saved: Record<string, string | undefined> = {};
before(async () => {
  for (const k of ['OTK_ADMIN_KEY', 'OTK_JWT_SECRET', 'OTK_SCIM_BEARER_TOKEN']) saved[k] = process.env[k];
  process.env['OTK_ADMIN_KEY'] = PLATFORM; process.env['OTK_JWT_SECRET'] = JWT_SECRET; process.env['OTK_SCIM_BEARER_TOKEN'] = SCIM_TOKEN;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  jwt = await import('../../src/auth/jwt.js');
  status = await import('../../src/auth/subjectStatus.js');
  rl = await import('../../src/security/IDistributedRateLimiter.js');
  users = await import('../../src/users/IUserStore.js');
  tenantCrud = await import('../../src/api/tenantCrud.js');
  const { MemoryUserStore } = await import('../../src/users/MemoryUserStore.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest(); tenantCrud.clearTenantsForTest();
  jwt.clearBlacklistForTest(); status.clearUserStatusForTest(); users.setUserStore(new MemoryUserStore());
  registry.registerToken(T_TOKEN, T, 'OWNER');
});
after(() => {
  registry.clearRegistry(); registry.clearHashRegistryForTest(); status.clearUserStatusForTest(); users.resetUserStoreForTest();
  rl.resetDistributedRateLimiterForTest();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => { rl.resetDistributedRateLimiterForTest(); });

const randTok = () => crypto.randomBytes(18).toString('base64url');

describe('F-H1-07 API auth-failure limiter keyed by source, not by token prefix', () => {
  it('wrong tokens with distinct prefixes from one source → 429 after 20 failures; the valid token from that source is also throttled', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 25; i++) statuses.push((await call('GET', `/receipts/lb-f07-${i}`, bearer(randTok()), '', '203.0.113.50')).status);
    assert.equal(statuses.filter((s) => s === 401).length, 20, `statuses: ${statuses.join(',')}`);
    assert.ok(statuses.slice(20).every((s) => s === 429), `statuses: ${statuses.join(',')}`);
  });

  it('wrong tokens sharing the prefix of a valid token, from another source, do not throttle the valid token (no tenant lockout)', async () => {
    const prefix = T_TOKEN.slice(0, 8);
    for (let i = 0; i < 25; i++) await call('GET', `/receipts/lb-f07b-${i}`, bearer(`${prefix}${randTok()}`), '', '198.51.100.66');
    const r = await call('GET', `/receipts/lb-f07b-missing-${RUN}`, bearer(`${prefix}${randTok()}`), '', '192.0.2.10');
    assert.equal(r.status, 401, `a fresh source with the same prefix is not throttled: ${r.body}`);
    const ok = await call('GET', `/receipts/lb-f07b-missing-${RUN}`, bearer(T_TOKEN), '', '192.0.2.10');
    assert.notEqual(ok.status, 429, ok.body);
    assert.notEqual(ok.status, 401, ok.body);
  });
});

describe('F-H1-08 SCIM bearer compared in constant time', () => {
  it('uses crypto.timingSafeEqual; wrong, shorter, longer and missing bearers → 401; the right one passes', async () => {
    const spy = mock.method(crypto, 'timingSafeEqual');
    try {
      for (const t of [SCIM_TOKEN.slice(0, -1) + 'X', SCIM_TOKEN.slice(0, 5), SCIM_TOKEN + 'extra']) {
        assert.equal((await call('GET', '/scim/v2/Groups', bearer(t))).status, 401);
      }
      assert.equal((await call('GET', '/scim/v2/Groups')).status, 401);
      const before = spy.mock.callCount();
      assert.equal((await call('GET', '/scim/v2/Groups', bearer(SCIM_TOKEN))).status, 200);
      assert.ok(spy.mock.callCount() > before, 'the valid bearer was compared with timingSafeEqual');
      assert.ok(before >= 3, `wrong bearers compared with timingSafeEqual too (calls: ${before})`);
    } finally { spy.mock.restore(); }
  });
});

describe('F-H1-09 /login hashes in the unknown-user path too', () => {
  it('unknown e-mail → 401 after one scrypt call; known e-mail with a wrong password → 401 after one scrypt call', async () => {
    const email = `lb-f09-${RUN}@example.invalid`; const password = `lb-f09-pass-${RUN}`;
    const s = await call('POST', '/signup', {}, j({ email, password, name: 'F09 synthetic', orgName: `lb f09 ${RUN}` }));
    assert.equal(s.status, 201, s.body);
    const spy = mock.method(crypto, 'scrypt');
    try {
      const unknown = await call('POST', '/login', {}, j({ email: `lb-f09-nobody-${RUN}@example.invalid`, password }));
      assert.equal(unknown.status, 401);
      assert.equal(spy.mock.callCount(), 1, 'a dummy hash runs for an unknown e-mail');
      const wrong = await call('POST', '/login', {}, j({ email, password: `${password}-wrong` }));
      assert.equal(wrong.status, 401);
      assert.equal(spy.mock.callCount(), 2, 'one hash for a wrong password');
      const strip = (o: any) => { const { requestId: _r, ...rest } = o ?? {}; return rest; };
      assert.deepEqual(strip(unknown.json), strip(wrong.json), 'same answer in both paths (requestId aside)');
    } finally { spy.mock.restore(); }
  });
});

describe('F-H1-10 /auth/refresh requires a refresh token bound to a user', () => {
  it('an unbound refresh token (tenant only) mints nothing → 401', async () => {
    const r = await call('POST', '/auth/refresh', {}, j({ refreshToken: jwt.signRefreshToken(T, JWT_SECRET) }));
    assert.equal(r.status, 401, r.body);
    assert.equal(r.json?.token, undefined);
  });

  it('a refresh token bound to a member of the tenant → 200; the access JWT carries the userId and stays MEMBER', async () => {
    const email = `lb-f10-${RUN}@example.invalid`;
    const s = await call('POST', '/signup', {}, j({ email, password: `lb-f10-pass-${RUN}`, name: 'F10 synthetic', orgName: `lb f10 ${RUN}` }));
    assert.equal(s.status, 201, s.body);
    const r = await call('POST', '/auth/refresh', {}, j({ refreshToken: jwt.signRefreshToken(s.json.orgId, JWT_SECRET, s.json.userId) }));
    assert.equal(r.status, 200, r.body);
    const p = JSON.parse(Buffer.from(String(r.json.token).split('.')[1]!, 'base64url').toString());
    assert.equal(p.sub, s.json.orgId); assert.equal(p.userId, s.json.userId); assert.equal(p.role, 'MEMBER');
    const rp = JSON.parse(Buffer.from(String(r.json.refreshToken).split('.')[1]!, 'base64url').toString());
    assert.equal(rp.userId, s.json.userId, 'the rotated refresh token stays bound');
    // bound to a user that is not a member of the claimed tenant → 401
    const foreign = await call('POST', '/auth/refresh', {}, j({ refreshToken: jwt.signRefreshToken(T, JWT_SECRET, s.json.userId) }));
    assert.equal(foreign.status, 401, foreign.body);
    // unknown user → 401
    const ghost = await call('POST', '/auth/refresh', {}, j({ refreshToken: jwt.signRefreshToken(s.json.orgId, JWT_SECRET, `usr_ghost_${RUN}`) }));
    assert.equal(ghost.status, 401, ghost.body);
    // deprovisioned user → 401
    const s2 = await call('POST', '/signup', {}, j({ email: `lb-f10b-${RUN}@example.invalid`, password: `lb-f10-pass-${RUN}`, name: 'F10 b', orgName: `lb f10b ${RUN}` }));
    const rt2 = jwt.signRefreshToken(s2.json.orgId, JWT_SECRET, s2.json.userId);
    assert.equal((await call('DELETE', `/scim/v2/Users/${s2.json.userId}`, bearer(SCIM_TOKEN))).status, 204);
    status.clearUserStatusForTest(); // the route re-reads the user store (another replica)
    const dep = await call('POST', '/auth/refresh', {}, j({ refreshToken: rt2 }));
    assert.equal(dep.status, 401, dep.body);
  });

  it('user store unavailable → refresh fails closed (no token)', async () => {
    const email = `lb-f10c-${RUN}@example.invalid`;
    const s = await call('POST', '/signup', {}, j({ email, password: `lb-f10-pass-${RUN}`, name: 'F10 c', orgName: `lb f10c ${RUN}` }));
    const rt = jwt.signRefreshToken(s.json.orgId, JWT_SECRET, s.json.userId);
    const store = users.getUserStore();
    const m = mock.method(store, 'getUser', async () => { throw new Error('store down'); });
    try {
      const r = await call('POST', '/auth/refresh', {}, j({ refreshToken: rt }));
      assert.ok(r.status === 401 || r.status === 503, r.body);
      assert.equal(r.json?.token, undefined);
    } finally { m.mock.restore(); }
  });
});
