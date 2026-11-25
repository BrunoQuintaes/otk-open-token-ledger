/**
 * DurableProofQueue — Unit Tests (PA-01)
 *
 * Covers:
 *   - in-memory mode (no logPath): enqueue/dequeue/complete/fail/retry/DLQ
 *   - persistence mode (logPath): JSONL written on each state change
 *   - startup restore: pending/processing jobs recovered; done/DLQ not re-enqueued
 *   - retry backoff: jobs with nextRetryAt in future skipped by dequeue
 *   - dead-letter: job after MAX_ATTEMPTS attempts goes terminal
 *
 * Module under test: `src/prover/DurableProofQueue.ts` (the proof job queue that survives a
 * restart).
 *
 * Strategy / partitions: job states pending, processing, done, retry and dead letter; a failure
 * below and at the attempt limit; dequeue inside the backoff window (skipped) and after it (the
 * retry time is set into the past by hand, so no real waiting); counts per state; with a log
 * file: one line per change, restart restoring pending and processing jobs, not restoring done or
 * dead-letter jobs, keeping the retry time, and skipping malformed lines.
 *
 * Needs: the local file system for the persistent block (a temporary directory removed in its
 * `after` hook). No prover, network or database.
 *
 * Run just this file: `npx tsx --test test/unit/durable_proof_queue.test.ts`
 *
 * @since PA-01 (2026-03-12)
 * @module test/unit/durable_proof_queue.test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DurableProofQueue } from '../../src/prover/DurableProofQueue.js';
import type { ProofResult } from '../../src/prover/ProofQueue.js';

const mkdtempAsync = promisify(mkdtemp);
const rmAsync = promisify(rm);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROOF_INPUT = {
  userId: '42',
  usage: '100',
  nonce: '7',
  epoch: '12345',
  circuitVersion: 'v1' as const,
  maxUsage: '1000000',
};

const PROOF_RESULT: ProofResult = {
  proof: {
    pi_a: ['1', '2', '0'],
    pi_b: [['3', '4'], ['5', '6'], ['1', '0']],
    pi_c: ['7', '8', '1'],
    protocol: 'groth16',
    curve: 'bn128',
  },
  publicSignals: ['123', '12345', '1000000'],
  proveMs: 450,
};

// ---------------------------------------------------------------------------
// Suite A — In-memory mode (no persistence)
// ---------------------------------------------------------------------------

describe('DurableProofQueue — in-memory (no logPath)', () => {

  it('enqueue creates job with status=pending and attempts=0', () => {
    const q = new DurableProofQueue(null);
    const id = q.enqueue(PROOF_INPUT);
    const job = q.get(id);
    assert.ok(job, 'job should exist');
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 0);
    assert.equal(job.id, id);
    assert.deepEqual(job.input, PROOF_INPUT);
    assert.ok(job.createdAt > 0);
    assert.equal(q.size(), 1);
  });

  it('dequeue returns job and marks it processing', () => {
    const q = new DurableProofQueue(null);
    const id = q.enqueue(PROOF_INPUT);
    const job = q.dequeue();
    assert.ok(job, 'should return a job');
    assert.equal(job.id, id);
    assert.equal(job.status, 'processing');
    assert.equal(q.size(), 0, 'pending count drops');
    assert.equal(q.dequeue(), null, 'no more jobs');
  });

  it('complete marks job done with result', () => {
    const q = new DurableProofQueue(null);
    const id = q.enqueue(PROOF_INPUT);
    q.dequeue();
    q.complete(id, PROOF_RESULT);
    const job = q.get(id);
    assert.ok(job);
    assert.equal(job.status, 'done');
    assert.deepEqual(job.result, PROOF_RESULT);
    assert.ok(job.updatedAt >= job.createdAt);
  });

  it('fail under maxAttempts re-enqueues as pending with nextRetryAt', () => {
    const q = new DurableProofQueue(null, { maxAttempts: 3, baseBackoffMs: 100 });
    const id = q.enqueue(PROOF_INPUT);
    q.dequeue();
    const before = Date.now();
    q.fail(id, 'WASM OOM');
    const job = q.get(id);
    assert.ok(job);
    assert.equal(job.status, 'pending');
    assert.equal(job.attempts, 1);
    assert.equal(job.error, 'WASM OOM');
    assert.ok(job.nextRetryAt !== undefined && job.nextRetryAt >= before + 100,
      `nextRetryAt should be ≥ now + 200ms (2^1 * 100ms), got ${job.nextRetryAt}`);
    // Should be back in pending list
    assert.equal(q.size(), 1);
  });

  it('fail at maxAttempts marks job as dead_letter (terminal)', () => {
    const q = new DurableProofQueue(null, { maxAttempts: 2, baseBackoffMs: 1 });
    const id = q.enqueue(PROOF_INPUT);

    // Attempt 1
    q.dequeue();
    q.fail(id, 'error-1');
    let job = q.get(id);
    assert.equal(job?.status, 'pending', 'should retry after attempt 1');
    assert.equal(job?.attempts, 1);

    // Attempt 2 — force past backoff by setting nextRetryAt to past
    const j = q.get(id)!;
    j.nextRetryAt = Date.now() - 1;
    q.dequeue();
    q.fail(id, 'error-2');

    job = q.get(id);
    assert.equal(job?.status, 'dead_letter', 'should be dead_letter after attempt 2');
    assert.equal(job?.attempts, 2);
    assert.equal(q.size(), 0, 'dead_letter job not in pending queue');
    assert.equal(q.dequeue(), null, 'nothing to dequeue');
  });

  it('dequeue respects nextRetryAt backoff window', () => {
    const q = new DurableProofQueue(null, { maxAttempts: 3, baseBackoffMs: 60_000 });
    const id = q.enqueue(PROOF_INPUT);
    q.dequeue();
    q.fail(id, 'err');  // nextRetryAt = now + 120_000ms (2^1 * 60_000)

    // dequeue should return null — job is in backoff
    const result = q.dequeue();
    assert.equal(result, null, 'should skip job in backoff window');
    assert.equal(q.size(), 1, 'job still in pending list (backoff)');
  });

  it('dequeue returns job once backoff expires', () => {
    const q = new DurableProofQueue(null, { maxAttempts: 3, baseBackoffMs: 1 });
    const id = q.enqueue(PROOF_INPUT);
    q.dequeue();
    q.fail(id, 'err');  // nextRetryAt = now + 2ms

    // Manually expire the backoff
    const job = q.get(id)!;
    job.nextRetryAt = Date.now() - 1;

    const retrieved = q.dequeue();
    assert.ok(retrieved, 'should dequeue after backoff expires');
    assert.equal(retrieved.id, id);
    assert.equal(retrieved.status, 'processing');
  });

  it('stats returns correct counts including dead_letter', () => {
    const q = new DurableProofQueue(null, { maxAttempts: 1, baseBackoffMs: 1 });
    const id1 = q.enqueue(PROOF_INPUT);
    const id2 = q.enqueue(PROOF_INPUT);

    // id1 → done
    q.dequeue();
    q.complete(id1, PROOF_RESULT);

    // id2 → dead_letter (maxAttempts=1, one fail = dead)
    q.dequeue();
    q.fail(id2, 'fatal');

    const s = q.stats();
    assert.equal(s.total, 2);
    assert.equal(s.pending, 0);
    assert.equal(s.done, 1);
    assert.equal(s.dead_letter, 1);
    assert.equal(s.failed, 0, 'failed is always 0 (compatibility field)');
  });
});

// ---------------------------------------------------------------------------
// Suite B — Persistent mode (JSONL file)
// ---------------------------------------------------------------------------

describe('DurableProofQueue — persistent (JSONL)', () => {
  let tmpDir = '';
  let logPath = '';

  before(async () => {
    tmpDir = await mkdtempAsync(path.join(tmpdir(), 'otk-dpq-test-'));
    logPath = path.join(tmpDir, 'proof-queue.jsonl');
  });

  after(async () => {
    await rmAsync(tmpDir, { recursive: true, force: true });
  });

  it('enqueue writes a line to the JSONL file', () => {
    const q = new DurableProofQueue(logPath);
    const id = q.enqueue(PROOF_INPUT);
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]!) as { id: string; status: string };
    assert.equal(parsed.id, id);
    assert.equal(parsed.status, 'pending');
  });

  it('startup restores pending jobs from JSONL', () => {
    const freshLog = path.join(tmpDir, 'restore-test.jsonl');
    // Queue 1: enqueue two jobs, do not complete
    const q1 = new DurableProofQueue(freshLog);
    const id1 = q1.enqueue(PROOF_INPUT);
    const id2 = q1.enqueue(PROOF_INPUT);

    // Queue 2: simulates restart — reads same file
    const q2 = new DurableProofQueue(freshLog);
    assert.equal(q2.size(), 2, 'both jobs restored as pending');

    const restored1 = q2.get(id1);
    const restored2 = q2.get(id2);
    assert.equal(restored1?.status, 'pending');
    assert.equal(restored2?.status, 'pending');
  });

  it('startup restores processing jobs as pending (crash recovery)', () => {
    const freshLog = path.join(tmpDir, 'crash-test.jsonl');
    const q1 = new DurableProofQueue(freshLog);
    const id = q1.enqueue(PROOF_INPUT);
    q1.dequeue(); // moves to processing — "crash" here

    // Restart
    const q2 = new DurableProofQueue(freshLog);
    const job = q2.get(id);
    assert.ok(job, 'job should be restored');
    assert.equal(job.status, 'pending', 'processing → pending on restart');
    assert.equal(q2.size(), 1);
  });

  it('done jobs are NOT re-enqueued on startup', () => {
    const freshLog = path.join(tmpDir, 'done-test.jsonl');
    const q1 = new DurableProofQueue(freshLog);
    const id = q1.enqueue(PROOF_INPUT);
    q1.dequeue();
    q1.complete(id, PROOF_RESULT);

    // Restart
    const q2 = new DurableProofQueue(freshLog);
    assert.equal(q2.size(), 0, 'done job not re-enqueued');
    const job = q2.get(id);
    assert.equal(job?.status, 'done', 'done job preserved in map');
  });

  it('dead_letter jobs are NOT re-enqueued on startup', () => {
    const freshLog = path.join(tmpDir, 'dlq-test.jsonl');
    const q1 = new DurableProofQueue(freshLog, { maxAttempts: 1, baseBackoffMs: 1 });
    const id = q1.enqueue(PROOF_INPUT);
    q1.dequeue();
    q1.fail(id, 'fatal error');  // maxAttempts=1 → immediately dead_letter

    // Restart
    const q2 = new DurableProofQueue(freshLog, { maxAttempts: 1, baseBackoffMs: 1 });
    assert.equal(q2.size(), 0, 'dead_letter job not re-enqueued');
    const job = q2.get(id);
    assert.equal(job?.status, 'dead_letter', 'dead_letter preserved');
    assert.equal(job?.attempts, 1);
  });

  it('retry state (nextRetryAt) is preserved across restart', () => {
    const freshLog = path.join(tmpDir, 'retry-state.jsonl');
    const q1 = new DurableProofQueue(freshLog, { maxAttempts: 3, baseBackoffMs: 60_000 });
    const id = q1.enqueue(PROOF_INPUT);
    q1.dequeue();
    q1.fail(id, 'transient');  // pending with nextRetryAt far in future

    const jobBefore = q1.get(id)!;
    const retryAtBefore = jobBefore.nextRetryAt;

    // Restart
    const q2 = new DurableProofQueue(freshLog, { maxAttempts: 3, baseBackoffMs: 60_000 });
    const jobAfter = q2.get(id);
    assert.ok(jobAfter, 'job restored');
    assert.equal(jobAfter.status, 'pending');
    assert.equal(jobAfter.attempts, 1);
    assert.equal(jobAfter.nextRetryAt, retryAtBefore, 'nextRetryAt preserved');
    // dequeue should skip it (still in backoff)
    assert.equal(q2.dequeue(), null, 'still in backoff after restart');
  });

  it('malformed JSONL lines are skipped without throwing', () => {
    const freshLog = path.join(tmpDir, 'malformed.jsonl');
    // Write malformed content
    appendFileSync(freshLog, 'not json\n{"id":"abc","status":"pending","input":{},"attempts":0,"createdAt":1,"updatedAt":1}\n{broken\n');

    // Should not throw — just skips malformed lines
    assert.doesNotThrow(() => new DurableProofQueue(freshLog));
  });
});
