/**
 * INF-05 (OTK-MOR-01, 2026-10-13): multi-tenant security and financial invariants, built on the INF-02 findings.
 * Complements m24_tenant_sweep (read/write IDOR and aggregation leaks) with what it does not cover:
 *   1. credential lifecycle: revoke, rotate, tenant deactivation, refresh token replay (SEC-02 N02/N04 neighbourhood);
 *   2. SCIM deprovisioning and /login (N04); self-service /signup OWNER without verified e-mail (N03);
 *   3. static tenant tokens: length and proxy authentication failures (N02);
 *   4. financial effect of the proxy: who is charged, quota per tenant, no debit without success, idempotent events.
 * Every negative case is paired with a positive control using a VALID credential, so a route that refuses
 * everything (401 for all) cannot make a case pass. Sentinels: tenant B carries 7919 CU, tenant D 104729 CU,
 * tenant A 13 CU per call; a charge to the wrong tenant shows up as a balance that is not a sum of its own values.
 * Cases marked `todo` reproduce an OPEN finding (INF05-Fxx): they run, assert the SECURE behaviour, and report the
 * failure without failing the suite; when the finding is fixed the todo must be removed.
 * The upstream provider is a fetch stub (no network, no real key, no paid call); in-memory stores only.
 *
 * Modules under test: `src/api/routes.ts` (called in process) and `src/proxy/ProxyGateway.ts`, with
 * `src/api/tenantKeyRegistry.ts`, `src/auth/jwt.ts`, `src/security/talRuntime.ts` (ledger),
 * `src/billing/PlanRegistry.ts`, `src/api/tenantCrud.ts`, `src/security/authFailureLimiter.ts` and the memory key,
 * token and user stores.
 *
 * Needs: nothing external. Before importing it empties `OTK_RECEIPT_LOG`, `OTK_DB_URL` and `OTK_TENANT_LOG`, sets
 * `PROVER_URL=disabled` and `OPENAI_API_KEY` to a fixture value, and removes `OTK_REDIS_URL`, `OTK_TENANTS` and
 * `OTK_PROXY_ALLOW_UNAUTHENTICATED`; `OTK_ADMIN_KEY`, `OTK_JWT_SECRET` and `OTK_SCIM_BEARER_TOKEN` get fixture
 * values and are restored after the run. Proxy receipts are written after the response, so some cases poll briefly.
 *
 * Run just this file: `npx tsx --test test/security/inf05_multitenant_invariants.test.ts`
 *
 * @module test/security/inf05_multitenant_invariants.test
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
type Json = any;

const RUN = Date.now().toString(36);
const A = `inf05a-${RUN}`; const B = `inf05b-${RUN}`; const D = `inf05d-${RUN}`;
const A_CU = 13; const B_CU = 7919; const D_CU = 104729;
const PLATFORM = `inf05-platform-${RUN}-0123456789abcdef`;
const JWT_SECRET = `inf05-jwt-${RUN}-0123456789abcdef0123456789`;
const SCIM_TOKEN = `inf05-scim-${RUN}-0123456789abcdef`;
const A_OWNER = `inf05-a-owner-${RUN}`; const A_OPERATOR = `inf05-a-operator-${RUN}`; const A_VIEWER = `inf05-a-viewer-${RUN}`;
const B_OWNER = `inf05-b-owner-${RUN}`; const B_OPERATOR = `inf05-b-operator-${RUN}`;
const D_CRUD = `inf05-d-crud-owner-${RUN}`;
const platform = { 'x-admin-key': PLATFORM };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const j = (o: unknown) => JSON.stringify(o);

let routes: any; let registry: any; let jwt: any; let talRt: any; let plans: any; let tenantCrud: any;
let metaStore: any; let tokenStore: any; let deriveEpoch: (ts: number) => bigint; let gw: any; let authFail: any;

// ── API harness (same shape as m24_tenant_sweep) ──
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
async function call(method: string, url: string, headers: Record<string, string> = {}, body = ''): Promise<{ status: number; body: string; json: Json }> {
  const res = new MockRes();
  await Promise.race([
    routes.handleRequest(mockReq(method, url, body, headers), res as unknown as ServerResponse),
    new Promise((r) => { setTimeout(r, 4000).unref(); }),
  ]);
  let json: Json; try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.statusCode, body: res.body, json };
}

// ── proxy harness: real gateway on loopback, upstream provider stubbed ──
let server: Server; let base = '';
const upstreamCalls: Array<{ url: string; auth: string }> = [];
const realFetch = globalThis.fetch;
const stub = { status: 200, promptTokens: A_CU, withUsage: true };
let upstreamSeq = 0; // provider response ids are the receipt requestId (N8): unique per call across the whole file
async function proxyCall(headers: Record<string, string>, body: unknown = { model: 'gpt-4o', messages: [] }) {
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: j(body) });
  const text = await r.text();
  return { status: r.status, text };
}
async function legacyEvent(headers: Record<string, string>, event: Record<string, unknown>) {
  const r = await fetch(`${base}/proxy`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: j(event) });
  return { status: r.status, json: await r.json() as Json };
}
const epoch = () => String(deriveEpoch(Math.floor(Date.now() / 1000)));
const cuOf = (t: string) => Number(talRt.getAccountingLayer().balance(t, epoch()).totalCU);
/** receipts of the MITM path are written in setImmediate after the response; wait until the ledger settles */
async function settle() { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); await new Promise((r) => setTimeout(r, 30)); }
const receiptBody = (requestId: string, tokens: number) => j({ requestId, provider: 'openai', model: 'gpt-4o', inputTokens: tokens, outputTokens: 0 });

let origKey: string | undefined; let origJwt: string | undefined; let origScim: string | undefined;
before(async () => {
  origKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  origJwt = process.env['OTK_JWT_SECRET']; process.env['OTK_JWT_SECRET'] = JWT_SECRET;
  origScim = process.env['OTK_SCIM_BEARER_TOKEN']; process.env['OTK_SCIM_BEARER_TOKEN'] = SCIM_TOKEN;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  jwt = await import('../../src/auth/jwt.js');
  talRt = await import('../../src/security/talRuntime.js');
  plans = await import('../../src/billing/PlanRegistry.js');
  tenantCrud = await import('../../src/api/tenantCrud.js');
  metaStore = await import('../../src/api/IApiKeyMetadataStore.js');
  tokenStore = await import('../../src/api/ITokenStore.js');
  gw = await import('../../src/proxy/ProxyGateway.js');
  authFail = await import('../../src/security/authFailureLimiter.js');
  deriveEpoch = (await import('../../src/types/receipt.js')).deriveEpoch;
  const { MemoryUserStore } = await import('../../src/users/MemoryUserStore.js');
  const { setUserStore } = await import('../../src/users/IUserStore.js');

  registry.clearRegistry(); registry.clearHashRegistryForTest(); metaStore.resetApiKeyMetadataStoreForTest(); tokenStore.resetTokenStoreForTest();
  tenantCrud.clearTenantsForTest(); jwt.clearBlacklistForTest(); setUserStore(new MemoryUserStore());

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://')) {
      const h = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      upstreamCalls.push({ url, auth: h['authorization'] ?? '' });
      const payload: Record<string, unknown> = { id: `chatcmpl-${RUN}-${++upstreamSeq}`, model: 'gpt-4o' };
      if (stub.withUsage) payload['usage'] = { prompt_tokens: stub.promptTokens, completion_tokens: 0 };
      if (stub.status !== 200) payload['error'] = { message: 'synthetic upstream failure' };
      return new Response(j(payload), { status: stub.status, headers: { 'content-type': 'application/json' } });
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
  registry.clearRegistry(); registry.clearHashRegistryForTest(); tenantCrud.clearTenantsForTest(); plans.resetPlanStoreForTest();
  for (const [k, v] of [['OTK_ADMIN_KEY', origKey], ['OTK_JWT_SECRET', origJwt], ['OTK_SCIM_BEARER_TOKEN', origScim]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
});

beforeEach(() => {
  upstreamCalls.length = 0;
  authFail.resetProxyAuthFailureLimiterForTest(); // H1-S06: each case starts with no recorded failure for 127.0.0.1
  Object.assign(stub, { status: 200, promptTokens: A_CU, withUsage: true });
  talRt.resetAccountingLayerForTest();
  plans.resetPlanStoreForTest();
  registry.registerToken(A_OWNER, A, 'OWNER'); registry.registerToken(A_OPERATOR, A, 'OPERATOR'); registry.registerToken(A_VIEWER, A, 'VIEWER');
  registry.registerToken(B_OWNER, B, 'OWNER'); registry.registerToken(B_OPERATOR, B, 'OPERATOR');
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INF05 credential lifecycle: a revoked credential stops working on every surface', () => {
  it('dynamic key: valid before revoke (control), 401 on the API after DELETE /keys/:id', async () => {
    const k = await call('POST', '/keys', bearer(A_OWNER), j({ label: `inf05-rev-${RUN}`, role: 'ADMIN' }));
    assert.equal(k.status, 201, k.body);
    const raw = k.json.key.rawKey as string; const id = k.json.key.keyId as string;
    const live = await call('POST', '/receipts', bearer(raw), receiptBody(`inf05-live-${RUN}`, A_CU));
    assert.equal(live.status, 201, `control: the live key writes a receipt: ${live.body}`);
    const del = await call('DELETE', `/keys/${encodeURIComponent(id)}`, bearer(A_OWNER));
    assert.equal(del.status, 200, del.body);
    const afterRevoke = await call('POST', '/receipts', bearer(raw), receiptBody(`inf05-rev-${RUN}`, A_CU));
    assert.equal(afterRevoke.status, 401, afterRevoke.body);
    assert.equal(cuOf(A), A_CU, 'only the call made before the revoke was charged');
  });

  it('dynamic key: rotate → old raw key 401, new raw key works (control)', async () => {
    const k = await call('POST', '/keys', bearer(A_OWNER), j({ label: `inf05-rot-${RUN}`, role: 'MEMBER' }));
    assert.equal(k.status, 201, k.body);
    const rot = await call('POST', `/keys/${encodeURIComponent(k.json.key.keyId)}/rotate`, bearer(A_OWNER));
    assert.equal(rot.status, 200, rot.body);
    const oldR = await call('POST', '/receipts', bearer(k.json.key.rawKey), receiptBody(`inf05-rot-old-${RUN}`, A_CU));
    assert.equal(oldR.status, 401, oldR.body);
    const newR = await call('POST', '/receipts', bearer(rot.json.key.rawKey), receiptBody(`inf05-rot-new-${RUN}`, A_CU));
    assert.equal(newR.status, 201, newR.body);
    assert.equal(cuOf(A), A_CU, 'only the call with the new key was charged');
  });

  it('tenant B cannot revoke or rotate a key of tenant A (404, key keeps working)', async () => {
    const k = await call('POST', '/keys', bearer(A_OWNER), j({ label: `inf05-xrev-${RUN}`, role: 'MEMBER' }));
    const id = encodeURIComponent(k.json.key.keyId);
    assert.equal((await call('DELETE', `/keys/${id}`, bearer(B_OWNER))).status, 404);
    assert.equal((await call('POST', `/keys/${id}/rotate`, bearer(B_OWNER))).status, 404);
    const still = await call('POST', '/receipts', bearer(k.json.key.rawKey), receiptBody(`inf05-xrev-${RUN}`, A_CU));
    assert.equal(still.status, 201, still.body);
  });

  it('refresh token: one use only (replay of a used refresh token → 401) and never yields more than MEMBER', async () => {
    // F-H1-10 (H1 lane B): a refresh token must be bound to a user that is a member of the tenant (an unbound one minted
    // a MEMBER JWT with no user behind it; it is now refused). The user here is an OWNER member: the refreshed JWT is
    // still capped at MEMBER.
    const { getUserStore } = await import('../../src/users/IUserStore.js');
    const uid = `usr_inf05_rt_${RUN}`; const nowIso = new Date().toISOString();
    await getUserStore()!.createUser({ id: uid, email: `inf05-rt-${RUN}@example.invalid`, emailVerified: true, name: 'inf05 rt', passwordHash: null, createdAt: nowIso, updatedAt: nowIso });
    await getUserStore()!.addMembership({ userId: uid, orgId: A, role: 'OWNER', joinedAt: nowIso });
    assert.equal((await call('POST', '/auth/refresh', {}, j({ refreshToken: jwt.signRefreshToken(A, JWT_SECRET) }))).status, 401, 'unbound refresh token');
    const refresh = jwt.signRefreshToken(A, JWT_SECRET, uid);
    const first = await call('POST', '/auth/refresh', {}, j({ refreshToken: refresh }));
    assert.equal(first.status, 200, first.body);
    const payload = JSON.parse(Buffer.from(String(first.json.token).split('.')[1]!, 'base64url').toString());
    assert.equal(payload.sub, A); assert.equal(payload.role, 'MEMBER'); assert.equal(payload.userId, uid);
    const replay = await call('POST', '/auth/refresh', {}, j({ refreshToken: refresh }));
    assert.equal(replay.status, 401, replay.body);
    // a refresh token is not an access token
    assert.equal((await call('POST', '/receipts', bearer(refresh), receiptBody(`inf05-rt-${RUN}`, A_CU))).status, 401);
  });
});

describe('INF05 tenant deactivation by the platform (DELETE /admin/tenants/:id)', () => {
  let dKeyRaw = ''; let dJwt = '';
  before(async () => {
    const c = await call('POST', '/admin/tenants', platform, j({ tenantId: D, token: D_CRUD, role: 'OWNER' }));
    assert.equal(c.status, 201, c.body);
    const k = await call('POST', '/keys', bearer(D_CRUD), j({ label: `inf05-d-${RUN}`, role: 'OWNER' }));
    assert.equal(k.status, 201, k.body);
    dKeyRaw = k.json.key.rawKey;
    dJwt = jwt.signToken({ sub: D, role: 'OWNER' }, JWT_SECRET, 600);
    // controls: the three credentials of D work while D is active
    for (const t of [D_CRUD, dKeyRaw, dJwt]) assert.notEqual((await call('GET', '/keys', bearer(t))).status, 401);
    const del = await call('DELETE', `/admin/tenants/${encodeURIComponent(D)}`, platform);
    assert.equal(del.status, 200, del.body);
  });

  it('the registry token of a deactivated tenant → 401 on the API and on the proxy, no upstream call', async () => {
    assert.equal((await call('POST', '/receipts', bearer(D_CRUD), receiptBody(`inf05-d1-${RUN}`, D_CU))).status, 401);
    assert.equal((await proxyCall(bearer(D_CRUD))).status, 401);
    assert.equal(upstreamCalls.length, 0);
  });

  // INF05-F01 FIXED (H1-S04): deactivation is checked at authentication time for every credential of the tenant
  it('a dynamic key minted by the deactivated tenant → 401 and no receipt or debit', async () => {
    const r = await call('POST', '/receipts', bearer(dKeyRaw), receiptBody(`inf05-d2-${RUN}`, D_CU));
    assert.equal(r.status, 401, `deactivated tenant still writes receipts with its /keys key: ${r.status} ${r.body}`);
    assert.equal(cuOf(D), 0);
  });

  it('an OWNER JWT of the deactivated tenant → 401 (cannot mint a new key)', async () => {
    const r = await call('POST', '/keys', bearer(dJwt), j({ label: `inf05-d3-${RUN}`, role: 'OWNER' }));
    assert.equal(r.status, 401, `deactivated tenant still mints keys with a JWT: ${r.status} ${r.body}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INF05 SCIM deprovisioning and self-service accounts (N03, N04)', () => {
  const email = `inf05-${RUN}@example.invalid`; const password = `inf05-pass-${RUN}`;
  let userId = ''; let signupJwt = '';
  before(async () => {
    const s = await call('POST', '/signup', {}, j({ email, password, name: 'INF05 synthetic', orgName: `inf05 org ${RUN}` }));
    assert.equal(s.status, 201, s.body);
    ({ userId, token: signupJwt } = s.json);
    assert.ok(signupJwt, 'JWT issued at signup');
  });

  it('control: login works for the active user; a wrong password → 401', async () => {
    assert.equal((await call('POST', '/login', {}, j({ email, password }))).status, 200);
    assert.equal((await call('POST', '/login', {}, j({ email, password: `${password}x` }))).status, 401);
  });

  it('SCIM requires its own bearer: platform key, tenant OWNER and a wrong SCIM token → 401, user untouched', async () => {
    for (const h of [platform, bearer(A_OWNER), bearer(`${SCIM_TOKEN}x`), bearer(signupJwt)]) {
      const r = await call('DELETE', `/scim/v2/Users/${userId}`, h);
      assert.equal(r.status, 401, `${JSON.stringify(Object.keys(h))}: ${r.status}`);
    }
    assert.equal((await call('POST', '/login', {}, j({ email, password }))).status, 200, 'still active');
  });

  // SEC02-N03 FIXED (H1-S05, POLICY=PENDING_HUMAN_APPROVAL (D3)): unverified e-mail → no key minting
  it('a /signup OWNER without verified e-mail cannot mint an OWNER API key', async () => {
    const r = await call('POST', '/keys', bearer(signupJwt), j({ label: `inf05-unverified-${RUN}`, role: 'OWNER' }));
    assert.equal(r.status, 403, `unverified self-service OWNER minted an OWNER key: ${r.status}`);
  });

  // SEC02-N04 FIXED (H1-S05): SCIM DELETE deprovisions the user (deprovisionedAt), checked by /login and JWT auth
  it('after SCIM DELETE the user cannot log in and gets no token', async () => {
    const del = await call('DELETE', `/scim/v2/Users/${userId}`, bearer(SCIM_TOKEN));
    assert.equal(del.status, 204, del.body);
    const login = await call('POST', '/login', {}, j({ email, password }));
    const role = login.json?.token ? JSON.parse(Buffer.from(String(login.json.token).split('.')[1]!, 'base64url').toString()).role : 'none';
    assert.equal(login.status, 401, `deprovisioned user logged in: ${login.status}, token role ${role}`);
  });

  it('after SCIM DELETE a JWT obtained before deprovisioning no longer mints keys', async () => {
    const r = await call('POST', '/keys', bearer(signupJwt), j({ label: `inf05-deprov-${RUN}`, role: 'OWNER' }));
    assert.equal(r.status, 401, `deprovisioned user's JWT still minted an OWNER key for its org: ${r.status}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INF05 static tenant tokens and proxy authentication failures (N02)', () => {
  // SEC02-N02 FIXED (H1-S06): minimum token length (24) on POST/PUT /admin/tenants; per-source proxy auth-failure limiter
  it('the platform cannot register a trivially short tenant token (1 char)', async () => {
    const r = await call('POST', '/admin/tenants', platform, j({ tenantId: `inf05-short-${RUN}`, token: 'z', role: 'OPERATOR' }));
    assert.equal(r.status, 400, `1-char token accepted: ${r.status}`);
  });

  // INF05-F02 FIXED (H1-S06): createTenant/updateTenant refuse a token already bound to another tenant (409)
  it('registering a tenant with a token that already belongs to another tenant is refused (no silent re-binding)', async () => {
    const dup = `inf05-dup-${RUN}`;
    const r = await call('POST', '/admin/tenants', platform, j({ tenantId: dup, token: A_OPERATOR, role: 'OPERATOR' }));
    // financial effect: the next proxy call made by A's operator must still be charged to A
    assert.equal((await proxyCall(bearer(A_OPERATOR))).status, 200);
    await settle();
    assert.equal(cuOf(A), A_CU, `A's call was charged to ${dup}: A=${cuOf(A)} ${dup}=${cuOf(dup)}`);
    const boundTo = registry.resolveTokenContext(A_OPERATOR)?.tenantId;
    assert.equal(boundTo, A, `A's operator token now resolves to ${boundTo} (answer ${r.status})`);
    assert.notEqual(r.status, 201, `duplicate token accepted: ${r.status}`);
  });

  it('repeated wrong tokens on the proxy are throttled (429) before a valid token is tried', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await proxyCall(bearer(`inf05-guess-${i}-${RUN}`))).status);
    assert.equal(upstreamCalls.length, 0, 'no wrong token reached the provider');
    assert.ok(statuses.includes(429), `40 wrong tokens from one client, statuses: ${[...new Set(statuses)].join(',')}`);
  });

  it('control: wrong tokens never reach the provider and the valid token still works', async () => {
    for (let i = 0; i < 5; i++) assert.equal((await proxyCall(bearer(`inf05-bad-${i}-${RUN}`))).status, 401);
    assert.equal((await proxyCall(bearer(A_OPERATOR))).status, 200);
    assert.equal(upstreamCalls.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('INF05 financial effect of the proxy: who pays, when, how much', () => {
  it('the tenant charged is the one of the bearer token; body/header tenant hints are ignored', async () => {
    talRt.getAccountingLayer().debit({ tenantId: B, epochId: epoch(), requestId: `inf05-b-seed-${RUN}`, provider: 'openai', model: 'gpt-4o', cu: BigInt(B_CU), ts: Date.now() });
    const r = await proxyCall({ ...bearer(A_OPERATOR), 'x-otk-tenant-id': B, 'x-tenant-id': B }, { model: 'gpt-4o', messages: [], tenantId: B, user: B });
    assert.equal(r.status, 200, r.text);
    await settle();
    assert.equal(cuOf(A), A_CU, 'A pays its own call');
    assert.equal(cuOf(B), B_CU, 'B balance unchanged (sentinel 7919)');
    assert.equal(upstreamCalls.length, 1);
    assert.ok(!upstreamCalls[0]!.auth.includes(A_OPERATOR), 'the OTK token is never sent upstream');
  });

  it('Authorization wins over x-api-key: a B token in x-api-key does not move the charge to B', async () => {
    const r = await proxyCall({ ...bearer(A_OPERATOR), 'x-api-key': B_OPERATOR });
    assert.equal(r.status, 200, r.text);
    await settle();
    assert.equal(cuOf(A), A_CU); assert.equal(cuOf(B), 0);
  });

  it('quota is per tenant: B exhausted → 429 for B with zero upstream calls, A still served (control)', async () => {
    talRt.getAccountingLayer().debit({ tenantId: B, epochId: epoch(), requestId: `inf05-b-full-${RUN}`, provider: 'openai', model: 'gpt-4o', cu: 10_000n, ts: Date.now() });
    assert.equal((await proxyCall(bearer(B_OPERATOR))).status, 429);
    assert.equal(upstreamCalls.length, 0);
    assert.equal((await proxyCall(bearer(A_OPERATOR))).status, 200);
    assert.equal(upstreamCalls.length, 1);
    await settle();
    assert.equal(cuOf(B), 10_000, 'a refused call is not charged');
  });

  it('VIEWER token → 403 at the proxy, no upstream call, no debit; OPERATOR of the same tenant → 200 (control)', async () => {
    assert.equal((await proxyCall(bearer(A_VIEWER))).status, 403);
    assert.equal(upstreamCalls.length, 0);
    assert.equal((await proxyCall(bearer(A_OPERATOR))).status, 200);
    await settle();
    assert.equal(cuOf(A), A_CU);
  });

  it('upstream failure (500) or a response without usage → relayed, but no receipt and no debit', async () => {
    stub.status = 500;
    assert.equal((await proxyCall(bearer(A_OPERATOR))).status, 500);
    Object.assign(stub, { status: 200, withUsage: false });
    assert.equal((await proxyCall(bearer(A_OPERATOR))).status, 200);
    await settle();
    assert.equal(upstreamCalls.length, 2);
    assert.equal(cuOf(A), 0);
  });

  it('JWT and /keys credentials are not accepted by the proxy (only registry tokens spend the operator key)', async () => {
    const k = await call('POST', '/keys', bearer(A_OWNER), j({ label: `inf05-px-${RUN}`, role: 'OPERATOR' }));
    assert.equal(k.status, 201, k.body);
    assert.equal((await proxyCall(bearer(k.json.key.rawKey))).status, 401);
    assert.equal((await proxyCall(bearer(jwt.signToken({ sub: A, role: 'OWNER' }, JWT_SECRET, 600)))).status, 401);
    assert.equal(upstreamCalls.length, 0);
  });

  it('legacy POST /proxy: the same requestId twice is charged once; body tenantId cannot redirect the charge', async () => {
    const ev = { requestId: `inf05-ev-${RUN}`, provider: 'openai', model: 'gpt-4o', inputTokens: A_CU, outputTokens: 0, tenantId: B };
    const first = await legacyEvent(bearer(A_OPERATOR), ev);
    assert.equal(first.status, 200, j(first.json));
    const second = await legacyEvent(bearer(A_OPERATOR), ev);
    assert.ok(second.status === 200 || second.status === 409, j(second.json));
    assert.equal(cuOf(A), A_CU, 'charged exactly once');
    assert.equal(cuOf(B), 0, 'body tenantId ignored with auth on');
  });

  it('legacy POST /proxy: B reusing A\'s requestId neither erases nor takes over A\'s charge', async () => {
    const ev = { requestId: `inf05-ev-shared-${RUN}`, provider: 'openai', model: 'gpt-4o', inputTokens: A_CU, outputTokens: 0 };
    assert.equal((await legacyEvent(bearer(A_OPERATOR), ev)).status, 200);
    const b = await legacyEvent(bearer(B_OPERATOR), { ...ev, inputTokens: B_CU });
    assert.ok([200, 409].includes(b.status), j(b.json));
    assert.equal(cuOf(A), A_CU, 'A unchanged');
    assert.ok(cuOf(B) === 0 || cuOf(B) === B_CU, `B is charged only its own value or nothing: ${cuOf(B)}`);
  });
});
