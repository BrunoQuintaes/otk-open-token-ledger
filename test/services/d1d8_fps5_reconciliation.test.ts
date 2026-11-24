/**
 * Fechamento pós-S5 — RV2-02 / AUD-4: the pending-price reconciliation makes progress past operations
 * that can never be priced, persists its schedule across restarts, and two workers never settle the same
 * operation twice. Real PostgreSQL 16, front B's real ports and price tables; no provider involved (the
 * usage is already stored with each operation).
 *
 *   . scripts/ops/fps5_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_fps5_reconciliation.test.ts
 *
 * Setup per scenario: N operations of one tenant under a money budget, final CU debited, money
 * pending_price. The first ones carry a frozen table that does not exist (`missing`): never priceable.
 * The rest carry the loaded illustrative table: priceable by the reconciliation.
 */
process.env['OTK_DB_URL'] = '';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';
import { writeFinal } from '../../src/operations/proxyDurable.js';
import { resolvePendingPrices } from '../../src/operations/pricingResolution.js';
import type { OperationKey, VersionRef } from '../../src/types/d1d8/index.js';
import { admitReq, cuResult, usage } from '../fixtures/d1d8/c/builders.js';

const P = 1_000_000_000_000n;
const tables = loadPriceTables(['test/fixtures/d1d8/b/price_table_illustrative_v1.json', 'scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json']);
const MISSING: VersionRef = { version: 'missing-audit-table', digest: `0x${'99'.repeat(32)}` as VersionRef['digest'] };
const AT = '2026-10-02T12:00:00.000Z';
let db: TestDb;
const runtimes: OperationsRuntime[] = [];

async function runtime(instanceId: string): Promise<OperationsRuntime> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, recoveryIntervalMs: 3_600_000, quotaFor: () => null,
    measurement: d1d8MeasurementPorts({ weights: developmentWeights(), prices: tables }) });
  runtimes.push(rt);
  return rt;
}

/** n pending-price operations of `tenant`; the first `missing` cannot be priced. updated_at spaced 1 s, oldest first. */
async function seed(rt: OperationsRuntime, tenant: string, n: number, missing: number): Promise<OperationKey[]> {
  await db.pool.query('INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ($1, $2, $3::numeric)', [`b-${tenant}`, tenant, (1000n * P).toString()]);
  const keys: OperationKey[] = [];
  for (let i = 0; i < n; i++) {
    const key = { tenantId: tenant, operationId: `p-${String(i).padStart(3, '0')}` };
    const req = admitReq(key, 10n, { money: 100_000_000_000n });
    req.config = { ...req.config, priceTable: i < missing ? MISSING : tables.active };
    assert.equal((await rt.store.admit(req)).outcome, 'admitted');
    await rt.store.transition(key, 0n, { execution: 'upstream_started' });
    assert.equal(await writeFinal(rt, key, { outcome: 'completed', usage: usage(10n, 2n), cu: cuResult(5n),
      price: { schema: 'otk.price_quote.v1', status: 'missing_price', total: null, lines: [], priceTable: req.config.priceTable!, pricedAt: AT },
      delivery: 'delivered', providerRequestId: 'fps5-local', localCount: null, at: AT }), 'written');
    await db.pool.query("UPDATE otk_operations SET updated_at = '2026-01-01T00:00:00Z'::timestamptz + ($1::int * interval '1 second') WHERE tenant_id = $2 AND operation_id = $3", [i, tenant, key.operationId]);
    keys.push(key);
  }
  return keys;
}
const state = async (k: OperationKey) => (await db.pool.query<{ m: string; u: string; a: number; due: string | null }>(
  "SELECT money->>'state' AS m, updated_at::text AS u, price_attempts AS a, price_next_attempt_at::text AS due FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2", [k.tenantId, k.operationId])).rows[0]!;
async function accounting(tenant: string) {
  const debits = await db.pool.query<{ n: string; s: string }>("SELECT count(*)::text AS n, COALESCE(sum(units), 0)::text AS s FROM otk_ledger WHERE tenant_id = $1", [tenant]);
  const money = await db.pool.query<{ n: string; s: string }>("SELECT count(*)::text AS n, COALESCE(sum(units), 0)::text AS s FROM otk_money_ledger WHERE tenant_id = $1", [tenant]);
  const b = await db.pool.query<{ s: string; h: string }>('SELECT spent_units::text AS s, held_units::text AS h FROM otk_money_budget WHERE budget_id = $1', [`b-${tenant}`]);
  const open = await db.pool.query<{ s: string }>("SELECT COALESCE(sum(reserved_money), 0)::text AS s FROM otk_operations WHERE tenant_id = $1 AND money->>'state' IN ('held', 'held_uncertain', 'pending_price')", [tenant]);
  return { debits: Number(debits.rows[0]!.n), moneyRows: Number(money.rows[0]!.n), moneySum: money.rows[0]!.s, spent: b.rows[0]!.s, held: b.rows[0]!.h, openReserved: open.rows[0]!.s };
}

before(async () => { db = await createTestDb('fps5recon'); });
after(async () => { for (const rt of runtimes) await rt.stop(); await db.drop(); });

describe('RV2-02 — fair, persistent reconciliation of pending prices', () => {
  it('AUD-4 vector: 100 unpriceable oldest + 1 priceable, batch 100 → the priceable one settles by pass 2; business timestamps unchanged', async () => {
    const rt = await runtime('rec-a');
    const keys = await seed(rt, 'tA', 101, 100);
    const last = keys[100]!;
    const before = await state(last);
    const p1 = await resolvePendingPrices(rt, { limit: 100 });
    assert.deepEqual(p1, { settled: 0, pending: 100, stuck: 0 }, 'pass 1 claims the 100 oldest, never tried');
    assert.equal((await state(last)).m, 'pending_price');
    const p2 = await resolvePendingPrices(rt, { limit: 100 });
    assert.deepEqual(p2, { settled: 1, pending: 0, stuck: 0 }, 'pass 2: the unpriceable ones are backing off; op 101 is claimed and settled');
    const after = await state(last);
    assert.equal(after.m, 'settled');
    // the money settlement is a transition (updated_at moves for that one); the 100 others keep their business timestamps
    for (const k of keys.slice(0, 100)) {
      const s = await state(k);
      assert.equal(s.m, 'pending_price');
      assert.equal(s.a, 1);
      assert.ok(s.due !== null);
    }
    const first = await state(keys[0]!);
    assert.equal(first.u, (await db.pool.query<{ u: string }>("SELECT ('2026-01-01T00:00:00Z'::timestamptz)::text AS u")).rows[0]!.u, 'updated_at of an unpriceable operation untouched');
    assert.notEqual(before.u, '');
    const acc = await accounting('tA');
    assert.equal(acc.debits, 101, 'one CU debit per operation, none added by the reconciliation');
    assert.equal(acc.moneyRows, 1);
    assert.equal(acc.held, acc.openReserved, 'held = reservations still open (100 × worst case)');
    assert.equal(acc.held, (100n * 100_000_000_000n).toString());
  });

  it('more than one batch: 25 unpriceable then 5 priceable, batch 10 → all 5 settle by pass ceil(30/10) = 3; repeated passes add nothing', async () => {
    const rt = await runtime('rec-b');
    const keys = await seed(rt, 'tB', 30, 25);
    const passes = [];
    for (let i = 0; i < 3; i++) passes.push(await resolvePendingPrices(rt, { limit: 10 }));
    assert.deepEqual(passes.map((p) => p.settled), [0, 0, 5]);
    for (const k of keys.slice(25)) assert.equal((await state(k)).m, 'settled');
    const acc1 = await accounting('tB');
    for (let i = 0; i < 3; i++) assert.equal((await resolvePendingPrices(rt, { limit: 10 })).settled, 0);
    assert.deepEqual(await accounting('tB'), acc1, 'idempotent');
    assert.equal(acc1.moneyRows, 5);
    assert.equal(acc1.debits, 30);
  });

  it('restart between passes: the schedule is in PostgreSQL, a new runtime continues where the old one stopped', async () => {
    const rt1 = await runtime('rec-c1');
    const keys = await seed(rt1, 'tC', 12, 10);
    assert.equal((await resolvePendingPrices(rt1, { limit: 10 })).settled, 0);
    await rt1.stop();
    runtimes.splice(runtimes.indexOf(rt1), 1);
    const rt2 = await runtime('rec-c2');
    assert.equal((await resolvePendingPrices(rt2, { limit: 10 })).settled, 2, 'the two priceable ones, not the 10 already backing off');
    for (const k of keys.slice(10)) assert.equal((await state(k)).m, 'settled');
  });

  it('two workers in parallel over 40 priceable operations: each settles exactly once, totals exact', async () => {
    const w1 = await runtime('rec-d1'); const w2 = await runtime('rec-d2');
    await seed(w1, 'tD', 40, 0);
    const results = await Promise.all([1, 2, 3, 4].map((i) => resolvePendingPrices(i % 2 ? w1 : w2, { limit: 10 })));
    assert.equal(results.reduce((n, r) => n + r.settled, 0), 40);
    const acc = await accounting('tD');
    assert.equal(acc.moneyRows, 40, 'one money ledger row per operation');
    assert.equal(acc.debits, 40, 'one CU debit per operation');
    assert.equal(acc.spent, acc.moneySum, 'budget spent = Σ money ledger');
    assert.equal(acc.held, '0');
  });

  it('an unpriceable operation keeps its exposure, backs off exponentially (capped) and is reported as stuck', async () => {
    const rt = await runtime('rec-e');
    const [k] = await seed(rt, 'tE', 1, 1);
    const held0 = (await accounting('tE')).held;
    // OVERNIGHT 20261005 (F-P1-09): pending prices are claimed across ALL tenants (fairness); the unpriceable operations
    // left by the restart case (tC) become due again when the suite runs slowly (gate run on 681f8e4: pending 10 !== 1).
    // Keep this case about tE only: everything else pending is scheduled far ahead.
    await db.pool.query("UPDATE otk_operations SET price_next_attempt_at = now() + interval '1 hour' WHERE tenant_id <> 'tE' AND money->>'state' = 'pending_price'");
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      await db.pool.query("UPDATE otk_operations SET price_next_attempt_at = now() - interval '1 second' WHERE tenant_id = 'tE'"); // time travel: due again
      const r = await resolvePendingPrices(rt, { limit: 10, baseBackoffMs: 1_000, maxBackoffMs: 8_000, alertAfterAttempts: 5 });
      assert.equal(r.pending, 1);
      assert.equal(r.stuck, i >= 4 ? 1 : 0);
      const g = await db.pool.query<{ ms: string }>("SELECT round(extract(epoch FROM (price_next_attempt_at - now())) * 1000)::text AS ms FROM otk_operations WHERE tenant_id = 'tE'");
      gaps.push(Math.round(Number(g.rows[0]!.ms) / 1000));
    }
    assert.deepEqual(gaps, [1, 2, 4, 8, 8, 8], 'base × 2^attempts, capped at max');
    const s = await state(k!);
    assert.equal(s.m, 'pending_price');
    assert.equal(s.a, 6);
    assert.equal((await accounting('tE')).held, held0, 'worst case still held: nothing released or spent without a price');
    // not due → not claimed
    assert.equal((await resolvePendingPrices(rt, { limit: 10 })).pending, 0);
  });
});
