/**
 * Wave 1 Pack 4 — TAL + Policy Tests (S3.3 + S3.5)
 *
 * Tests:
 *   - RedisTAL: debit, balance, idempotency, fallback, distributed flag
 *   - PublishPolicy window_k: production config, integration readiness
 *
 * @since Wave 1 Pack 4 (2026-03-15)
 *
 * Modules under test: `src/security/RedisTAL.ts` (local fallback and a mock Redis client) and
 * `src/publisher/PublishPolicy.ts`.
 *
 * Strategy / partitions: the accounting layer without Redis (debit sync and async, balance, idempotent debit,
 * entries, reconcile with and without a delta) and with a mock client (distributed flag); the publish policy
 * from the environment, off mode, both window conditions, flush, inspect, and invalid window and batch size.
 *
 * Needs: no Redis and no network. One case sets `CU_PUBLISH_POLICY` and deletes it afterwards.
 *
 * Run just this file: `npx tsx --test test/unit/wave1_pack04_tal_policy.test.ts`
 *
 * @module test/unit/wave1_pack04_tal_policy.test
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { RedisTAL } from '../../src/security/RedisTAL.js';
import { PublishPolicy, optionsFromEnv } from '../../src/publisher/PublishPolicy.js';

// ─── S3.3 — RedisTAL Tests (no Redis — local fallback) ──────────────

describe('S3.3 — RedisTAL (local fallback mode)', () => {
  let tal: RedisTAL;

  beforeEach(() => {
    tal = new RedisTAL(null); // no Redis client
  });

  it('isDistributed is false without Redis', () => {
    assert.equal(tal.isDistributed, false);
  });

  it('debit records entry locally', () => {
    tal.debit({
      tenantId: 'acme', epochId: '100', requestId: 'req-1',
      provider: 'openai', model: 'gpt-4', cu: 150n, ts: Date.now(),
    });
    assert.equal(tal.size(), 1);
  });

  it('debitAsync records entry locally', async () => {
    await tal.debitAsync({
      tenantId: 'acme', epochId: '100', requestId: 'req-1',
      provider: 'openai', model: 'gpt-4', cu: 150n, ts: Date.now(),
    });
    assert.equal(tal.size(), 1);
  });

  it('balance returns correct CU total', () => {
    tal.debit({ tenantId: 'acme', epochId: '100', requestId: 'r1', provider: 'o', model: 'm', cu: 100n, ts: 1 });
    tal.debit({ tenantId: 'acme', epochId: '100', requestId: 'r2', provider: 'o', model: 'm', cu: 200n, ts: 2 });
    const bal = tal.balance('acme', '100');
    assert.equal(bal.totalCU, 300n);
    assert.equal(bal.entryCount, 2);
  });

  it('balanceAsync returns correct CU total', async () => {
    tal.debit({ tenantId: 'acme', epochId: '100', requestId: 'r1', provider: 'o', model: 'm', cu: 100n, ts: 1 });
    const bal = await tal.balanceAsync('acme', '100');
    assert.equal(bal.totalCU, 100n);
  });

  it('debit is idempotent by requestId', () => {
    const entry = { tenantId: 'acme', epochId: '100', requestId: 'r1', provider: 'o', model: 'm', cu: 100n, ts: 1 };
    tal.debit(entry);
    tal.debit(entry); // duplicate
    assert.equal(tal.size(), 1);
    assert.equal(tal.balance('acme', '100').totalCU, 100n);
  });

  it('entries returns per-tenant/epoch entries', () => {
    tal.debit({ tenantId: 'acme', epochId: '100', requestId: 'r1', provider: 'o', model: 'm', cu: 100n, ts: 1 });
    tal.debit({ tenantId: 'beta', epochId: '100', requestId: 'r2', provider: 'o', model: 'm', cu: 200n, ts: 2 });
    const entries = tal.entries('acme', '100');
    assert.equal(entries.length, 1);
    assert.equal(entries[0].requestId, 'r1');
  });

  it('reconcile detects delta', () => {
    tal.debit({ tenantId: 'acme', epochId: '100', requestId: 'r1', provider: 'o', model: 'm', cu: 100n, ts: 1 });
    const result = tal.reconcile('acme', '100', 50n);
    assert.equal(result.delta, 50n); // 100 off-chain - 50 on-chain
    assert.equal(result.ok, false);
  });

  it('reconcile shows ok when balanced', () => {
    tal.debit({ tenantId: 'acme', epochId: '100', requestId: 'r1', provider: 'o', model: 'm', cu: 100n, ts: 1 });
    const result = tal.reconcile('acme', '100', 100n);
    assert.equal(result.ok, true);
  });

  it('isDistributed is true with mock Redis client', () => {
    const mockRedis = {}; // truthy object
    const redisTal = new RedisTAL(mockRedis);
    assert.equal(redisTal.isDistributed, true);
  });
});

// ─── S3.5 — PublishPolicy window_k Production Tests ────────────────

describe('S3.5 — PublishPolicy window_k (production config)', () => {
  it('fromEnv creates policy with defaults', () => {
    const policy = PublishPolicy.fromEnv<string>();
    assert.equal(policy.mode, 'window_k');
    assert.equal(policy.windowMs, 60_000);
    assert.equal(policy.minBatchK, 10);
  });

  it('off mode returns receipt immediately', () => {
    const policy = new PublishPolicy<string>({ mode: 'off', windowMs: 1000, minBatchK: 5 });
    const result = policy.add('receipt1');
    assert.deepEqual(result, ['receipt1']);
  });

  it('window_k buffers until both conditions met', () => {
    let time = 1000;
    const policy = new PublishPolicy<string>({
      mode: 'window_k',
      windowMs: 100,
      minBatchK: 3,
      now: () => time,
    });

    // Add 2 receipts — not enough for K
    assert.equal(policy.add('r1'), null);
    assert.equal(policy.add('r2'), null);
    assert.equal(policy.pendingCount, 2);

    // Add 3rd — K met but window not elapsed
    assert.equal(policy.add('r3'), null);

    // Advance time past window
    time = 1200;
    // Add 4th — now both conditions met
    const batch = policy.add('r4');
    assert.ok(batch);
    assert.equal(batch!.length, 4);
  });

  it('flush releases all pending', () => {
    const policy = new PublishPolicy<string>({
      mode: 'window_k',
      windowMs: 60000,
      minBatchK: 100,
    });
    policy.add('r1');
    policy.add('r2');
    const flushed = policy.flush();
    assert.equal(flushed.length, 2);
    assert.equal(policy.pendingCount, 0);
  });

  it('inspect returns correct state', () => {
    let time = 5000;
    const policy = new PublishPolicy<string>({
      mode: 'window_k',
      windowMs: 1000,
      minBatchK: 5,
      now: () => time,
    });
    policy.add('r1');
    time = 5500;
    const state = policy.inspect();
    assert.equal(state.mode, 'window_k');
    assert.equal(state.pendingCount, 1);
    assert.equal(state.batchOpenSince, 5000);
    assert.equal(state.elapsedMs, 500);
  });

  it('optionsFromEnv reads env vars', () => {
    process.env['CU_PUBLISH_POLICY'] = 'off';
    const opts = optionsFromEnv();
    assert.equal(opts.mode, 'off');
    delete process.env['CU_PUBLISH_POLICY'];
  });

  it('windowMs <= 0 throws RangeError', () => {
    assert.throws(
      () => new PublishPolicy<string>({ mode: 'window_k', windowMs: 0, minBatchK: 1 }),
      RangeError,
    );
  });

  it('minBatchK < 1 throws RangeError', () => {
    assert.throws(
      () => new PublishPolicy<string>({ mode: 'window_k', windowMs: 1000, minBatchK: 0 }),
      RangeError,
    );
  });
});
