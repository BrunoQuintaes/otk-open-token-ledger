/**
 * D1–D8 / C — PgOperationStore against real PostgreSQL (C1; D7-G07 store part, D3-G03/G06 for
 * operations, RV30-01 for admission). Two "instances" = two stores on two independent pools.
 *
 * Modules under test: `src/operations/PgOperationStore.ts` (`PgOperationStore`, `RevisionConflictError`), with
 * `src/operations/PgEffectOutbox.ts`, `src/operations/accounting.ts`, `src/operations/ledger.ts` and
 * `src/operations/transitions.ts`.
 *
 * Strategy / partitions: durable, idempotent, tenant-scoped admission (read from another pool; same id and digest
 * gives the existing operation, a different digest a conflict; the same id in another tenant is another operation;
 * 20 concurrent same-key admissions on two pools give one admission); quota contention (20 concurrent reservations
 * of 3,000 CU against 10,000 CU on one and on two instances: exactly 4 admitted); settlement moving held to confirmed
 * once, with the ledger identity and outbox row in the same transaction (excess flagged, a failed transition writes
 * nothing, uncertain holds kept, rebuild reproduces the counters); the money ceiling separate from the CU quota;
 * every admitting budget settled and released; an unreachable database answering "persistence unavailable"; and
 * leases hiding operations from recovery until they expire.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`); each run creates and drops its
 * own database.
 *
 * Run just this file: `npx tsx --test test/services/d1d8_c_operation_store.test.ts`
 *
 * @module test/services/d1d8_c_operation_store.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { PgOperationStore, RevisionConflictError } from '../../src/operations/PgOperationStore.js';
import { PgEffectOutbox } from '../../src/operations/PgEffectOutbox.js';
import { ACCOUNTING_SCALE, MONEY_SCALE, quotaUnits } from '../../src/operations/accounting.js';
import { effectId, payloadDigest } from '../../src/operations/ids.js';
import { ledgerTotal, rebuildQuotaRow } from '../../src/operations/ledger.js';
import { IllegalTransitionError } from '../../src/operations/transitions.js';
import { admitReq, CU, usage } from '../fixtures/d1d8/c/builders.js';

let db: TestDb;
const EPOCH = 'e1';
const quotas = new Map<string, bigint | null>();
const store = (pool: pg.Pool) => new PgOperationStore(pool, { quotaFor: (t) => quotas.get(t) ?? null, epochOf: () => EPOCH });

before(async () => { db = await createTestDb('opstore'); });
after(async () => { await db.drop(); });

async function counters(tenant: string) {
  const r = await db.pool.query<{ c: string; h: string }>('SELECT confirmed_units::text AS c, held_units::text AS h FROM otk_quota_usage WHERE tenant_id = $1 AND epoch_id = $2', [tenant, EPOCH]);
  return { confirmed: BigInt(r.rows[0]?.c ?? '0') / ACCOUNTING_SCALE, held: BigInt(r.rows[0]?.h ?? '0') / ACCOUNTING_SCALE };
}

describe('admission is durable, idempotent and tenant-scoped', () => {
  it('admitted operation is read by another instance (other pool)', async () => {
    const a = store(db.pool); const b = store(db.newPool());
    const res = await a.admit(admitReq({ tenantId: 'T1', operationId: 'op-1' }, 100n));
    assert.equal(res.outcome, 'admitted');
    const seen = await b.get({ tenantId: 'T1', operationId: 'op-1' });
    assert.equal(seen?.execution, 'admitted');
    assert.equal(seen?.reservation.state, 'held');
    assert.deepEqual(seen?.reservation.cu, CU(100n));
    assert.deepEqual(await counters('T1'), { confirmed: 0n, held: 100n });
  });

  it('same id + same digest → existing (no second hold); different digest → conflict, never overwrite', async () => {
    const a = store(db.pool);
    const again = await a.admit(admitReq({ tenantId: 'T1', operationId: 'op-1' }, 100n));
    assert.equal(again.outcome, 'existing');
    const other = await a.admit(admitReq({ tenantId: 'T1', operationId: 'op-1' }, 100n, { digest: `0x${'bb'.repeat(32)}` }));
    assert.deepEqual(other, { outcome: 'conflict', existingRequestDigest: `0x${'aa'.repeat(32)}` });
    assert.deepEqual(await counters('T1'), { confirmed: 0n, held: 100n });
  });

  it('same operation id in another tenant is another operation (D3-G03)', async () => {
    const a = store(db.pool);
    const res = await a.admit(admitReq({ tenantId: 'T2', operationId: 'op-1' }, 7n, { digest: `0x${'cc'.repeat(32)}` }));
    assert.equal(res.outcome, 'admitted');
    assert.equal((await a.get({ tenantId: 'T1', operationId: 'op-1' }))?.requestDigest, `0x${'aa'.repeat(32)}`);
    assert.equal(await a.get({ tenantId: 'T3', operationId: 'op-1' }), null, 'unknown tenant does not see it');
  });

  it('20 concurrent same-key admissions on two instances: one admitted, 19 existing, one hold', async () => {
    const a = store(db.pool); const b = store(db.newPool());
    const res = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).admit(admitReq({ tenantId: 'T4', operationId: 'same' }, 50n))));
    assert.equal(res.filter((r) => r.outcome === 'admitted').length, 1);
    assert.equal(res.filter((r) => r.outcome === 'existing').length, 19);
    assert.deepEqual(await counters('T4'), { confirmed: 0n, held: 50n });
  });
});

describe('D7-G07 (store): quota 10 000 CU, twenty concurrent reservations of 3 000', () => {
  for (const instances of [1, 2]) {
    it(`${instances} instance(s): exactly 4 admitted, held = 12 000 CU`, async () => {
      const tenant = `Q${instances}`;
      quotas.set(tenant, quotaUnits(10_000n));
      const stores = Array.from({ length: instances }, (_, i) => store(i === 0 ? db.pool : db.newPool()));
      const res = await Promise.all(Array.from({ length: 20 }, (_, i) => stores[i % instances]!.admit(admitReq({ tenantId: tenant, operationId: `q-${i}` }, 3_000n))));
      const admitted = res.filter((r) => r.outcome === 'admitted').length;
      assert.equal(admitted, 4);
      assert.equal(res.filter((r) => r.outcome === 'quota_exceeded').length, 16);
      assert.deepEqual(await counters(tenant), { confirmed: 0n, held: 12_000n });
      const refused = res.find((r) => r.outcome === 'quota_exceeded');
      assert.deepEqual(refused, { outcome: 'quota_exceeded', quota: { units: 10_000n * ACCOUNTING_SCALE, scale: ACCOUNTING_SCALE }, current: { units: 12_000n * ACCOUNTING_SCALE, scale: ACCOUNTING_SCALE } });
    });
  }
});

describe('settlement moves held → confirmed exactly once, with ledger identity and outbox in the same transaction', () => {
  it('settle 30 CU reserved / 48 CU final: excess flagged, never truncated', async () => {
    const s = store(db.pool);
    const key = { tenantId: 'S1', operationId: 'op' };
    const adm = await s.admit(admitReq(key, 30n));
    assert.equal(adm.outcome, 'admitted');
    const started = await s.transition(key, 0n, { execution: 'upstream_started' });
    const effect = { effectId: effectId('persist_receipt', key), schema: 'otk.outbox_effect.v1' as const, key, kind: 'persist_receipt' as const, payloadDigest: payloadDigest({ v: 1 }), target: null };
    const settled = await s.transition(key, started.revision, {
      execution: 'completed', measurement: 'final', usage: usage(100n, 20n),
      reservation: { cu: CU(48n), money: null, basis: 'settled:known_cu', state: 'settled' },
    }, { enqueue: [effect] });
    assert.equal(settled.effects.debitApplied, true);
    assert.equal(settled.revision, 2n);
    assert.deepEqual(await counters('S1'), { confirmed: 48n, held: 0n });
    assert.deepEqual(await ledgerTotal(db.pool, 'S1', EPOCH), { units: 48n * ACCOUNTING_SCALE, entries: 1 });
    const detail = await s.getDetail(key);
    assert.equal(detail?.settlementNote, 'excess_over_reservation');
    assert.equal(detail?.reservedUnits, 30n * ACCOUNTING_SCALE, 'original reservation kept for audit');
    const ob = await new PgEffectOutbox(db.pool).listFor(key);
    assert.deepEqual(ob.map((e) => [e.kind, e.state]), [['persist_receipt', 'pending']]);
    await assert.rejects(s.transition(key, settled.revision, { reservation: { ...settled.reservation, cu: CU(1n) } }), IllegalTransitionError, 'settled amount is immutable');
    await assert.rejects(s.transition(key, settled.revision, { reservation: { ...settled.reservation, state: 'released' } }), IllegalTransitionError);
    assert.deepEqual(await ledgerTotal(db.pool, 'S1', EPOCH), { units: 48n * ACCOUNTING_SCALE, entries: 1 }, 'still one debit');
    await assert.rejects(s.transition(key, 0n, { delivery: 'delivered' }), RevisionConflictError);
  });

  it('a failed transition writes nothing (no outbox row, counters unchanged)', async () => {
    const s = store(db.pool);
    const key = { tenantId: 'S2', operationId: 'op' };
    await s.admit(admitReq(key, 10n));
    const effect = { effectId: effectId('persist_receipt', key), schema: 'otk.outbox_effect.v1' as const, key, kind: 'persist_receipt' as const, payloadDigest: payloadDigest({}), target: null };
    await assert.rejects(s.transition(key, 0n, { measurement: 'final', usage: { ...usage(1n, 1n), completeness: 'partial' } }, { enqueue: [effect] }), IllegalTransitionError);
    assert.deepEqual(await new PgEffectOutbox(db.pool).listFor(key), []);
    assert.deepEqual(await counters('S2'), { confirmed: 0n, held: 10n });
  });

  it('held_uncertain keeps the exposure; released returns it; rebuild reproduces the counters', async () => {
    const s = store(db.pool);
    const k1 = { tenantId: 'S3', operationId: 'lost' }; const k2 = { tenantId: 'S3', operationId: 'never-started' };
    await s.admit(admitReq(k1, 40n)); await s.admit(admitReq(k2, 60n));
    const st = await s.transition(k1, 0n, { execution: 'upstream_started' });
    await s.transition(k1, st.revision, { execution: 'upstream_failed', measurement: 'uncertain', reservation: { ...st.reservation, state: 'held_uncertain' } });
    const op2 = (await s.get(k2))!;
    await s.transition(k2, 0n, { execution: 'process_lost', reservation: { ...op2.reservation, state: 'released' } });
    assert.deepEqual(await counters('S3'), { confirmed: 0n, held: 40n });
    await db.pool.query("UPDATE otk_quota_usage SET held_units = 0, confirmed_units = 999 WHERE tenant_id = 'S3'");
    const c = await db.pool.connect();
    try { await c.query('BEGIN'); await rebuildQuotaRow(c, 'S3', EPOCH); await c.query('COMMIT'); } finally { c.release(); }
    assert.deepEqual(await counters('S3'), { confirmed: 0n, held: 40n });
  });
});

describe('money ceiling strict_ceiling_worst_case@1 is separate from the CU quota', () => {
  it('ceiling US$ 1.00; worst cases US$ 0.40: two admitted, third refused; unknown cost refused', async () => {
    const s = store(db.pool);
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-M1', 'M1', $1::numeric)", [(1n * MONEY_SCALE).toString()]);
    const w = 40n * MONEY_SCALE / 100n;
    const r = [];
    for (let i = 0; i < 3; i++) r.push(await s.admit(admitReq({ tenantId: 'M1', operationId: `m-${i}` }, 1n, { money: w })));
    assert.deepEqual(r.map((x) => x.outcome), ['admitted', 'admitted', 'budget_exceeded']);
    assert.deepEqual(r[2], { outcome: 'budget_exceeded', remaining: { units: 20n * MONEY_SCALE / 100n, scale: MONEY_SCALE, currency: 'USD' } });
    const unknown = await s.admit(admitReq({ tenantId: 'M1', operationId: 'm-unknown' }, 1n, { money: null }));
    assert.equal(unknown.outcome, 'budget_exceeded');
    // settling one at US$ 0.10 returns the difference of its worst case
    const k = { tenantId: 'M1', operationId: 'm-0' };
    const st = await s.transition(k, 0n, { execution: 'upstream_started' });
    // S4 (ABC-03): CU settlement keeps the reserved money; only a complete quote moves money to spent
    const cur = (await s.get(k))!;
    await s.transition(k, st.revision, { execution: 'completed', measurement: 'final', usage: usage(1n, 1n), reservation: { cu: CU(1n), money: cur.reservation.money, basis: 'settled', state: 'settled' },
      money: { ...cur.money!, state: 'settled', confirmed: { units: 10n * MONEY_SCALE / 100n, scale: MONEY_SCALE, currency: 'USD' }, priceStatus: 'priced', priceTable: { version: 't', digest: `0x${'11'.repeat(32)}` } } });
    const b = await db.pool.query<{ s: string; h: string }>("SELECT spent_units::text AS s, held_units::text AS h FROM otk_money_budget WHERE budget_id = 'b-M1'");
    assert.deepEqual(b.rows[0], { s: (10n * MONEY_SCALE / 100n).toString(), h: w.toString() });
  });
});

describe('review H1: every budget that admitted an operation is settled and released', () => {
  it('two budgets (daily, monthly): settle charges both and returns both holds; release returns both', async () => {
    const s = store(db.pool);
    const w = 40n * MONEY_SCALE / 100n;
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('m2-daily', 'M2', $1::numeric), ('m2-monthly', 'M2', $2::numeric)", [(1n * MONEY_SCALE).toString(), (10n * MONEY_SCALE).toString()]);
    const k1 = { tenantId: 'M2', operationId: 'a' }; const k2 = { tenantId: 'M2', operationId: 'b' };
    assert.equal((await s.admit(admitReq(k1, 1n, { money: w }))).outcome, 'admitted');
    assert.equal((await s.admit(admitReq(k2, 1n, { money: w }))).outcome, 'admitted');
    const st = await s.transition(k1, 0n, { execution: 'upstream_started' });
    // S4 (ABC-03): money settles with an explicit complete quote, not with the reservation
    const c1 = (await s.get(k1))!;
    await s.transition(k1, st.revision, { execution: 'completed', measurement: 'final', usage: usage(1n, 1n), reservation: { cu: CU(1n), money: c1.reservation.money, basis: 'settled', state: 'settled' },
      money: { ...c1.money!, state: 'settled', confirmed: { units: 10n * MONEY_SCALE / 100n, scale: MONEY_SCALE, currency: 'USD' }, priceStatus: 'priced', priceTable: { version: 't', digest: `0x${'11'.repeat(32)}` } } });
    const o2 = (await s.get(k2))!;
    await s.transition(k2, o2.revision, { execution: 'process_lost', reservation: { ...o2.reservation, state: 'released' } });
    const b = await db.pool.query<{ id: string; s: string; h: string }>("SELECT budget_id AS id, spent_units::text AS s, held_units::text AS h FROM otk_money_budget WHERE tenant_id = 'M2' ORDER BY budget_id");
    const spent = (10n * MONEY_SCALE / 100n).toString();
    assert.deepEqual(b.rows, [{ id: 'm2-daily', s: spent, h: '0' }, { id: 'm2-monthly', s: spent, h: '0' }]);
  });
});

describe('RV30-01 (admission): unreachable PostgreSQL answers persistence_unavailable, never admitted', () => {
  it('pool on a closed port', async () => {
    const dead = new pg.Pool({ connectionString: 'postgres://otk:x@127.0.0.1:1/none', connectionTimeoutMillis: 1000 });
    dead.on('error', () => {});
    const s = new PgOperationStore(dead, { quotaFor: () => null, epochOf: () => EPOCH });
    // OVERNIGHT 20261005 (3b42134, F-P1-04): the outcome now carries the database error as `detail` (it was swallowed)
    const r = await s.admit(admitReq({ tenantId: 'X', operationId: 'x' }, 1n));
    assert.equal(r.outcome, 'persistence_unavailable');
    assert.match((r as { detail?: string }).detail ?? '', /ECONNREFUSED|connect/);
    await dead.end();
  });
});

describe('leases and listIncomplete', () => {
  it('a live lease hides the operation from recovery; an expired one exposes it', async () => {
    const s = store(db.pool);
    const key = { tenantId: 'L1', operationId: 'op' };
    await s.admit(admitReq(key, 1n));
    assert.equal(await s.claimLease(key, 'inst-A', 60_000), true);
    assert.equal(await s.claimLease(key, 'inst-B', 60_000), false, 'another live owner');
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal((await s.listIncomplete({ olderThan: future, limit: 100 })).some((o) => o.key.tenantId === 'L1'), false);
    await db.pool.query("UPDATE otk_operations SET lease_until = now() - interval '1 second' WHERE tenant_id = 'L1'");
    assert.equal((await s.listIncomplete({ olderThan: future, limit: 100 })).some((o) => o.key.tenantId === 'L1'), true);
    assert.equal(await s.claimLease(key, 'inst-B', 60_000), true, 'expired lease can be taken over');
  });
});
