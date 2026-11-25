/**
 * H1R2 A2 — R-07 / R-11 (OTK H1 final closure R2, 2026-10-13): authoritative per-tenant order between administrative
 * plan decisions and Stripe events. In-memory store, through the Stripe webhook handler and PlanRegistry; the same
 * rules against a real PostgreSQL are in test/integration/h1r2_a2_pg_plan_ordering.test.ts.
 *
 *   R-07 an event created before a later administrative decision (or belonging to a subscription that decision
 *        revoked) must not restore the tier the decision removed; it is recorded as ignored with a reason;
 *   R-11 cancellation of subscription A and payment of subscription B in the same second: the tie is broken by the
 *        subscription identity (cancelling A never cancels B), not by the timestamp.
 * Controls: a NEW subscription after the decision still upgrades; events without subscription ids keep the H1-S03
 * fail-closed rules (C5 in h1_s01_s03_concurrency); same subscription in the same second still fails closed.
 *
 * Also covered: an ignored event is recorded with its reason and its redelivery is a duplicate; a subscription id
 * given as an expanded object is accepted; reprocessing every event after a restart is idempotent; a concurrent admin
 * downgrade and late old upgrade always end on the lower tier.
 *
 * Modules under test: `src/billing/PlanRegistry.ts`, `src/billing/IPlanStore.ts` (memory store) and
 * `src/billing/stripe/StripeWebhookHandler.ts`.
 *
 * Needs: nothing external. Empties `OTK_RECEIPT_LOG` and `OTK_DB_URL` and sets `OTK_PLAN_STORE_TIMEOUT_MS=500` in
 * `process.env` before importing. Event timestamps are relative to the wall clock (seconds since the Unix epoch).
 *
 * Run just this file: `npx tsx --test test/security/h1r2_a2_r07_r11_plan_ordering.test.ts`
 *
 * @module test/security/h1r2_a2_r07_r11_plan_ordering.test
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_PLAN_STORE_TIMEOUT_MS'] = '500';

/* eslint-disable @typescript-eslint/no-explicit-any */
let plans: any; let planStores: any; let stripe: any; let store: any;
const RUN = Date.now().toString(36);
let n = 0;
let T = '';
const NOW = () => Math.floor(Date.now() / 1000);

const checkout = (id: string, created: number, sub: string | null, tier = 'PRO', tenant = T) => ({
  type: 'checkout.session.completed', id: `${id}_${RUN}`, created,
  data: { object: { payment_status: 'paid', ...(sub ? { subscription: sub } : {}), metadata: { tenantId: tenant, tier } } },
});
const cancelled = (id: string, created: number, sub: string | null, tenant = T) => ({
  type: 'customer.subscription.deleted', id: `${id}_${RUN}`, created,
  data: { object: { ...(sub ? { id: sub, object: 'subscription' } : {}), metadata: { tenantId: tenant } } },
});

before(async () => {
  plans = await import('../../src/billing/PlanRegistry.js');
  planStores = await import('../../src/billing/IPlanStore.js');
  stripe = await import('../../src/billing/stripe/StripeWebhookHandler.js');
});
beforeEach(async () => {
  plans.resetPlanStoreForTest();
  store = new planStores.MemoryPlanStore();
  await plans.setPlanStore(store);
  T = `h1r2a2-${RUN}-${++n}`;
});

describe('H1R2 R-07: an administrative decision is not undone by an older Stripe event', () => {
  it('manual downgrade, then the late (first delivery failed) upgrade event of before the decision → stays FREE', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout('r07a_first', NOW() - 7200, 'sub_A', 'STARTER'));
    await plans.assignPlan(T, 'FREE', { actor: 'platform', source: 'admin_api' });   // authoritative decision
    // an upgrade event created BEFORE the decision, for a subscription never seen here (its first delivery failed)
    const late = await h.handle(checkout('r07a_late', NOW() - 3600, 'sub_X'));
    assert.equal(late.ok, true);
    assert.equal(late.action, 'admin_superseded_ignored', JSON.stringify(late));
    assert.equal(await store.get(T), 'FREE');
    assert.equal(plans.getTenantPlan(T), 'FREE');
  });

  it('identity, not clock: an event of a subscription the decision revoked is ignored even with a "future" created', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout('r07b_a', NOW() - 100, 'sub_A'));
    assert.equal(await store.get(T), 'PRO');
    await plans.assignPlan(T, 'FREE', { actor: 'platform', source: 'admin_api' });
    // Stripe clock ahead / skewed: created is AFTER the decision, but the subscription was revoked by it
    const r = await h.handle(checkout('r07b_again', NOW() + 3600, 'sub_A'));
    assert.equal(r.action, 'admin_superseded_ignored', JSON.stringify(r));
    assert.equal(await store.get(T), 'FREE');
  });

  it('legacy event without subscription id, created before the decision → ignored (time fallback)', async () => {
    await plans.assignPlan(T, 'STARTER', { actor: 'platform', source: 'admin_api' });
    const r = await new stripe.StripeWebhookHandler().handle(checkout('r07c', NOW() - 600, null, 'PRO'));
    assert.equal(r.action, 'admin_superseded_ignored');
    assert.equal(await store.get(T), 'STARTER');
  });

  it('the ignored event is recorded with its reason and a redelivery is idempotent (duplicate, no audit row)', async () => {
    const h = new stripe.StripeWebhookHandler();
    await plans.assignPlan(T, 'FREE', { actor: 'platform', source: 'admin_api' });
    const ev = checkout('r07d', NOW() - 600, 'sub_old');
    await h.handle(ev);
    const audit = (await plans.listPlanAudit(T)).length;
    const again = await h.handle(ev);
    assert.equal(again.action, 'duplicate_ignored');
    assert.equal((await plans.listPlanAudit(T)).length, audit);
    const evs = await store.listStripeEvents(T);
    assert.deepEqual(evs.map((e: any) => [e.eventId, e.applied, e.skipReason, e.subscriptionId]), [[ev.id, false, 'superseded_by_admin', 'sub_old']]);
    const ord = await store.getPlanOrdering(T);
    assert.equal(typeof ord.adminDecidedAtMs, 'number');
    assert.equal(ord.adminVersion, 1);
  });

  it('control: a NEW subscription paid after the decision still upgrades', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout('r07e_a', NOW() - 100, 'sub_A'));
    await plans.assignPlan(T, 'FREE', { actor: 'platform', source: 'admin_api' });
    const r = await h.handle(checkout('r07e_b', NOW() + 3600, 'sub_B'));
    assert.equal(r.action, 'plan_activated', JSON.stringify(r));
    assert.equal(await store.get(T), 'PRO');
  });

  it('control: a Stripe cancellation after a manual upgrade is still applied (downgrade = fail closed)', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout('r07f_a', NOW() - 100, 'sub_A', 'STARTER'));
    await plans.assignPlan(T, 'PRO', { actor: 'platform', source: 'admin_api' });
    const r = await h.handle(cancelled('r07f_c', NOW() - 50, 'sub_A'));
    assert.equal(r.action, 'downgraded_to_free');
    assert.equal(await store.get(T), 'FREE');
  });
});

describe('H1R2 R-11: subscription identity breaks ties, not the timestamp', () => {
  it('old cancellation of A delivered after the new subscription B → B stays (other_subscription)', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout('r11a_a', 100, 'sub_A', 'STARTER'));
    await h.handle(checkout('r11a_b', 200, 'sub_B', 'PRO'));
    const r = await h.handle(cancelled('r11a_cA', 300, 'sub_A'));
    assert.equal(r.action, 'other_subscription_ignored', JSON.stringify(r));
    assert.equal(await store.get(T), 'PRO');
    // and A cannot come back afterwards: its subscription is recorded as cancelled
    const back = await h.handle(checkout('r11a_a2', 400, 'sub_A', 'PRO'));
    assert.equal(back.action, 'stale_ignored');
  });

  it('same second, cancellation of A first then payment of B → PRO (payment preserved)', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout('r11b_a', 100, 'sub_A', 'STARTER'));
    await h.handle(cancelled('r11b_cA', 500, 'sub_A'));
    const r = await h.handle(checkout('r11b_b', 500, 'sub_B', 'PRO'));
    assert.equal(r.action, 'plan_activated', JSON.stringify(r));
    assert.equal(await store.get(T), 'PRO');
  });

  it('same second, payment of B first then cancellation of A → PRO (payment preserved)', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout('r11c_a', 100, 'sub_A', 'STARTER'));
    await h.handle(checkout('r11c_b', 500, 'sub_B', 'PRO'));
    const r = await h.handle(cancelled('r11c_cA', 500, 'sub_A'));
    assert.equal(r.action, 'other_subscription_ignored');
    assert.equal(await store.get(T), 'PRO');
  });

  it('control: same subscription, cancellation and payment in the same second → fails closed (FREE)', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout('r11d_a', 100, 'sub_A', 'STARTER'));
    await h.handle(cancelled('r11d_cA', 500, 'sub_A'));
    const r = await h.handle(checkout('r11d_a2', 500, 'sub_A', 'PRO'));
    assert.equal(r.action, 'stale_ignored');
    assert.equal(await store.get(T), 'FREE');
  });

  it('control: cancellation of the ACTIVE subscription is applied', async () => {
    const h = new stripe.StripeWebhookHandler();
    await h.handle(checkout('r11e_b', 100, 'sub_B', 'PRO'));
    const r = await h.handle(cancelled('r11e_cB', 200, 'sub_B'));
    assert.equal(r.action, 'downgraded_to_free');
    assert.equal(await store.get(T), 'FREE');
  });

  it('subscription id given as an expanded object is accepted', async () => {
    const h = new stripe.StripeWebhookHandler();
    const ev: any = checkout('r11f', 100, null, 'PRO');
    ev.data.object.subscription = { id: 'sub_OBJ', object: 'subscription' };
    await h.handle(ev);
    assert.equal((await store.getPlanOrdering(T)).activeSubscriptionId, 'sub_OBJ');
  });
});

describe('H1R2 A2: restart and concurrency (memory)', () => {
  it('reprocessing every event after a restart (new registry, same store) is idempotent', async () => {
    const h = new stripe.StripeWebhookHandler();
    const evs = [checkout('rs_a', 100, 'sub_A', 'STARTER'), checkout('rs_b', 200, 'sub_B'), cancelled('rs_cA', 300, 'sub_A')];
    for (const e of evs) await h.handle(e);
    await plans.assignPlan(T, 'FREE', { actor: 'platform', source: 'admin_api' });
    const audit = (await plans.listPlanAudit(T)).length;
    plans.resetPlanStoreForTest();
    await plans.setPlanStore(store);                                  // "restart": cache rebuilt from the store
    const h2 = new stripe.StripeWebhookHandler();
    for (const e of evs) assert.equal((await h2.handle(e)).action, 'duplicate_ignored');
    assert.equal(await store.get(T), 'FREE');
    assert.equal((await plans.listPlanAudit(T)).length, audit);
  });

  it('concurrent admin downgrade and late old upgrade: FREE whatever the interleaving', async () => {
    for (let i = 0; i < 20; i++) {
      const t = `${T}-c${i}`;
      await plans.assignPlan(t, 'STARTER', { actor: 'platform', source: 'admin_api' });
      const h = new stripe.StripeWebhookHandler();
      await Promise.all([
        h.handle(checkout(`cc${i}`, NOW() - 600, `sub_c${i}`, 'PRO', t)),
        plans.assignPlan(t, 'FREE', { actor: 'platform', source: 'admin_api' }),
      ]);
      assert.equal(await store.get(t), 'FREE', `iteration ${i}`);
    }
  });
});
