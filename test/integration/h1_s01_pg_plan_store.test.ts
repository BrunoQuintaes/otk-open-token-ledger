/**
 * H1-S01 (OTK-H1-MEGA-S01-S24-20261013): PgPlanStore against a real, disposable PostgreSQL.
 *
 * Runs only with OTK_TEST_PG_URL (a throwaway database; the tables otk_plan_assignments, otk_plan_audit and
 * otk_stripe_events are dropped and recreated). Without it the suite is skipped (no PostgreSQL in the default run).
 * A dedicated variable is used instead of OTK_DB_URL so that setting it never changes the store mode of other tests.
 *
 * Covers what the memory fake cannot: the transaction (plan row + audit row commit together), the version check
 * under FOR UPDATE with two real connections, the primary-key race between two first assignments, the additive
 * migration of a pre-H1 table, a connection failure surfacing as an error (no false success), and two "replicas"
 * (two pools) observing each other's writes through the store.
 *
 * Modules under test: `src/billing/IPlanStore.ts` (`PgPlanStore`) and `src/billing/PlanRegistry.ts`.
 *
 * Further scenarios: a stale expected version is a conflict and writes nothing; a plan change and its billing
 * event record commit atomically (a failing event insert leaves the plan untouched); the same billing event from
 * two connections is applied once; stale and same-second upgrade events are recorded but not applied; and a write
 * blocked past the store's server-side bound (`OTK_PLAN_STORE_TIMEOUT_MS`, set to 300 ms in that case and then
 * restored) rolls back on the server instead of committing late.
 *
 * Needs: `OTK_TEST_PG_URL` pointing at a disposable PostgreSQL database (see above); without it every case is
 * skipped.
 *
 * Run just this file: `npx tsx --test test/integration/h1_s01_pg_plan_store.test.ts`
 *
 * @module test/integration/h1_s01_pg_plan_store.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const PG_URL = process.env['OTK_TEST_PG_URL'];

/* eslint-disable @typescript-eslint/no-explicit-any */
describe(PG_URL ? 'H1-S01 PgPlanStore on PostgreSQL (OTK_TEST_PG_URL set)' : 'H1-S01 PgPlanStore on PostgreSQL (SKIPPED — set OTK_TEST_PG_URL)', { skip: !PG_URL }, () => {
  let pg: any; let poolA: any; let poolB: any; let stores: any;

  before(async () => {
    pg = await import('pg');
    const Pool = pg.default?.Pool ?? pg.Pool;
    poolA = new Pool({ connectionString: PG_URL, max: 4 });
    poolB = new Pool({ connectionString: PG_URL, max: 4 });
    stores = await import('../../src/billing/IPlanStore.js');
    await poolA.query('DROP TABLE IF EXISTS otk_plan_assignments, otk_plan_audit, otk_stripe_events');
    // pre-H1 schema with one row, to exercise the additive migration
    await poolA.query(`CREATE TABLE otk_plan_assignments (tenant_id TEXT PRIMARY KEY, plan TEXT NOT NULL DEFAULT 'FREE', assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await poolA.query(`INSERT INTO otk_plan_assignments (tenant_id, plan) VALUES ('legacy-t', 'STARTER')`);
  });

  after(async () => {
    await poolA?.end(); await poolB?.end();
  });

  it('migration keeps pre-H1 rows (version 1) and init is idempotent', async () => {
    const s = new stores.PgPlanStore(poolA);
    await s.init(); await s.init();
    assert.deepEqual(await s.getVersioned('legacy-t'), { tier: 'STARTER', version: 1 });
  });

  it('assign writes the plan and the audit row in one transaction, version increments', async () => {
    const s = new stores.PgPlanStore(poolA);
    const r1 = await s.assign('t1', 'PRO', { actor: 'platform', source: 'test' });
    const r2 = await s.assign('t1', 'FREE', { actor: 'stripe:evt_x', source: 'stripe_webhook', expectedVersion: 1 });
    assert.deepEqual(r1, { previous: null, version: 1 });
    assert.deepEqual(r2, { previous: 'PRO', version: 2 });
    const audit = await s.listAudit('t1');
    assert.deepEqual(audit.map((a: any) => [a.fromTier, a.toTier, a.version, a.actor]), [[null, 'PRO', 1, 'platform'], ['PRO', 'FREE', 2, 'stripe:evt_x']]);
  });

  it('stale expectedVersion → PlanVersionConflictError, nothing written (plan and audit unchanged)', async () => {
    const s = new stores.PgPlanStore(poolA);
    await assert.rejects(() => s.assign('t1', 'PRO', { expectedVersion: 1 }), (e: any) => e?.code === 'plan_version_conflict');
    assert.deepEqual(await s.getVersioned('t1'), { tier: 'FREE', version: 2 });
    assert.equal((await s.listAudit('t1')).length, 2);
  });

  it('two connections racing with the same version: exactly one commits', async () => {
    const a = new stores.PgPlanStore(poolA); const b = new stores.PgPlanStore(poolB);
    await a.assign('race', 'STARTER');
    const results = await Promise.allSettled([
      a.assign('race', 'PRO', { expectedVersion: 1, actor: 'A' }),
      b.assign('race', 'FREE', { expectedVersion: 1, actor: 'B' }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1, JSON.stringify(results.map((r) => r.status)));
    const rej = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.equal(rej.reason?.code, 'plan_version_conflict');
    assert.equal((await a.getVersioned('race')).version, 2);
    assert.equal((await a.listAudit('race')).length, 2);
  });

  it('two first assignments racing (no row yet): one commits, the other is a conflict, never two rows', async () => {
    const a = new stores.PgPlanStore(poolA); const b = new stores.PgPlanStore(poolB);
    const results = await Promise.allSettled([
      a.assign('first', 'PRO', { expectedVersion: 0 }),
      b.assign('first', 'STARTER', { expectedVersion: 0 }),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal((await a.listAudit('first')).length, 1);
  });

  it('replicas: a downgrade through pool B is what the registry on pool A reads next (getTenantPlanAsync)', async () => {
    const plans = await import('../../src/billing/PlanRegistry.js');
    plans.resetPlanStoreForTest();
    await plans.setPlanStore(new stores.PgPlanStore(poolA));
    await plans.assignPlan('rep', 'PRO');
    assert.equal(plans.getTenantPlan('rep'), 'PRO');
    await new stores.PgPlanStore(poolB).assign('rep', 'FREE');            // the other replica
    assert.equal(await plans.getTenantPlanAsync('rep'), 'FREE');
    assert.equal(plans.getTenantPlan('rep'), 'FREE');
    plans.resetPlanStoreForTest();
  });

  it('connection failure: assignPlan rejects (no false success) and the cache is not promoted', async () => {
    const plans = await import('../../src/billing/PlanRegistry.js');
    const Pool = pg.default?.Pool ?? pg.Pool;
    const dead = new Pool({ connectionString: PG_URL, max: 1 });
    plans.resetPlanStoreForTest();
    await plans.setPlanStore(new stores.PgPlanStore(dead));
    await dead.end();                                                    // database gone after start
    await assert.rejects(() => plans.assignPlan('down', 'PRO'), (e: any) => e?.code === 'plan_store_unavailable');
    assert.equal(plans.getTenantPlan('down'), 'FREE');
    plans.resetPlanStoreForTest();
    assert.equal(await new stores.PgPlanStore(poolA).get('down'), null, 'nothing persisted');
  });

  it('H1-S03b: plan change and event record are atomic — a failing event insert leaves the plan untouched', async () => {
    const s = new stores.PgPlanStore(poolA);
    await poolA.query(`CREATE OR REPLACE FUNCTION h1_fail_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.event_id LIKE 'evt_fail%' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$`);
    await poolA.query('DROP TRIGGER IF EXISTS h1_fail_event ON otk_stripe_events');
    await poolA.query('CREATE TRIGGER h1_fail_event BEFORE INSERT ON otk_stripe_events FOR EACH ROW EXECUTE FUNCTION h1_fail_event()');
    try {
      await assert.rejects(() => s.assign('atom', 'PRO', { stripeEvent: { id: 'evt_fail_1', created: 10, type: 'checkout.session.completed' } }));
      assert.equal(await s.get('atom'), null, 'no plan without its event record');
      assert.equal((await s.listAudit('atom')).length, 0);
    } finally {
      await poolA.query('DROP TRIGGER IF EXISTS h1_fail_event ON otk_stripe_events');
    }
    const ok = await s.assign('atom', 'PRO', { stripeEvent: { id: 'evt_ok_1', created: 10, type: 'checkout.session.completed' } });
    assert.notEqual(ok.applied, false);
    assert.equal(await s.get('atom'), 'PRO');
  });

  it('H1-S03b: the same event from two connections at once is applied exactly once', async () => {
    const a = new stores.PgPlanStore(poolA); const b = new stores.PgPlanStore(poolB);
    const ev = { id: 'evt_dup_1', created: 20, type: 'checkout.session.completed' };
    const rs = await Promise.all([a.assign('dupt', 'STARTER', { stripeEvent: ev }), b.assign('dupt', 'STARTER', { stripeEvent: ev })]);
    assert.equal(rs.filter((r: any) => r.applied === false).length, 1, JSON.stringify(rs));
    assert.equal((await a.listAudit('dupt')).length, 1);
  });

  it('H1-S03b: stale and same-second-upgrade events are recorded but not applied', async () => {
    const s = new stores.PgPlanStore(poolA);
    await s.assign('ord', 'PRO', { stripeEvent: { id: 'evt_o1', created: 100, type: 'checkout.session.completed' } });
    await s.assign('ord', 'FREE', { stripeEvent: { id: 'evt_o2', created: 300, type: 'customer.subscription.deleted' } });
    const late = await s.assign('ord', 'PRO', { stripeEvent: { id: 'evt_o3', created: 200, type: 'checkout.session.completed' } });
    const tie = await s.assign('ord', 'PRO', { stripeEvent: { id: 'evt_o4', created: 300, type: 'checkout.session.completed' } });
    assert.equal(late.skipped, 'stale'); assert.equal(tie.skipped, 'stale');
    assert.equal(await s.get('ord'), 'FREE');
  });

  it('H1-S01b: a write blocked past the server bound rolls back on the server (no late COMMIT)', async () => {
    const prev = process.env['OTK_PLAN_STORE_TIMEOUT_MS'];
    process.env['OTK_PLAN_STORE_TIMEOUT_MS'] = '300';
    const s = new stores.PgPlanStore(poolB);
    await s.assign('lockt', 'FREE');
    const holder = await poolA.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtextextended('otk_plan:' || 'lockt', 0))");
      await assert.rejects(() => s.assign('lockt', 'PRO'), /lock timeout|statement timeout|canceling statement/);
      await new Promise((r) => setTimeout(r, 400));
      await holder.query('COMMIT');
    } finally {
      holder.release();
      if (prev === undefined) delete process.env['OTK_PLAN_STORE_TIMEOUT_MS']; else process.env['OTK_PLAN_STORE_TIMEOUT_MS'] = prev;
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(await s.get('lockt'), 'FREE', 'the timed-out upgrade never commits');
  });
});
