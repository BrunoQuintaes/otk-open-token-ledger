/**
 * PA-04 — Restart Hardening / Nonce Gap Recovery Tests
 *
 * Covers the gap identified in PA-03 closeout: if ProverDaemon crashes between
 * submitProofOnChain() returning and queue.complete() being called, the job
 * stays as 'processing' in JSONL. On restart, the queue must correctly
 * distinguish:
 *   (a) processing WITHOUT txHash → crash before submit → safe to retry
 *   (b) processing WITH txHash    → crash after submit  → promote to done, no re-submit
 *
 * Also covers markSubmitted() semantics and end-to-end happy-path preservation.
 *
 * @since PA-04 (2026-03-13)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFileSync } from 'node:fs';
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
  userId: '99',
  usage: '200',
  nonce: '3',
  epoch: '99999',
  circuitVersion: 'v2' as const,
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
  publicSignals: ['abc', '99999', '1000000'],
  proveMs: 300,
};

const TX_HASH = '0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';

// ---------------------------------------------------------------------------
// Setup/teardown
// ---------------------------------------------------------------------------

let tmpDir = '';

before(async () => {
  tmpDir = await mkdtempAsync(path.join(tmpdir(), 'otk-pa04-test-'));
});

after(async () => {
  await rmAsync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Suite: markSubmitted()
// ---------------------------------------------------------------------------

describe('PA-04 — markSubmitted()', () => {

  it('persists txHash and keeps status=processing', () => {
    const logPath = path.join(tmpDir, 'mark-submitted.jsonl');
    const q = new DurableProofQueue(logPath);
    const id = q.enqueue(PROOF_INPUT);
    q.dequeue(); // → processing

    q.markSubmitted(id, TX_HASH);

    const job = q.get(id);
    assert.ok(job, 'job must exist');
    assert.equal(job.status, 'processing', 'status stays processing');
    assert.equal(job.txHash, TX_HASH, 'txHash persisted in-memory');

    // Verify JSONL snapshot was appended with txHash
    const lines = readFileSync(logPath, 'utf-8').split('\n').filter(Boolean);
    // pending + processing (dequeue) + processing+txHash (markSubmitted) = 3 lines
    assert.ok(lines.length >= 3, `expected ≥3 JSONL lines, got ${lines.length}`);
    const lastLine = JSON.parse(lines[lines.length - 1]!) as { txHash?: string; status: string };
    assert.equal(lastLine.txHash, TX_HASH, 'JSONL last snapshot has txHash');
    assert.equal(lastLine.status, 'processing', 'JSONL last snapshot status=processing');
  });

  it('throws when job id not found', () => {
    const q = new DurableProofQueue(null);
    assert.throws(
      () => q.markSubmitted('nonexistent-id', TX_HASH),
      /job nonexistent-id not found/,
    );
  });
});

// ---------------------------------------------------------------------------
// Suite: _restore() — nonce gap recovery
// ---------------------------------------------------------------------------

describe('PA-04 — _restore() nonce gap recovery', () => {

  it('processing WITHOUT txHash → restored as pending, re-enqueued', () => {
    const logPath = path.join(tmpDir, 'restore-no-txhash.jsonl');
    const q1 = new DurableProofQueue(logPath);
    const id = q1.enqueue(PROOF_INPUT);
    q1.dequeue(); // → processing, no txHash, then "crash"

    // Restart: last JSONL snapshot has status=processing, txHash absent
    const q2 = new DurableProofQueue(logPath);
    const job = q2.get(id);
    assert.ok(job, 'job must be restored');
    assert.equal(job.status, 'pending', 'processing without txHash → pending');
    assert.equal(q2.size(), 1, 'job is re-enqueued in _pendingIds');
    assert.ok(q2.dequeue() !== null, 'dequeue returns the restored job');
  });

  it('processing WITH txHash → promoted to done, NOT re-enqueued', () => {
    const logPath = path.join(tmpDir, 'restore-with-txhash.jsonl');
    const q1 = new DurableProofQueue(logPath);
    const id = q1.enqueue(PROOF_INPUT);
    q1.dequeue(); // → processing
    q1.markSubmitted(id, TX_HASH); // → processing+txHash (submit done, then "crash")

    // Restart: last JSONL snapshot has status=processing, txHash present
    const q2 = new DurableProofQueue(logPath);
    const job = q2.get(id);
    assert.ok(job, 'job must be restored');
    assert.equal(job.status, 'done', 'processing+txHash → promoted to done');
    assert.equal(job.txHash, TX_HASH, 'txHash preserved after promotion');
    assert.equal(q2.size(), 0, 'promoted job NOT in pending queue');
    assert.equal(q2.dequeue(), null, 'nothing to dequeue (no orphan re-submit)');
  });

  it('done jobs are NOT re-enqueued on restart (regression guard)', () => {
    const logPath = path.join(tmpDir, 'restore-done.jsonl');
    const q1 = new DurableProofQueue(logPath);
    const id = q1.enqueue(PROOF_INPUT);
    q1.dequeue();
    q1.markSubmitted(id, TX_HASH);
    q1.complete(id, PROOF_RESULT, TX_HASH);

    const q2 = new DurableProofQueue(logPath);
    const job = q2.get(id);
    assert.equal(job?.status, 'done', 'done status preserved');
    assert.equal(q2.size(), 0, 'done job not re-enqueued');
  });

  it('dead_letter jobs are NOT re-enqueued on restart (regression guard)', () => {
    const logPath = path.join(tmpDir, 'restore-dlq.jsonl');
    const q1 = new DurableProofQueue(logPath, { maxAttempts: 1, baseBackoffMs: 1 });
    const id = q1.enqueue(PROOF_INPUT);
    q1.dequeue();
    q1.fail(id, 'fatal-submit-error'); // maxAttempts=1 → dead_letter immediately

    const q2 = new DurableProofQueue(logPath, { maxAttempts: 1, baseBackoffMs: 1 });
    assert.equal(q2.size(), 0, 'dead_letter not re-enqueued');
    assert.equal(q2.get(id)?.status, 'dead_letter');
  });
});

// ---------------------------------------------------------------------------
// Suite: happy-path regression
// ---------------------------------------------------------------------------

describe('PA-04 — happy path regression', () => {

  it('markSubmitted + complete → done with txHash (normal flow)', () => {
    const logPath = path.join(tmpDir, 'happy-path.jsonl');
    const q = new DurableProofQueue(logPath);
    const id = q.enqueue(PROOF_INPUT);
    q.dequeue();
    q.markSubmitted(id, TX_HASH);   // PA-04: persist before complete
    q.complete(id, PROOF_RESULT, TX_HASH);

    const job = q.get(id);
    assert.ok(job);
    assert.equal(job.status, 'done');
    assert.equal(job.txHash, TX_HASH);
    assert.deepEqual(job.result, PROOF_RESULT);
    assert.equal(q.size(), 0);
  });

  it('complete without markSubmitted still works (no-chain dev mode)', () => {
    const q = new DurableProofQueue(null);
    const id = q.enqueue(PROOF_INPUT);
    q.dequeue();
    q.complete(id, PROOF_RESULT); // no txHash — dev mode

    const job = q.get(id);
    assert.ok(job);
    assert.equal(job.status, 'done');
    assert.equal(job.txHash, undefined);
  });

  it('fail without txHash still sends job to dead_letter correctly', () => {
    const q = new DurableProofQueue(null, { maxAttempts: 1, baseBackoffMs: 1 });
    const id = q.enqueue(PROOF_INPUT);
    q.dequeue();
    q.fail(id, 'CommitmentAlreadyUsed'); // unexpected: tx exists but queue has no txHash

    const job = q.get(id);
    assert.equal(job?.status, 'dead_letter');
    assert.equal(q.size(), 0);
  });
});
