/**
 * H1-S01 / H1-S03 (OTK-H1-MEGA-S01-S24-20261013): plan assignments are durable, atomic and consistent; Stripe
 * webhooks never acknowledge an effect that was not persisted.
 *
 * Findings reproduced (MOR01 FA-01..FA-06, INF02-O1, INF02-O2), scenarios P1..P9 of the MOR01 report:
 *   P1 store write fails → before: 200 + PRO served from the cache; now: error, no promotion visible
 *   P2 store write hangs → before: 200 at once; now: bounded error (OTK_PLAN_STORE_TIMEOUT_MS)
 *   P3 restart after a confirmed assignment → the persisted tier comes back (control)
 *   P4 downgrade not persisted → before: 200 and PRO back after restart; now: explicit error (caller retries)
 *   P5 concurrent promotion/downgrade on the same version → one wins, the other gets a version conflict (409)
 *   P6/P7 two replicas → a downgrade written by replica 2 applies to the quota check of replica 1 on the next request
 *   P8 tenant that does not exist → 404, nothing stored
 *   P9 deployed environment without durable plan store → start refused (deployedStoreProblems)
 *   Stripe: unpaid checkout never activates; duplicate and out-of-order events applied once; store failure → 503
 *
 * Every negative case has a positive control. Only in-memory fakes; no network, no PostgreSQL, no real key.
 * The module is accessed through `any` on purpose: the same file runs against the code before the fix (where the
 * new functions are missing) to show which cases fail there.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_PLAN_STORE_TIMEOUT_MS'] = '150';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];

/* eslint-disable @typescript-eslint/no-explicit-any */
const RUN = Date.now().toString(36);
const T = `h1s01-${RUN}`;
const GHOST = `h1s01-ghost-${RUN}`;
const OWNER_TOK = `h1s01-owner-${RUN}-0123456789abcdef`;
const PLATFORM = `h1s01-platform-${RUN}-0123456789abcdef0123`;

let routes: any; let registry: any; let plans: any; let planStores: any; let quota: any; let talRt: any;
let stripe: any; let boot: any;
let origAdminKey: string | undefined;

function mockReq(method: string, url: string, body: string, headers: Record<string, string>): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
  process.nextTick(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); });
  return req;
}
function mockRes(): ServerResponse & { body: string } {
  let body = '';
  return { statusCode: 200, setHeader: () => {}, getHeader: () => undefined, writeHead(c: number) { (this as any).statusCode = c; return this; }, end: (d: string) => { body = d; }, get body() { return body; } } as any;
}
async function assign(headers: Record<string, string>, body: unknown) {
  const res = mockRes();
  await routes.handleRequest(mockReq('POST', '/admin/plans/assign', JSON.stringify(body), { 'content-type': 'application/json', ...headers }), res);
  let json: any = {};
  try { json = JSON.parse(res.body); } catch { /* non-JSON */ }
  return { status: res.statusCode, json };
}
const platform = { 'x-admin-key': PLATFORM };
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

/** Wraps a memory store; `mode` makes writes fail or hang (reads keep working, like a read replica). */
class FaultyStore {
  inner: any; mode: 'ok' | 'fail' | 'hang' = 'ok'; writes = 0;
  constructor(inner: any) { this.inner = inner; }
  async assign(t: string, tier: string, meta?: unknown) {
    this.writes++;
    if (this.mode === 'fail') throw new Error('connection terminated unexpectedly');
    if (this.mode === 'hang') return new Promise(() => { /* never settles */ });
    return this.inner.assign(t, tier, meta);
  }
  get(t: string) { return this.inner.get(t); }
  getVersioned(t: string) { return this.inner.getVersioned(t); }
  list() { return this.inner.list(); }
  listAudit(t?: string) { return this.inner.listAudit(t); }
  clear() { return this.inner.clear(); }
}

before(async () => {
  origAdminKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  plans = await import('../../src/billing/PlanRegistry.js');
  planStores = await import('../../src/billing/IPlanStore.js');
  quota = await import('../../src/billing/meteringQuota.js');
  talRt = await import('../../src/security/talRuntime.js');
  stripe = await import('../../src/billing/stripe/StripeWebhookHandler.js');
  boot = await import('../../src/infra/storeBootstrap.js');
});

after(() => {
  registry.clearRegistry();
  plans.resetPlanStoreForTest();
  if (origAdminKey === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origAdminKey;
});

let store: FaultyStore;
beforeEach(async () => {
  plans.resetPlanStoreForTest();
  store = new FaultyStore(new planStores.MemoryPlanStore());
  await plans.setPlanStore(store);
  talRt.resetAccountingLayerForTest();
  registry.loadTenantsFromString(`${T}/OWNER:${OWNER_TOK}`);
});

describe('H1-S01 P1/P2: an unconfirmed write is an error, never a promotion', () => {
  it('control: platform assigns PRO, store confirms → 200, persisted, visible', async () => {
    const r = await assign(platform, { tenantId: T, tier: 'PRO' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(await store.inner.get(T), 'PRO');
    assert.equal(plans.getTenantPlan(T), 'PRO');
  });

  it('P1 store write fails → 503 plan_store_unavailable, cache NOT promoted, store unchanged', async () => {
    store.mode = 'fail';
    const r = await assign(platform, { tenantId: T, tier: 'PRO' });
    assert.equal(r.status, 503, `a failed write must not answer success: ${JSON.stringify(r.json)}`);
    assert.equal(plans.getTenantPlan(T), 'FREE', 'promotion must not be visible before it is persisted');
    assert.equal(await store.inner.get(T), null);
  });

  it('P1 (API) assignPlan rejects when the store fails', async () => {
    store.mode = 'fail';
    await assert.rejects(() => plans.assignPlan(T, 'PRO'), (e: any) => e?.code === 'plan_store_unavailable');
    assert.equal(plans.getTenantPlan(T), 'FREE');
  });

  it('P2 store write hangs → error within the timeout, no promotion', async () => {
    store.mode = 'hang';
    const t0 = Date.now();
    await assert.rejects(() => plans.assignPlan(T, 'PRO'));
    assert.ok(Date.now() - t0 < 2_000, 'bounded by OTK_PLAN_STORE_TIMEOUT_MS');
    assert.equal(plans.getTenantPlan(T), 'FREE');
  });
});

describe('H1-S01 P3/P4: restart and downgrade durability', () => {
  it('P3 control: a confirmed PRO survives a restart (new process hydrates from the store)', async () => {
    await plans.assignPlan(T, 'PRO');
    const backend = store.inner;
    plans.resetPlanStoreForTest();               // "restart": empty cache, default store
    assert.equal(plans.getTenantPlan(T), 'FREE');
    await plans.setPlanStore(backend);          // bootstrap with the same durable backend
    assert.equal(plans.getTenantPlan(T), 'PRO');
  });

  it('P4 downgrade that the store did not confirm → error reported (not 200), local view already lowered', async () => {
    await plans.assignPlan(T, 'PRO');
    store.mode = 'fail';
    const r = await assign(platform, { tenantId: T, tier: 'FREE' });
    assert.equal(r.status, 503, 'the caller must learn the downgrade is not durable, so it retries');
    assert.equal(plans.getTenantPlan(T), 'FREE', 'fail-closed: unconfirmed downgrade already limits this instance');
    store.mode = 'ok';
    const retry = await assign(platform, { tenantId: T, tier: 'FREE' });
    assert.equal(retry.status, 200);
    assert.equal(await store.inner.get(T), 'FREE', 'after the retry the downgrade is durable');
  });
});

describe('H1-S01 P5: concurrency through versions', () => {
  it('two writers holding the same version: the second gets plan_version_conflict and writes nothing', async () => {
    await plans.assignPlan(T, 'PRO');
    const v = (await plans.getTenantPlanVersioned(T)).version;
    await plans.assignPlan(T, 'FREE', { expectedVersion: v, actor: 'platform' });           // downgrade wins
    await assert.rejects(() => plans.assignPlan(T, 'PRO', { expectedVersion: v, actor: 'stale' }),
      (e: any) => e?.code === 'plan_version_conflict');
    assert.equal(await store.inner.get(T), 'FREE', 'the downgrade was not lost');
    assert.equal(plans.getTenantPlan(T), 'FREE');
  });

  it('audit trail records every confirmed change with actor and source', async () => {
    await assign(platform, { tenantId: T, tier: 'STARTER' });
    await assign(platform, { tenantId: T, tier: 'FREE' });
    const audit = await plans.listPlanAudit(T);
    assert.deepEqual(audit.map((a: any) => [a.fromTier, a.toTier, a.actor, a.source]),
      [[null, 'STARTER', 'platform', 'admin_api'], ['STARTER', 'FREE', 'platform', 'admin_api']]);
    assert.deepEqual(audit.map((a: any) => a.version), [1, 2]);
  });
});

describe('H1-S01 P6/P7: replicas share the store, not the cache', () => {
  it('downgrade written by another replica applies to this replica on the next quota check', async () => {
    await plans.assignPlan(T, 'PRO');
    const epoch = String((await import('../../src/types/receipt.js')).deriveEpoch(Math.floor(Date.now() / 1000)));
    talRt.getAccountingLayer().debit({ tenantId: T, epochId: epoch, requestId: `s01-p6-${RUN}`, provider: 'openai', model: 'gpt-4o', cu: 10_000n, ts: Date.now() });
    assert.equal((await quota.checkMeteringQuotaAsync(T)).exceeded, false, 'control: PRO has no hard limit');
    await store.inner.assign(T, 'FREE');           // replica 2 (or Stripe on replica 2) downgraded; our cache says PRO
    assert.equal((await quota.checkMeteringQuotaAsync(T)).exceeded, true, 'FREE quota (10 000 CU) applies at once');
    const res = await quota.reserveMeteringQuota(T, 1n);
    assert.equal(res.exceeded, true, 'the POST /receipts reservation path sees it too');
  });
});

describe('H1-S01 P8: unknown or inactive tenant', () => {
  it('platform cannot assign a plan to a tenant that does not exist → 404, nothing stored', async () => {
    const r = await assign(platform, { tenantId: GHOST, tier: 'PRO' });
    assert.equal(r.status, 404, JSON.stringify(r.json));
    assert.equal(await store.inner.get(GHOST), null);
  });

  it('control: tenant role can lower its own plan (exists, own tenant)', async () => {
    await plans.assignPlan(T, 'STARTER');
    const r = await assign(bearer(OWNER_TOK), { tenantId: T, tier: 'FREE' });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.equal(await store.inner.get(T), 'FREE');
  });
});

describe('H1-S01 P9: deployed environment refuses a non-durable plan store', () => {
  it('NODE_ENV=production with a memory plan store → problem listed; PostgreSQL, development or explicit opt-out → none', () => {
    const prevEnv = process.env['NODE_ENV']; const prevOpt = process.env['OTK_ALLOW_NON_DURABLE_STORES'];
    try {
      delete process.env['OTK_ALLOW_NON_DURABLE_STORES'];
      process.env['NODE_ENV'] = 'production';
      assert.ok(boot.deployedStoreProblems({ redis: false, pg: false, stores: {} }).length > 0, 'no OTK_DB_URL');
      assert.ok(boot.deployedStoreProblems({ redis: false, pg: false, stores: { planStore: 'memory' } }).length > 0, 'PG unreachable');
      const allPg = { planStore: 'pg', subjectStatus: 'pg', userStore: 'pg', apiKeyMetadata: 'pg' };
      assert.deepEqual(boot.deployedStoreProblems({ redis: false, pg: true, stores: allPg }), []);
      // H1 R-03: plan store ok but the revocation status load failed afterwards (pg=false, no subjectStatus) → refused
      assert.ok(boot.deployedStoreProblems({ redis: false, pg: false, stores: { planStore: 'pg', userStore: 'pg', apiKeyMetadata: 'pg' } })
        .some((p: string) => p.includes('subjectStatus')));
      process.env['OTK_ALLOW_NON_DURABLE_STORES'] = '1';
      assert.deepEqual(boot.deployedStoreProblems({ redis: false, pg: false, stores: {} }), []);
      delete process.env['OTK_ALLOW_NON_DURABLE_STORES'];
      process.env['NODE_ENV'] = 'development';
      assert.deepEqual(boot.deployedStoreProblems({ redis: false, pg: false, stores: {} }), []);
    } finally {
      if (prevEnv === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = prevEnv;
      if (prevOpt === undefined) delete process.env['OTK_ALLOW_NON_DURABLE_STORES']; else process.env['OTK_ALLOW_NON_DURABLE_STORES'] = prevOpt;
    }
  });
});

describe('H1-S03: Stripe webhook effects', () => {
  const checkout = (id: string, created: number, payment_status: string, tier = 'PRO') => ({
    type: 'checkout.session.completed', id, created, data: { object: { payment_status, metadata: { tenantId: T, tier } } },
  });
  const cancelled = (id: string, created: number) => ({
    type: 'customer.subscription.deleted', id, created, data: { object: { metadata: { tenantId: T } } },
  });

  it('control: paid checkout activates the tier, persisted, audited with the event id', async () => {
    const r = await new stripe.StripeWebhookHandler().handle(checkout(`evt_paid_${RUN}`, 100, 'paid'));
    assert.equal(r.action, 'plan_activated');
    assert.equal(await store.inner.get(T), 'PRO');
    const audit = await plans.listPlanAudit(T);
    assert.equal(audit.at(-1).actor, `stripe:evt_paid_${RUN}`);
  });

  it('unpaid checkout (asynchronous payment pending) does not activate a paid tier', async () => {
    const r = await new stripe.StripeWebhookHandler().handle(checkout(`evt_unpaid_${RUN}`, 100, 'unpaid'));
    assert.notEqual(r.action, 'plan_activated');
    assert.equal(await store.inner.get(T), null);
    assert.equal(plans.getTenantPlan(T), 'FREE');
  });

  it('unknown tier in the metadata is refused', async () => {
    const r = await new stripe.StripeWebhookHandler().handle(checkout(`evt_tier_${RUN}`, 100, 'paid', 'ENTERPRISE'));
    assert.equal(r.ok, false);
    assert.equal(await store.inner.get(T), null);
  });

  it('plan-store failure → retryable (route answers 503) and a redelivery after recovery applies it', async () => {
    store.mode = 'fail';
    const h = new stripe.StripeWebhookHandler();
    const first = await h.handle(checkout(`evt_retry_${RUN}`, 100, 'paid'));
    assert.equal(first.retryable, true, `failure must be retryable: ${JSON.stringify(first)}`);
    assert.equal(plans.getTenantPlan(T), 'FREE');
    store.mode = 'ok';
    const again = await h.handle(checkout(`evt_retry_${RUN}`, 100, 'paid'));
    assert.equal(again.action, 'plan_activated', 'the event was not marked processed while it failed');
    assert.equal(await store.inner.get(T), 'PRO');
  });

  it('duplicate delivery is applied once', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout(`evt_dup_${RUN}`, 100, 'paid'));
    const audit = (await plans.listPlanAudit(T)).length;
    const r = await h.handle(checkout(`evt_dup_${RUN}`, 100, 'paid'));
    assert.equal(r.action, 'duplicate_ignored');
    // H1-S03b: the duplicate check happens inside the atomic store operation, so the store is called; nothing changes
    assert.equal((await plans.listPlanAudit(T)).length, audit, 'no second plan change');
  });

  it('out-of-order: an older checkout delivered after a newer cancellation does not resurrect PRO', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout(`evt_ooo_a_${RUN}`, 100, 'paid'));
    await h.handle(cancelled(`evt_ooo_c_${RUN}`, 300));
    assert.equal(await store.inner.get(T), 'FREE');
    const late = await h.handle(checkout(`evt_ooo_b_${RUN}`, 200, 'paid'));
    assert.equal(late.action, 'stale_ignored');
    assert.equal(await store.inner.get(T), 'FREE');
  });
});
