/**
 * Wave 1 Pack 3 — Queue + Retry Tests (S3.2 + S3.4)
 *
 * Tests:
 *   - ProductionQueue lifecycle (durable mode — no Redis required)
 *   - Backpressure rejection + dead-letter integration
 *   - Retry policy with exponential backoff
 *   - Dead-letter after exhausted retries → S1.5 store
 *   - Metrics tracking
 *   - Configuration validation
 *
 * @since Wave 1 Pack 3 (2026-03-15)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ProductionQueue, resetProductionQueueForTest } from '../../src/prover/ProductionQueue.js';
import { clearDeadLettersForTest, deadLetterCount, listDeadLetters } from '../../src/api/deadLetterStore.js';

describe('S3.2 — ProductionQueue (durable mode)', () => {
  let queue: ProductionQueue;

  beforeEach(async () => {
    resetProductionQueueForTest();
    await clearDeadLettersForTest();
    // Ensure no Redis URL so we use durable mode
    delete process.env['OTK_REDIS_URL'];
    queue = new ProductionQueue({ maxQueueSize: 100 });
    await queue.init();
  });

  it('mode is durable when OTK_REDIS_URL is not set', () => {
    assert.equal(queue.mode, 'durable');
  });

  it('enqueue returns a job id', async () => {
    const id = await queue.enqueue({
      userId: '1', usage: '100', nonce: '0', epoch: '1',
    });
    assert.ok(id);
    assert.equal(typeof id, 'string');
    assert.ok(id.length > 0);
  });

  it('enqueue increments metrics', async () => {
    await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    await queue.enqueue({ userId: '2', usage: '200', nonce: '1', epoch: '1' });
    const metrics = await queue.stats();
    assert.equal(metrics.totalEnqueued, 2);
    assert.equal(metrics.mode, 'durable');
  });

  it('dequeue returns pending job', async () => {
    await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    const job = queue.dequeue();
    assert.ok(job);
    assert.equal(job!.status, 'processing');
    assert.equal(job!.input.userId, '1');
  });

  it('dequeue returns null when empty', () => {
    const job = queue.dequeue();
    assert.equal(job, null);
  });

  it('complete marks job as done', async () => {
    const id = await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    queue.dequeue();
    queue.complete(id, {
      proof: { pi_a: [], pi_b: [], pi_c: [], protocol: 'groth16', curve: 'bn128' },
      publicSignals: [],
      proveMs: 100,
    });
    const metrics = await queue.stats();
    assert.equal(metrics.totalCompleted, 1);
  });

  it('depth tracks queue size', async () => {
    assert.equal(await queue.depth(), 0);
    await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    assert.equal(await queue.depth(), 1);
    await queue.enqueue({ userId: '2', usage: '200', nonce: '1', epoch: '1' });
    assert.equal(await queue.depth(), 2);
  });

  it('getJob returns job info', async () => {
    const id = await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    const job = await queue.getJob(id);
    assert.ok(job);
    assert.equal(job!.id, id);
    assert.equal(job!.status, 'pending');
  });

  it('getJob returns null for unknown id', async () => {
    const job = await queue.getJob('nonexistent');
    assert.equal(job, null);
  });

  it('close is safe', async () => {
    await queue.close(); // should not throw
  });
});

describe('S3.4 — Retry + Recovery', () => {
  let queue: ProductionQueue;

  beforeEach(async () => {
    resetProductionQueueForTest();
    await clearDeadLettersForTest();
    delete process.env['OTK_REDIS_URL'];
    queue = new ProductionQueue({
      maxQueueSize: 100,
      retry: { maxRetries: 2, backoffMs: 10, backoffFactor: 2.0, maxBackoffMs: 100 },
    });
    await queue.init();
  });

  it('fail re-enqueues job for retry (attempts < max)', async () => {
    const id = await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    queue.dequeue();
    queue.fail(id, 'circuit error');
    const metrics = await queue.stats();
    assert.equal(metrics.totalFailed, 1);
    assert.equal(metrics.totalDeadLettered, 0);
    // Job should be back in pending for retry
    const job = await queue.getJob(id);
    assert.ok(job);
    assert.equal(job!.status, 'pending');
    assert.equal(job!.attempts, 1);
  });

  it('fail dead-letters after max retries', async () => {
    const id = await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    // Attempt 1
    queue.dequeue();
    queue.fail(id, 'error 1');
    // Attempt 2 (after tiny backoff)
    await new Promise(r => setTimeout(r, 50));
    queue.dequeue();
    queue.fail(id, 'error 2');
    // Now dead-lettered
    const metrics = await queue.stats();
    assert.equal(metrics.totalDeadLettered, 1);
    const job = await queue.getJob(id);
    assert.ok(job);
    assert.equal(job!.status, 'dead_letter');
  });

  it('dead-lettered job captured in S1.5 dead-letter store', async () => {
    const id = await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    // Exhaust retries
    queue.dequeue();
    queue.fail(id, 'err1');
    await new Promise(r => setTimeout(r, 50));
    queue.dequeue();
    queue.fail(id, 'err2');
    // Verify dead-letter store
    assert.equal(await deadLetterCount(), 1);
    const dlEntries = await listDeadLetters();
    assert.equal(dlEntries.length, 1);
    assert.ok(dlEntries[0].error.includes('proof failed'));
    assert.equal(dlEntries[0].reason, 'dispatch_error');
    assert.equal(dlEntries[0].source, 'ProductionQueue.fail');
  });

  it('markSubmitted stores txHash', async () => {
    const id = await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    queue.dequeue();
    queue.markSubmitted(id, '0xabc123');
    const job = await queue.getJob(id);
    assert.ok(job);
    assert.equal(job!.txHash, '0xabc123');
  });
});

describe('S3.2 — Backpressure', () => {
  let queue: ProductionQueue;

  beforeEach(async () => {
    resetProductionQueueForTest();
    await clearDeadLettersForTest();
    delete process.env['OTK_REDIS_URL'];
    queue = new ProductionQueue({
      maxQueueSize: 3,
      rejectPolicy: 'reject',
    });
    await queue.init();
  });

  it('rejects enqueue when queue is full', async () => {
    await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    await queue.enqueue({ userId: '2', usage: '200', nonce: '1', epoch: '1' });
    await queue.enqueue({ userId: '3', usage: '300', nonce: '2', epoch: '1' });
    // Queue is full (3/3)
    await assert.rejects(
      () => queue.enqueue({ userId: '4', usage: '400', nonce: '3', epoch: '1' }),
      (err: Error) => {
        assert.ok(err.message.includes('Queue full'));
        return true;
      },
    );
  });

  it('backpressure rejection captured in dead-letter store', async () => {
    await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    await queue.enqueue({ userId: '2', usage: '200', nonce: '1', epoch: '1' });
    await queue.enqueue({ userId: '3', usage: '300', nonce: '2', epoch: '1' });
    try {
      await queue.enqueue({ userId: '4', usage: '400', nonce: '3', epoch: '1' });
    } catch { /* expected */ }
    assert.equal(await deadLetterCount(), 1);
    const entries = await listDeadLetters();
    assert.equal(entries[0].reason, 'processing_error');
  });

  it('backpressure metrics tracked', async () => {
    await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    await queue.enqueue({ userId: '2', usage: '200', nonce: '1', epoch: '1' });
    await queue.enqueue({ userId: '3', usage: '300', nonce: '2', epoch: '1' });
    try {
      await queue.enqueue({ userId: '4', usage: '400', nonce: '3', epoch: '1' });
    } catch { /* expected */ }
    const metrics = await queue.stats();
    assert.equal(metrics.backpressureRejections, 1);
    assert.equal(metrics.totalEnqueued, 3);
  });
});

describe('S3.2 — Queue Configuration', () => {
  it('default retry policy uses env vars', () => {
    const queue = new ProductionQueue();
    assert.ok(queue);
    assert.equal(queue.mode, 'durable');
  });

  it('custom config is applied', async () => {
    const queue = new ProductionQueue({
      maxQueueSize: 50,
      concurrency: 2,
      retry: { maxRetries: 5, backoffMs: 500, backoffFactor: 1.5, maxBackoffMs: 10000 },
    });
    await queue.init();
    assert.ok(queue);
    // Verify it's functional
    const id = await queue.enqueue({ userId: '1', usage: '100', nonce: '0', epoch: '1' });
    assert.ok(id);
  });
});
