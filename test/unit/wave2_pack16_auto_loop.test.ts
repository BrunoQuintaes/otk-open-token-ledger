/**
 * Wave 2 Pack 16 — AutoLoop tests (S4.2 + S4.3)
 *
 * Tests:
 *   - AutoLoop lifecycle (start/stop/isRunning)
 *   - Batch triggering when threshold is met
 *   - Auto-submit on-chain after batch
 *   - Event emissions (batch_triggered, submit_initiated, submit_completed, submit_failed)
 *   - State inspection
 *   - Manual tick() execution
 *   - No batch when below threshold
 *
 * @since Wave 2 Pack 16 (2026-03-15)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AutoLoop } from '../../src/automation/AutoLoop.js';

describe('S4.2 — AutoLoop Lifecycle', () => {
  let loop: AutoLoop;

  beforeEach(() => {
    loop = new AutoLoop(
      {
        getReceiptCount: () => 0,
        flushBatch: () => null,
      },
      { intervalMs: 100, batchThreshold: 5 },
    );
  });

  afterEach(() => {
    loop.stop();
  });

  it('isRunning() is false before start()', () => {
    assert.equal(loop.isRunning(), false);
  });

  it('isRunning() is true after start()', () => {
    loop.start();
    assert.equal(loop.isRunning(), true);
  });

  it('isRunning() is false after stop()', () => {
    loop.start();
    loop.stop();
    assert.equal(loop.isRunning(), false);
  });

  it('start() is idempotent (second call is no-op)', () => {
    loop.start();
    loop.start(); // should not throw or create duplicate timers
    assert.equal(loop.isRunning(), true);
  });

  it('stop() is idempotent (no-op when not running)', () => {
    loop.stop(); // should not throw
    assert.equal(loop.isRunning(), false);
  });

  it('inspect() returns initial state', () => {
    const state = loop.inspect();
    assert.equal(state.running, false);
    assert.equal(state.tickCount, 0);
    assert.equal(state.batchesTriggered, 0);
    assert.equal(state.submitsInitiated, 0);
    assert.equal(state.submitsCompleted, 0);
    assert.equal(state.submitsFailed, 0);
    assert.equal(state.lastTickAt, null);
    assert.equal(state.lastBatchAt, null);
    assert.equal(state.startedAt, null);
  });
});

describe('S4.2 — AutoLoop Batch Triggering', () => {
  it('triggers batch when receipt count >= threshold', async () => {
    let flushed = false;
    const loop = new AutoLoop(
      {
        getReceiptCount: () => 10,
        flushBatch: () => { flushed = true; return { header: { root: 'abc', count: 10 }, proofs: [] }; },
      },
      { intervalMs: 100, batchThreshold: 5, autoSubmit: false },
    );

    await loop.tick();
    assert.equal(flushed, true, 'flushBatch should have been called');
    const state = loop.inspect();
    assert.equal(state.batchesTriggered, 1);
    assert.equal(state.tickCount, 1);
    assert.ok(state.lastBatchAt !== null);
  });

  it('does NOT trigger batch when receipt count < threshold', async () => {
    let flushed = false;
    const loop = new AutoLoop(
      {
        getReceiptCount: () => 3,
        flushBatch: () => { flushed = true; return null; },
      },
      { intervalMs: 100, batchThreshold: 5, autoSubmit: false },
    );

    await loop.tick();
    assert.equal(flushed, false, 'flushBatch should NOT have been called');
    const state = loop.inspect();
    assert.equal(state.batchesTriggered, 0);
    assert.equal(state.tickCount, 1);
  });

  it('emits batch_triggered event', async () => {
    let eventFired = false;
    const loop = new AutoLoop(
      {
        getReceiptCount: () => 10,
        flushBatch: () => ({ header: { root: 'r1' }, proofs: [] }),
      },
      { intervalMs: 100, batchThreshold: 5, autoSubmit: false },
    );
    loop.on('batch_triggered', () => { eventFired = true; });
    await loop.tick();
    assert.equal(eventFired, true);
  });
});

describe('S4.3 — AutoLoop Auto-Submit', () => {
  it('auto-submits when autoSubmit=true and batch is produced', async () => {
    let submitted = false;
    const loop = new AutoLoop(
      {
        getReceiptCount: () => 10,
        flushBatch: () => ({ header: { root: 'r1' }, proofs: [] }),
        submitOnChain: async () => { submitted = true; return '0xabc'; },
      },
      { intervalMs: 100, batchThreshold: 5, autoSubmit: true },
    );

    await loop.tick();
    assert.equal(submitted, true);
    const state = loop.inspect();
    assert.equal(state.submitsInitiated, 1);
    assert.equal(state.submitsCompleted, 1);
  });

  it('emits submit_completed event with txHash', async () => {
    let receivedHash: string | null = null;
    const loop = new AutoLoop(
      {
        getReceiptCount: () => 10,
        flushBatch: () => ({ header: { root: 'r1' }, proofs: [] }),
        submitOnChain: async () => '0xdeadbeef',
      },
      { intervalMs: 100, batchThreshold: 5, autoSubmit: true },
    );
    loop.on('submit_completed', (hash: string) => { receivedHash = hash; });
    await loop.tick();
    assert.equal(receivedHash, '0xdeadbeef');
  });

  it('emits submit_failed event on submission error', async () => {
    let failMsg: string | null = null;
    const loop = new AutoLoop(
      {
        getReceiptCount: () => 10,
        flushBatch: () => ({ header: { root: 'r1' }, proofs: [] }),
        submitOnChain: async () => { throw new Error('rpc timeout'); },
      },
      { intervalMs: 100, batchThreshold: 5, autoSubmit: true },
    );
    loop.on('submit_failed', (msg: string) => { failMsg = msg; });
    await loop.tick();
    assert.equal(failMsg, 'rpc timeout');
    const state = loop.inspect();
    assert.equal(state.submitsFailed, 1);
  });

  it('does not attempt submit when autoSubmit=false', async () => {
    let submitted = false;
    const loop = new AutoLoop(
      {
        getReceiptCount: () => 10,
        flushBatch: () => ({ header: { root: 'r1' }, proofs: [] }),
        submitOnChain: async () => { submitted = true; return '0x123'; },
      },
      { intervalMs: 100, batchThreshold: 5, autoSubmit: false },
    );
    await loop.tick();
    assert.equal(submitted, false);
    const state = loop.inspect();
    assert.equal(state.submitsInitiated, 0);
  });
});
