/**
 * H1R2 A2 — R-07 / R-11 against a real, disposable PostgreSQL (OTK_TEST_PG_URL; skipped without it).
 * Pattern of test/integration/h1_s01_pg_plan_store.test.ts: the plan tables (otk_plan_assignments, otk_plan_audit,
 * otk_stripe_events, otk_plan_subscriptions) are dropped and recreated.
 *
 * Covers: manual downgrade + late old upgrade (time and identity), NEW subscription after the decision, old
 * cancellation after a new subscription, same-second cancellation/payment (R-11), concurrency from two connections,
 * a failure between steps (nothing partially applied: plan, audit, event, subscription rows) and reprocessing after a
 * restart (new pool, new store) being idempotent.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const PG_URL = process.env['OTK_TEST_PG_URL'];
const NOW = () => Math.floor(Date.now() / 1000);

/* eslint-disable @typescript-eslint/no-explicit-any */
describe(PG_URL ? 'H1R2 A2 plan ordering on PostgreSQL (OTK_TEST_PG_URL set)' : 'H1R2 A2 plan ordering on PostgreSQL (SKIPPED — set OTK_TEST_PG_URL)', { skip: !PG_URL }, () => {
  let pg: any; let poolA: any; let poolB: any; let stores: any; let Pool: any;
  const up = (id: string, created: number, sub: string | null) => ({ stripeEvent: { id, created, type: 'checkout.session.completed', ...(sub ? { subscriptionId: sub } : {}) } });
  const del = (id: string, created: number, sub: string | null) => ({ stripeEvent: { id, created, type: 'customer.subscription.deleted', ...(sub ? { subscriptionId: sub } : {}) } });
  const admin = { actor: 'platform', source: 'admin_api' };

  before(async () => {
    pg = await import('pg');
    Pool = pg.default?.Pool ?? pg.Pool;
    poolA = new Pool({ connectionString: PG_URL, max: 4 });
    poolB = new Pool({ connectionString: PG_URL, max: 4 });
    stores = await import('../../src/billing/IPlanStore.js');
    await poolA.query('DROP TABLE IF EXISTS otk_plan_assignments, otk_plan_audit, otk_stripe_events, otk_plan_subscriptions');
    // pre-R2 schema (H1-S03b), to exercise the additive migration
    await poolA.query(`CREATE TABLE otk_plan_assignments (tenant_id TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'FREE', assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), version BIGINT NOT NULL DEFAULT 1)`);
    await poolA.query(`CREATE TABLE otk_stripe_events (event_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, created BIGINT NOT NULL, type TEXT NOT NULL, processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), applied BOOLEAN NOT NULL DEFAULT TRUE)`);
    await poolA.query(`INSERT INTO otk_plan_assignments (tenant_id, plan) VALUES ('legacy-r2', 'PRO')`);
    await poolA.query(`INSERT INTO otk_stripe_events (event_id, tenant_id, created, type) VALUES ('evt_legacy_r2', 'legacy-r2', 100, 'checkout.session.completed')`);
    const s = new stores.PgPlanStore(poolA);
    await s.init(); await s.init();
  });

  after(async () => { await poolA?.end(); await poolB?.end(); });

  it('migration keeps pre-R2 rows; a legacy (no subscription id) event is still a duplicate', async () => {
    const s = new stores.PgPlanStore(poolA);
    assert.deepEqual(await s.getVersioned('legacy-r2'), { tier: 'PRO', version: 1 });
    const r = await s.assign('legacy-r2', 'PRO', up('evt_legacy_r2', 100, null));
    assert.equal(r.skipped, 'duplicate');
  });

  it('R-07: manual downgrade, late old upgrade (unknown subscription, created before) → FREE, recorded with reason', async () => {
    const s = new stores.PgPlanStore(poolA);
    await s.assign('r07', 'STARTER', up('pg_r07_a', NOW() - 7200, 'sub_A'));
    await s.assign('r07', 'FREE', admin);
    const late = await s.assign('r07', 'PRO', up('pg_r07_late', NOW() - 3600, 'sub_X'));
    assert.equal(late.applied, false); assert.equal(late.skipped, 'superseded_by_admin');
    assert.equal(await s.get('r07'), 'FREE');
    const evs = await s.listStripeEvents('r07');
    assert.deepEqual(evs.map((e: any) => [e.eventId, e.applied, e.skipReason]), [['pg_r07_a', true, null], ['pg_r07_late', false, 'superseded_by_admin']]);
    const again = await s.assign('r07', 'PRO', up('pg_r07_late', NOW() - 3600, 'sub_X'));
    assert.equal(again.skipped, 'duplicate');
  });

  it('R-07 identity: event of the revoked subscription with a "future" created is ignored; a NEW subscription upgrades', async () => {
    const s = new stores.PgPlanStore(poolA);
    await s.assign('r07i', 'PRO', up('pg_r07i_a', NOW() - 100, 'sub_A'));
    await s.assign('r07i', 'FREE', admin);
    const ord = await s.getPlanOrdering('r07i');
    assert.equal(ord.adminVersion, 2); assert.equal(typeof ord.adminDecidedAtMs, 'number'); assert.equal(ord.activeSubscriptionId, null);
    assert.equal((await s.assign('r07i', 'PRO', up('pg_r07i_a2', NOW() + 3600, 'sub_A'))).skipped, 'superseded_by_admin');
    assert.equal(await s.get('r07i'), 'FREE');
    const ok = await s.assign('r07i', 'PRO', up('pg_r07i_b', NOW() + 3600, 'sub_B'));
    assert.notEqual(ok.applied, false);
    assert.equal(await s.get('r07i'), 'PRO');
  });

  it('R-11: old cancellation of A after the new subscription B does not cancel B; same second both orders → PRO', async () => {
    const s = new stores.PgPlanStore(poolA);
    await s.assign('r11', 'STARTER', up('pg_r11_a', 100, 'sub_A'));
    await s.assign('r11', 'PRO', up('pg_r11_b', 200, 'sub_B'));
    assert.equal((await s.assign('r11', 'FREE', del('pg_r11_cA', 300, 'sub_A'))).skipped, 'other_subscription');
    assert.equal(await s.get('r11'), 'PRO');

    await s.assign('r11s1', 'STARTER', up('pg_r11s1_a', 100, 'sub_A'));
    await s.assign('r11s1', 'FREE', del('pg_r11s1_cA', 500, 'sub_A'));
    assert.notEqual((await s.assign('r11s1', 'PRO', up('pg_r11s1_b', 500, 'sub_B'))).applied, false);
    assert.equal(await s.get('r11s1'), 'PRO');

    await s.assign('r11s2', 'STARTER', up('pg_r11s2_a', 100, 'sub_A'));
    await s.assign('r11s2', 'PRO', up('pg_r11s2_b', 500, 'sub_B'));
    assert.equal((await s.assign('r11s2', 'FREE', del('pg_r11s2_cA', 500, 'sub_A'))).skipped, 'other_subscription');
    assert.equal(await s.get('r11s2'), 'PRO');

    // control: same subscription in the same second still fails closed
    await s.assign('r11s3', 'STARTER', up('pg_r11s3_a', 100, 'sub_A'));
    await s.assign('r11s3', 'FREE', del('pg_r11s3_cA', 500, 'sub_A'));
    assert.equal((await s.assign('r11s3', 'PRO', up('pg_r11s3_a2', 500, 'sub_A'))).skipped, 'stale');
    assert.equal(await s.get('r11s3'), 'FREE');
  });

  it('concurrency (2 connections): admin downgrade vs old upgrade → always FREE; cancel A vs pay B → always PRO', async () => {
    const a = new stores.PgPlanStore(poolA); const b = new stores.PgPlanStore(poolB);
    for (let i = 0; i < 15; i++) {
      const t = `cc-adm-${i}`;
      await a.assign(t, 'STARTER', admin);
      await Promise.all([b.assign(t, 'PRO', up(`pg_cc_up_${i}`, NOW() - 600, `sub_cc${i}`)), a.assign(t, 'FREE', admin)]);
      assert.equal(await a.get(t), 'FREE', `admin iteration ${i}`);

      const u = `cc-sub-${i}`;
      await a.assign(u, 'STARTER', up(`pg_cc_a_${i}`, 100, 'sub_A'));
      const order = i % 2 === 0;
      await Promise.all([
        (order ? a : b).assign(u, 'FREE', del(`pg_cc_cA_${i}`, 500, 'sub_A')),
        (order ? b : a).assign(u, 'PRO', up(`pg_cc_b_${i}`, 500, 'sub_B')),
      ]);
      assert.equal(await a.get(u), 'PRO', `subscription iteration ${i}`);
    }
  });

  it('failure between steps: subscription-row insert fails → plan, audit, event and subscription rows unchanged', async () => {
    const s = new stores.PgPlanStore(poolA);
    await s.assign('fail', 'STARTER', up('pg_fail_a', 100, 'sub_A'));
    await poolA.query(`CREATE OR REPLACE FUNCTION h1r2_fail_sub() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.subscription_id = 'sub_FAIL' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$`);
    await poolA.query('DROP TRIGGER IF EXISTS h1r2_fail_sub ON otk_plan_subscriptions');
    await poolA.query('CREATE TRIGGER h1r2_fail_sub BEFORE INSERT OR UPDATE ON otk_plan_subscriptions FOR EACH ROW EXECUTE FUNCTION h1r2_fail_sub()');
    const auditBefore = (await s.listAudit('fail')).length;
    try {
      await assert.rejects(() => s.assign('fail', 'PRO', up('pg_fail_b', 200, 'sub_FAIL')));
      assert.equal(await s.get('fail'), 'STARTER');
      assert.equal((await s.listAudit('fail')).length, auditBefore);
      assert.deepEqual((await s.listStripeEvents('fail')).map((e: any) => e.eventId), ['pg_fail_a']);
      assert.equal((await s.getPlanOrdering('fail')).activeSubscriptionId, 'sub_A');
    } finally {
      await poolA.query('DROP TRIGGER IF EXISTS h1r2_fail_sub ON otk_plan_subscriptions');
    }
    assert.notEqual((await s.assign('fail', 'PRO', up('pg_fail_b', 200, 'sub_FAIL'))).applied, false, 'redelivery after recovery applies');
    assert.equal(await s.get('fail'), 'PRO');
  });

  it('restart: new pool + new store, reprocess every event → all duplicates, state unchanged', async () => {
    const s = new stores.PgPlanStore(poolA);
    const evs: Array<[string, any]> = [['PRO', up('pg_rs_a', NOW() - 100, 'sub_A')], ['PRO', up('pg_rs_b', NOW() - 50, 'sub_B')], ['FREE', del('pg_rs_cA', NOW() - 10, 'sub_A')]];
    for (const [tier, m] of evs) await s.assign('rs', tier, m);
    await s.assign('rs', 'FREE', admin);
    const snap = { v: await s.getVersioned('rs'), a: (await s.listAudit('rs')).length, e: (await s.listStripeEvents('rs')).length, o: await s.getPlanOrdering('rs') };
    const fresh = new Pool({ connectionString: PG_URL, max: 2 });
    try {
      const s2 = new stores.PgPlanStore(fresh);
      await s2.init();
      for (const [tier, m] of evs) assert.equal((await s2.assign('rs', tier, m)).skipped, 'duplicate');
      assert.deepEqual(await s2.getVersioned('rs'), snap.v);
      assert.equal((await s2.listAudit('rs')).length, snap.a);
      assert.equal((await s2.listStripeEvents('rs')).length, snap.e);
      assert.deepEqual(await s2.getPlanOrdering('rs'), snap.o);
      // an old upgrade of the revoked subscription after the restart is still ignored
      assert.equal((await s2.assign('rs', 'PRO', up('pg_rs_b2', NOW() + 3600, 'sub_B'))).skipped, 'superseded_by_admin');
    } finally {
      await fresh.end();
    }
  });
});
