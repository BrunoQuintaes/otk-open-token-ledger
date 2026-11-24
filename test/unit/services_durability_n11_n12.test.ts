/**
 * N11 / N12 — behaviours found with real PostgreSQL and Redis (scripts/rehearsal/
 * services_rehearsal.ts, session 2026-09-29/30), checked here without the services.
 *
 * N12: an idle-client error on a pg Pool (PostgreSQL restarted) had no listener, so Node
 *      raised it as unhandled and the API process exited with code 1.
 * N11: with RedisTAL the quota read this process's memory only; after a restart (or on a
 *      second replica) consumption was 0 although Redis held the total.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';

describe('N12 — pg pool idle errors do not terminate the process', () => {
  it('PostgresReceiptStore pool handles an idle client error', async () => {
    const { PostgresReceiptStore } = await import('../../src/api/PostgresReceiptStore.js');
    // No connection is opened until the first query
    const store = new PostgresReceiptStore('postgres://otk@127.0.0.1:1/otk');
    const pool = (store as unknown as { pool: import('node:events').EventEmitter }).pool;
    assert.ok(pool.listenerCount('error') >= 1, 'error listener registered');
    assert.doesNotThrow(() => pool.emit('error', new Error('terminating connection due to administrator command')));
    await store.close();
  });
});

describe('N11 — quota reads the shared (Redis) balance', () => {
  it('restart-like state: memory empty, Redis total 12000 CU → FREE quota exceeded', async () => {
    const { RedisTAL } = await import('../../src/security/RedisTAL.js');
    const talRuntime = await import('../../src/security/talRuntime.js');
    const { checkMeteringQuota, checkMeteringQuotaAsync } = await import('../../src/billing/meteringQuota.js');
    const { deriveEpoch } = await import('../../src/types/receipt.js');
    const now = Math.floor(Date.now() / 1000);
    const epoch = String(deriveEpoch(now));
    const tenant = 'n11-tenant';
    const fakeRedis = {
      async hgetall(key: string) {
        return key === `otk:tal:${tenant}:${epoch}` ? { totalCU: '12000', entryCount: '4' } : {};
      },
      // RV30-04: RedisTAL reads the two aggregate fields with HMGET (the hash also holds markers)
      async hmget(key: string, ...fields: string[]) {
        const h: Record<string, string> = key === `otk:tal:${tenant}:${epoch}` ? { totalCU: '12000', entryCount: '4' } : {};
        return fields.map((f) => h[f] ?? null);
      },
    };
    const previous = talRuntime.getAccountingLayer();
    talRuntime.setAccountingLayer(new RedisTAL(fakeRedis));
    try {
      // this process has debited nothing: the local view says 0
      assert.equal(checkMeteringQuota(tenant, now).exceeded, false);
      const shared = await checkMeteringQuotaAsync(tenant, now);
      assert.equal(shared.current, 12000n);
      assert.equal(shared.exceeded, true, 'FREE quota (10000 CU) is exceeded by the shared total');
      assert.equal((await talRuntime.sharedBalance(tenant, epoch)).totalCU, 12000n);
    } finally {
      talRuntime.setAccountingLayer(previous);
    }
  });

  it('in-memory TAL: shared balance = local balance', async () => {
    const talRuntime = await import('../../src/security/talRuntime.js');
    talRuntime.resetAccountingLayerForTest();
    talRuntime.getAccountingLayer().debit({ tenantId: 't', epochId: 'e', requestId: 'r', provider: 'openai', model: 'gpt-4o', cu: 700n, ts: 0 });
    assert.equal((await talRuntime.sharedBalance('t', 'e')).totalCU, 700n);
  });
});

describe('Quota under concurrency — CU of receipts being written counts (S7c regression)', () => {
  it('5 concurrent reservations of 3000 CU on FREE (10000): 4 admitted, the 5th refused; release frees', async () => {
    const talRuntime = await import('../../src/security/talRuntime.js');
    const { reserveMeteringQuota } = await import('../../src/billing/meteringQuota.js');
    talRuntime.resetAccountingLayerForTest();
    const rs = await Promise.all(Array.from({ length: 5 }, () => reserveMeteringQuota('quota-race-tenant', 3000n)));
    assert.deepEqual(rs.map(r => r.exceeded), [false, false, false, false, true]);
    rs.forEach(r => r.release());
    const again = await reserveMeteringQuota('quota-race-tenant', 3000n);
    assert.equal(again.exceeded, false, 'released reservations no longer count');
    again.release();
  });
});
