/**
 * Fechamento pós-S5 — RV2-05 / AUD-5: a spooled record that PostgreSQL rejects for a permanent logical
 * reason goes to a durable intervention queue (original record, reason, sha256), with an alert, while the
 * other records keep progressing; a transient database failure keeps records live; a restart keeps the
 * queue; after the cause is fixed the record is re-applied exactly once; if the queue itself cannot be
 * written the record stays in the live spool. Real PostgreSQL 16, front B's real ports.
 *
 *   . scripts/ops/fps5_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_fps5_spool_intervention.test.ts
 *
 * Permanent rejections used (both reachable with intact JSON):
 *  - SCALE: the CU result has scale 3, which the accounting scale cannot represent exactly (ScaleLossError):
 *    the record itself is wrong; it stays in the queue;
 *  - CLASH: a stray debit row with the operation's ledger identity already exists (LedgerIdentityError), e.g.
 *    after a bad manual restore: fixable by the operator (remove the stray row), then re-applied.
 *
 * Module under test: the measurement spool and its intervention queue in `src/operations/runtime.ts`, with
 * operations built from `test/fixtures/d1d8/c/builders.ts`.
 *
 * Strategy / scenarios: permanent errors next to valid records (valid ones apply, rejected ones move whole to the
 * queue with an alert, none retried forever); a transient database failure (record stays live and applies later);
 * restart (queue kept, integrity re-checked, nothing re-applied by itself); re-application exactly once after the
 * fix, while the unfixable record stays open; an unwritable queue (record kept in the live spool); the live write
 * path; and the real replay path with a torn queue tail.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`) and a writable temporary
 * directory for spool folders; run with `--test-concurrency=1`. It sets `OTK_DB_URL` in the test process. With the
 * variables already set, `npx tsx --test --test-concurrency=1 test/services/d1d8_fps5_spool_intervention.test.ts`
 * runs just this file.
 *
 * @module test/services/d1d8_fps5_spool_intervention.test
 */
process.env['OTK_DB_URL'] = '';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';
import { reapplyInterventions, replaySpool, writeFinal, type FinalFacts } from '../../src/operations/proxyDurable.js';
import { encodeJson } from '../../src/operations/codec.js';
import { effectId } from '../../src/operations/ids.js';
import type { OperationsContext } from '../../src/operations/context.js';
import type { OperationKey } from '../../src/types/d1d8/index.js';
import { admitReq, cuResult, usage } from '../fixtures/d1d8/c/builders.js';

const tables = loadPriceTables(['test/fixtures/d1d8/b/price_table_illustrative_v1.json']);
const AT = '2026-10-02T12:00:00.000Z';
let db: TestDb;
const runtimes: Array<OperationsRuntime & { events: string[] }> = [];
const spoolDir = mkdtempSync(path.join(tmpdir(), 'otkd1d8fps5-spool-'));

async function runtime(instanceId: string, dir = spoolDir): Promise<OperationsRuntime & { events: string[] }> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, spoolDir: dir, recoveryIntervalMs: 3_600_000, quotaFor: () => null,
    measurement: d1d8MeasurementPorts({ weights: developmentWeights(), prices: tables }) }) as OperationsRuntime & { events: string[] };
  rt.events = [];
  const log = rt.log.bind(rt);
  rt.log = (e: string, f: Record<string, unknown>) => { rt.events.push(e); log(e, f); };
  runtimes.push(rt);
  return rt;
}
const facts = (cu = cuResult(5n)): FinalFacts => ({ outcome: 'completed', usage: usage(10n, 2n), cu,
  price: { schema: 'otk.price_quote.v1', status: 'missing_price', total: null, lines: [], priceTable: tables.active!, pricedAt: AT },
  delivery: 'delivered', providerRequestId: 'fps5-spool', localCount: null, at: AT });
const scaleBroken = (): FinalFacts => { const c = cuResult(5n); return facts({ ...c, cu: { units: 1n, scale: 3n } }); };
async function started(rt: OperationsRuntime, tenant: string, id: string): Promise<OperationKey> {
  const key = { tenantId: tenant, operationId: id };
  const req = admitReq(key, 10n, { money: 100_000_000_000n });
  req.config = { ...req.config, priceTable: tables.active };
  assert.equal((await rt.store.admit(req)).outcome, 'admitted');
  await rt.store.transition(key, 0n, { execution: 'upstream_started' });
  return key;
}
const spoolRec = (id: string, key: OperationKey, f: FinalFacts) => ({ id, key, patch: JSON.parse(encodeJson(f)) as unknown, localCount: null, enqueue: [] });
const debits = async (k: OperationKey) => Number((await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM otk_ledger WHERE tenant_id = $1 AND operation_id = $2', [k.tenantId, k.operationId])).rows[0]!.n);
const row = async (k: OperationKey) => (await db.pool.query<{ m: string; r: string; meas: string }>(
  "SELECT money->>'state' AS m, reservation->>'state' AS r, measurement AS meas FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2", [k.tenantId, k.operationId])).rows[0]!;

before(async () => { db = await createTestDb('fps5spool'); });
after(async () => { for (const rt of runtimes) await rt.stop(); await db.drop(); rmSync(spoolDir, { recursive: true, force: true }); });

describe('RV2-05 — permanent spool errors go to a durable intervention queue', () => {
  let A: OperationKey; let B: OperationKey; let C: OperationKey; let D: OperationKey;

  it('permanent errors next to valid records: valid ones apply, rejected ones move whole to the queue (alert), none is retried forever', async () => {
    const rt = await runtime('fps5-sp-1');
    A = await started(rt, 'tSp', 'a'); B = await started(rt, 'tSp', 'b'); C = await started(rt, 'tSp', 'c'); D = await started(rt, 'tSp', 'd');
    await db.pool.query("INSERT INTO otk_ledger (tenant_id, effect_id, epoch_id, units, source, operation_id) VALUES ($1, $2, 'stray', 1, 'operation', $3)", [C.tenantId, effectId('debit', C), C.operationId]);
    const spool = rt.spool!;
    for (const [id, k, f] of [['r-a', A, facts()], ['r-b', B, scaleBroken()], ['r-c', C, facts()], ['r-d', D, facts()]] as const) spool.append(spoolRec(id, k, f));
    const res = await replaySpool(rt);
    assert.deepEqual(res, { applied: 2, already: 0, left: 0, corrupt: 0, intervention: 2 });
    assert.ok(rt.events.includes('spool_records_need_intervention'), 'alert emitted');
    for (const k of [A, D]) { assert.equal((await row(k)).meas, 'final'); assert.equal(await debits(k), 1); }
    for (const k of [B, C]) assert.equal((await row(k)).meas, 'none', 'not applied');
    assert.equal((await row(B)).r, 'held', 'exposure kept, nothing released without a measurement');
    const open = spool.openInterventions();
    assert.deepEqual(open.map((e) => [e.id, e.source, e.intact]), [['r-b', 'replay', true], ['r-c', 'replay', true]]);
    assert.match(open[0]!.reason, /^ScaleLossError/);
    assert.match(open[1]!.reason, /^LedgerIdentityError/);
    assert.deepEqual(open[1]!.record.key, C, 'original record kept (traceability)');
    assert.equal(spool.pending().length, 0, 'the live spool no longer retries them');
    assert.deepEqual(await replaySpool(rt), { applied: 0, already: 0, left: 0, corrupt: 0, intervention: 0 });
  });

  it('transient PostgreSQL failure: the record stays live (no intervention), and applies once the database answers', async () => {
    const rt = runtimes[0]!;
    const E = await started(rt, 'tSp', 'e');
    rt.spool!.append(spoolRec('r-e', E, facts()));
    const down = Object.create(rt, { store: { value: Object.create(rt.store, { get: { value: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:5432'); } } }) } }) as OperationsContext;
    assert.deepEqual(await replaySpool(down), { applied: 0, already: 0, left: 1, corrupt: 0, intervention: 0 });
    assert.equal(rt.spool!.openInterventions().length, 2);
    assert.deepEqual(await replaySpool(rt), { applied: 1, already: 0, left: 0, corrupt: 0, intervention: 0 });
    assert.equal(await debits(E), 1);
  });

  it('restart: the queue survives (same spool directory and instance), integrity re-checked, nothing re-applied by itself', async () => {
    await runtimes[0]!.stop(); runtimes.splice(0, 1);
    const rt = await runtime('fps5-sp-1');
    assert.deepEqual(rt.spool!.openInterventions().map((e) => [e.id, e.intact]), [['r-b', true], ['r-c', true]]);
    await rt.recoverOnce();
    assert.equal((await row(C)).meas, 'none', 'a recovery pass does not re-apply queued records');
    assert.equal(await debits(C), 1, 'only the stray row');
    assert.equal(rt.spool!.openInterventions().length, 2);
  });

  it('after the fix (stray ledger row removed) the record is re-applied exactly once; the unfixable one stays open', async () => {
    const rt = runtimes[runtimes.length - 1]!;
    const still = await reapplyInterventions(rt);
    assert.deepEqual(still, { resolved: 0, open: 2, corrupt: 0 }, 'cause not fixed yet: nothing changes');
    await db.pool.query("DELETE FROM otk_ledger WHERE tenant_id = $1 AND effect_id = $2 AND epoch_id = 'stray'", [C.tenantId, effectId('debit', C)]);
    assert.deepEqual(await reapplyInterventions(rt), { resolved: 1, open: 1, corrupt: 0 });
    assert.equal((await row(C)).meas, 'final');
    assert.equal(await debits(C), 1, 'CU debited once');
    assert.deepEqual(await reapplyInterventions(rt), { resolved: 0, open: 1, corrupt: 0 }, 'idempotent');
    assert.equal(await debits(C), 1);
    assert.deepEqual(rt.spool!.openInterventions().map((e) => e.id), ['r-b']);
    // the file is append-only: both entries and the resolution line are still there
    const lines = readFileSync(rt.spool!.interventionFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; id: string });
    assert.deepEqual(lines.map((l) => `${l.kind}:${l.id}`), ['intervention:r-b', 'intervention:r-c', 'resolved:r-c']);
  });

  it('the queue itself cannot be written: the record stays in the live spool (never dropped), and moves once it can', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'otkd1d8fps5-spool2-'));
    const rt = await runtime('fps5-sp-2', dir);
    const F = await started(rt, 'tSp2', 'f');
    mkdirSync(rt.spool!.interventionFile); // a directory where the queue file should be: every append fails
    rt.spool!.append(spoolRec('r-f', F, scaleBroken()));
    assert.deepEqual(await replaySpool(rt), { applied: 0, already: 0, left: 1, corrupt: 0, intervention: 0 });
    assert.equal(rt.spool!.pending().length, 1);
    rmSync(rt.spool!.interventionFile, { recursive: true });
    assert.deepEqual(await replaySpool(rt), { applied: 0, already: 0, left: 0, corrupt: 0, intervention: 1 });
    assert.deepEqual(rt.spool!.openInterventions().map((e) => e.id), ['r-f']);
  });

  it('live path: a final write PostgreSQL rejects permanently is queued for intervention (source live), not lost', async () => {
    const rt = runtimes[runtimes.length - 1]!;
    const G = await started(rt, 'tSp2', 'g');
    assert.equal(await writeFinal(rt, G, scaleBroken()), 'rejected');
    const e = rt.spool!.openInterventions().find((x) => x.record.key.operationId === 'g')!;
    assert.equal(e.source, 'live');
    assert.match(e.reason, /^ScaleLossError/);
    assert.ok(rt.events.includes('operation_final_needs_intervention'));
  });
});

describe('F-FPS5-01 — real replay path: torn intervention tail, restart, transfer, fix, re-apply once', () => {
  it('a record transferred after an interrupted queue write stays reachable; damage is reported; re-application debits once', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'otkd1d8fps5-spool3-'));
    const rt1 = await runtime('fps5-sp-3', dir);
    const H = await started(rt1, 'tSp3', 'h');
    rt1.spool!.recordIntervention({ v: 1, id: 'r-old', key: { tenantId: 'tSp3', operationId: 'old' }, patch: {}, localCount: null, enqueue: [], at: AT }, 'synthetic', 'live');
    appendFileSync(rt1.spool!.interventionFile, '{"v":1,"kind":"intervention","id":"torn'); // crash mid-write
    await rt1.stop(); runtimes.splice(runtimes.indexOf(rt1), 1);
    const rt = await runtime('fps5-sp-3', dir); // restart: same spool directory and instance
    await db.pool.query("INSERT INTO otk_ledger (tenant_id, effect_id, epoch_id, units, source, operation_id) VALUES ($1, $2, 'stray', 1, 'operation', $3)", [H.tenantId, effectId('debit', H), H.operationId]);
    rt.spool!.append(spoolRec('r-h', H, facts()));
    assert.deepEqual(await replaySpool(rt), { applied: 0, already: 0, left: 0, corrupt: 0, intervention: 1 });
    assert.ok(rt.events.includes('spool_intervention_file_damaged'), 'the damaged queue bytes are reported');
    assert.deepEqual(rt.spool!.openInterventions().map((e) => [e.id, e.intact]), [['r-old', true], ['r-h', true]], 'the transferred record is reachable');
    assert.equal(rt.spool!.pending().length, 0);
    await db.pool.query("DELETE FROM otk_ledger WHERE tenant_id = $1 AND effect_id = $2 AND epoch_id = 'stray'", [H.tenantId, effectId('debit', H)]);
    const r = await reapplyInterventions(rt, ['r-h']);
    assert.deepEqual(r, { resolved: 1, open: 0, corrupt: 0 });
    assert.equal((await row(H)).meas, 'final');
    assert.equal(await debits(H), 1, 'CU debited exactly once');
    assert.deepEqual(await reapplyInterventions(rt, ['r-h']), { resolved: 0, open: 0, corrupt: 0 }, 'already resolved');
    assert.equal(await debits(H), 1);
    const h = rt.spool!.inspectInterventions();
    assert.equal(h.corrupt.length, 1);
    assert.equal(h.tornTail, null);
  });
});
