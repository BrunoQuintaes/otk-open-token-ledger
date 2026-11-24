/**
 * R13 (Postgres mode) — storeReceiptDurable with a controllable fake Postgres store.
 * The same paths were exercised against a real PostgreSQL 16 in
 * scripts/rehearsal/services_rehearsal.ts; these tests pin the edge cases without Docker,
 * including the concurrency defect found by the independent review of 2026-09-30.
 */
import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_PG_WRITE_TIMEOUT_MS'] = '200';

let store: typeof import('../../src/api/receiptStore.js');
let talRuntime: typeof import('../../src/security/talRuntime.js');
let deriveEpoch: (ts: number) => bigint;

const TS = 1700000000;
type Receipt = import('../../src/types/receipt.js').RawReceipt;

/** Fake Postgres: each store() call waits for the test to settle it. */
class FakePg {
  rows = new Map<string, Receipt>();
  pending: { receipt: Receipt; resolve: (v: boolean) => void; reject: (e: Error) => void }[] = [];
  mode: 'manual' | 'hang' = 'manual';
  store(r: Receipt): Promise<boolean> {
    if (this.mode === 'hang') return new Promise<boolean>(() => {});
    return new Promise<boolean>((resolve, reject) => {
      this.pending.push({
        receipt: r,
        resolve: (ok) => { if (ok && !this.rows.has(r.requestId)) { this.rows.set(r.requestId, r); resolve(true); } else resolve(false); },
        reject,
      });
    });
  }
  async get(id: string): Promise<Receipt | undefined> { return this.rows.get(id); }
}

const receipt = (requestId: string, cu = 3000, tenantId?: string): Receipt => ({
  provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 2000, costUnits: cu,
  latencyMs: 1, timestamp: TS, requestId, userId: 1n, nonce: 1n, ...(tenantId ? { tenantId } : {}),
});
const flush = () => new Promise(r => setImmediate(r));
const balance = (tenant: string) => talRuntime.getAccountingLayer().balance(tenant, String(deriveEpoch(TS))).totalCU;
let fake: FakePg;

before(async () => {
  store = await import('../../src/api/receiptStore.js');
  talRuntime = await import('../../src/security/talRuntime.js');
  deriveEpoch = (await import('../../src/types/receipt.js')).deriveEpoch;
});
beforeEach(() => {
  fake = new FakePg();
  store.setPgStoreForTest(fake);
  talRuntime.resetAccountingLayerForTest();
});
after(() => store.setPgStoreForTest(null));

describe('R13 — durable Postgres write before any effect', () => {
  it('insert fails → persistence_failed, no memory entry, no debit', async () => {
    const p = store.storeReceiptDurable(receipt('d-fail'), 'ta');
    await flush();
    fake.pending[0]!.reject(new Error('connection refused'));
    assert.deepEqual(await p, { stored: false, reason: 'persistence_failed' });
    assert.equal(store.getReceipt('d-fail'), undefined);
    assert.equal(balance('ta'), 0n);
  });

  it('insert accepted → stored, then effects (debit) happen once', async () => {
    const p = store.storeReceiptDurable(receipt('d-ok'), 'ta');
    await flush();
    assert.equal(store.getReceipt('d-ok'), undefined, 'no effect before Postgres answered');
    fake.pending[0]!.resolve(true);
    assert.deepEqual(await p, { stored: true });
    assert.equal(balance('ta'), 3000n);
  });

  it('frozen database → persistence_failed after the write timeout (200 ms here)', async () => {
    fake.mode = 'hang';
    const t0 = Date.now();
    assert.deepEqual(await store.storeReceiptDurable(receipt('d-hang'), 'ta'), { stored: false, reason: 'persistence_failed' });
    assert.ok(Date.now() - t0 < 2000);
    assert.equal(balance('ta'), 0n);
  });
});

describe('R13 — concurrent requests with the same requestId (review finding)', () => {
  it('first write fails: the second request is not told "duplicate"; it writes itself', async () => {
    const a = store.storeReceiptDurable(receipt('d-race-1'), 'ta');
    const b = store.storeReceiptDurable(receipt('d-race-1'), 'ta');
    await flush();
    assert.equal(fake.pending.length, 1, 'second request waits for the first write');
    fake.pending[0]!.reject(new Error('timeout'));
    assert.deepEqual(await a, { stored: false, reason: 'persistence_failed' });
    for (let i = 0; i < 5 && fake.pending.length < 2; i++) await flush();
    assert.equal(fake.pending.length, 2, 'second request made its own attempt');
    fake.pending[1]!.resolve(true);
    assert.deepEqual(await b, { stored: true });
    assert.equal(balance('ta'), 3000n);
  });

  it('first write succeeds: the second is a duplicate and nothing is debited twice', async () => {
    const a = store.storeReceiptDurable(receipt('d-race-2'), 'ta');
    const b = store.storeReceiptDurable(receipt('d-race-2'), 'ta');
    await flush();
    fake.pending[0]!.resolve(true);
    assert.deepEqual(await a, { stored: true });
    assert.deepEqual(await b, { stored: false, reason: 'duplicate' });
    assert.equal(fake.pending.length, 1);
    assert.equal(balance('ta'), 3000n);
  });
});

describe('R13 — row already in Postgres (late commit or another instance)', () => {
  it('same tenant: duplicate, adopted into memory and accounting without a new audit entry', async () => {
    fake.rows.set('d-late', { ...receipt('d-late'), tenantId: 'ta' });
    const audits = store.auditCount();
    const p = store.storeReceiptDurable(receipt('d-late'), 'ta');
    await flush();
    fake.pending[0]!.resolve(true); // ON CONFLICT DO NOTHING → false
    assert.deepEqual(await p, { stored: false, reason: 'duplicate' });
    assert.ok(store.getReceipt('d-late'), 'adopted');
    assert.equal(balance('ta'), 3000n);
    assert.equal(store.auditCount(), audits, 'no audit entry for an adopted row');
  });

  it("another tenant's id: tenant_mismatch, nothing adopted", async () => {
    fake.rows.set('d-other', { ...receipt('d-other'), tenantId: 'tb' });
    const p = store.storeReceiptDurable(receipt('d-other'), 'ta');
    await flush();
    fake.pending[0]!.resolve(true);
    assert.deepEqual(await p, { stored: false, reason: 'tenant_mismatch' });
    assert.equal(store.getReceipt('d-other'), undefined);
    assert.equal(balance('ta'), 0n);
    assert.equal(balance('tb'), 0n);
  });
});

describe('N14 — which restored receipts are sent for proving', () => {
  it('only receipts without a recorded job, and none when the prover is disabled', () => {
    const rs = [receipt('p-1'), receipt('p-2'), receipt('p-3')];
    const jobs = new Map([['p-1', 'job-9'], ['p-3', 'legacy-unknown']]);
    assert.deepEqual(store.pendingFromRestore(rs, jobs, false).map(r => r.requestId), ['p-2']);
    assert.deepEqual(store.pendingFromRestore(rs, jobs, true), []);
  });
});
