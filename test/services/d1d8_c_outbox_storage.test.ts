/**
 * D1–D8 / C — EffectOutbox, OpeningStore and receipt v3 stores against real PostgreSQL, plus the
 * JSONL receipt store (C1; D3-G02/G03/G06 storage part, D2-G06 storage part, D7 §11 frozen target).
 *
 * Modules under test: `src/operations/PgEffectOutbox.ts` (`PgEffectOutbox`, `LeaseLostError`),
 * `src/operations/PgOpeningStore.ts` (`PgOpeningStore`, `OpeningConflictError`) and `src/operations/receiptV3Store.ts`
 * (`PgReceiptV3Store`, `JsonlReceiptV3Store` and their errors).
 *
 * Strategy / partitions: outbox (idempotent enqueue, concurrent claims never shared, completion by a non-owner
 * refused, expired leases reclaimed, the frozen target returned unchanged, retry versus dead after max attempts,
 * heartbeats while the handler runs, live leases never handed out, queue metrics); opening store (round trip,
 * idempotent rewrite, conflicting content refused without echoing it, tenant scope); and the receipt stores, both
 * PostgreSQL and JSON lines (fsync per line, reopened from the file, a torn last line ignored and counted).
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`) and a writable temporary
 * directory for the JSON-lines store; some tests wait on short real timers for lease expiry.
 *
 * Run just this file: `npx tsx --test test/services/d1d8_c_outbox_storage.test.ts`
 *
 * @module test/services/d1d8_c_outbox_storage.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { PgEffectOutbox, LeaseLostError } from '../../src/operations/PgEffectOutbox.js';
import { PgOpeningStore, OpeningConflictError } from '../../src/operations/PgOpeningStore.js';
import { PgReceiptV3Store, JsonlReceiptV3Store, ReceiptConflictError, BindingMismatchError, type ReceiptV3Store } from '../../src/operations/receiptV3Store.js';
import { effectId, payloadDigest } from '../../src/operations/ids.js';
import type { ConferenceReport, OutboxEffect } from '../../src/types/d1d8/index.js';
import { conference, opening, receiptV3 } from '../fixtures/d1d8/c/builders.js';
import { createReceiptCryptoDouble } from '../fixtures/d1d8/c/doubles.js';

let db: TestDb;
before(async () => { db = await createTestDb('outbox'); });
after(async () => { await db.drop(); });

const TARGET = { chainId: 1337n, registry: '0x00000000000000000000000000000000000000a1', circuitId: 'metering_v3@test', schemaVersion: 'otk.registry.v3' };
const eff = (op: string, kind: OutboxEffect['kind'] = 'enqueue_proof') => {
  const key = { tenantId: 'T', operationId: op };
  return { schema: 'otk.outbox_effect.v1' as const, effectId: effectId(kind, key), key, kind, payloadDigest: payloadDigest({ op }), target: kind === 'enqueue_proof' ? TARGET : null };
};

describe('EffectOutbox: dedupe, exclusive claims, lease expiry, frozen target', () => {
  it('enqueue is idempotent by effectId', async () => {
    const ob = new PgEffectOutbox(db.pool);
    assert.equal(await ob.enqueue(eff('a')), 'enqueued');
    assert.equal(await ob.enqueue(eff('a')), 'duplicate');
  });

  it('two instances claiming concurrently never get the same effect', async () => {
    const ob1 = new PgEffectOutbox(db.pool); const ob2 = new PgEffectOutbox(db.newPool());
    for (let i = 0; i < 30; i++) await ob1.enqueue(eff(`c-${i}`, 'project_redis'));
    const [x, y] = await Promise.all([ob1.claim('A', ['project_redis'], 60_000, 20), ob2.claim('B', ['project_redis'], 60_000, 20)]);
    const ids = [...x, ...y].map((e) => e.effectId);
    assert.equal(ids.length, 30);
    assert.equal(new Set(ids).size, 30);
  });

  it('complete by a non-owner fails; expired lease is reclaimed; target is returned unchanged', async () => {
    const ob = new PgEffectOutbox(db.pool);
    const [c] = await ob.claim('A', ['enqueue_proof'], 60_000, 1);
    assert.equal(c!.effectId, eff('a').effectId);
    assert.deepEqual(c!.target, TARGET);
    await assert.rejects(ob.complete(c!.effectId, 'B'), LeaseLostError);
    assert.deepEqual(await ob.claim('B', ['enqueue_proof'], 60_000, 1), [], 'live lease is exclusive');
    await db.pool.query("UPDATE otk_outbox SET lease_until = now() - interval '1 second' WHERE effect_id = $1", [c!.effectId]);
    const [again] = await ob.claim('B', ['enqueue_proof'], 60_000, 1);
    assert.equal(again!.attempts, 2);
    await assert.rejects(ob.complete(c!.effectId, 'A'), LeaseLostError, 'the old owner lost it');
    await ob.complete(again!.effectId, 'B');
    assert.equal((await ob.get(c!.effectId))!.state, 'done');
  });

  it('fail with retryAt returns to pending later; without retryAt (or after max attempts) it is dead, kept', async () => {
    const ob = new PgEffectOutbox(db.pool, { maxAttempts: 2 });
    await ob.enqueue(eff('f'));
    const [c1] = await ob.claim('A', ['enqueue_proof'], 60_000, 1);
    await ob.fail(c1!.effectId, 'A', 'daemon timeout', new Date(Date.now() + 3_600_000).toISOString());
    assert.deepEqual(await ob.claim('A', ['enqueue_proof'], 60_000, 1), [], 'not before retryAt');
    await db.pool.query('UPDATE otk_outbox SET next_attempt_at = now() WHERE effect_id = $1', [c1!.effectId]);
    const [c2] = await ob.claim('A', ['enqueue_proof'], 60_000, 1);
    await ob.fail(c2!.effectId, 'A', 'again', new Date().toISOString());
    const dead = await ob.get(c2!.effectId);
    assert.equal(dead!.state, 'dead');
    assert.equal(dead!.lastError, 'again');
  });
});

/**
 * review H6 — rewritten in OVERNIGHT 20261005 (INC-03, F-P1-06). The previous form raced a second worker against a
 * 300 ms lease on real PostgreSQL and asserted it NEVER claimed. Measured on the candidate host
 * (docs/_ops/OVERNIGHT_20261005_MASTER/probes/p1_inc03): renewal round trips of 221–337 ms idle and up to 8 s under the
 * services load, so no lease short enough for a unit-speed test gives that guarantee; lease-based exclusion is always
 * conditional on renewal latency (production leases: 30 s operations, 120 s proofs). The trace also exposed a real
 * defect, fixed in OutboxWorker: the heartbeat stopped when the handler returned, before complete() recorded the
 * outcome, so a finished effect could be claimed and run again.
 * The mechanisms are now tested deterministically: (1) the heartbeat renews during the handler AND until the outcome
 * is recorded (fake outbox, no wall-clock race); (2) PostgreSQL never hands out a live lease; (3) completion is fenced.
 */
describe('review H6: heartbeat during the handler and until the outcome is recorded; live leases are never claimed', () => {
  it('heartbeat renews every ~lease/3 while the handler runs and keeps renewing until complete() returns', async () => {
    const { OutboxWorker } = await import('../../src/operations/OutboxWorker.js');
    const log: Array<{ at: number; what: string }> = [];
    const t0 = Date.now(); const at = () => Date.now() - t0;
    let completeStarted = 0;
    const fake = {
      claim: async () => [{ ...eff('hb', 'persist_receipt'), state: 'leased', attempts: 1, leaseOwner: 'W1', createdAt: new Date().toISOString() }],
      renew: async () => { log.push({ at: at(), what: 'renew' }); return true; },
      // the outcome takes 500 ms to be recorded (slow database): the lease must keep being renewed meanwhile
      complete: async () => { completeStarted = at(); log.push({ at: at(), what: 'complete:start' }); await new Promise((r) => setTimeout(r, 500)); log.push({ at: at(), what: 'complete:end' }); },
      fail: async () => { throw new Error('unexpected'); },
    };
    const w = new OutboxWorker(fake as never, 'W1', { persist_receipt: async () => { await new Promise((r) => setTimeout(r, 900)); return 'done'; } }, { leaseMs: 300 });
    await w.tick();
    const renewals = log.filter((x) => x.what === 'renew');
    assert.ok(renewals.filter((x) => x.at < completeStarted).length >= 6, `heartbeat during the handler: ${JSON.stringify(log)}`);
    assert.ok(renewals.some((x) => x.at > completeStarted + 150), `heartbeat still renewing while complete() runs (stopped too early before the fix): ${JSON.stringify(log)}`);
    const end = log.find((x) => x.what === 'complete:end')!.at;
    const before = renewals.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(renewals.length, before, 'heartbeat stops once the outcome is recorded');
    assert.ok(log.filter((x) => x.what === 'renew').every((x) => x.at <= end + 50));
  });

  it('PostgreSQL never hands out a live lease, and hands out an expired one', async () => {
    const ob = new PgEffectOutbox(db.pool);
    const e = eff('live', 'persist_receipt');
    await ob.enqueue(e);
    assert.equal((await ob.claim('W1', ['persist_receipt'], 60_000, 10)).filter((x) => x.effectId === e.effectId).length, 1);
    const other = new PgEffectOutbox(db.newPool());
    assert.deepEqual((await other.claim('W2', ['persist_receipt'], 300, 10)).filter((x) => x.effectId === e.effectId), [], 'live lease');
    assert.equal(await ob.renew(e.effectId, 'W1', 60_000), true);
    await db.pool.query("UPDATE otk_outbox SET lease_until = now() - interval '1 second' WHERE effect_id = $1", [e.effectId]);
    assert.equal(await ob.renew(e.effectId, 'W1', 60_000), false, 'an expired lease is not silently revived by its old owner');
    assert.equal((await other.claim('W2', ['persist_receipt'], 60_000, 10)).filter((x) => x.effectId === e.effectId).length, 1, 'expired lease is claimable');
    // fencing: the old owner can no longer record an outcome
    await assert.rejects(ob.complete(e.effectId, 'W1'), LeaseLostError);
    await other.complete(e.effectId, 'W2');
    assert.equal((await ob.get(e.effectId))!.state, 'done');
  });
});

describe('OVERNIGHT 20261005 Phase 2 — outbox metrics (depth, oldest age, leases, retries, dead)', () => {
  it('reports the queue as it is, including an expired lease and a dead effect', async () => {
    const m0 = await new PgEffectOutbox(db.newPool()).metrics();
    const ob = new PgEffectOutbox(db.pool, { maxAttempts: 1 });
    for (const op of ['m-pend', 'm-live', 'm-exp', 'm-dead', 'm-done']) await ob.enqueue(eff(op, 'persist_receipt'));
    await db.pool.query("UPDATE otk_outbox SET created_at = now() - interval '5 seconds' WHERE effect_id = $1", [eff('m-pend', 'persist_receipt').effectId]);
    const ids = (op: string) => eff(op, 'persist_receipt').effectId;
    await db.pool.query("UPDATE otk_outbox SET state = 'leased', lease_owner = 'W', lease_until = now() + interval '1 hour', attempts = 2 WHERE effect_id = $1", [ids('m-live')]);
    await db.pool.query("UPDATE otk_outbox SET state = 'leased', lease_owner = 'W', lease_until = now() - interval '1 second', attempts = 1 WHERE effect_id = $1", [ids('m-exp')]);
    await db.pool.query("UPDATE otk_outbox SET state = 'dead', attempts = 3 WHERE effect_id = $1", [ids('m-dead')]);
    await db.pool.query("UPDATE otk_outbox SET state = 'done', done_at = now() WHERE effect_id = $1", [ids('m-done')]);
    const m = await new PgEffectOutbox(db.newPool()).metrics();
    const d = (k: string) => (m.byState[k] ?? 0) - (m0.byState[k] ?? 0);
    assert.deepEqual([d('pending'), d('leased'), d('dead'), d('done')], [1, 2, 1, 1]);
    assert.equal(m.leasesLive - m0.leasesLive, 1);
    assert.equal(m.leasesExpired - m0.leasesExpired, 1);
    assert.equal(m.retried - m0.retried, 2, 'attempts > 1');
    assert.ok((m.oldestPendingAgeMs ?? 0) >= 4_000, `oldest not-done effect ${m.oldestPendingAgeMs} ms`);
    assert.ok(m.doneLastMinute - m0.doneLastMinute >= 1);
    assert.ok((m.byKind['persist_receipt']?.['pending'] ?? 0) >= 1);
  });
});

describe('OpeningStore (D2 §5): durable, idempotent, conflict-refusing, tenant-scoped', () => {
  it('put/get round trip; same content again is fine; different content is refused without echoing it', async () => {
    const s = new PgOpeningStore(db.pool);
    const key = { tenantId: 'A', operationId: 'o1' };
    await s.put(opening(key));
    await s.put(opening(key));
    assert.deepEqual(await new PgOpeningStore(db.newPool()).get(key), opening(key));
    await assert.rejects(s.put(opening(key, '111')), (e: Error) => e instanceof OpeningConflictError && !e.message.includes('111') && !e.message.includes('987654321'));
    assert.equal(await s.get({ tenantId: 'B', operationId: 'o1' }), null, 'tenant B does not read A');
  });
});

async function exerciseReceiptStore(make: () => ReceiptV3Store, reopen: () => ReceiptV3Store) {
  const crypto = createReceiptCryptoDouble();
  const keyA = { tenantId: 'A', operationId: 'same-id' }; const keyB = { tenantId: 'B', operationId: 'same-id' };
  const s = make();
  const rA = receiptV3(keyA); const rB = receiptV3(keyB, 7n);
  const dA = crypto.digestReceipt(rA); const dB = crypto.digestReceipt(rB);
  assert.equal(await s.putReceipt(rA, await crypto.signReceipt(rA), dA), 'stored');
  assert.equal(await s.putReceipt(rA, await crypto.signReceipt(rA), dA), 'duplicate');
  assert.equal(await s.putReceipt(rB, await crypto.signReceipt(rB), dB), 'stored', 'same operation id in another tenant');
  const changed = { ...rA, userRef: '8' };
  await assert.rejects(s.putReceipt(changed, await crypto.signReceipt(changed), crypto.digestReceipt(changed)), ReceiptConflictError);
  const envA = await crypto.signReceipt(rA);
  await assert.rejects(s.putReceipt(rA, { ...envA, domain: 'OTK_CONFERENCE_V1' }, dA), BindingMismatchError);

  const repA: ConferenceReport = { ...conference(keyA, dA), support: 'exact', catalogVersion: 'cat-1' }; // 1.1.0 additive fields (typed: support is a SupportLevel)
  const repDigest = crypto.digestConference(repA);
  assert.equal(await s.putConference(repA, await crypto.signConference(repA), repDigest), 'stored');
  const moved = conference(keyB, dA); // names A's receipt under B's key
  await assert.rejects(s.putConference(moved, await crypto.signConference(moved), crypto.digestConference(moved)), BindingMismatchError);
  const badVerdict = { ...conference(keyB, dB, 'observed'), verdict: 'within_threshold' as const };
  await assert.rejects(s.putConference(badVerdict, await crypto.signConference(badVerdict), crypto.digestConference(badVerdict)), BindingMismatchError, 'only compared may carry a verdict');

  const r = reopen();
  const back = await r.getReceipt(keyA);
  assert.deepEqual(back?.receipt, rA, 'exact after restart, categories/versions/states');
  assert.equal(crypto.verifyReceipt(back!.receipt, back!.envelope).ok, true, 'consumer verifies the stored envelope');
  const rep = await r.getConference(keyA);
  assert.deepEqual(rep?.report, repA);
  assert.equal(crypto.verifyConference(rep!.report, rep!.envelope, back!.receipt).ok, true);
  assert.equal(crypto.verifyConference(rep!.report, rep!.envelope, (await r.getReceipt(keyB))!.receipt).ok, false, 'report bound to A does not verify against B');
  assert.equal(await r.getConference(keyB), null);
}

describe('receipt v3 + conference stores (D3-G02/G03/G06 storage)', () => {
  it('PostgreSQL', async () => {
    await exerciseReceiptStore(() => new PgReceiptV3Store(db.pool), () => new PgReceiptV3Store(db.newPool()));
  });
  it('JSONL (fsync per line), reopened from the file; torn tail ignored and counted', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'otkd1d8c-')), 'receipts_v3.jsonl');
    await exerciseReceiptStore(() => new JsonlReceiptV3Store(file), () => new JsonlReceiptV3Store(file));
    appendFileSync(file, '{"kind":"receipt","dig');
    const torn = new JsonlReceiptV3Store(file);
    assert.equal(torn.skippedLines, 1);
    assert.ok(await torn.getReceipt({ tenantId: 'A', operationId: 'same-id' }));
  });
});
