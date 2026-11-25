/**
 * OVERNIGHT 20261005 / Phase 2, F-P2-01 — a PostgreSQL connection lost while a client is CHECKED OUT (inside a
 * transaction, between two awaits) must not crash the process.
 *
 * Found by the Phase 2 load probe: a 6 s PostgreSQL cut through a TCP relay killed the process with an unhandled 'error'
 * event (node-postgres only listens on idle clients). Deterministic reproduction: a transaction of the real
 * PgOperationStore pauses between statements, the relay cuts every connection, the paused client emits 'error'.
 * Before the fix (c6937c7 and every commit before F-P2-01) this test file dies with "Unhandled 'error' event".
 *
 *   . docs/_ops/OVERNIGHT_20261005_MASTER/tools/ovn_env.sh && npx tsx --test test/services/d1d8_ovn_pg_client_guard.test.ts
 *
 * Module under test: `src/operations/PgOperationStore.ts` (and its guard for errors on checked-out clients), with
 * the TCP relay from `./d1d8_c_proc.ts` cutting the database connection.
 *
 * Strategy: one scenario; the paused transaction fails normally, the process survives, and the pool serves again
 * after the outage.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`). The command above first
 * sources an environment script that is not part of this repository; with `OTK_TEST_PG_URL` already set,
 * `npx tsx --test test/services/d1d8_ovn_pg_client_guard.test.ts` runs just this file.
 *
 * @module test/services/d1d8_ovn_pg_client_guard.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { TcpRelay } from './d1d8_c_proc.js';
import { PgOperationStore } from '../../src/operations/PgOperationStore.js';
import { admitReq } from '../fixtures/d1d8/c/builders.js';

let db: TestDb; let relay: TcpRelay; let pool: pg.Pool;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  db = await createTestDb('ovnguard');
  const u = new URL(db.url);
  relay = new TcpRelay(u.hostname, Number(u.port));
  const port = await relay.start();
  // M24-R03 (RUN-M1-24H): the relay listens on 127.0.0.1; keeping the database host here bypassed the relay whenever
  // PostgreSQL is not on loopback (e.g. a Linux container reaching it by service name)
  u.hostname = '127.0.0.1';
  u.port = String(port);
  pool = new pg.Pool({ connectionString: String(u), max: 4, connectionTimeoutMillis: 2_000 });
  pool.on('error', () => {}); // idle clients (node-postgres' own listener covers only these)
});
after(async () => { await pool.end().catch(() => {}); await relay.stop(); await db.drop(); });

describe('F-P2-01 — connection lost during a transaction', () => {
  it('the transaction fails normally, the process survives, and the pool serves again after the outage', async () => {
    const store = new PgOperationStore(pool, { quotaFor: () => null, epochOf: () => 'e' });
    const tx = (store as unknown as { tx<T>(fn: (c: { query(q: string): Promise<unknown> }) => Promise<T>): Promise<T> }).tx.bind(store);
    const outcome = tx(async (c) => {
      await c.query('SELECT 1');
      relay.cut();                 // every connection destroyed while this client is checked out and idle
      await sleep(500);            // the client emits 'error' now (no query in flight)
      await c.query('SELECT 1');   // and the next statement fails
      return 'unreachable';
    });
    await assert.rejects(outcome, 'the transaction reports the outage to its caller');
    relay.restore();
    // the broken client was destroyed, not reused: a new admission works through the same pool
    let ok = false;
    for (let i = 0; i < 20 && !ok; i++) {
      const r = await store.admit(admitReq({ tenantId: 'G', operationId: `after-${i}` }, 1n)).catch(() => null);
      ok = r?.outcome === 'admitted';
      if (!ok) await sleep(250);
    }
    assert.ok(ok, 'admission works again after the relay is restored');
  });
});
