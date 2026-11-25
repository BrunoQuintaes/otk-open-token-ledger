/**
 * H1-S07 (OTK-H1-MEGA-S01-S24-20261013) — no spend on the operator's provider key without a USD ceiling.
 * Before: a tenant without any money budget was admitted with only the CU quota, and PRO has no CU quota
 * (quotaFor → null), so spend was unbounded. Real PostgreSQL (createTestDb), same builders as d1d8_c_operation_store.
 *   M1 requireMoneyBudget: tenant without budget (PRO-like, no quota) → money_budget_required, nothing reserved;
 *      positive control: same tenant after the operator assigns a budget → admitted;
 *   M2 requireMoneyBudget off (development default): unchanged behaviour (admitted) — the switch is the difference;
 *   M3 globalBudgetId: a tenant with its own budget but outside the operator-wide budget → refused; member → admitted;
 *   M4 global ceiling under concurrency: 3 tenants × 4 parallel requests of US$ 0.40 against a US$ 1.00 global budget
 *      → exactly 2 admitted across ALL tenants (the shared row lock serialises them), held = US$ 0.80.
 *
 * Module under test: the admission of `src/operations/PgOperationStore.ts` with the money-budget requirement and the
 * operator-wide budget options, using operations built from `test/fixtures/d1d8/c/builders.ts`.
 *
 * Strategy: the four cases M1 to M4 listed above, including a positive control for M1.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`).
 *
 * Run just this file: `npx tsx --test test/services/h1_s07_money_required.test.ts`
 *
 * @module test/services/h1_s07_money_required.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { PgOperationStore } from '../../src/operations/PgOperationStore.js';
import { MONEY_SCALE } from '../../src/operations/accounting.js';
import { admitReq } from '../fixtures/d1d8/c/builders.js';

let db: TestDb;
const EPOCH = 'e1';
const W = 40n * MONEY_SCALE / 100n;    // worst-case reservation US$ 0.40
const store = (pool: pg.Pool, o: { requireMoneyBudget?: boolean; globalBudgetId?: string | null } = {}) =>
  new PgOperationStore(pool, { quotaFor: () => null, epochOf: () => EPOCH, ...o });

before(async () => { db = await createTestDb('h1s07'); });
after(async () => { await db.drop(); });

describe('H1-S07: a USD ceiling is required to spend the operator key', () => {
  it('M1 tenant without budget is refused before any reservation; with a budget it is admitted', async () => {
    const s = store(db.pool, { requireMoneyBudget: true });
    const r = await s.admit(admitReq({ tenantId: 'NB', operationId: 'nb-1' }, 1n, { money: W }));
    assert.deepEqual(r, { outcome: 'money_budget_required', globalBudgetId: null });
    const ops = await db.pool.query("SELECT count(*)::int AS n FROM otk_operations WHERE tenant_id = 'NB'").catch(() => ({ rows: [{ n: 0 }] }));
    assert.equal(ops.rows[0].n, 0, 'nothing admitted');
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-NB', 'NB', $1::numeric)", [(1n * MONEY_SCALE).toString()]);
    assert.equal((await s.admit(admitReq({ tenantId: 'NB', operationId: 'nb-2' }, 1n, { money: W }))).outcome, 'admitted');
  });

  it('M2 with the requirement off (development default) the old behaviour is unchanged', async () => {
    const s = store(db.pool, { requireMoneyBudget: false });
    assert.equal((await s.admit(admitReq({ tenantId: 'DEV', operationId: 'dev-1' }, 1n, { money: W }))).outcome, 'admitted');
  });

  it('M3 operator-wide budget: own budget is not enough, membership in the global budget is', async () => {
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-global', 'operator', $1::numeric), ('b-G1', 'G1', $1::numeric)", [(100n * MONEY_SCALE).toString()]);
    const s = store(db.pool, { requireMoneyBudget: true, globalBudgetId: 'b-global' });
    assert.deepEqual(await s.admit(admitReq({ tenantId: 'G1', operationId: 'g1-1' }, 1n, { money: W })), { outcome: 'money_budget_required', globalBudgetId: 'b-global' });
    await db.pool.query("INSERT INTO otk_money_budget_members (budget_id, tenant_id) VALUES ('b-global', 'G1')");
    assert.equal((await s.admit(admitReq({ tenantId: 'G1', operationId: 'g1-2' }, 1n, { money: W }))).outcome, 'admitted');
  });

  it('M4 global ceiling holds across tenants and concurrent admissions', async () => {
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-g4', 'operator4', $1::numeric)", [(1n * MONEY_SCALE).toString()]);
    for (const t of ['X1', 'X2', 'X3']) await db.pool.query("INSERT INTO otk_money_budget_members (budget_id, tenant_id) VALUES ('b-g4', $1)", [t]);
    const pools = [db.pool, db.newPool(), db.newPool()];
    const res = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      store(pools[i % 3]!, { requireMoneyBudget: true, globalBudgetId: 'b-g4' }).admit(admitReq({ tenantId: `X${(i % 3) + 1}`, operationId: `x-${i}` }, 1n, { money: W }))));
    const admitted = res.filter((r) => r.outcome === 'admitted').length;
    assert.equal(admitted, 2, JSON.stringify(res.map((r) => r.outcome)));
    assert.ok(res.every((r) => r.outcome === 'admitted' || r.outcome === 'budget_exceeded'));
    const b = await db.pool.query("SELECT held_units::text AS h FROM otk_money_budget WHERE budget_id = 'b-g4'");
    assert.equal(BigInt(b.rows[0].h), 2n * W);
  });
});
