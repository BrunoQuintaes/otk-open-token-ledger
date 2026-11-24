/**
 * H1-S24 (OTK-H1-MEGA-S01-S24-20261013, lane D): API contract tests (docs/_ops/H1/LANED_20261013/S24_API_CONTRACT.md).
 *
 * 1. /openapi.json is valid JSON (OpenAPI 3.1.0), its version equals GET /version, and every documented path is a real
 *    route of the inventory (no phantom path). Routes of the inventory missing from the spec are REPORTED (diagnostic),
 *    not failed: the spec documents a subset on purpose.
 * 2. Error envelope: every OTK code's first three digits equal its HTTP status; sampled sendError answers have the
 *    envelope shape and echo x-request-id; every BARE error string written by routes.ts / gdpr.ts is documented.
 * 3. Versioning: no version header; /v1 prefix answers the same; x-request-id echoed.
 * 4. Idempotency-Key on POST /receipts: replay = same status and body, no new effect; other body = 409 OTK-4091.
 * 5. Error codes introduced by this run are present in the source AND documented in the spec; the reachable ones are
 *    exercised (plans 404, checkout 400, keys 403 email_not_verified with a positive control, proxy 429 + Retry-After).
 * 6. Every path called by the SDKs (sdk/src/index.ts, sdk/python) is a real route.
 * In-memory stores; the proxy gateway listens on 127.0.0.1 with the provider fetch stubbed (no external network).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

const RUN = Date.now().toString(36);
process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OPENAI_API_KEY'] = 'provider-key-fixture-s24';
process.env['OTK_JWT_SECRET'] = `s24-jwt-${RUN}-0123456789abcdef0123`;
process.env['OTK_PROXY_AUTH_FAIL_MAX'] = '2';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];
delete process.env['OTK_STRICT_VERSIONING'];
delete process.env['OTK_BILLING_REDIRECT_ORIGINS'];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');
const SPEC: Json = JSON.parse(read('docs/api/openapi.json'));

let routes: any; let registry: any; let errors: any; let users: any; let memUsers: any; let ev: any; let gw: any; let limiter: any; let store: any;

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

const A = `s24a-${RUN}`;
const OWNER_A = `s24-owner-a-${RUN}-0123456789`; const MEMBER_A = `s24-member-a-${RUN}-0123456789`; const VIEWER_A = `s24-viewer-a-${RUN}-0123456789`;
const PLATFORM = `s24-platform-${RUN}-0123456789abcdef`;
let origAdmin: string | undefined;
let server: Server; let base = '';
const realFetch = globalThis.fetch;

before(async () => {
  origAdmin = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  errors = await import('../../src/api/errors.js');
  users = await import('../../src/users/IUserStore.js');
  memUsers = await import('../../src/users/MemoryUserStore.js');
  ev = await import('../../src/auth/emailVerification.js');
  gw = await import('../../src/proxy/ProxyGateway.js');
  limiter = await import('../../src/security/authFailureLimiter.js');
  store = await import('../../src/api/receiptStore.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest();
  registry.registerToken(OWNER_A, A, 'OWNER'); registry.registerToken(MEMBER_A, A, 'MEMBER'); registry.registerToken(VIEWER_A, A, 'VIEWER');
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://')) return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    return realFetch(input as string, init);
  }) as typeof fetch;
});
after(async () => {
  globalThis.fetch = realFetch;
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (origAdmin === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origAdmin;
});

// ── route inventory: extractor + supplementary handlers (see test/security/h1_s08_route_matrix_gaps.test.ts) ──
type Route = { server: string; methods: string[]; kind: string; path: string; file: string };
const EXTRACTED = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ops', 'extract_routes.mjs'), ROOT, '--json'], { encoding: 'utf-8' })) as Route[];
const DISPATCHERS = new Set(['/v1/', '/auth/saml/', '/auth/oidc/', '/app', '/v1/webhooks', '/scim/v2/', '/admin/gdpr/', '/admin/flags']);
// H1R2 C1 (S08-F01 fixed): the extractor now reports the handlers that the supplementary list used to cover (regex
// conditions, *Match variables, flagsPath), so the list is gone and regex/except routes are matched here.
/** True when (method, concrete path) is served by a handler of the given server (api: routes.ts, SCIM, dashboard). */
function isRoute(method: string, concrete: string, srv: 'api' | 'proxy' = 'api'): boolean {
  // the API dispatcher cuts one leading /v1 (routes declared with a literal /v1 live at /v1/v1/..., NF-15)
  const rp = srv === 'api' && concrete.startsWith('/v1/') ? concrete.slice(3) : concrete;
  for (const r of EXTRACTED) {
    if (r.server !== srv || (DISPATCHERS.has(r.path) && r.methods.includes('ANY'))) continue;
    if (!r.methods.includes('ANY') && !r.methods.includes(method)) continue;
    if (r.kind === 'eq' && r.path === rp) return true;
    if (r.kind === 'prefix' && rp.startsWith(r.path) && rp.length > r.path.length) return true;
    if (r.kind === 'regex') { const m = r.path.match(/^\/(.*)\/([a-z]*)$/); if (m && new RegExp(m[1]!, m[2]).test(rp)) return true; }
    if (r.kind === 'except' && !r.path.split(',').includes(rp)) return true;
  }
  return false;
}
const concrete = (p: string) => p.replace(/\{[^}]+\}/g, 'sample-id');

// ── 1. OpenAPI ──
describe('H1-S24 /openapi.json', () => {
  it('is served as valid JSON (3.1.0) and its version equals GET /version apiVersion', async () => {
    const r = await call('GET', '/openapi.json');
    assert.equal(r.status, 200);
    assert.match(String(r.hdrs['content-type']), /^application\/json/);
    assert.equal(r.json.openapi, '3.1.0');
    const v = await call('GET', '/version');
    assert.equal(r.json.info.version, v.json.apiVersion);
    for (const [p, ops] of Object.entries<Json>(r.json.paths)) {
      for (const [m, op] of Object.entries<Json>(ops)) {
        assert.ok(op.responses && Object.keys(op.responses).length > 0, `${m.toUpperCase()} ${p} documents responses`);
      }
    }
  });
  it('every documented path+method is a real route (no phantom path); undocumented routes are reported', (t) => {
    const phantom: string[] = [];
    for (const [p, ops] of Object.entries<Json>(SPEC.paths)) {
      for (const [m, op] of Object.entries<Json>(ops)) {
        const srv = Array.isArray(op.servers) && op.servers.some((s: Json) => String(s.url).includes('8788')) ? 'proxy' : 'api';
        if (!isRoute(m.toUpperCase(), concrete(p), srv)) phantom.push(`${m.toUpperCase()} ${p}`);
      }
    }
    assert.deepEqual(phantom, []);
    const documented = new Set(Object.entries<Json>(SPEC.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${concrete(p)}`)));
    const missing = EXTRACTED.filter((r) => r.file === 'src/api/routes.ts' && !DISPATCHERS.has(r.path))
      .flatMap((r) => (r.methods.includes('ANY') ? ['GET'] : r.methods).map((m) => `${m} ${r.kind === 'prefix' ? `${r.path}{id}` : r.path}`))
      .filter((k) => ![...documented].some((d) => d === k || (k.endsWith('{id}') && d.startsWith(k.slice(0, -4)))));
    t.diagnostic(`routes of src/api/routes.ts not in the spec: ${missing.length}: ${missing.join(', ')}`);
    assert.ok(missing.length > 0, 'the spec is a documented subset (see S24_API_CONTRACT.md)');
  });
});

// ── 2. error envelope ──
const ENVELOPE_KEYS = new Set(['ok', 'error', 'code', 'message', 'details', 'requestId', 'retryAfterMs']);
function assertEnvelope(r: { status: number; json: Json }, code: string, reqId?: string) {
  assert.equal(r.json?.ok, false);
  assert.equal(r.json.code, code);
  assert.equal(r.status, Number(code.slice(4, 7)), `${code} vs status ${r.status}`);
  assert.equal(typeof r.json.error, 'string'); assert.equal(typeof r.json.message, 'string');
  for (const k of Object.keys(r.json)) assert.ok(ENVELOPE_KEYS.has(k), `unexpected envelope key ${k}`);
  if (reqId) assert.equal(r.json.requestId, reqId);
}
describe('H1-S24 error envelope', () => {
  it('every registered OTK code: first three digits = HTTP status, a message and a legacy error string', () => {
    for (const [code, def] of Object.entries<Json>(errors.ERROR_REGISTRY)) {
      assert.match(code, /^OTK-[45]\d{3}$/);
      assert.equal(def.status, Number(code.slice(4, 7)), code);
      assert.ok(def.message && def.legacyError, code);
    }
  });
  it('sampled sendError answers have the envelope shape and echo x-request-id', async () => {
    const rid = `s24-req-${RUN}`;
    assertEnvelope(await call('GET', `/no-such-route-${RUN}`, { 'x-request-id': rid }), 'OTK-4040', rid);
    assertEnvelope(await call('POST', '/receipts', { ...bearer(MEMBER_A), 'x-request-id': rid }, '{not json'), 'OTK-4002', rid);
    assertEnvelope(await call('POST', '/receipts', { 'x-request-id': rid }, '{}'), 'OTK-4010', rid);
    assertEnvelope(await call('POST', '/receipts', { ...bearer(VIEWER_A), 'x-request-id': rid }, '{}'), 'OTK-4030', rid);
    assertEnvelope(await call('POST', '/receipts', bearer(MEMBER_A), JSON.stringify({ requestId: `s24-v-${RUN}` })), 'OTK-4001');
  });
  it('S24-F01: bare errors (no code) are a second shape; every bare error string of routes.ts and gdpr.ts is documented', async () => {
    const src = read('src/api/routes.ts') + read('src/api/gdpr.ts');
    const bare = [...new Set([...src.matchAll(/sendJson\(res, [45]\d\d, \{ ok: false, error: '([a-z_]+)'/g)].map((m) => m[1]!))].sort();
    assert.ok(bare.length >= 14, `found ${bare.length}`);
    const doc = String(SPEC.components.schemas.ErrorResponse.properties.error.description);
    assert.deepEqual(bare.filter((e) => !doc.includes(e)), [], 'document every bare error in ErrorResponse.error');
    // one live sample: no code, but ok/error/detail/requestId
    const r = await call('GET', '/admin/finance', { ...bearer(OWNER_A), 'x-request-id': `s24-bare-${RUN}` });
    assert.equal(r.status, 403);
    assert.deepEqual(Object.keys(r.json).sort(), ['detail', 'error', 'ok', 'requestId']);
    assert.equal(r.json.error, 'platform_operation_forbidden');
  });
});

// ── 3. versioning ──
describe('H1-S24 versioning headers', () => {
  it('no version header is emitted; /version and /v1/version answer the same; x-request-id is echoed or generated', async () => {
    const a = await call('GET', '/version', { 'x-request-id': 'fixed-id' });
    const b = await call('GET', '/v1/version');
    assert.deepEqual({ ...a.json, requestId: undefined }, { ...b.json, requestId: undefined });
    for (const h of Object.keys(a.hdrs)) assert.ok(!/version/i.test(h), `unexpected version header ${h}`);
    assert.equal(a.hdrs['x-request-id'], 'fixed-id');
    assert.match(String(b.hdrs['x-request-id']), /^[0-9a-f-]{36}$/);
  });
});

// ── 4. idempotency ──
describe('H1-S24 Idempotency-Key on POST /receipts', () => {
  const receipt = (rid: string, inTok = 10) => JSON.stringify({ requestId: rid, provider: 'openai', model: 'gpt-4o-mini', inputTokens: inTok, outputTokens: 5 });
  it('replay with the same key and body → same status and body, no second receipt; different body → 409 OTK-4091', async () => {
    const key = `s24-idem-${RUN}`; const rid = `s24-idem-r-${RUN}`;
    const h = { ...bearer(MEMBER_A), 'idempotency-key': key };
    const first = await call('POST', '/receipts', h, receipt(rid));
    assert.equal(first.status, 201, first.body);
    const sizeAfterFirst = store.size();
    const replay = await call('POST', '/receipts', h, receipt(rid));
    assert.equal(replay.status, 201);
    assert.equal(replay.body, first.body, 'byte-identical replay (duplicate:false is replayed as is)');
    assert.equal(store.size(), sizeAfterFirst);
    const conflict = await call('POST', '/receipts', h, receipt(rid, 11));
    assertEnvelope(conflict, 'OTK-4091');
    // control: the same requestId without the key is the documented duplicate answer (200, duplicate:true)
    const dup = await call('POST', '/receipts', bearer(MEMBER_A), receipt(rid));
    assert.equal(dup.status, 200); assert.equal(dup.json.duplicate, true);
  });
  it('error answers are not cached: after a 400 the same key with a valid body is processed', async () => {
    const key = `s24-idem-err-${RUN}`; const h = { ...bearer(MEMBER_A), 'idempotency-key': key };
    const bad = await call('POST', '/receipts', h, JSON.stringify({ requestId: `s24-e-${RUN}` }));
    assert.equal(bad.status, 400);
    const ok = await call('POST', '/receipts', h, receipt(`s24-e2-${RUN}`));
    assert.equal(ok.status, 201, ok.body);
  });
});

// ── 5. error codes introduced by this run ──
type NewCode = { path: string; method: string; status: string; error: string; src: string; needle: string };
const NEW_CODES: NewCode[] = [
  { path: '/admin/plans/assign', method: 'post', status: '404', error: 'tenant_not_found', src: 'src/api/routes.ts', needle: "error: 'tenant_not_found'" },
  { path: '/admin/plans/assign', method: 'post', status: '409', error: 'plan_version_conflict', src: 'src/api/routes.ts', needle: "error: 'plan_version_conflict'" },
  { path: '/admin/plans/assign', method: 'post', status: '503', error: 'plan_store_unavailable', src: 'src/api/routes.ts', needle: "error: 'plan_store_unavailable'" },
  { path: '/webhooks/stripe', method: 'post', status: '503', error: 'received: false', src: 'src/api/routes.ts', needle: 'sendJson(res, 503, { received: false, result })' },
  { path: '/billing/checkout', method: 'post', status: '400', error: 'redirect_not_allowed', src: 'src/api/routes.ts', needle: "error: 'redirect_not_allowed'" },
  { path: '/billing/checkout', method: 'post', status: '400', error: 'tenant_context_required', src: 'src/api/routes.ts', needle: "error: 'tenant_context_required'" },
  { path: '/proxy', method: 'post', status: '429', error: 'too_many_auth_failures', src: 'src/proxy/ProxyGateway.ts', needle: "status: 429, error: 'too_many_auth_failures'" },
  { path: '/keys', method: 'post', status: '403', error: 'email_not_verified', src: 'src/api/routes.ts', needle: "error: 'email_not_verified'" },
  { path: '/keys/{keyId}/rotate', method: 'post', status: '403', error: 'email_not_verified', src: 'src/api/routes.ts', needle: "error: 'email_not_verified'" },
  { path: '/admin/gdpr/erase/{tenantId}', method: 'delete', status: '501', error: 'gdpr_store_not_configured', src: 'src/api/gdpr.ts', needle: "error: 'gdpr_store_not_configured'" },
];
describe('H1-S24 error codes of this run: in the source and in the spec', () => {
  for (const c of NEW_CODES) {
    it(`${c.method.toUpperCase()} ${c.path} ${c.status} ${c.error}`, () => {
      assert.ok(read(c.src).includes(c.needle), `source ${c.src} contains ${c.needle}`);
      const resp = SPEC.paths[c.path]?.[c.method]?.responses?.[c.status];
      assert.ok(resp, `spec documents ${c.status} for ${c.method.toUpperCase()} ${c.path}`);
      assert.ok(String(resp.description).includes(c.error), `description of ${c.status} mentions ${c.error}`);
    });
  }
  it('Retry-After is documented on the proxy 429', () => {
    assert.ok(SPEC.paths['/proxy'].post.responses['429'].headers['Retry-After']);
  });
});

describe('H1-S24 error codes of this run: reachable ones exercised', () => {
  it('POST /admin/plans/assign by the platform for an unknown tenant → 404 { ok:false, error:"tenant_not_found", tenantId }', async () => {
    const r = await call('POST', '/admin/plans/assign', { 'x-admin-key': PLATFORM }, JSON.stringify({ tenantId: `s24-ghost-${RUN}`, tier: 'STARTER' }));
    assert.equal(r.status, 404, r.body);
    assert.equal(r.json.error, 'tenant_not_found'); assert.equal(r.json.tenantId, `s24-ghost-${RUN}`); assert.equal(r.json.code, undefined);
    // positive control: an existing tenant gets its plan
    const ok = await call('POST', '/admin/plans/assign', { 'x-admin-key': PLATFORM }, JSON.stringify({ tenantId: A, tier: 'FREE' }));
    assert.equal(ok.status, 200, ok.body);
  });
  it('POST /billing/checkout with a redirect outside the allowlist → 400 redirect_not_allowed (localhost passes the check)', async () => {
    const bad = await call('POST', '/billing/checkout', bearer(OWNER_A), JSON.stringify({ tier: 'PRO', successUrl: 'https://evil.invalid/ok', cancelUrl: 'http://localhost/c' }));
    assert.equal(bad.status, 400); assert.equal(bad.json.error, 'redirect_not_allowed');
    const good = await call('POST', '/billing/checkout', bearer(OWNER_A), JSON.stringify({ tier: 'PRO', successUrl: 'http://localhost/ok', cancelUrl: 'http://localhost/c' }));
    assert.equal(good.status, 500, 'passes the redirect check and stops at the missing Stripe key (no network)');
    assert.equal(good.json.code, 'OTK-5000');
  });
  it('POST /keys with a JWT of an unverified signup user → 403 email_not_verified; after verification → 201', async () => {
    users.setUserStore(new memUsers.MemoryUserStore());
    const s = await call('POST', '/signup', {}, JSON.stringify({ email: `s24-${RUN}@example.invalid`, password: 'synthetic-pass-1234', name: 'S24', orgName: `s24 org ${RUN}` }));
    assert.equal(s.status, 201, s.body);
    const denied = await call('POST', '/keys', bearer(s.json.token), JSON.stringify({ label: 'k' }));
    assert.equal(denied.status, 403); assert.equal(denied.json.error, 'email_not_verified'); assert.equal(denied.json.code, undefined);
    const v = await call('POST', '/verify-email', {}, JSON.stringify({ token: ev.generateVerificationToken(s.json.userId) }));
    assert.equal(v.status, 200, v.body);
    const ok = await call('POST', '/keys', bearer(s.json.token), JSON.stringify({ label: 'k' }));
    assert.equal(ok.status, 201, ok.body); assert.equal(ok.json.key.tenantId, s.json.orgId);
  });
  it('proxy: after OTK_PROXY_AUTH_FAIL_MAX failures the source gets 429 too_many_auth_failures with Retry-After, valid token included', async () => {
    limiter.resetProxyAuthFailureLimiterForTest();
    server = gw.startProxyGateway({ port: 0 });
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const post = async (token: string) => {
      const res = await fetch(`${base}/proxy`, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer(token) }, body: JSON.stringify({ requestId: `s24-px-${RUN}-${token.length}`, provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1, outputTokens: 1 }) });
      return { status: res.status, retryAfter: res.headers.get('retry-after'), json: await res.json() as Json };
    };
    assert.equal((await post('bad-token-1')).status, 401);
    assert.equal((await post('bad-token-2')).status, 401);
    const t = await post(MEMBER_A);
    assert.equal(t.status, 429);
    assert.deepEqual({ ok: t.json.ok, error: t.json.error }, { ok: false, error: 'too_many_auth_failures' });
    assert.match(String(t.retryAfter), /^\d+$/);
    // positive control: a fresh limiter lets the valid token through
    limiter.resetProxyAuthFailureLimiterForTest();
    assert.equal((await post(MEMBER_A)).status, 200);
  });
});

// ── 6. SDK paths ──
describe('H1-S24 SDK paths', () => {
  it('every path called by the TypeScript and Python SDKs is a real API route', () => {
    const ts = read('sdk/src/index.ts'); const py = read('sdk/python/otk_metering/__init__.py');
    const calls: Array<[string, string]> = [];
    for (const m of ts.matchAll(/this\.request<[^>]+>\('([A-Z]+)', [`']([^`'?]+)/g)) calls.push([m[1]!, m[2]!.replace(/\$\{[^}]+\}/g, '{id}')]);
    for (const m of py.matchAll(/self\._request\("([A-Z]+)", f?"([^"?]+)/g)) calls.push([m[1]!, m[2]!.replace(/\{[^}]+\}/g, '{id}')]);
    assert.ok(calls.length >= 10, `found ${calls.length} SDK calls`);
    const notRoutes = calls.filter(([m, p]) => !isRoute(m, concrete(p))).map(([m, p]) => `${m} ${p}`);
    assert.deepEqual(notRoutes, []);
    assert.ok(!py.includes('urllib.request.urlencode'), 'urllib.request has no urlencode (AttributeError at call time)');
  });
});
