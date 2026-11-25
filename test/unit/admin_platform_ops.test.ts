/**
 * AUD-FC-01 / AUD-FC-02 (FINAL CLOSURE adversarial audit, 2026-10-07): operations on the whole platform are not
 * tenant administration. A tenant OWNER or ADMIN cannot replace the tenant registry (which could switch auth off for
 * every tenant) nor read the global finance view. With auth enabled these need the platform operator credential that
 * already exists (OTK_ADMIN_KEY in x-admin-key); no new role is introduced.
 *
 * Modules under test: `handleRequest` in `src/api/routes.ts` for the registry reload and the
 * global finance endpoints, with `src/api/tenantKeyRegistry.ts` to set up tokens and to check
 * that the registry survived.
 *
 * Strategy / partitions: registry reload by a tenant OWNER (empty registry, its own entries, a
 * wrong platform key), with no platform key configured, with no credential at all, and with the
 * platform key (a reload that would load nothing is refused); finance view by tenant roles
 * (403, no data) and by the platform key.
 *
 * Needs: no server (mock request/response objects). Sets or deletes `OTK_ADMIN_KEY` per test and
 * restores the original value after each test.
 *
 * Run just this file: `npx tsx --test test/unit/admin_platform_ops.test.ts`
 *
 * @module test/unit/admin_platform_ops.test
 */
import { describe, it, before, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerToken, clearRegistry, isAuthEnabled, resolveTokenContext } from '../../src/api/tenantKeyRegistry.js';
import { handleRequest } from '../../src/api/routes.js';

function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers: { 'content-type': 'application/json', ...headers } }) as unknown as IncomingMessage;
  process.nextTick(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); });
  return req;
}
type MockRes = ServerResponse & { body: string };
function mockRes(): MockRes {
  let body = '';
  return { statusCode: 200, setHeader: () => {}, writeHead(c: number) { (this as { statusCode: number }).statusCode = c; return this; }, end: (d: string) => { body = d; }, get body() { return body; } } as unknown as MockRes;
}
async function call(method: string, url: string, headers: Record<string, string>, body?: unknown) {
  const res = mockRes();
  await handleRequest(mockReq(method, url, body === undefined ? '' : JSON.stringify(body), headers), res);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(res.body) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.statusCode, json };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const RUN = Date.now().toString(36);
const PLATFORM_KEY = `platform-key-${RUN}`;
let origKey: string | undefined;

function setup(platformKey: string | null) {
  clearRegistry();
  registerToken(`owner-a-${RUN}`, `ten-a-${RUN}`, 'OWNER');
  registerToken(`admin-a-${RUN}`, `ten-a-${RUN}`, 'ADMIN');
  registerToken(`owner-b-${RUN}`, `ten-b-${RUN}`, 'OWNER');
  if (platformKey === null) delete process.env['OTK_ADMIN_KEY'];
  else process.env['OTK_ADMIN_KEY'] = platformKey;
}
before(() => { origKey = process.env['OTK_ADMIN_KEY']; });
afterEach(() => {
  clearRegistry();
  if (origKey === undefined) delete process.env['OTK_ADMIN_KEY'];
  else process.env['OTK_ADMIN_KEY'] = origKey;
});

describe('AUD-FC-01: POST /admin/tenants/reload is a platform operation', () => {
  it('a tenant OWNER cannot switch auth off by reloading an empty registry; every tenant keeps working', async () => {
    setup(PLATFORM_KEY);
    const r = await call('POST', '/admin/tenants/reload', bearer(`owner-a-${RUN}`), { tenants: '' });
    assert.equal(r.status, 403);
    assert.equal(r.json['error'], 'platform_operation_forbidden');
    assert.equal(isAuthEnabled(), true);
    assert.equal(resolveTokenContext(`owner-b-${RUN}`)?.tenantId, `ten-b-${RUN}`, 'tenant B untouched');
  });
  it('a tenant OWNER cannot replace the registry with its own entries either', async () => {
    setup(PLATFORM_KEY);
    const r = await call('POST', '/admin/tenants/reload', bearer(`owner-a-${RUN}`), { tenants: `ten-a-${RUN}/OWNER:new-${RUN}` });
    assert.equal(r.status, 403);
    assert.equal(resolveTokenContext(`owner-b-${RUN}`)?.tenantId, `ten-b-${RUN}`);
    assert.equal(resolveTokenContext(`new-${RUN}`), null);
  });
  it('a tenant OWNER with a wrong platform key is still refused', async () => {
    setup(PLATFORM_KEY);
    const r = await call('POST', '/admin/tenants/reload', { ...bearer(`owner-a-${RUN}`), 'x-admin-key': 'wrong' }, { tenants: `x:y-${RUN}` });
    assert.equal(r.status, 403);
    assert.equal(isAuthEnabled(), true);
  });
  it('with no platform credential configured, nobody can reload over HTTP while auth is enabled', async () => {
    setup(null);
    const r = await call('POST', '/admin/tenants/reload', bearer(`owner-a-${RUN}`), { tenants: `x:y-${RUN}` });
    assert.equal(r.status, 403);
    assert.equal(resolveTokenContext(`owner-a-${RUN}`)?.tenantId, `ten-a-${RUN}`);
  });
  it('without any credential → 401 (RBAC answer kept)', async () => {
    setup(PLATFORM_KEY);
    const r = await call('POST', '/admin/tenants/reload', {}, { tenants: `x:y-${RUN}` });
    assert.equal(r.status, 401);
  });
  it('the platform credential reloads; a reload that would load nothing is refused and the registry stays', async () => {
    setup(PLATFORM_KEY);
    const empty = await call('POST', '/admin/tenants/reload', { 'x-admin-key': PLATFORM_KEY }, { tenants: ' , :x, bad' });
    assert.equal(empty.status, 400);
    assert.equal(empty.json['error'], 'reload_would_disable_auth');
    assert.equal(isAuthEnabled(), true);
    assert.equal(resolveTokenContext(`owner-b-${RUN}`)?.tenantId, `ten-b-${RUN}`);
    const ok = await call('POST', '/admin/tenants/reload', { 'x-admin-key': PLATFORM_KEY }, { tenants: `ten-c-${RUN}/OWNER:tok-c-${RUN}` });
    assert.equal(ok.status, 200);
    assert.equal(resolveTokenContext(`tok-c-${RUN}`)?.tenantId, `ten-c-${RUN}`);
    assert.equal(resolveTokenContext(`owner-b-${RUN}`), null, 'replaced atomically');
  });
});

describe('AUD-FC-02: GET /admin/finance (global payouts and totals) is a platform operation', () => {
  it('a tenant ADMIN or OWNER gets 403 and no financial data', async () => {
    setup(PLATFORM_KEY);
    for (const tok of [`admin-a-${RUN}`, `owner-b-${RUN}`]) {
      const r = await call('GET', '/admin/finance', bearer(tok));
      assert.equal(r.status, 403, tok);
      assert.equal(r.json['error'], 'platform_operation_forbidden');
      assert.equal(r.json['pendingPayouts'], undefined);
      assert.equal(r.json['totalOwedUsd'], undefined);
    }
  });
  it('the platform credential reads it', async () => {
    setup(PLATFORM_KEY);
    const r = await call('GET', '/admin/finance', { 'x-admin-key': PLATFORM_KEY });
    assert.equal(r.status, 200);
    assert.ok('totalOwedUsd' in r.json);
  });
});
