/**
 * D1–D8 / S4 — S4-F06 regression: the recovery pass of an instance never declares lost an
 * operation that the SAME instance is still streaming, even when its lease expired because the
 * renewal lagged under load (observed in the S4.5 clean-copy run: an operation being streamed was
 * marked process_lost). Operations of other (dead) instances are still recovered by lease expiry.
 *
 *   . scripts/ops/s4_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_s4_recovery.test.ts
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { legacyMeasurementPorts } from '../../src/operations/measurementPorts.js';
import { recoverOrphans } from '../../src/operations/effects.js';
import { keyString } from '../../src/operations/context.js';
import { admitReq } from '../fixtures/d1d8/c/builders.js';

let db: TestDb;
let rt: OperationsRuntime;
before(async () => { db = await createTestDb('s4recovery'); rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId: 'rec-1', recoveryIntervalMs: 3_600_000, quotaFor: () => null, measurement: legacyMeasurementPorts() }); });
after(async () => { await rt.stop(); await db.drop(); });

describe('S4-F06 — recovery skips operations streamed by this instance', () => {
  it('own in-flight operation with an expired lease stays upstream_started; after it leaves the in-flight set it is recovered', async () => {
    const key = { tenantId: 'r', operationId: 'live-1' };
    assert.equal((await rt.store.admit(admitReq(key, 3n))).outcome, 'admitted');
    await rt.store.claimLease(key, 'rec-1', 60_000);
    await rt.store.transition(key, 0n, { execution: 'upstream_started' });
    await db.pool.query("UPDATE otk_operations SET lease_until = now() - interval '5 seconds', updated_at = now() - interval '5 seconds' WHERE operation_id = 'live-1'");
    rt.inflight.set(keyString(key), { abort: () => {} });
    await recoverOrphans(rt, { olderThanMs: 0 });
    assert.equal((await rt.store.get(key))!.execution, 'upstream_started', 'alive: not declared lost');
    rt.inflight.delete(keyString(key));
    await recoverOrphans(rt, { olderThanMs: 0 });
    const op = (await rt.store.get(key))!;
    assert.deepEqual([op.execution, op.measurement, op.reservation.state], ['process_lost', 'uncertain', 'held_uncertain']);
  });
});
