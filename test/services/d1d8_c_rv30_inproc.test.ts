/**
 * D1–D8 / C (C2) — RV30-02, RV30-03, RV30-04 after the fix, in-process, against real
 * PostgreSQL 16 and Redis 7 of the C stack. Faults are injected deterministically: a rejected
 * Redis `eval`, and a real `LOCK TABLE` that holds the INSERT past the application timeout.
 * The scenarios are the ones of docs/_ops/correcoes/REVISAO_CODEX_20260930/probes.mjs with the
 * correct expectations; the "before" results are in C/C2_rv30/before/.
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
// OVERNIGHT 20261005 / Phase 1 (F-P1-05): was 150 ms. The late-commit scenario only needs the FIRST write to time out
// while the test holds LOCK TABLE (it does, for any value); the client RETRY inherits the same budget and, on the
// loaded candidate host, the whole quota+receipt+ledger+effects transaction took longer than 150 ms (baseline services
// run 1 and gate run 2 on fcf15aa: "pg write timeout after 150 ms" on the retry → persistence_failed instead of
// duplicate, then the ledger case failed by cascade). 2 000 ms keeps the scenario and gives the retry headroom.
process.env['OTK_PG_WRITE_TIMEOUT_MS'] = '2000';
process.env['PROVER_RECOVERY_INTERVAL_MS'] = '3600000'; // the test drives ticks explicitly

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Redis from 'ioredis';
import { createTestDb, requireEnv, RUN, type TestDb } from './d1d8_c_env.js';
import { RedisTAL } from '../../src/security/RedisTAL.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import type { RawReceipt } from '../../src/types/receipt.js';
import { deriveEpoch } from '../../src/types/receipt.js';
import type { TALEntry } from '../../src/security/TokenAccountingLayer.js';

let redis: Redis;
const PREFIX = `otkd1d8c:${RUN}:`;
const entry = (tenantId: string, requestId: string, cu: number): TALEntry => ({ requestId, cu: BigInt(cu), tenantId, epochId: '1', provider: 'openai', model: 'gpt-4o', ts: Date.now() });

before(async () => {
  redis = new Redis(requireEnv('OTK_TEST_REDIS_URL'), { maxRetriesPerRequest: 1 });
});
after(async () => {
  if (process.env['OTK_TEST_KEEP'] !== '1') {
    const keys = await redis.keys(`${PREFIX}*`);
    if (keys.length) await redis.del(...keys);
  }
  redis.disconnect();
});

describe('RV30-02 (in-process part): a failed Redis write is replayed, not forgotten', () => {
  it('9 000 with one rejected eval, then 3 000 → shared 12 000 (before: 3 000)', async () => {
    let fail = true;
    const fault = {
      eval: (...a: unknown[]) => { if (fail) { fail = false; return Promise.reject(new Error('controlled one-write Redis outage')); } return (redis.eval as (...x: unknown[]) => Promise<unknown>)(...a); },
      hmget: (...a: unknown[]) => (redis.hmget as (...x: unknown[]) => Promise<unknown>)(...a),
    };
    const tal = new RedisTAL(fault, { keyPrefix: `${PREFIX}fault:`, ttlSeconds: 60 });
    await tal.debitAsync(entry('t', 'A', 9000));
    assert.equal(tal.pendingProjection, 1, 'the failed projection is kept');
    await tal.debitAsync(entry('t', 'B', 3000));
    assert.equal(tal.pendingProjection, 0);
    assert.equal((await tal.balanceAsync('t', '1')).totalCU, 12000n);
    assert.equal((await new RedisTAL(redis, { keyPrefix: `${PREFIX}fault:` }).balanceAsync('t', '1')).totalCU, 12000n, 'fresh instance reads 12 000');
  });

  it('debitStrict throws on a Redis failure (the durable outbox effect stays pending)', async () => {
    const tal = new RedisTAL({ eval: () => Promise.reject(new Error('down')), hmget: () => Promise.resolve([null, null]) }, { keyPrefix: `${PREFIX}strict:` });
    await assert.rejects(tal.debitStrict(entry('t', 'X', 1)), /down/);
  });
});

describe('RV30-04: the dedupe marker lives inside the aggregate (identity ≥ aggregate retention)', () => {
  it('A=100, B=200: one key only, marker fields present; replay of A keeps 300', async () => {
    const p = `${PREFIX}ttl:`;
    const tal = new RedisTAL(redis, { keyPrefix: p, ttlSeconds: 60 });
    await tal.debitAsync(entry('t', 'A', 100));
    await tal.debitAsync(entry('t', 'B', 200));
    assert.deepEqual(await redis.keys(`${p}*`), [`${p}t:1`], 'no separate marker key that could expire first');
    assert.equal(await redis.hexists(`${p}t:1`, 'm:A'), 1);
    await tal.debitAsync(entry('t', 'A', 100));
    assert.equal((await tal.balanceAsync('t', '1')).totalCU, 300n, 'before the fix: 400');
  });

  it('marker and aggregate expire together: after expiry a replay starts a new aggregate (the PG ledger stays the source)', async () => {
    const p = `${PREFIX}exp:`;
    const tal = new RedisTAL(redis, { keyPrefix: p, ttlSeconds: 60 });
    await tal.debitAsync(entry('t', 'A', 100));
    await tal.debitAsync(entry('t', 'B', 200));
    await redis.pexpire(`${p}t:1`, 1); // deterministic expiry of the whole aggregate
    for (let i = 0; i < 100 && (await redis.exists(`${p}t:1`)); i++) await new Promise((r) => setTimeout(r, 10));
    assert.equal(await redis.exists(`${p}t:1`), 0);
    await tal.debitAsync(entry('t', 'A', 100));
    assert.equal((await new RedisTAL(redis, { keyPrefix: p }).balanceAsync('t', '1')).totalCU, 100n, 'never 400: A is not added to an aggregate that still contains it');
  });

  it('a marker written by the old layout still counts as applied', async () => {
    const p = `${PREFIX}legacy:`;
    await redis.set(`${p}t:1:req:OLD`, '1', 'EX', 60);
    const tal = new RedisTAL(redis, { keyPrefix: p, ttlSeconds: 60 });
    await tal.debitAsync(entry('t', 'OLD', 50));
    assert.equal(await redis.hget(`${p}t:1`, 'totalCU'), null);
  });
});

describe('RV30-03: a PostgreSQL commit that lands after the timeout still reaches the prover', () => {
  let db: TestDb;
  let prover: Server;
  let proofRequests: string[] = [];
  let store: typeof import('../../src/api/receiptStore.js');
  let pgStore: PostgresReceiptStore;

  before(async () => {
    db = await createTestDb('rv30_late');
    prover = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        if (req.method === 'POST' && req.url === '/prove') {
          proofRequests.push(body);
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jobId: `job-${proofRequests.length}` }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'pending', attempts: 0 }));
      });
    });
    await new Promise<void>((r) => prover.listen(0, '127.0.0.1', r));
    process.env['PROVER_URL'] = `http://127.0.0.1:${(prover.address() as AddressInfo).port}`;
    store = await import('../../src/api/receiptStore.js');
    pgStore = new PostgresReceiptStore(db.url);
    await pgStore.init();
    store.setPgStoreForTest(pgStore);
  });
  after(async () => {
    store.setPgStoreForTest(null);
    await pgStore.close();
    prover.closeAllConnections();
    await new Promise<void>((r) => prover.close(() => r()));
    await db.drop();
  });

  const receipt = (id: string): RawReceipt => ({ requestId: `${RUN}-${id}`, provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 2000, costUnits: 3000, latencyMs: 1, timestamp: Math.floor(Date.now() / 1000), userId: 1n, nonce: 1n, tenantId: 'late' });

  async function lateCommit(id: string): Promise<{ first: Awaited<ReturnType<typeof store.storeReceiptDurable>> }> {
    const lock = await db.pool.connect();
    try {
      await lock.query('BEGIN');
      await lock.query('LOCK TABLE otk_receipts IN ACCESS EXCLUSIVE MODE');
      const first = await store.storeReceiptDurable(receipt(id), 'late');
      await lock.query('COMMIT');
      return { first };
    } finally { lock.release(); }
  }
  async function waitRow(id: string) {
    for (let i = 0; i < 100 && !(await pgStore.get(`${RUN}-${id}`)); i++) await new Promise((r) => setTimeout(r, 20));
  }

  it('without a client retry and without a restart: one proof request after the late commit (before: 0)', async () => {
    proofRequests = [];
    const { first } = await lateCommit('noretry');
    assert.deepEqual(first, { stored: false, reason: 'persistence_failed' }, 'the client was told 503');
    await waitRow('noretry');
    await store.retryPendingProofs(); // one recovery tick of this or any other instance
    assert.equal(proofRequests.length, 1);
    assert.equal((await store.getProofStatus(`${RUN}-noretry`)).jobId, 'job-1');
    await store.retryPendingProofs();
    assert.equal(proofRequests.length, 1, 'no second request for the same receipt');
  });

  it('with a client retry: duplicate answer, still exactly one proof request', async () => {
    proofRequests = [];
    await lateCommit('retry');
    await waitRow('retry');
    const retry = await store.storeReceiptDurable(receipt('retry'), 'late');
    assert.deepEqual(retry, { stored: false, reason: 'duplicate' });
    await store.awaitLastDispatch();
    await store.retryPendingProofs();
    assert.equal(proofRequests.length, 1);
  });

  it('ledger counted each late receipt once (3 000 CU each) and the Redis projection effect exists', async () => {
    const epoch = String(deriveEpoch(Math.floor(Date.now() / 1000)));
    const bal = await pgStore.ledgerBalance('late', epoch);
    assert.deepEqual(bal, { units: 6_000n * 1_000_000n, entries: 2 });
    const effects = await db.pool.query<{ kind: string; state: string }>("SELECT kind, state FROM otk_outbox WHERE tenant_id = 'late' ORDER BY kind, effect_id");
    assert.deepEqual(effects.rows.map((r) => `${r.kind}:${r.state}`), ['enqueue_proof:done', 'enqueue_proof:done', 'project_redis:done', 'project_redis:done']);
  });
});
