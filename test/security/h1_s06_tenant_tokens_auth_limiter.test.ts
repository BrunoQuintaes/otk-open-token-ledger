/**
 * H1-S06 (SEC02-N02, INF05-F02): tenant token hygiene and the proxy's per-source limiter of authentication failures.
 *   - POST/PUT /admin/tenants refuse tokens shorter than 24 characters (400) and tokens bound to another tenant (409);
 *     a 24-character token and a tenant keeping its own token are accepted (controls);
 *   - limiter: keyed by source, never by tenant; a throttled source gets 429 + Retry-After even with a valid token, while
 *     the same valid token from another source works; bounded memory; window expiry; MAX=0 disables it.
 * The upstream provider is a fetch stub (no network, no real key); in-memory stores only.
 *
 * Modules under test: the tenant routes of `src/api/routes.ts` and `src/api/tenantCrud.ts` (called in process),
 * `src/security/authFailureLimiter.ts` and the proxy authentication path of `src/proxy/ProxyGateway.ts`.
 *
 * Needs: nothing external. Before importing it empties `OTK_RECEIPT_LOG`, `OTK_DB_URL` and `OTK_TENANT_LOG`, sets
 * `PROVER_URL=disabled` and `OPENAI_API_KEY` to a fixture value, and removes `OTK_REDIS_URL`, `OTK_TENANTS` and
 * `OTK_PROXY_ALLOW_UNAUTHENTICATED`; `OTK_ADMIN_KEY`, `OTK_PROXY_TRUSTED_HOPS` and `OTK_PROXY_AUTH_FAIL_MAX` are
 * saved and restored. The proxy gateway listens on a local port.
 *
 * Run just this file: `npx tsx --test test/security/h1_s06_tenant_tokens_auth_limiter.test.ts`
 *
 * @module test/security/h1_s06_tenant_tokens_auth_limiter.test
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OPENAI_API_KEY'] = 'operator-provider-key-fixture';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];
delete process.env['OTK_PROXY_ALLOW_UNAUTHENTICATED'];

/* eslint-disable @typescript-eslint/no-explicit-any */
const RUN = Date.now().toString(36);
const PLATFORM = `s06-platform-${RUN}-0123456789abcdef`;
const A = `s06a-${RUN}`; const A_TOKEN = `s06-a-operator-token-${RUN}-0123456789`;
const platform = { 'x-admin-key': PLATFORM };
const j = (o: unknown) => JSON.stringify(o);

let routes: any; let registry: any; let tenantCrud: any; let lim: any; let gw: any; let plans: any; let talRt: any;

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
async function call(method: string, url: string, headers: Record<string, string> = {}, body = ''): Promise<{ status: number; body: string }> {
  const res = new MockRes();
  await routes.handleRequest(mockReq(method, url, body, headers), res as unknown as ServerResponse);
  return { status: res.statusCode, body: res.body };
}

let server: Server; let base = ''; let upstreamCalls = 0;
const realFetch = globalThis.fetch;
async function proxyCall(token: string, xff?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  if (xff) headers['x-forwarded-for'] = xff;
  const r = await realFetch(`${base}/v1/chat/completions`, { method: 'POST', headers, body: j({ model: 'gpt-4o', messages: [] }) });
  await r.text();
  return { status: r.status, retryAfter: r.headers.get('retry-after') };
}

const saved: Record<string, string | undefined> = {};
before(async () => {
  for (const k of ['OTK_ADMIN_KEY', 'OTK_PROXY_TRUSTED_HOPS', 'OTK_PROXY_AUTH_FAIL_MAX']) saved[k] = process.env[k];
  process.env['OTK_ADMIN_KEY'] = PLATFORM;
  delete process.env['OTK_PROXY_AUTH_FAIL_MAX'];
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  tenantCrud = await import('../../src/api/tenantCrud.js');
  lim = await import('../../src/security/authFailureLimiter.js');
  gw = await import('../../src/proxy/ProxyGateway.js');
  plans = await import('../../src/billing/PlanRegistry.js');
  talRt = await import('../../src/security/talRuntime.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest(); tenantCrud.clearTenantsForTest();
  registry.registerToken(A_TOKEN, A, 'OPERATOR');
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://')) {
      upstreamCalls++;
      return new Response(j({ id: `chatcmpl-s06-${RUN}-${upstreamCalls}`, model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 0 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as string, init);
  }) as typeof fetch;
  server = gw.startProxyGateway({ port: 0 });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>((r) => server.close(() => r()));
  registry.clearRegistry(); tenantCrud.clearTenantsForTest(); plans.resetPlanStoreForTest(); lim.resetProxyAuthFailureLimiterForTest();
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});
beforeEach(() => { lim.resetProxyAuthFailureLimiterForTest(); upstreamCalls = 0; talRt.resetAccountingLayerForTest(); plans.resetPlanStoreForTest(); });

describe('H1-S06 tenant tokens registered through the API (SEC02-N02 length, INF05-F02 uniqueness)', () => {
  it('POST: 23 characters → 400; 24 characters → 201 (control)', async () => {
    const t23 = 'x'.repeat(23); const t24 = `s06-len-${RUN}`.padEnd(24, 'y');
    assert.equal((await call('POST', '/admin/tenants', platform, j({ tenantId: `s06-l23-${RUN}`, token: t23 }))).status, 400);
    assert.equal(registry.resolveTokenContext(t23), null);
    assert.equal((await call('POST', '/admin/tenants', platform, j({ tenantId: `s06-l24-${RUN}`, token: t24 }))).status, 201);
  });

  it('PUT: a short token → 400 and the tenant keeps its token', async () => {
    const tid = `s06-put-${RUN}`; const tok = `s06-put-token-${RUN}-0123456789`;
    assert.equal((await call('POST', '/admin/tenants', platform, j({ tenantId: tid, token: tok }))).status, 201);
    assert.equal((await call('PUT', `/admin/tenants/${tid}`, platform, j({ token: 'short' }))).status, 400);
    assert.equal(registry.resolveTokenContext(tok)?.tenantId, tid);
  });

  it('a token of another tenant (registry or CRUD, active or deactivated) → 409 on POST and PUT; own token on PUT → 200', async () => {
    const t1 = `s06-u1-${RUN}`; const tok1 = `s06-u1-token-${RUN}-0123456789`;
    const t2 = `s06-u2-${RUN}`; const tok2 = `s06-u2-token-${RUN}-0123456789`;
    assert.equal((await call('POST', '/admin/tenants', platform, j({ tenantId: t1, token: tok1 }))).status, 201);
    assert.equal((await call('POST', '/admin/tenants', platform, j({ tenantId: t2, token: tok2 }))).status, 201);
    assert.equal((await call('POST', '/admin/tenants', platform, j({ tenantId: `s06-u3-${RUN}`, token: A_TOKEN }))).status, 409, 'static registry token');
    assert.equal((await call('POST', '/admin/tenants', platform, j({ tenantId: `s06-u4-${RUN}`, token: tok1 }))).status, 409, 'CRUD token');
    assert.equal((await call('PUT', `/admin/tenants/${t2}`, platform, j({ token: tok1 }))).status, 409, 'PUT onto another tenant token');
    assert.equal(registry.resolveTokenContext(tok1)?.tenantId, t1);
    assert.equal(registry.resolveTokenContext(tok2)?.tenantId, t2);
    assert.equal((await call('PUT', `/admin/tenants/${t1}`, platform, j({ token: tok1, role: 'MEMBER' }))).status, 200, 'own token');
    assert.equal((await call('DELETE', `/admin/tenants/${t1}`, platform)).status, 200);
    assert.equal((await call('POST', '/admin/tenants', platform, j({ tenantId: `s06-u5-${RUN}`, token: tok1 }))).status, 409, 'token of a deactivated tenant');
  });
});

describe('H1-S06 proxy limiter of authentication failures (SEC02-N02)', () => {
  it('throttled source → 429 + Retry-After even with a valid token; another source with the same token → 200', async () => {
    process.env['OTK_PROXY_TRUSTED_HOPS'] = '1'; lim.resetProxyAuthFailureLimiterForTest();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 25; i++) statuses.push((await proxyCall(`s06-guess-${i}-${RUN}`, '203.0.113.7')).status);
      assert.deepEqual([...new Set(statuses)], [401, 429]);
      assert.equal(statuses.filter((s) => s === 401).length, 20, 'default: 20 failures per window');
      const blocked = await proxyCall(A_TOKEN, '203.0.113.7');
      assert.equal(blocked.status, 429);
      assert.ok(Number(blocked.retryAfter) >= 1, `Retry-After: ${blocked.retryAfter}`);
      const other = await proxyCall(A_TOKEN, '198.51.100.9');
      assert.equal(other.status, 200, 'the tenant is not locked out from other sources');
      assert.equal(upstreamCalls, 1, 'no throttled or wrong request reached the provider');
    } finally { delete process.env['OTK_PROXY_TRUSTED_HOPS']; }
  });

  it('without trusted hops X-Forwarded-For is ignored (a client cannot pick its own source)', async () => {
    lim.resetProxyAuthFailureLimiterForTest();
    for (let i = 0; i < 20; i++) await proxyCall(`s06-xff-${i}-${RUN}`, `192.0.2.${i}`);
    assert.equal((await proxyCall(`s06-xff-last-${RUN}`, '192.0.2.250')).status, 429);
  });

  it('successful authentications do not count (control)', async () => {
    for (let i = 0; i < 25; i++) assert.equal((await proxyCall(A_TOKEN)).status, 200);
  });
});

describe('H1-S06 AuthFailureLimiter unit', () => {
  it('window expiry, bounded memory, MAX=0 disables, source normalisation', () => {
    const l = new lim.AuthFailureLimiter({ max: 2, windowMs: 1000, maxEntries: 3 });
    l.recordFailure('a', 0); l.recordFailure('a', 10);
    assert.ok(l.throttledFor('a', 20) >= 1);
    assert.equal(l.throttledFor('b', 20), 0, 'other source unaffected');
    assert.equal(l.throttledFor('a', 1000), 0, 'window over');
    for (const s of ['s1', 's2', 's3', 's4', 's5']) l.recordFailure(s, 2000);
    assert.equal(l.size(), 3, 'bounded');
    const off = new lim.AuthFailureLimiter({ max: 0, windowMs: 1000, maxEntries: 3 });
    for (let i = 0; i < 10; i++) off.recordFailure('a', 0);
    assert.equal(off.throttledFor('a', 1), 0);
    const req = (addr: string) => ({ socket: { remoteAddress: addr }, headers: {} }) as any;
    assert.equal(lim.sourceKey(req('::ffff:10.1.2.3')), 'ip4:10.1.2.3');
    assert.equal(lim.sourceKey(req('2001:db8:1:2:aaaa::1')), lim.sourceKey(req('2001:db8:1:2:bbbb::9')), 'same /64');
    assert.notEqual(lim.sourceKey(req('2001:db8:1:2::1')), lim.sourceKey(req('2001:db8:1:3::1')));
  });
});
