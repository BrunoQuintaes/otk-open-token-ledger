/**
 * M24-SEC-01 (HIGH), M24-SEC-05 / F-FC-01 (MEDIUM), M24-SEC-04 (LOW) — RUN-M1-24H-20261010, found by static review and
 * reproduced here. The tenant registry holds STATIC tokens, the only credential the MITM proxy accepts, and the proxy
 * forwards with the OPERATOR's provider keys. A tenant role could write that registry for its own tenant: an anonymous
 * user ran POST /signup (OWNER of a new org), then POST /admin/tenants {tenantId: <own org>, token: <chosen>} and used
 * the token on the proxy, spending the operator's keys (bounded only by the plan quota, and /signup is unlimited).
 * The same writes let an ADMIN create an OWNER token or take over the OWNER's token (F-FC-01 and two more vectors).
 * Now every write to the tenant registry is a platform operation (x-admin-key); reads stay scoped to the caller's tenant
 * and no longer expose the platform-wide audit counter. Sentinel token value: 7919.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OPENAI_API_KEY'] = 'operator-provider-key-fixture';

const RUN = Date.now().toString(36);
const PLATFORM = `trp-platform-${RUN}-0123456789abcdef`;
const JWT_SECRET = `trp-jwt-${RUN}-0123456789abcdef`;
const ADMIN_A = `trp-admin-a-${RUN}`;
const A = `trp-a-${RUN}`;
const SENTINEL = `sentinel-tok-7919-${RUN}`;

let routes: typeof import('../../src/api/routes.js');
let registry: typeof import('../../src/api/tenantKeyRegistry.js');
let gw: typeof import('../../src/proxy/ProxyGateway.js');
let tenantCrud: typeof import('../../src/api/tenantCrud.js');
let server: Server; let base = '';
let upstreamCalls = 0;
const realFetch = globalThis.fetch;

function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter(); let sent = false;
  em.on('newListener', (ev: string) => { if (ev === 'end' && !sent) { sent = true; setImmediate(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); }); } });
  return Object.assign(em, { method, url, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' }, destroy: () => {} }) as unknown as IncomingMessage;
}
async function call(method: string, url: string, headers: Record<string, string> = {}, body = '') {
  let code = 200; let out = '';
  const res = { setHeader() {}, writeHead(c: number) { code = c; return res; }, end(d?: string) { if (d) out += String(d); }, get statusCode() { return code; }, set statusCode(c: number) { code = c; } };
  await routes.handleRequest(mockReq(method, url, body, headers), res as unknown as ServerResponse);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(out) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: code, json, body: out };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const platform = { 'x-admin-key': PLATFORM };
const proxyCall = (token: string) => realFetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-otk-provider': 'openai' },
  body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] }),
});

let origKey: string | undefined; let origJwt: string | undefined;
before(async () => {
  origKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  origJwt = process.env['OTK_JWT_SECRET']; process.env['OTK_JWT_SECRET'] = JWT_SECRET;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  tenantCrud = await import('../../src/api/tenantCrud.js');
  gw = await import('../../src/proxy/ProxyGateway.js');
  const { MemoryUserStore } = await import('../../src/users/MemoryUserStore.js');
  const { setUserStore } = await import('../../src/users/IUserStore.js');
  setUserStore(new MemoryUserStore());
  // fake provider: counts every call that would have used the operator's key
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://')) {
      upstreamCalls++;
      return new Response(JSON.stringify({ id: 'chatcmpl-fixture', object: 'chat.completion', model: 'gpt-4o-mini-2024-07-18',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } }),
      { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as string, init);
  }) as typeof fetch;
  server = gw.startProxyGateway({ port: 0 });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  globalThis.fetch = realFetch;
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  if (origKey === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origKey;
  if (origJwt === undefined) delete process.env['OTK_JWT_SECRET']; else process.env['OTK_JWT_SECRET'] = origJwt;
});
beforeEach(() => {
  registry.clearRegistry();
  tenantCrud.clearTenantsForTest();
  registry.registerToken(ADMIN_A, A, 'ADMIN');
  upstreamCalls = 0;
});

describe('M24-SEC-01: an anonymous /signup cannot mint a proxy token that spends the operator keys', () => {
  it('signup OWNER → POST /admin/tenants on its own org → 403, the token is not registered, the proxy refuses it and the provider is never called', async () => {
    const su = await call('POST', '/signup', {}, JSON.stringify({ email: `atk-${RUN}@example.test`, password: 'correct horse battery staple 7919', name: 'atk', orgName: 'atk org' }));
    assert.equal(su.status, 201, su.body);
    const jwt = String(su.json['token']); const org = String(su.json['orgId']);
    const r = await call('POST', '/admin/tenants', bearer(jwt), JSON.stringify({ tenantId: org, token: SENTINEL, role: 'MEMBER' }));
    assert.equal(r.status, 403, r.body);
    assert.equal(r.json['error'], 'platform_operation_forbidden');
    assert.equal(registry.resolveTokenContext(SENTINEL), null, 'the chosen token must not be accepted anywhere');
    const p = await proxyCall(SENTINEL);
    assert.equal(p.status, 401, `proxy answered ${p.status}`);
    assert.equal(upstreamCalls, 0, 'the operator key was never used');
  });

  it('the platform credential still provisions a tenant token, and the proxy then serves it (control)', async () => {
    const r = await call('POST', '/admin/tenants', platform, JSON.stringify({ tenantId: `trp-c-${RUN}`, token: `${SENTINEL}-platform`, role: 'MEMBER' }));
    assert.equal(r.status, 201, r.body);
    assert.equal(registry.resolveTokenContext(`${SENTINEL}-platform`)?.tenantId, `trp-c-${RUN}`);
    const p = await proxyCall(`${SENTINEL}-platform`);
    assert.notEqual(p.status, 401, 'a platform-provisioned token is accepted by the proxy');
    assert.equal(upstreamCalls, 1);
  });
});

describe('M24-SEC-05 / F-FC-01: an ADMIN cannot become OWNER through the tenant registry', () => {
  it('POST an OWNER token for its own tenant → 403 and nothing registered', async () => {
    const r = await call('POST', '/admin/tenants', bearer(ADMIN_A), JSON.stringify({ tenantId: A, token: `esc-7919-${RUN}`, role: 'OWNER' }));
    assert.equal(r.status, 403, r.body);
    assert.equal(registry.resolveTokenContext(`esc-7919-${RUN}`), null);
  });
  it('PUT on its own record (role OWNER, or a new token over an OWNER record) → 403 and the OWNER keeps its token', async () => {
    const owner = await call('POST', '/admin/tenants', platform, JSON.stringify({ tenantId: A, token: `owner-a-platform-token-${RUN}`, role: 'OWNER' }));
    assert.equal(owner.status, 201, owner.body);
    const up1 = await call('PUT', `/admin/tenants/${A}`, bearer(ADMIN_A), JSON.stringify({ role: 'OWNER' }));
    assert.equal(up1.status, 403, up1.body);
    const up2 = await call('PUT', `/admin/tenants/${A}`, bearer(ADMIN_A), JSON.stringify({ token: `takeover-7919-${RUN}` }));
    assert.equal(up2.status, 403, up2.body);
    assert.equal(registry.resolveTokenContext(`owner-a-platform-token-${RUN}`)?.role, 'OWNER', 'the OWNER token still works');
    assert.equal(registry.resolveTokenContext(`takeover-7919-${RUN}`), null);
  });
  it('DELETE of its own record → 403 and the record survives', async () => {
    await call('POST', '/admin/tenants', platform, JSON.stringify({ tenantId: A, token: `owner-a2-platform-token-${RUN}`, role: 'OWNER' }));
    const d = await call('DELETE', `/admin/tenants/${A}`, bearer(ADMIN_A));
    assert.equal(d.status, 403, d.body);
    assert.equal(registry.resolveTokenContext(`owner-a2-platform-token-${RUN}`)?.tenantId, A);
  });
});

describe('M24-SEC-04: the tenant list shows no platform-wide audit counter to a tenant role', () => {
  it('GET /admin/tenants by a tenant ADMIN has no audit field; the platform still sees it', async () => {
    for (let i = 0; i < 3; i++) await call('POST', '/admin/tenants', platform, JSON.stringify({ tenantId: `trp-x${i}-${RUN}`, token: `x${i}-7919-platform-token-${RUN}`, role: 'MEMBER' }));
    const t = await call('GET', '/admin/tenants', bearer(ADMIN_A));
    assert.equal(t.status, 200, t.body);
    assert.equal(t.json['audit'], undefined, 'no audit head/count of other tenants');
    assert.ok(!t.body.includes('trp-x'), 'no other tenant appears');
    const p = await call('GET', '/admin/tenants', platform);
    assert.equal(p.status, 200);
    assert.ok(p.json['audit'], 'platform keeps the audit status');
  });
});
