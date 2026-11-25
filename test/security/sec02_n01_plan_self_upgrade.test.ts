/**
 * SEC02-N01 (OTK-MOR-01 / INF-02, 2026-10-13): a tenant role must not raise its own plan.
 *
 * Before: POST /admin/plans/assign accepted any credential with admin:tenants (tenant OWNER/ADMIN, static token, dynamic
 * key or JWT from /signup) for its own tenant, with any tier. PRO has cuQuotaPerEpoch = 0 (no hard limit) and priceUsd 0,
 * so a tenant that the platform enabled in the proxy could leave an exhausted FREE quota and keep calling the provider
 * with the operator's key, without any payment.
 *
 * Rule tested here (fail-closed, decision of plan policy still pending with the author): with auth enabled a tenant role
 * may keep or LOWER its own tier; raising it needs the platform operator credential (x-admin-key) or the Stripe checkout
 * webhook (signature-verified). The upstream provider is a fetch stub (no network, no paid call, no real key).
 *
 * Strategy / scenarios: end to end, a tenant whose FREE quota is exhausted cannot reopen the proxy by assigning PRO to
 * itself; OWNER and ADMIN registry tokens are refused when raising their own plan from FREE to STARTER or PRO, and an
 * OWNER from STARTER to PRO; an OWNER JWT of the shape issued at signup is refused too; an OWNER may lower its own
 * plan (control).
 *
 * Modules under test: the plan assignment route of `src/api/routes.ts` (called in process), `src/billing/PlanRegistry.ts`,
 * the ledger in `src/security/talRuntime.ts` and the proxy `src/proxy/ProxyGateway.ts`.
 *
 * Needs: nothing external. Before importing it empties `OTK_RECEIPT_LOG` and `OTK_DB_URL`, sets
 * `PROVER_URL=disabled` and `OPENAI_API_KEY` to a fixture value, and removes `OTK_PROXY_ALLOW_UNAUTHENTICATED`;
 * `OTK_ADMIN_KEY` and `OTK_JWT_SECRET` get fixture values and are restored after the run.
 *
 * Run just this file: `npx tsx --test test/security/sec02_n01_plan_self_upgrade.test.ts`
 *
 * @module test/security/sec02_n01_plan_self_upgrade.test
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
delete process.env['OTK_PROXY_ALLOW_UNAUTHENTICATED'];

const RUN = Date.now().toString(36);
const T = `sec02n01-${RUN}`;
const OTHER = `sec02n01-other-${RUN}`;
const OWNER_TOK = `n01-owner-${RUN}`;
const ADMIN_TOK = `n01-admin-${RUN}`;
const OPERATOR_TOK = `n01-operator-${RUN}`;
const PLATFORM = `n01-platform-key-${RUN}-0123456789abcdef`;
const JWT_SECRET = `n01-jwt-secret-${RUN}-0123456789abcdef0123456789`;

let routes: typeof import('../../src/api/routes.js');
let registry: typeof import('../../src/api/tenantKeyRegistry.js');
let plans: typeof import('../../src/billing/PlanRegistry.js');
let talRuntime: typeof import('../../src/security/talRuntime.js');
let gw: typeof import('../../src/proxy/ProxyGateway.js');
let jwt: typeof import('../../src/auth/jwt.js');
let deriveEpoch: (ts: number) => bigint;

let server: Server;
let base: string;
const upstreamCalls: Array<{ url: string; auth: string }> = [];
const realFetch = globalThis.fetch;
let origAdminKey: string | undefined;
let origJwt: string | undefined;

function mockReq(method: string, url: string, body: string, headers: Record<string, string>): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers }) as unknown as IncomingMessage;
  process.nextTick(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); });
  return req;
}
type MockRes = ServerResponse & { body: string };
function mockRes(): MockRes {
  let body = '';
  return { statusCode: 200, setHeader: () => {}, writeHead(c: number) { (this as { statusCode: number }).statusCode = c; return this; }, end: (d: string) => { body = d; }, get body() { return body; } } as unknown as MockRes;
}
async function assign(headers: Record<string, string>, body: unknown) {
  const res = mockRes();
  await routes.handleRequest(mockReq('POST', '/admin/plans/assign', JSON.stringify(body), { 'content-type': 'application/json', ...headers }), res);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(res.body) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.statusCode, json };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
const nowEpoch = () => String(deriveEpoch(Math.floor(Date.now() / 1000)));
const proxyCall = (token: string) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ model: 'gpt-4o', messages: [] }),
});

before(async () => {
  origAdminKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  origJwt = process.env['OTK_JWT_SECRET']; process.env['OTK_JWT_SECRET'] = JWT_SECRET;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  plans = await import('../../src/billing/PlanRegistry.js');
  talRuntime = await import('../../src/security/talRuntime.js');
  gw = await import('../../src/proxy/ProxyGateway.js');
  jwt = await import('../../src/auth/jwt.js');
  deriveEpoch = (await import('../../src/types/receipt.js')).deriveEpoch;

  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('https://')) {
      const h = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      upstreamCalls.push({ url, auth: h['authorization'] ?? '' });
      return new Response(JSON.stringify({ id: `chatcmpl-${Math.random().toString(36).slice(2)}`, model: 'gpt-4o', usage: { prompt_tokens: 10, completion_tokens: 10 } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return realFetch(input as string, init);
  }) as typeof fetch;

  server = gw.startProxyGateway({ port: 0 });
  await new Promise<void>(r => (server.listening ? r() : server.once('listening', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  globalThis.fetch = realFetch;
  await new Promise<void>(r => server.close(() => r()));
  registry.clearRegistry();
  plans.resetPlanStoreForTest();
  if (origAdminKey === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origAdminKey;
  if (origJwt === undefined) delete process.env['OTK_JWT_SECRET']; else process.env['OTK_JWT_SECRET'] = origJwt;
});

beforeEach(() => {
  upstreamCalls.length = 0;
  talRuntime.resetAccountingLayerForTest();
  plans.resetPlanStoreForTest();
  // the platform enabled tenant T in the proxy with static tokens (OTK_TENANTS / POST /admin/tenants)
  registry.loadTenantsFromString(`${T}/OWNER:${OWNER_TOK},${T}/ADMIN:${ADMIN_TOK},${T}/OPERATOR:${OPERATOR_TOK}`);
});

describe('SEC02-N01: end to end, FREE quota exhausted + self-upgrade + proxy with the operator key', () => {
  it('after the FREE quota is exhausted, the tenant cannot reopen the proxy by assigning PRO to itself', async () => {
    talRuntime.getAccountingLayer().debit({
      tenantId: T, epochId: nowEpoch(), requestId: `prefill-${RUN}`, provider: 'openai', model: 'gpt-4o', cu: 10_000n, ts: Date.now(),
    });
    const blocked = await proxyCall(OPERATOR_TOK);
    assert.equal(blocked.status, 429, 'FREE quota exhausted → 429');
    assert.equal(upstreamCalls.length, 0);

    const up = await assign(bearer(OWNER_TOK), { tenantId: T, tier: 'PRO' });
    assert.equal(up.status, 403, `self-upgrade must be refused: ${JSON.stringify(up.json)}`);
    assert.equal(up.json['error'], 'plan_upgrade_requires_platform');
    assert.equal(plans.getTenantPlan(T), 'FREE');

    const after = await proxyCall(OPERATOR_TOK);
    assert.equal(after.status, 429, 'still over quota');
    assert.equal(upstreamCalls.length, 0, 'the operator provider key was never used');
  });
});

describe('SEC02-N01: POST /admin/plans/assign by tenant roles (own tenant)', () => {
  for (const [label, tok] of [['OWNER', OWNER_TOK], ['ADMIN', ADMIN_TOK]] as const) {
    for (const tier of ['STARTER', 'PRO'] as const) {
      it(`${label} FREE → ${tier} → 403 and the plan is unchanged`, async () => {
        const r = await assign(bearer(tok), { tenantId: T, tier });
        assert.equal(r.status, 403, JSON.stringify(r.json));
        assert.equal(plans.getTenantPlan(T), 'FREE');
      });
    }
  }

  it('OWNER STARTER → PRO → 403 (any raise, not only from FREE)', async () => {
    await plans.assignPlan(T, 'STARTER');
    const r = await assign(bearer(OWNER_TOK), { tenantId: T, tier: 'PRO' });
    assert.equal(r.status, 403);
    assert.equal(plans.getTenantPlan(T), 'STARTER');
  });

  it('JWT OWNER (shape issued by /signup) cannot raise its own plan either', async () => {
    const org = `org_n01_${RUN}`;
    const tok = jwt.signToken({ sub: org, role: 'OWNER', userId: `usr_n01_${RUN}` } as never, JWT_SECRET, 600);
    const r = await assign(bearer(tok), { tenantId: org, tier: 'PRO' });
    assert.equal(r.status, 403, JSON.stringify(r.json));
    assert.equal(plans.getTenantPlan(org), 'FREE');
  });

  it('OWNER may lower its own plan (PRO → FREE) → 200', async () => {
    await plans.assignPlan(T, 'PRO');
    const r = await assign(bearer(OWNER_TOK), { tenantId: T, tier: 'FREE' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(plans.getTenantPlan(T), 'FREE');
  });

  it('ADMIN may keep its current plan (STARTER → STARTER) → 200', async () => {
    await plans.assignPlan(T, 'STARTER');
    const r = await assign(bearer(ADMIN_TOK), { tenantId: T, tier: 'STARTER' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(plans.getTenantPlan(T), 'STARTER');
  });

  it('OPERATOR (no admin:tenants) → 403 and unchanged', async () => {
    const r = await assign(bearer(OPERATOR_TOK), { tenantId: T, tier: 'PRO' });
    assert.equal(r.status, 403);
    assert.equal(plans.getTenantPlan(T), 'FREE');
  });

  it('cross-tenant downgrade is still refused (403 cross_tenant_forbidden)', async () => {
    await plans.assignPlan(OTHER, 'PRO');
    const r = await assign(bearer(OWNER_TOK), { tenantId: OTHER, tier: 'FREE' });
    assert.equal(r.status, 403);
    assert.equal(r.json['error'], 'cross_tenant_forbidden');
    assert.equal(plans.getTenantPlan(OTHER), 'PRO');
  });

  it('unknown tier → 400 and unchanged', async () => {
    const r = await assign(bearer(OWNER_TOK), { tenantId: T, tier: 'ENTERPRISE' });
    assert.equal(r.status, 400);
    assert.equal(plans.getTenantPlan(T), 'FREE');
  });
});

describe('SEC02-N01: platform operator credential', () => {
  it('x-admin-key alone (no tenant bearer) can raise any tenant → 200', async () => {
    // H1-S01 (FA-06): the tenant must exist; OTHER is registered here (an unknown id → 404, h1_s01_s03 P8)
    registry.registerToken(`n01-other-op-${RUN}`, OTHER, 'OPERATOR');
    const r = await assign({ 'x-admin-key': PLATFORM }, { tenantId: OTHER, tier: 'PRO' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(plans.getTenantPlan(OTHER), 'PRO');
  });

  it('x-admin-key together with a tenant bearer still acts as platform (runPilotV3 sends both) → 200', async () => {
    const r = await assign({ 'x-admin-key': PLATFORM, ...bearer(ADMIN_TOK) }, { tenantId: T, tier: 'PRO' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(plans.getTenantPlan(T), 'PRO');
  });

  it('wrong x-admin-key does not grant the platform path; tenant bearer rules apply → 403', async () => {
    for (const k of [`${PLATFORM}x`, PLATFORM.slice(0, -1), '', 'demo-otk-2026']) {
      const r = await assign({ 'x-admin-key': k, ...bearer(OWNER_TOK) }, { tenantId: T, tier: 'PRO' });
      assert.equal(r.status, 403, `x-admin-key='${k.slice(0, 6)}...' → ${r.status}`);
    }
    assert.equal(plans.getTenantPlan(T), 'FREE');
  });

  it('wrong x-admin-key without bearer → 401 and unchanged', async () => {
    const r = await assign({ 'x-admin-key': 'nope' }, { tenantId: T, tier: 'PRO' });
    assert.equal(r.status, 401);
    assert.equal(plans.getTenantPlan(T), 'FREE');
  });

  it('platform with empty or missing tenantId → 400, nothing assigned', async () => {
    for (const body of [{ tier: 'PRO' }, { tenantId: '', tier: 'PRO' }, { tenantId: 42, tier: 'PRO' }]) {
      const r = await assign({ 'x-admin-key': PLATFORM }, body);
      assert.ok(r.status === 400 || r.status === 403, `${JSON.stringify(body)} → ${r.status}`);
    }
    assert.deepEqual(plans.listAssignments(), []);
  });
});
