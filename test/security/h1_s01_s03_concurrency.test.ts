/**
 * H1-S01 / H1-S03 continuation (OTK-H1-MEGA-S01-S24-20261013): interleavings the first pass did not cover.
 *   C1 a read that started before a write and finished after it must not put the OLD tier back in the cache
 *      (before: getTenantPlanAsync wrote whatever it read; a stale PRO could survive a downgrade in sync readers);
 *   C2 an ambiguous write (client timeout) never leaves the cache above the store, and the next read reconciles;
 *   C3 Stripe: the plan change and the "event processed" record are ONE atomic effect (before: plan committed, then
 *      the ledger write could fail; a redelivery after an out-of-order event could then re-apply a stale tier);
 *   C4 Stripe: the same event delivered twice concurrently is applied once;
 *   C5 Stripe: an upgrade and a cancellation with the SAME `created` second resolve to the lower tier (fail closed);
 *   C6 Stripe: a signed event whose tenant does not exist is refused without creating a plan row.
 * In-memory fakes only; the PostgreSQL versions of C3/C4 are in test/integration/h1_s01_pg_plan_store.test.ts.
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_PLAN_STORE_TIMEOUT_MS'] = '150';

/* eslint-disable @typescript-eslint/no-explicit-any */
let plans: any; let planStores: any; let stripe: any;
const RUN = Date.now().toString(36);
const T = `h1c-${RUN}`;

/** Memory store whose reads can be paused, to interleave a read with a write. */
class GatedStore {
  inner: any; gate: Promise<void> | null = null; release: () => void = () => {};
  failEventInsert = false;
  constructor(inner: any) { this.inner = inner; }
  /** The NEXT read is held after it has read the store (one-shot), so it completes after later writes/reads. */
  pauseReads() { this.gate = new Promise<void>((r) => { this.release = () => r(); }); }
  private async hold() { const g = this.gate; this.gate = null; if (g) await g; }
  async assign(t: string, tier: string, meta?: any) {
    if (meta?.stripeEvent && this.failEventInsert) throw new Error('insert into otk_stripe_events failed');
    return this.inner.assign(t, tier, meta);
  }
  async get(t: string) { const v = await this.inner.getVersioned(t); await this.hold(); return v?.tier ?? null; }
  async getVersioned(t: string) { const v = await this.inner.getVersioned(t); await this.hold(); return v; }
  list() { return this.inner.list(); }
  listAudit(t?: string) { return this.inner.listAudit(t); }
  clear() { return this.inner.clear(); }
}

let store: GatedStore;
before(async () => {
  plans = await import('../../src/billing/PlanRegistry.js');
  planStores = await import('../../src/billing/IPlanStore.js');
  stripe = await import('../../src/billing/stripe/StripeWebhookHandler.js');
});
beforeEach(async () => {
  plans.resetPlanStoreForTest();
  store = new GatedStore(new planStores.MemoryPlanStore());
  await plans.setPlanStore(store);
});

describe('H1-S01 C1/C2: the cache never ends above the store', () => {
  it('C1 read started before a downgrade and finished after it does not restore PRO in the cache', async () => {
    await plans.assignPlan(T, 'PRO');
    store.pauseReads();
    const staleRead = plans.getTenantPlanAsync(T);              // reads PRO, then waits at the gate
    await new Promise((r) => setImmediate(r));
    await store.inner.assign(T, 'FREE');                        // downgrade lands in the store (e.g. another replica)
    assert.equal(await plans.getTenantPlanAsync(T), 'FREE');   // a fresh read sees it (cache FREE, version 2)
    store.release();                                            // the old read (PRO, version 1) completes now
    await staleRead;
    await new Promise((r) => setImmediate(r));
    assert.equal(await store.inner.get(T), 'FREE');
    assert.equal(plans.getTenantPlan(T), 'FREE', 'a stale read must not overwrite a newer version in the cache');
  });

  it('C2 timeout on an upgrade: 503 path, cache stays FREE; when the store later shows PRO the next read reconciles', async () => {
    const orig = store.assign.bind(store);
    let finish: () => void = () => {};
    store.assign = (t: string, tier: string, meta?: any) => new Promise((res) => { finish = () => res(orig(t, tier, meta)); }) as any;
    await assert.rejects(() => plans.assignPlan(T, 'PRO'), (e: any) => e?.code === 'plan_store_unavailable');
    assert.equal(plans.getTenantPlan(T), 'FREE');
    finish();                                                    // the "late COMMIT"
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(plans.getTenantPlan(T), 'FREE', 'a late commit is not trusted until it is read back');
    assert.equal(await plans.getTenantPlanAsync(T), 'PRO', 'the store is the truth; the next read reconciles');
  });
});

describe('H1-S03 C3–C6: Stripe events are atomic, idempotent and fail closed', () => {
  const ev = (id: string, type: string, created: number, tier?: string, payment = 'paid', tenant = T) => ({
    id, type, created,
    data: { object: type === 'checkout.session.completed'
      ? { payment_status: payment, metadata: { tenantId: tenant, tier } }
      : { metadata: { tenantId: tenant } } },
  });

  it('C3 the event record cannot be lost after the plan commits: a failure leaves plan AND record untouched', async () => {
    store.failEventInsert = true;
    const h = new stripe.StripeWebhookHandler();
    const r = await h.handle(ev(`c3_${RUN}`, 'checkout.session.completed', 100, 'PRO'));
    assert.equal(r.retryable, true, JSON.stringify(r));
    assert.equal(await store.inner.get(T), null, 'no plan written when the event record could not be written');
    store.failEventInsert = false;
    const again = await h.handle(ev(`c3_${RUN}`, 'checkout.session.completed', 100, 'PRO'));
    assert.equal(again.action, 'plan_activated');
    assert.equal(await store.inner.get(T), 'PRO');
  });

  it('C4 the same event delivered twice at the same time is applied once', async () => {
    const h1 = new stripe.StripeWebhookHandler(); const h2 = new stripe.StripeWebhookHandler();
    const e = ev(`c4_${RUN}`, 'checkout.session.completed', 100, 'STARTER');
    const [a, b] = await Promise.all([h1.handle(e), h2.handle(e)]);
    assert.deepEqual([a.action, b.action].sort(), ['duplicate_ignored', 'plan_activated']);
    assert.equal((await plans.listPlanAudit(T)).length, 1);
  });

  it('C5 checkout and cancellation in the same second: the lower tier wins in either arrival order', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(ev(`c5_cancel_${RUN}`, 'customer.subscription.deleted', 500));
    await h.handle(ev(`c5_checkout_${RUN}`, 'checkout.session.completed', 500, 'PRO'));
    assert.equal(await store.inner.get(T), 'FREE');
  });

  it('C6 signed event for a tenant that does not exist → refused, no plan row', async () => {
    const h = new stripe.StripeWebhookHandler({ tenantExists: async (t: string) => t === T });
    const r = await h.handle(ev(`c6_${RUN}`, 'checkout.session.completed', 100, 'PRO', 'paid', `ghost-${RUN}`));
    assert.equal(r.ok, false);
    assert.equal(r.action, 'unknown_tenant');
    assert.equal(r.retryable, true, 'H1 R-08: retried (503), not acknowledged and lost');
    assert.equal(await store.inner.get(`ghost-${RUN}`), null);
  });

  it('H1 R-08: a cancellation for a tenant this replica considers unknown/deactivated is still applied', async () => {
    await plans.assignPlan(T, 'PRO');
    const h = new stripe.StripeWebhookHandler({ tenantExists: async () => false });
    const r = await h.handle(ev(`r08_${RUN}`, 'customer.subscription.deleted', 900));
    assert.equal(r.action, 'downgraded_to_free');
    assert.equal(await store.inner.get(T), 'FREE');
  });

  it('H1 R-02: checkout sessions carry tenantId/tier in subscription_data.metadata (seen by subscription.deleted)', async () => {
    const { StripeClient } = await import('../../src/billing/stripe/StripeClient.js');
    let captured: any;
    const mock: any = { checkout: { sessions: { create: async (p: any) => { captured = p; return { id: 'cs', url: null, customer: null, payment_status: 'unpaid', metadata: p.metadata }; }, retrieve: async () => ({}) } },
      customers: { create: async () => ({}), list: async () => ({ data: [] }) }, webhooks: { constructEvent: () => ({}) } };
    await new StripeClient(mock, { PRO: 'price_fixture' }).createCheckoutSession({ tenantId: T, tier: 'PRO', successUrl: 'http://localhost/s', cancelUrl: 'http://localhost/c' });
    assert.deepEqual(captured.subscription_data?.metadata, { tenantId: T, tier: 'PRO' });
  });
});

describe('H1-S22: plan and Stripe failures are observable (no tenant id in the metrics)', () => {
  it('unavailable store and a retryable Stripe event show up in /metrics counters', async () => {
    const metrics = await import('../../src/observability/prometheusMetrics.js');
    store.failEventInsert = true;
    await new stripe.StripeWebhookHandler().handle({ id: `m_${RUN}`, type: 'checkout.session.completed', created: 1,
      data: { object: { payment_status: 'paid', metadata: { tenantId: T, tier: 'PRO' } } } });
    store.failEventInsert = false;
    const orig = store.assign.bind(store);
    store.assign = (() => Promise.reject(new Error('connection terminated'))) as any;
    await plans.assignPlan(T, 'PRO', { source: 'admin_api' }).catch(() => {});
    store.assign = orig;
    const text = await metrics.getMetricsText();
    assert.match(text, /otk_plan_store_ops_total\{source="stripe_webhook",outcome="unavailable"\} [1-9]/);
    assert.match(text, /otk_plan_store_ops_total\{source="admin_api",outcome="unavailable"\} [1-9]/);
    assert.match(text, /otk_stripe_webhook_events_total\{type="checkout.session.completed",action="plan_store_unavailable"\} [1-9]/);
    assert.ok(!text.includes(T), 'tenant id never appears in metrics');
  });
});

describe('H1 R-01 (adversarial review): ambiguous write + read that started before it', () => {
  it('a downgrade times out but commits; a read started BEFORE the failure (old PRO, same version) must not win', async () => {
    await plans.assignPlan(T, 'PRO');
    store.pauseReads();
    process.env['OTK_PLAN_STORE_TIMEOUT_MS'] = '3000';            // the held read must outlive the write timeout
    const oldRead = plans.getTenantPlanAsync(T);                  // reads PRO v1, held at the gate
    process.env['OTK_PLAN_STORE_TIMEOUT_MS'] = '150';
    await new Promise((r) => setImmediate(r));
    const orig = store.assign.bind(store);
    let commit: () => void = () => {};
    store.assign = ((t: string, tier: string, meta?: any) => new Promise((res) => { commit = () => res(orig(t, tier, meta)); })) as any;
    await assert.rejects(() => plans.assignPlan(T, 'FREE'), (e: any) => e?.code === 'plan_store_unavailable');
    store.assign = orig;
    assert.equal(plans.getTenantPlan(T), 'FREE', 'unconfirmed downgrade already applies locally');
    store.release();                                               // the old read returns PRO at version 1
    await oldRead;
    assert.equal(plans.getTenantPlan(T), 'FREE', 'the pre-failure read must not put PRO back (cache above the store)');
    commit();                                                      // late COMMIT: store FREE v2
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(await plans.getTenantPlanAsync(T), 'FREE');
  });

  it('control: if the ambiguous downgrade did NOT commit, a read started after the failure restores the true tier', async () => {
    await plans.assignPlan(T, 'PRO');
    const orig = store.assign.bind(store);
    store.assign = (() => Promise.reject(new Error('connection terminated'))) as any;
    await assert.rejects(() => plans.assignPlan(T, 'FREE'));
    store.assign = orig;
    assert.equal(plans.getTenantPlan(T), 'FREE');
    assert.equal(await plans.getTenantPlanAsync(T), 'PRO', 'store still says PRO (nothing committed)');
    assert.equal(plans.getTenantPlan(T), 'PRO');
  });
});

describe('H1 R-10: the USD-ceiling requirement is only turned off by an explicit 0', () => {
  it('deployed: unset/true/yes/empty keep it ON; 0 turns it off; development default OFF, 1 turns it on', async () => {
    const { moneyBudgetRequiredFromEnv } = await import('../../src/operations/runtime.js');
    const prevEnv = process.env['NODE_ENV']; const prev = process.env['OTK_REQUIRE_MONEY_BUDGET'];
    try {
      process.env['NODE_ENV'] = 'production';
      for (const v of [undefined, 'true', 'yes', '', ' 1 ']) {
        if (v === undefined) delete process.env['OTK_REQUIRE_MONEY_BUDGET']; else process.env['OTK_REQUIRE_MONEY_BUDGET'] = v;
        assert.equal(moneyBudgetRequiredFromEnv(), true, `value ${JSON.stringify(v)}`);
      }
      process.env['OTK_REQUIRE_MONEY_BUDGET'] = '0';
      assert.equal(moneyBudgetRequiredFromEnv(), false);
      process.env['NODE_ENV'] = 'development'; delete process.env['OTK_REQUIRE_MONEY_BUDGET'];
      assert.equal(moneyBudgetRequiredFromEnv(), false);
      process.env['OTK_REQUIRE_MONEY_BUDGET'] = '1';
      assert.equal(moneyBudgetRequiredFromEnv(), true);
    } finally {
      if (prevEnv === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = prevEnv;
      if (prev === undefined) delete process.env['OTK_REQUIRE_MONEY_BUDGET']; else process.env['OTK_REQUIRE_MONEY_BUDGET'] = prev;
    }
  });
});
