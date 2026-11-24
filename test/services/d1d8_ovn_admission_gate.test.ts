/**
 * OVERNIGHT 20261005 / Phase 1, F-P1-04 — admissions must not exhaust the PostgreSQL pool while they wait for the quota
 * row lock (root cause of the 503 seen in d1d8_c_proxy_entry "20 concurrent calls", gate run on fcf15aa and repeated
 * runs with child logs: "timeout exceeded when trying to connect" in the admission and in the money-scope read).
 *
 * Deterministic reproduction: the test holds the tenant's admission lock (otk_money_scope_lock) for 7 s, longer than the pool's
 * connection timeout (5 s), while 8 concurrent requests arrive at a runtime with a pool of 4.
 *   - no effective gate (limit 100 ≫ pool, the previous behavior): waiters hold every connection → 503 persistence_unavailable;
 *   - default gate (pool − 3 = 1 admission in the database): the others wait in memory → every request admitted, no 503.
 *
 *   . docs/_ops/OVERNIGHT_20261005_MASTER/tools/ovn_env.sh && npx tsx --test test/services/d1d8_ovn_admission_gate.test.ts
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'gO/OPERATOR:tokgO,gF/OPERATOR:tokgF,gB/OPERATOR:tokgB';
process.env['OPENAI_API_KEY'] = 'sk-otk-admission-gate-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider } from './d1d8_c_provider.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { legacyMeasurementPorts } from '../../src/operations/measurementPorts.js';
import { PgOperationStore } from '../../src/operations/PgOperationStore.js';
import { admitReq } from '../fixtures/d1d8/c/builders.js';

let db: TestDb;
const provider = new ControllableProvider();

async function gateway(instanceId: string, admissionConcurrency?: number): Promise<{ rt: OperationsRuntime; server: Server; base: string }> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, recoveryIntervalMs: 3_600_000, quotaFor: () => null, measurement: legacyMeasurementPorts(),
    poolMax: 4, ...(admissionConcurrency ? { admissionConcurrency } : {}), admissionQueueTimeoutMs: 30_000,
    policy: { leaseMs: 30_000, cancelPollMs: 1_000, extraForwardHeaders: ['x-test-script', 'x-test-tokens'] } });
  const gw = await import('../../src/proxy/ProxyGateway.js');
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  return { rt, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const call = (base: string, token: string, op: string) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-otk-provider': 'openai', 'x-otk-operation-id': op, 'x-test-script': 'ok', 'x-test-tokens': '10,2' },
  body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
});

/** 8 concurrent requests while the tenant's quota row stays locked for 7 s; returns every status and error. */
async function burst(base: string, token: string, tenant: string, tag: string): Promise<Array<{ status: number; error: string | null }>> {
  const warm = await call(base, token, `${tag}-warm`); await warm.text(); // creates the quota row of this epoch
  const lock = await db.pool.connect();
  try {
    await lock.query('BEGIN');
    // the tenant-scoped lock every admission takes first (independent of the hourly quota epoch: locking the quota row
    // of the warm-up's epoch missed the burst when the hour changed in between; clean-clone run at 08:00 UTC)
    await lock.query('SELECT otk_money_scope_lock($1)', [tenant]);
    const all = Promise.all(Array.from({ length: 8 }, (_, i) => call(base, token, `${tag}-${i}`).then(async (r) => {
      const t = await r.text(); let error: string | null = null; try { error = (JSON.parse(t) as { error?: string }).error ?? null; } catch { /* body */ }
      return { status: r.status, error };
    })));
    await new Promise((r) => setTimeout(r, 7_000));
    await lock.query('COMMIT');
    return await all;
  } finally { lock.release(); }
}

before(async () => {
  db = await createTestDb('ovngate');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
});
after(async () => { await provider.stop(); await db.drop(); });

describe('F-P1-04 — admission waiters must not starve the pool', () => {
  it('BEFORE (no effective limit, as before 3b42134): waiters hold every connection; the rest time out → 503 persistence_unavailable', async () => {
    // 100 ≫ pool 4 emulates the code without a gate (a limit equal to the pool would still keep the waiters out of it)
    const g = await gateway('gate-open', 100);
    try {
      const out = await burst(g.base, 'tokgO', 'gO', 'open');
      assert.ok(out.some((o) => o.status === 503 && o.error === 'persistence_unavailable'), `expected the defect: ${JSON.stringify(out)}`);
    } finally { g.server.closeAllConnections(); await new Promise<void>((r) => g.server.close(() => r())); await g.rt.stop(); }
  });

  it('AFTER (default gate, pool − 3): every request waits in memory and is admitted once the lock is released; no 503', async () => {
    const g = await gateway('gate-default');
    try {
      assert.equal(g.rt.admission.limit, 1);
      const out = await burst(g.base, 'tokgF', 'gF', 'fixed');
      assert.deepEqual(out.map((o) => o.status), Array(8).fill(200), JSON.stringify(out));
      assert.ok(g.rt.admission.maxQueued >= 1, 'requests actually queued in memory');
    } finally { g.server.closeAllConnections(); await new Promise<void>((r) => g.server.close(() => r())); await g.rt.stop(); }
  });

  it('queue wait beyond admissionQueueTimeoutMs → 503 admission_busy, named as such; nothing reserved, nothing sent', async () => {
    const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId: 'gate-busy', recoveryIntervalMs: 3_600_000, quotaFor: () => null, measurement: legacyMeasurementPorts(),
      poolMax: 4, admissionConcurrency: 1, admissionQueueTimeoutMs: 1_000, policy: { leaseMs: 30_000, cancelPollMs: 1_000, extraForwardHeaders: ['x-test-script', 'x-test-tokens'] } });
    const gw = await import('../../src/proxy/ProxyGateway.js');
    const server = gw.startProxyGateway({ port: 0, operations: rt });
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const warm = await call(base, 'tokgB', 'busy-warm'); await warm.text();
      const n = provider.calls.length;
      const lock = await db.pool.connect();
      let out: Array<{ status: number; error: string | null }> = [];
      try {
        await lock.query('BEGIN');
        await lock.query("SELECT otk_money_scope_lock('gB')"); // epoch-independent (see burst())
        const all = Promise.all(Array.from({ length: 4 }, (_, i) => call(base, 'tokgB', `busy-${i}`).then(async (r) => {
          const t = await r.text(); let error: string | null = null; try { error = (JSON.parse(t) as { error?: string }).error ?? null; } catch { /* body */ }
          return { status: r.status, error };
        })));
        await new Promise((r) => setTimeout(r, 3_000));
        await lock.query('COMMIT');
        out = await all;
      } finally { lock.release(); }
      const busy = out.filter((o) => o.status === 503 && o.error === 'admission_busy');
      assert.equal(busy.length, 3, JSON.stringify(out));
      assert.equal(out.filter((o) => o.status === 200).length, 1, 'the one inside the database is admitted after the lock');
      assert.equal(provider.calls.length - n, 1, 'refused waiters never reached the provider');
      const ops = await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM otk_operations WHERE tenant_id = 'gB' AND operation_id LIKE 'busy-%' AND operation_id <> 'busy-warm'");
      assert.equal(ops.rows[0]!.n, '1', 'no operation, reservation or quota for the refused ones');
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rt.stop(); }
  });

  it('the execution lease is written by the admitting transaction (owner + lease_until), absent when not asked', async () => {
    const store = new PgOperationStore(db.pool, { quotaFor: () => null, epochOf: () => 'e' });
    assert.equal((await store.admit({ ...admitReq({ tenantId: 'gL', operationId: 'with-lease' }, 1n), lease: { owner: 'inst-L', ms: 30_000 } })).outcome, 'admitted');
    assert.equal((await store.admit(admitReq({ tenantId: 'gL', operationId: 'no-lease' }, 1n))).outcome, 'admitted');
    const rows = await db.pool.query<{ op: string; owner: string | null; left: string | null }>(
      "SELECT operation_id AS op, owner, round(extract(epoch FROM (lease_until - now())) * 1000)::text AS left FROM otk_operations WHERE tenant_id = 'gL' ORDER BY 1");
    const by = Object.fromEntries(rows.rows.map((r) => [r.op, r]));
    assert.equal(by['with-lease']!.owner, 'inst-L');
    assert.ok(Number(by['with-lease']!.left) > 20_000, `lease left ${by['with-lease']!.left} ms`);
    assert.deepEqual([by['no-lease']!.owner, by['no-lease']!.left], [null, null]);
    // recovery does not take an admitted operation whose admission lease is valid
    assert.equal((await store.listIncomplete({ olderThan: new Date(Date.now() + 60_000).toISOString(), limit: 10 })).map((o) => o.key.operationId).join(), 'no-lease');
  });
});
