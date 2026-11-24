/**
 * D1–D8 / S4 — ABC-03 and ABC-01 on the real PostgreSQL of the S4 stack: money is a separate
 * axis (reservation ≠ spend, subtotal ≠ total), a pending price is completed later exactly once
 * from the stored usage, and a measurement spooled after a torn tail reaches PostgreSQL once.
 *
 *   . scripts/ops/s4_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_s4_money.test.ts
 *
 * Hand values (illustrative table test/fixtures/d1d8/b/price_table_illustrative_v1.json, usage
 * observed 2026-10-01T12:00Z, gpt-4o-mini-2024-07-18 → gpt-4o-mini): input 10 × 200 000 µUSD/MTok
 * (price in force from 2026-10-01) = 2 000 000 pico-USD; output 2 × 600 000 = 1 200 000;
 * total 3 200 000 pico-USD (US$ 0.0000032). Reservation US$ 0.10 = 100 000 000 000 pico-USD.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { legacyMeasurementPorts } from '../../src/operations/measurementPorts.js';
import { writeFinal, type FinalFacts } from '../../src/operations/proxyDurable.js';
import { resolveOperationPrice } from '../../src/operations/pricingResolution.js';
import { encodeJson } from '../../src/operations/codec.js';
import { createPriceTableRegistry, createPriceUsage, parsePriceTableV1, priceTableRef } from '../../src/pricing/priceUsage.js';
import type { OperationKey, PriceQuote } from '../../src/types/d1d8/index.js';
import { admitReq, cuResult, usage } from '../fixtures/d1d8/c/builders.js';

const P = 1_000_000_000_000n;
const RESERVED = 100_000_000_000n;
const raw = JSON.parse(readFileSync('test/fixtures/d1d8/b/price_table_illustrative_v1.json', 'utf8'));
const table = parsePriceTableV1(raw);
const registry = createPriceTableRegistry([table]);
const TABLE = priceTableRef(table);
const MISSING_TABLE = { version: 'not-loaded-yet', digest: `0x${'99'.repeat(32)}` as const };

let db: TestDb;
let rt: OperationsRuntime;
const spoolDir = mkdtempSync(path.join(tmpdir(), 'otkd1d8s4-money-spool-'));
const mk = (dbUrl: string) => OperationsRuntime.create({
  dbUrl, instanceId: 's4-money-1', spoolDir, recoveryIntervalMs: 60_000, quotaFor: () => null,
  measurement: { ...legacyMeasurementPorts(), priceUsage: createPriceUsage(registry), label: 'legacy+s4-price' },
});

before(async () => {
  db = await createTestDb('s4money');
  rt = await mk(db.url);
  await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-S', 'S', $1::numeric)", [P.toString()]);
});
after(async () => { await rt.stop(); await db.drop(); });

const quote = (status: PriceQuote['status'], units: bigint | null, t = TABLE): PriceQuote =>
  ({ schema: 'otk.price_quote.v1', status, total: units === null ? null : { units, scale: P, currency: 'USD' }, lines: [], priceTable: t, pricedAt: '2026-10-01T12:00:00.000Z' });
const facts = (price: PriceQuote | null): FinalFacts =>
  ({ outcome: 'completed', usage: usage(10n, 2n), cu: cuResult(5n), price, delivery: 'delivered', providerRequestId: 'prov', localCount: null, at: new Date().toISOString() });

async function started(op: string): Promise<OperationKey> {
  const key = { tenantId: 'S', operationId: op };
  const a = await rt.store.admit({ ...admitReq(key, 10n, { money: RESERVED }), config: { ...admitReq(key, 10n).config, priceTable: MISSING_TABLE } });
  assert.equal(a.outcome, 'admitted');
  await rt.store.transition(key, 0n, { execution: 'upstream_started' });
  return key;
}
const budget = async () => (await db.pool.query<{ s: string; h: string }>("SELECT spent_units::text AS s, held_units::text AS h FROM otk_money_budget WHERE budget_id = 'b-S'")).rows[0]!;
const moneyLedger = async (op: string) => (await db.pool.query("SELECT units::text FROM otk_money_ledger WHERE operation_id = $1", [op])).rows;

describe('S4 ABC-03 — money axis on PostgreSQL', () => {
  it('missing_price: CU debited once, money stays held (audit vector: was settled at US$ 0.10)', async () => {
    const k = await started('miss');
    assert.equal(await writeFinal(rt, k, facts(quote('missing_price', null))), 'written');
    const op = (await rt.store.get(k))!;
    assert.equal(op.reservation.state, 'settled');
    assert.equal(op.money!.state, 'pending_price');
    assert.deepEqual(await budget(), { s: '0', h: RESERVED.toString() }, 'reservation is not spend');
    assert.equal((await moneyLedger('miss')).length, 0);
    const led = await db.pool.query("SELECT units::text AS u FROM otk_ledger WHERE operation_id = 'miss'");
    assert.deepEqual(led.rows, [{ u: '5000000' }], 'CU ledger debit exists exactly once');
  });

  it('partial: subtotal kept as information, money still held (audit vector: was settled at US$ 0.02)', async () => {
    const k = await started('part');
    await writeFinal(rt, k, facts(quote('partial', 20_000_000_000n)));
    const op = (await rt.store.get(k))!;
    assert.equal(op.money!.state, 'pending_price');
    assert.equal(op.money!.knownSubtotal!.units, 20_000_000_000n);
    assert.deepEqual(await budget(), { s: '0', h: (2n * RESERVED).toString() });
  });

  it('later completion from the stored usage settles exactly once; repeated / restarted resolution is a no-op', async () => {
    const k = { tenantId: 'S', operationId: 'miss' };
    // the frozen table was not loaded: the reconciliation pass cannot price it and keeps it pending
    assert.deepEqual(await resolveOperationPrice(rt, k), { outcome: 'still_pending', priceStatus: 'missing_price' });
    // operator applies the published table (same usage, no provider call)
    assert.deepEqual(await resolveOperationPrice(rt, k, TABLE), { outcome: 'settled', table: TABLE });
    const op = (await rt.store.get(k))!;
    assert.equal(op.money!.state, 'settled');
    assert.equal(op.money!.confirmed!.units, 3_200_000n, 'hand value: 2 000 000 + 1 200 000 pico-USD');
    assert.deepEqual(await budget(), { s: '3200000', h: RESERVED.toString() }, 'one hold returned, partial still held');
    assert.deepEqual(await resolveOperationPrice(rt, k, TABLE), { outcome: 'already' });
    const rt2 = await mk(db.url); // restart
    try {
      assert.deepEqual(await resolveOperationPrice(rt2, k, TABLE), { outcome: 'already' });
      // the spooled/replayed final facts of the same operation change nothing
      assert.equal(await writeFinal(rt2, k, facts(quote('priced', 3_200_000n))), 'written');
    } finally { await rt2.stop(); }
    assert.deepEqual(await budget(), { s: '3200000', h: RESERVED.toString() });
    assert.equal((await moneyLedger('miss')).length, 1, 'money ledger identity written once');
    const led = await db.pool.query("SELECT count(*)::int AS n FROM otk_ledger WHERE operation_id = 'miss'");
    assert.equal(led.rows[0]!.n, 1, 'no second CU debit');
  });

  it('legitimate zero settles at zero; complete price settles at the quoted total', async () => {
    const z = await started('zero');
    await writeFinal(rt, z, facts(quote('priced', 0n)));
    assert.equal((await rt.store.get(z))!.money!.confirmed!.units, 0n);
    const f = await started('full');
    await writeFinal(rt, f, facts(quote('priced', 30_000_000_000n)));
    assert.equal((await rt.store.get(f))!.money!.confirmed!.units, 30_000_000_000n);
    assert.deepEqual(await budget(), { s: (3_200_000n + 30_000_000_000n).toString(), h: RESERVED.toString() });
  });

  it('status API shape distinguishes reserved, confirmed and pending', async () => {
    const { operationView } = await import('../../src/operations/proxyDurable.js');
    const v = operationView((await rt.store.get({ tenantId: 'S', operationId: 'part' }))!) as { money: Record<string, unknown> };
    assert.equal(v.money['state'], 'pending_price');
    assert.deepEqual(v.money['reserved'], { units: RESERVED.toString(), scale: P.toString(), currency: 'USD' });
    assert.equal(v.money['confirmed'], null);
    assert.deepEqual(v.money['knownSubtotal'], { units: '20000000000', scale: P.toString(), currency: 'USD' });
  });
});

describe('S4 ABC-01 — spooled measurement after a torn tail reaches PostgreSQL once', () => {
  it('torn tail + append (PG was down) → replay applies to PostgreSQL; replay again adds nothing', async () => {
    const k = await started('spooled');
    const spool = rt.spool!;
    writeFileSync(spool.file, '{"v":1,"id":"crash'); // a previous append died before its newline/fsync
    spool.append({ id: 'rec-1', key: k, patch: JSON.parse(encodeJson(facts(quote('priced', 1_000n)))), localCount: null, enqueue: [] });
    await rt.recoverOnce();
    const op = (await rt.store.get(k))!;
    assert.equal(op.measurement, 'final');
    assert.equal(op.money!.confirmed!.units, 1_000n);
    assert.equal(spool.pending().length, 0);
    await rt.recoverOnce();
    const led = await db.pool.query("SELECT count(*)::int AS n FROM otk_ledger WHERE operation_id = 'spooled'");
    assert.equal(led.rows[0]!.n, 1);
    assert.equal((await moneyLedger('spooled')).length, 1);
    assert.match(readFileSync(spool.quarantineFile, 'utf8'), /"kind":"torn_tail"/);
  });
});
