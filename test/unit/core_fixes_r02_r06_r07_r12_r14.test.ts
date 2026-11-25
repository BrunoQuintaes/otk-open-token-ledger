/**
 * Regression tests for review findings R02, R06, R07, R12, R14 (2026-09-28).
 *
 * Expected values are computed by hand, not by the code under test:
 *   openai/gpt-4o seed price 2026-04: 0.005 USD / 1K input, 0.015 USD / 1K output
 *   1000 input + 2000 output tokens = 1 × 0.005 + 2 × 0.015 = 0.035 USD
 *
 * The prover is replaced by a local fetch stub (no network). No Stripe call is made.
 *
 * Modules under test (imported dynamically after the environment is set):
 * `src/api/receiptStore.ts` (tenant stamping, prover circuit breaker), `src/billing/UsageMeterService.ts`
 * (pricing and usage submission), `src/economics/ReconciliationSystem.ts`, `src/billing/PlanRegistry.ts`
 * with `src/billing/IPlanStore.ts`, and `src/security/talRuntime.ts`.
 *
 * Strategy / partitions: tenant argument present, absent and contradicting the receipt, and
 * duplicates; billing with real token counts, a genuine zero, missing counts (never priced as 0)
 * and an unknown model, plus submission of an incomplete period, a complete period without and
 * with a usage-record port; reconciliation of several receipts in one transaction, including an
 * unpriced one; plan cache loading, refresh after another replica's write, read-through and a
 * concurrent read; prover outage (circuit opens after 2 failures, cooldown, half-open replay) and
 * a failed half-open trial.
 *
 * Needs: no network and no database. Sets `OTK_RECEIPT_LOG`, `OTK_DB_URL` (both empty),
 * `PROVER_URL`, `PROVER_CB_THRESHOLD` and `PROVER_CB_COOLDOWN_MS` before the modules load, and
 * replaces `globalThis.fetch` during the prover block (restored after each test); that block
 * waits on real timers for the 200 ms cooldown.
 *
 * Run just this file: `npx tsx --test test/unit/core_fixes_r02_r06_r07_r12_r14.test.ts`
 *
 * @module test/unit/core_fixes_r02_r06_r07_r12_r14.test
 */
import { describe, it, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { RawReceipt } from '../../src/types/receipt.js';

// receiptStore reads these at module load
process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['PROVER_CB_THRESHOLD'] = '2';
process.env['PROVER_CB_COOLDOWN_MS'] = '200';

let store: typeof import('../../src/api/receiptStore.js');
let talRuntime: typeof import('../../src/security/talRuntime.js');
let usage: typeof import('../../src/billing/UsageMeterService.js');
let plans: typeof import('../../src/billing/PlanRegistry.js');
let planStores: typeof import('../../src/billing/IPlanStore.js');
let recon: typeof import('../../src/economics/ReconciliationSystem.js');
let deriveEpoch: (ts: number) => bigint | number;

before(async () => {
  store = await import('../../src/api/receiptStore.js');
  talRuntime = await import('../../src/security/talRuntime.js');
  usage = await import('../../src/billing/UsageMeterService.js');
  plans = await import('../../src/billing/PlanRegistry.js');
  planStores = await import('../../src/billing/IPlanStore.js');
  recon = await import('../../src/economics/ReconciliationSystem.js');
  deriveEpoch = (await import('../../src/types/receipt.js')).deriveEpoch as typeof deriveEpoch;
});

const TS = 1700000000;
let seq = 0;
function receipt(over: Partial<RawReceipt> = {}): RawReceipt {
  seq++;
  return {
    provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 2000,
    costUnits: 3000, latencyMs: 10, timestamp: TS,
    requestId: `core-fix-${seq}`, userId: 7n, nonce: BigInt(seq),
    ...over,
  };
}
const epochOf = () => String(deriveEpoch(TS));

// ---------------------------------------------------------------------------
describe('R12 — tenant is persisted with the receipt', () => {
  beforeEach(() => talRuntime.resetAccountingLayerForTest());

  it('stamps the tenantId argument on the stored receipt', () => {
    const r = receipt();
    assert.deepEqual(store.storeReceipt(r, 'tenant-x'), { stored: true });
    assert.equal(store.getReceipt(r.requestId)?.tenantId, 'tenant-x');
    assert.equal(talRuntime.getAccountingLayer().balance('tenant-x', epochOf()).totalCU, 3000n);
    assert.equal(r.tenantId, undefined, 'caller object is not mutated');
  });

  it('stamps default explicitly when no tenant is known', () => {
    const r = receipt();
    store.storeReceipt(r);
    assert.equal(store.getReceipt(r.requestId)?.tenantId, 'default');
  });

  it('rejects a tenantId argument that contradicts receipt.tenantId, with no side effects', () => {
    const r = receipt({ tenantId: 'tenant-a' });
    assert.deepEqual(store.storeReceipt(r, 'tenant-b'), { stored: false, reason: 'tenant_mismatch' });
    assert.equal(store.getReceipt(r.requestId), undefined);
    assert.equal(talRuntime.getAccountingLayer().balance('tenant-a', epochOf()).entryCount, 0);
    assert.equal(talRuntime.getAccountingLayer().balance('tenant-b', epochOf()).entryCount, 0);
  });

  it('reports duplicates explicitly', () => {
    const r = receipt();
    store.storeReceipt(r, 'tenant-x');
    assert.deepEqual(store.storeReceipt(r, 'tenant-x'), { stored: false, reason: 'duplicate' });
  });
});

// ---------------------------------------------------------------------------
describe('R02 — billing uses recorded tokens; missing data is never USD 0', () => {
  beforeEach(() => talRuntime.resetAccountingLayerForTest());

  it('prices 1000/2000 gpt-4o tokens at 0.035 USD and names the price version', async () => {
    store.storeReceipt(receipt(), 'bill-a');
    const s = await usage.computeAndSubmitUsage('bill-a', epochOf(), { dryRun: true });
    assert.ok(Math.abs(s.totalUsd - 0.035) < 1e-12, `got ${s.totalUsd}`);
    assert.equal(s.totalCU, 3000n);
    assert.equal(s.complete, true);
    assert.equal(s.pricedEntries, 1);
    assert.deepEqual(s.unpricedEntries, []);
    assert.equal(s.priceVersion, '2026-04');
  });

  it('a genuine zero-token entry is priced as 0 and stays complete', async () => {
    store.storeReceipt(receipt({ inputTokens: 0, outputTokens: 0, costUnits: 0 }), 'bill-zero');
    const s = await usage.computeAndSubmitUsage('bill-zero', epochOf(), { dryRun: true });
    assert.equal(s.totalUsd, 0);
    assert.equal(s.complete, true);
  });

  it('an entry without token counts is reported as missing_tokens, not priced as 0', async () => {
    talRuntime.getAccountingLayer().debit({
      tenantId: 'bill-b', epochId: epochOf(), requestId: 'legacy-entry',
      provider: 'openai', model: 'gpt-4o', cu: 3000n, ts: TS * 1000,
    });
    const s = await usage.computeAndSubmitUsage('bill-b', epochOf(), { dryRun: true });
    assert.equal(s.complete, false);
    assert.deepEqual(s.unpricedEntries, [{ requestId: 'legacy-entry', reason: 'missing_tokens' }]);
    assert.equal(s.totalCU, 3000n);
  });

  it('an unknown model is reported as unknown_price', async () => {
    store.storeReceipt(receipt({ model: 'model-not-in-seed' }), 'bill-c');
    const s = await usage.computeAndSubmitUsage('bill-c', epochOf(), { dryRun: true });
    assert.equal(s.complete, false);
    assert.equal(s.unpricedEntries[0]?.reason, 'unknown_price');
  });

  it('refuses to submit an incomplete period to Stripe', async () => {
    await plans.assignPlan('bill-d', 'PRO');
    store.storeReceipt(receipt(), 'bill-d');
    store.storeReceipt(receipt({ model: 'model-not-in-seed' }), 'bill-d');
    const s = await usage.computeAndSubmitUsage('bill-d', epochOf(), { stripeSubscriptionItemId: 'si_test_fixture' });
    assert.equal(s.submissionBlocked, 'incomplete_pricing');
    assert.equal(s.stripeUsageRecordId, null);
    assert.ok(Math.abs(s.totalUsd - 0.035) < 1e-12, 'partial total stays visible for diagnosis');
  });

  // OVERNIGHT 20261005 / Phase 5 (R03): the submission used a getStripeClient that never existed (raw tsc TS2339)
  it('complete PRO period without a usage-record port: blocked explicitly, no attempt pretended', async () => {
    await plans.assignPlan('bill-e', 'PRO');
    store.storeReceipt(receipt(), 'bill-e');
    const s = await usage.computeAndSubmitUsage('bill-e', epochOf(), { stripeSubscriptionItemId: 'si_test_fixture' });
    assert.equal(s.complete, true);
    assert.equal(s.submissionBlocked, 'stripe_usage_port_not_configured');
    assert.equal(s.stripeUsageRecordId, null);
  });

  it('complete PRO period with an injected usage-record port: one set-record in cents, id returned', async () => {
    await plans.assignPlan('bill-f', 'PRO');
    store.storeReceipt(receipt(), 'bill-f');
    const calls: unknown[] = [];
    const s = await usage.computeAndSubmitUsage('bill-f', epochOf(), { stripeSubscriptionItemId: 'si_test_fixture',
      usageRecords: { createUsageRecord: async (id, params) => { calls.push([id, params]); return { id: 'mbur_test_fixture' }; } } });
    assert.equal(s.stripeUsageRecordId, 'mbur_test_fixture');
    // 0.035 USD × 100 = 3.4999999999999996 in binary floating point → 3 cents (F-P5-01: this legacy path keeps USD as a
    // JS number; the v3 money axis uses integer pico-USD). Recorded, not fixed here: Stripe is outside the validated scope.
    assert.deepEqual(calls, [['si_test_fixture', { quantity: 3, timestamp: 'now', action: 'set' }]]);
  });
});

// ---------------------------------------------------------------------------
describe('R06 — reconciliation keeps every receipt of a transaction', () => {
  it('100 CU + 200 CU in one tx → 300 CU, two receipts, traceable ids', () => {
    const r = recon.reconcile([
      { txHash: 'tx', userId: 'u1', costUnits: 100n, epoch: 1, receiptId: 'a' },
      { txHash: 'tx', userId: 'u2', costUnits: 200n, epoch: 1, receiptId: 'b' },
    ], [], '2026-09-28T00:00:00Z');
    assert.equal(r.items.length, 1);
    const line = r.items[0]!;
    assert.equal(line.otkCU, 300n);
    assert.equal(line.otkReceiptCount, 2);
    assert.deepEqual(line.receiptIds, ['a', 'b']);
    assert.deepEqual(line.userIds, ['u1', 'u2']);
    assert.equal(line.userId, 'multiple');
    assert.equal(r.totalOTK, 2);
  });

  it('expected USD is the sum over receipts; external lines of one tx are summed', () => {
    const tok = { provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 2000 };
    const r = recon.reconcile([
      { txHash: 'tx2', userId: 'u1', costUnits: 3000n, epoch: 1, ...tok },
      { txHash: 'tx2', userId: 'u1', costUnits: 3000n, epoch: 1, ...tok },
    ], [
      { txHash: 'tx2', userId: 'u1', billedUsd: 0.03 },
      { txHash: 'tx2', userId: 'u1', billedUsd: 0.04 },
    ], '2026-09-28T00:00:00Z');
    const line = r.items[0]!;
    assert.ok(Math.abs(line.expectedUsd! - 0.07) < 1e-12);
    assert.ok(Math.abs(line.externalUsd! - 0.07) < 1e-12);
    assert.equal(line.externalRecordCount, 2);
    assert.equal(line.discrepancyFlag, false);
  });

  it('one unpriced receipt makes the tx expected USD unknown instead of undercounting', () => {
    const r = recon.reconcile([
      { txHash: 'tx3', userId: 'u1', costUnits: 3000n, epoch: 1, provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 2000 },
      { txHash: 'tx3', userId: 'u1', costUnits: 3000n, epoch: 1 },
    ], [{ txHash: 'tx3', userId: 'u1', billedUsd: 0.035 }], '2026-09-28T00:00:00Z');
    const line = r.items[0]!;
    assert.equal(line.expectedUsd, null);
    assert.equal(line.unpricedReceipts, 1);
    assert.equal(line.deltaUsd, null);
  });
});

// ---------------------------------------------------------------------------
describe('R07 — plan cache is hydrated from the persistent store', () => {
  beforeEach(() => plans.resetPlanStoreForTest());

  it('setPlanStore loads persisted assignments into the sync view', async () => {
    const backend = new planStores.MemoryPlanStore();
    await backend.assign('persisted-pro', 'PRO');
    assert.equal(await plans.setPlanStore(backend), 1);
    assert.equal(plans.getTenantPlan('persisted-pro'), 'PRO');
    assert.equal(plans.getTenantPlanDefinition('persisted-pro').billingModel, 'usage');
  });

  it('refreshPlanCache picks up a change written by another replica', async () => {
    const backend = new planStores.MemoryPlanStore();
    await plans.setPlanStore(backend);
    await backend.assign('replica-t', 'STARTER'); // written elsewhere, not through assignPlan
    assert.equal(plans.getTenantPlan('replica-t'), 'FREE', 'stale until refreshed (documented limit)');
    await plans.refreshPlanCache();
    assert.equal(plans.getTenantPlan('replica-t'), 'STARTER');
  });

  it('getTenantPlanAsync reads through into the sync view', async () => {
    const backend = new planStores.MemoryPlanStore();
    await plans.setPlanStore(backend);
    await backend.assign('rt', 'PRO');
    assert.equal(await plans.getTenantPlanAsync('rt'), 'PRO');
    assert.equal(plans.getTenantPlan('rt'), 'PRO');
  });

  it('a fresh assignPlan is not evicted by a concurrent async read', async () => {
    await plans.assignPlan('fresh', 'STARTER');
    await plans.getTenantPlanAsync('fresh');
    assert.equal(plans.getTenantPlan('fresh'), 'STARTER');
  });
});

// ---------------------------------------------------------------------------
describe('R14 — prover dispatch recovers after an outage and replays pending receipts', () => {
  let calls: Array<{ userId: string; nonce: string }> = [];
  let mode: 'down' | 'up' = 'down';
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    store.resetProverStateForTest();
    calls = [];
    mode = 'down';
    process.env['PROVER_URL'] = 'http://prover.test';
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { userId: string; nonce: string };
      calls.push({ userId: body.userId, nonce: body.nonce });
      if (mode === 'down') return new Response('{}', { status: 503 });
      return new Response(JSON.stringify({ jobId: `job-${body.nonce}` }), { status: 202 });
    }) as typeof fetch;
  });

  const restore = () => { globalThis.fetch = realFetch; process.env['PROVER_URL'] = 'disabled'; };
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

  it('opens after 2 failures, skips during cooldown, then half-opens and replays all pending', async () => {
    try {
      const rs = [receipt(), receipt(), receipt(), receipt()];
      store.storeReceipt(rs[0]!, 'p'); await store.awaitLastDispatch();
      store.storeReceipt(rs[1]!, 'p'); await store.awaitLastDispatch();
      assert.equal(store.circuitBreakerStatus().open, true);
      assert.equal(calls.length, 2);

      store.storeReceipt(rs[2]!, 'p'); await store.awaitLastDispatch();
      assert.equal(calls.length, 2, 'no call while open and inside cooldown');
      assert.equal(store.circuitBreakerStatus().pendingProofs, 3);

      mode = 'up';
      await sleep(250); // beyond PROVER_CB_COOLDOWN_MS=200
      store.storeReceipt(rs[3]!, 'p'); await store.awaitLastDispatch();

      const status = store.circuitBreakerStatus();
      assert.equal(status.open, false);
      assert.equal(status.pendingProofs, 0);
      const accepted = new Set(calls.slice(2).map(c => c.nonce));
      assert.deepEqual([...accepted].sort(), rs.map(r => String(r.nonce)).sort(), 'every receipt reached the prover');
      assert.equal(calls.length, 2 + 4, 'each receipt accepted exactly once after recovery');

      assert.equal(await store.retryPendingProofs(), 0);
      assert.equal(calls.length, 6, 'accepted receipts are never re-sent');
    } finally { restore(); }
  });

  it('a failed half-open trial re-opens the circuit and keeps receipts pending', async () => {
    try {
      store.storeReceipt(receipt(), 'p'); await store.awaitLastDispatch();
      store.storeReceipt(receipt(), 'p'); await store.awaitLastDispatch();
      await sleep(250);
      store.storeReceipt(receipt(), 'p'); await store.awaitLastDispatch(); // trial, still down
      assert.equal(calls.length, 3);
      assert.equal(store.circuitBreakerStatus().open, true);
      assert.equal(store.circuitBreakerStatus().pendingProofs, 3);
    } finally { restore(); }
  });
});
