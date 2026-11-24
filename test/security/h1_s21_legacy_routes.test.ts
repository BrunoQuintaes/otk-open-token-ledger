/**
 * H1-S21 (OTK-H1-MEGA-S01-S24-20261013, lane D): legacy route handling, documented by tests
 * (docs/_ops/H1/LANED_20261013/S21_LEGACY_ROUTES.md).
 *
 * What is pinned here is the CURRENT behaviour of the compatibility layer, with the security property of each case:
 *  - /v1 prefix: cut ONCE; routes declared with a literal '/v1/...' in routes.ts are reachable only at '/v1/v1/...'
 *    (NF-15), except /auth/refresh which has three spellings;
 *  - webhook list/create (GET/POST /v1/v1/webhooks) were unreachable (S21-F01); since H1R2 C4 every spelling answers an
 *    explicit 501 'webhook_management_disabled' after authentication; no endpoint can be created through the API;
 *  - trailing-slash variants: only the routes that list them answer; protected routes do not gain an unguarded twin;
 *  - '//host/path' (authority confusion of new URL(path, base)): the guard of the resolved route still applies (S21-F02);
 *  - OTK_STRICT_VERSIONING=1: redirect to a relative '/v1...' Location (never protocol-relative): 301 for GET/HEAD,
 *    308 for POST and other methods with a body (S21-F03, H1R2 C4);
 *  - legacy POST /proxy of the gateway: same auth as the MITM path; GET /proxy is 404; '/proxy/' is a MITM path;
 *    a non-numeric userId is refused with 400 (S21-F04, fixed in H1).
 * In-memory stores, provider fetch stubbed (no network, no paid call).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OPENAI_API_KEY'] = 'provider-key-fixture-s21';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];
delete process.env['OTK_STRICT_VERSIONING'];
delete process.env['OTK_PROXY_ALLOW_UNAUTHENTICATED'];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
let routes: any; let registry: any; let whMod: any; let gw: any; let store: any; let limiter: any;

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
  writeHead(c: number, h?: Record<string, unknown>) { this.statusCode = c; if (h) for (const [k, v] of Object.entries(h)) this.hdrs[k.toLowerCase()] = v; this.headersSent = true; return this; }
  write(d: unknown) { this.body += String(d); return true; }
  end(d?: unknown) { if (d !== undefined && d !== null) this.body += String(d); this.headersSent = true; this.emit('finish'); return this; }
}
async function call(method: string, url: string, headers: Record<string, string> = {}, body = ''): Promise<{ status: number; body: string; json: Json; hdrs: Record<string, unknown> }> {
  const res = new MockRes();
  await Promise.race([
    routes.handleRequest(mockReq(method, url, body, headers), res as unknown as ServerResponse),
    new Promise((r) => { setTimeout(r, 4000).unref(); }),
  ]);
  let json: Json; try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.statusCode, body: res.body, json, hdrs: res.hdrs };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const RUN = Date.now().toString(36);
const A = `s21a-${RUN}`; const B = `s21b-${RUN}`;
const OWNER_A = `s21-owner-a-${RUN}-0123456789`; const MEMBER_A = `s21-member-a-${RUN}-0123456789`;
const VIEWER_A = `s21-viewer-a-${RUN}-0123456789`;
const PLATFORM = `s21-platform-${RUN}-0123456789abcdef`;
const platform = { 'x-admin-key': PLATFORM };
let origAdmin: string | undefined;
let server: Server; let base = '';
const realFetch = globalThis.fetch;
let upstreamCalls = 0;

before(async () => {
  origAdmin = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  whMod = await import('../../src/webhooks/WebhookRegistry.js');
  gw = await import('../../src/proxy/ProxyGateway.js');
  store = await import('../../src/api/receiptStore.js');
  limiter = await import('../../src/security/authFailureLimiter.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest();
  registry.registerToken(OWNER_A, A, 'OWNER'); registry.registerToken(MEMBER_A, A, 'MEMBER'); registry.registerToken(VIEWER_A, A, 'VIEWER');
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://')) {
      upstreamCalls++;
      return new Response(JSON.stringify({ id: `s21-up-${upstreamCalls}`, model: 'gpt-4o', usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
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
  if (origAdmin === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origAdmin;
});

describe('H1-S21 /v1 prefix: cut once (NF-15 double prefix)', () => {
  it('ordinary routes answer with and without /v1; /v1/v1/<ordinary> is 404', async () => {
    assert.equal((await call('GET', '/health')).status, 200);
    assert.equal((await call('GET', '/v1/health')).status, 200);
    assert.equal((await call('GET', '/v1/v1/health')).status, 404);
    assert.equal((await call('GET', '/v1/keys', bearer(OWNER_A))).status, 200);
    assert.equal((await call('GET', '/v1/v1/keys', bearer(OWNER_A))).status, 404);
    // '/v1' without a trailing slash and '/V1/' are not prefixes
    assert.equal((await call('GET', '/v1')).status, 404);
    assert.equal((await call('GET', '/V1/health')).status, 404);
  });
  it('routes declared with a literal /v1/ are reachable only at /v1/v1/... (platform credential = positive control)', async () => {
    for (const p of ['/reconciliation/reports', '/admin/ga-readiness', '/admin/prices']) {
      assert.equal((await call('GET', `/v1${p}`, platform)).status, 404, `single prefix ${p}`);
      assert.equal((await call('GET', p, platform)).status, 404, `bare ${p}`);
      assert.equal((await call('GET', `/v1/v1${p}`, platform)).status, 200, `double prefix ${p}`);
    }
    assert.equal((await call('GET', `/v1/tenants/${A}/provider-keys`, bearer(OWNER_A))).status, 404);
    assert.equal((await call('GET', `/v1/v1/tenants/${A}/provider-keys`, bearer(OWNER_A))).status, 200);
    assert.equal((await call('GET', '/v1/reports/teams', bearer(OWNER_A))).status, 404);
    assert.equal((await call('GET', '/v1/v1/reports/teams', bearer(OWNER_A))).status, 200);
  });
  it('the double-prefix routes keep their guards: no credential → 401, tenant OWNER on platform routes → 403', async () => {
    for (const p of ['/v1/v1/reconciliation/reports', '/v1/v1/admin/ga-readiness', '/v1/v1/admin/prices']) {
      assert.equal((await call('GET', p)).status, 401, p);
      const o = await call('GET', p, bearer(OWNER_A));
      assert.equal(o.status, 403, p); assert.equal(o.json?.error, 'platform_operation_forbidden');
    }
    assert.equal((await call('GET', `/v1/v1/tenants/${B}/provider-keys`, bearer(OWNER_A))).status, 403);
  });
  it('/auth/refresh has three spellings, all with the same validation (no token minted from an empty body)', async () => {
    for (const p of ['/auth/refresh', '/v1/auth/refresh', '/v1/v1/auth/refresh']) {
      const r = await call('POST', p, {}, '{}');
      assert.equal(r.status, 400, `${p}: ${r.body}`); assert.equal(r.json?.code, 'OTK-4001');
      assert.equal(r.json?.token, undefined);
    }
  });
});

describe('H1-S21 webhook management block (S21-F01)', () => {
  it('list and create are disabled at every spelling (H1R2 C4: explicit 501, was 404); no endpoint is created', async () => {
    const before = (await whMod.getWebhookStore().listEndpoints(A)).length;
    const body = JSON.stringify({ url: 'https://hooks.example.invalid/s21', events: ['*'] });
    for (const p of ['/webhooks', '/v1/webhooks', '/v1/v1/webhooks']) {
      const g = await call('GET', p, bearer(OWNER_A));
      assert.equal(g.status, 501, `GET ${p}`); assert.equal(g.json?.error, 'webhook_management_disabled');
      const c = await call('POST', p, bearer(OWNER_A), body);
      assert.equal(c.status, 501, `POST ${p}`); assert.equal(c.json?.error, 'webhook_management_disabled');
    }
    assert.equal((await whMod.getWebhookStore().listEndpoints(A)).length, before);
  });
  it('the block still authenticates before answering: /v1/v1/webhooks without a credential → 401', async () => {
    assert.equal((await call('GET', '/v1/v1/webhooks')).status, 401);
    assert.equal((await call('POST', '/v1/v1/webhooks', {}, '{}')).status, 401);
  });
  it('POST /v1/webhooks/stripe is the Stripe webhook (prefix cut), not the management block', async () => {
    const r = await call('POST', '/v1/webhooks/stripe', { 'stripe-signature': 't=1,v1=00' }, '{}');
    assert.notEqual(r.status, 401); // no tenant credential involved; answered by the Stripe handler (secret not configured here)
    assert.ok([500, 503].includes(r.status), `${r.status} ${r.body}`);
  });
});

describe('H1-S21 trailing-slash and path variants', () => {
  it('public pages list their slash variant; liveness does not', async () => {
    for (const p of ['/status/', '/pricing/', '/analytics/', '/demo/', '/changelog/', '/terms/', '/privacy/', '/dpa/']) {
      assert.equal((await call('GET', p)).status, 200, p);
    }
    assert.equal((await call('GET', '/health/')).status, 404);
    assert.equal((await call('GET', '/openapi.json/')).status, 404);
  });
  it('a slash variant of a protected route is never an unguarded twin', async () => {
    // POST /receipts/ is not the receipt write; GET /receipts/ reads id "" (guarded, not found)
    const w = await call('POST', '/receipts/', bearer(MEMBER_A), JSON.stringify({ requestId: `s21-${RUN}`, provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1, outputTokens: 1 }));
    assert.equal(w.status, 404);
    assert.equal(store.getReceipt(`s21-${RUN}`), undefined);
    assert.equal((await call('GET', '/receipts/')).status, 401);
    assert.equal((await call('GET', '/receipts/', bearer(VIEWER_A))).status, 404);
    for (const p of ['/admin/finance/', '/accounting/balance/', '/admin/plans/assign/', '/invoices/']) {
      const r = await call(p.includes('assign') ? 'POST' : 'GET', p, bearer(OWNER_A), '{}');
      assert.equal(r.status, 404, `${p}: ${r.status}`);
    }
    // the flags list accepts '/admin/flags/' with the same platform guard
    assert.equal((await call('GET', '/admin/flags/', bearer(OWNER_A))).status, 403);
    assert.equal((await call('GET', '/admin/flags/', platform)).status, 200);
  });
  it('S21-F02: "//host/admin/finance" is parsed as authority + "/admin/finance" and keeps the platform guard', async () => {
    const none = await call('GET', '//evil.invalid/admin/finance');
    assert.equal(none.status, 401);
    const owner = await call('GET', '//evil.invalid/admin/finance', bearer(OWNER_A));
    assert.equal(owner.status, 403); assert.equal(owner.json?.error, 'platform_operation_forbidden');
    assert.equal((await call('GET', '//evil.invalid/admin/finance', platform)).status, 200, 'positive control');
    // the first segment is swallowed as the host: "//v1/health" is "/health", "//x/v1/health" is "/v1/health"
    assert.equal((await call('GET', '//v1/health')).status, 200);
    assert.equal((await call('GET', '//x/v1/v1/health')).status, 404);
  });
});

describe('H1-S21 strict versioning (OTK_STRICT_VERSIONING=1)', () => {
  const withStrict = async <T>(fn: () => Promise<T>): Promise<T> => {
    process.env['OTK_STRICT_VERSIONING'] = '1';
    try { return await fn(); } finally { delete process.env['OTK_STRICT_VERSIONING']; }
  };
  it('unversioned routes get a redirect to a relative /v1 Location: 301 for GET, 308 for POST (S21-F03 fixed in H1R2 C4)', async () => {
    await withStrict(async () => {
      const g = await call('GET', '/receipts/x?y=1');
      assert.equal(g.status, 301); assert.equal(g.hdrs['location'], '/v1/receipts/x?y=1');
      const p = await call('POST', '/receipts', bearer(MEMBER_A), '{}');
      assert.equal(p.status, 308); assert.equal(p.hdrs['location'], '/v1/receipts');
    });
  });
  it('the Location is never protocol-relative nor absolute (no open redirect)', async () => {
    await withStrict(async () => {
      for (const u of ['//evil.invalid/x', '/\\evil.invalid/x', '/%2F%2Fevil.invalid', '/.//evil.invalid']) {
        const r = await call('GET', u);
        if (r.status !== 301 && r.status !== 308) continue;
        const loc = String(r.hdrs['location']);
        assert.ok(loc.startsWith('/v1/') || loc === '/v1', `${u} → ${loc}`);
        assert.ok(!loc.startsWith('//') && !/^[a-z]+:/i.test(loc), `${u} → ${loc}`);
      }
    });
  });
  it('infra routes, /app and /system/status are exempt; versioned paths are served', async () => {
    await withStrict(async () => {
      for (const p of ['/health', '/healthz', '/version', '/openapi.json', '/system/status']) assert.notEqual((await call('GET', p)).status, 301, p);
      assert.equal((await call('GET', '/v1/health')).status, 200);
    });
  });
});

describe('H1-S21 legacy POST /proxy (gateway)', () => {
  const post = async (p: string, token?: string, body: Record<string, unknown> = {}) => {
    const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', ...(token ? bearer(token) : {}) }, body: JSON.stringify(body) });
    const text = await res.text(); let json: Json; try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, text };
  };
  const ev = (rid: string, extra: Record<string, unknown> = {}) => ({ requestId: rid, provider: 'openai', model: 'gpt-4o', inputTokens: 3, outputTokens: 2, userId: '1', nonce: '1', ...extra });
  it('no token → 401, VIEWER → 403, MEMBER → 200 stamped with its own tenant (body tenantId ignored)', async () => {
    limiter.resetProxyAuthFailureLimiterForTest();
    const r0 = `s21-p0-${RUN}`; const r1 = `s21-p1-${RUN}`; const r2 = `s21-p2-${RUN}`;
    assert.equal((await post('/proxy', undefined, ev(r0))).status, 401);
    assert.equal((await post('/proxy', VIEWER_A, ev(r1))).status, 403);
    assert.equal(store.getReceipt(r0), undefined); assert.equal(store.getReceipt(r1), undefined);
    const ok = await post('/proxy', MEMBER_A, ev(r2, { tenantId: B }));
    assert.equal(ok.status, 200, ok.text);
    assert.equal(store.getReceipt(r2)?.tenantId, A);
  });
  it('GET /proxy is 404; POST /proxy/ is a MITM path with the same authentication', async () => {
    limiter.resetProxyAuthFailureLimiterForTest();
    const g = await fetch(`${base}/proxy`); await g.text();
    assert.equal(g.status, 404);
    const before = upstreamCalls;
    assert.equal((await post('/proxy/', undefined, {})).status, 401);
    assert.equal((await post('/proxy/', VIEWER_A, {})).status, 403);
    assert.equal(upstreamCalls, before, 'refused MITM calls never reach the provider');
  });
  // S21-F04: fixed in ProxyGateway (BigInt parsing guarded → 400 invalid_integer_field); todo removed
  it('a non-numeric userId is a client error (400), not a 500 with the parser message', async () => {
    limiter.resetProxyAuthFailureLimiterForTest();
    const rid = `s21-bad-${RUN}`;
    const r = await post('/proxy', MEMBER_A, ev(rid, { userId: 'not-a-number' }));
    assert.equal(store.getReceipt(rid), undefined, 'no receipt either way');
    assert.equal(r.status, 400, r.text);
  });
});
