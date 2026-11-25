/**
 * Fechamento pós-S5 — FPS5-F01 (found by the closing verification, not in the audit): the first use of
 * front B's local counter in a process is synchronous (tokenizer load, ~0.9 s measured idle) and used to
 * run AFTER the execution lease was claimed and BEFORE any renewal timer existed. With a short lease, the
 * lease expired while the operation was live and another instance declared it process_lost
 * (d1d8_c_proxy_entry INT-04, intermittent). The handler now renews the lease after the counter and
 * before the durable start. Deterministic in-process reproduction: a counter that blocks the event loop
 * for longer than the lease; when the provider receives the call, the lease must still be valid.
 *
 *   . scripts/ops/fps5_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_fps5_lease_start.test.ts
 *
 * Module under test: the in-process API proxy path of `src/operations/runtime.ts` (lease handling around the first
 * counter use), with the fake provider from `./d1d8_c_provider.ts` and a blocking counter built on the local-counter
 * double from `test/fixtures/d1d8/c/doubles.ts`.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`). Before importing the server it
 * sets fixture values in the test process for the API's variables (tenants, a fake provider key, the upstream
 * override, `PROVER_URL=disabled`). The command above loads the test environment from `scripts/ops/fps5_env.sh`
 * first; with the variables already set, `npx tsx --test test/services/d1d8_fps5_lease_start.test.ts` runs just this
 * file.
 *
 * @module test/services/d1d8_fps5_lease_start.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'tLs/OPERATOR:tokLs';
process.env['OPENAI_API_KEY'] = 'sk-otkd1d8fps5-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider } from './d1d8_c_provider.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { legacyMeasurementPorts, type MeasurementPorts } from '../../src/operations/measurementPorts.js';
import { createLocalCounterDouble } from '../fixtures/d1d8/c/doubles.js';

const LEASE_MS = 1_000;
let db: TestDb;
let rt: OperationsRuntime;
let server: Server;
const provider = new ControllableProvider();

/** A counter whose creation blocks the event loop (busy wait) for 2 × the lease, like a cold tokenizer load. */
function blockingMeasurement(): MeasurementPorts {
  const base = legacyMeasurementPorts();
  return {
    ...base,
    label: 'legacy+blocking-counter',
    createLocalCounter: () => { const end = Date.now() + 2 * LEASE_MS; while (Date.now() < end) { /* synchronous */ } return createLocalCounterDouble(); },
    resolveModelSupport: (p, api, model) => ({ provider: p, api, modelRequested: model, catalogKey: model, support: 'generic_fallback', tokenizer: null, catalogVersion: 'double' }),
  };
}

before(async () => {
  db = await createTestDb('fps5lease');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId: 'lease-1', recoveryIntervalMs: 3_600_000, quotaFor: () => null, measurement: blockingMeasurement(),
    policy: { leaseMs: LEASE_MS, cancelPollMs: 300, extraForwardHeaders: ['x-test-script', 'x-test-tokens'] } });
  const gw = await import('../../src/proxy/ProxyGateway.js');
  server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
});
after(async () => {
  await provider.stop();
  server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r()));
  await rt.stop(); await db.drop();
});

describe('FPS5-F01 — the execution lease is valid when the provider is called, even after a blocking counter', () => {
  it('lease renewed after the synchronous counter work; the operation is never orphaned while live', async () => {
    const seen: Array<{ execution: string; leaseLeftMs: number }> = [];
    provider.onArrive = async () => {
      const r = await db.pool.query<{ execution: string; left: string }>(
        "SELECT execution, round(extract(epoch FROM (lease_until - now())) * 1000)::text AS left FROM otk_operations WHERE tenant_id = 'tLs' AND operation_id = 'ls-1'");
      seen.push({ execution: r.rows[0]!.execution, leaseLeftMs: Number(r.rows[0]!.left) });
    };
    const res = await fetch(`${`http://127.0.0.1:${(server.address() as AddressInfo).port}`}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer tokLs', 'x-otk-provider': 'openai', 'x-otk-operation-id': 'ls-1', 'x-test-script': 'ok', 'x-test-tokens': '10,2' },
      body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] }),
    });
    assert.equal(res.status, 200, await res.clone().text());
    await res.text();
    provider.onArrive = null;
    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.execution, 'upstream_started');
    assert.ok(seen[0]!.leaseLeftMs > LEASE_MS / 2, `lease left at the provider call: ${seen[0]!.leaseLeftMs} ms (expired before the fix)`);
  });
});
