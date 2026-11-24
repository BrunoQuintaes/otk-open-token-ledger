/**
 * DurableProofQueue — Persistence-backed proof job queue (PA-01)
 *
 * Drop-in replacement for ProofQueue that adds:
 *   - Optional JSONL persistence (OTK_PROOF_QUEUE_LOG env)
 *   - Startup replay: pending/processing jobs restored as pending
 *   - Retry with exponential backoff (PROVER_MAX_ATTEMPTS, default 3)
 *   - Dead-letter after all attempts exhausted
 *
 * When logPath is null/empty: in-memory only (retry/DLQ logic still active,
 * no file I/O — backward-compatible with old ProofQueue behaviour).
 *
 * State machine:
 *   enqueue → pending
 *   dequeue → processing
 *   complete → done                (terminal)
 *   fail (attempts < max) → pending (retry, backoff applied)
 *   fail (attempts >= max) → dead_letter (terminal)
 *
 * JSONL format: each line = full job snapshot at that moment.
 * On startup: last snapshot per jobId wins; pending/processing → pending.
 *
 * Future migration: replace with BullMQ adapter (ENT-03) without changing
 * ProverDaemon call sites.
 *
 * @module prover/DurableProofQueue
 * @since PA-01 (2026-03-12)
 */

import { appendFileSync, readFileSync, existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import type { ProofInput, ProofResult } from './ProofQueue.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DurableJobStatus = 'pending' | 'processing' | 'done' | 'dead_letter';

export interface DurableProofJob {
  id: string;
  status: DurableJobStatus;
  input: ProofInput;
  result?: ProofResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** Total proof attempts made. Starts at 0; incremented on each fail(). */
  attempts: number;
  /** Unix ms: do not dequeue before this timestamp (backoff window). */
  nextRetryAt?: number;
  /** PA-03: on-chain tx hash after successful ReceiptRegistry.submitReceipt(). */
  txHash?: string;
}

export interface DurableQueueStats {
  total: number;
  pending: number;
  processing: number;
  done: number;
  failed: number;        // always 0 — kept for API compatibility with ProofQueue.stats()
  dead_letter: number;
}

// ---------------------------------------------------------------------------
// DurableProofQueue
// ---------------------------------------------------------------------------

export class DurableProofQueue {
  private readonly _jobs = new Map<string, DurableProofJob>();
  /** IDs of jobs eligible for dequeue (pending, in insertion order). */
  private readonly _pendingIds: string[] = [];
  private readonly _logPath: string | null;
  private readonly _maxAttempts: number;
  private readonly _baseBackoffMs: number;

  /**
   * @param logPath  Absolute path for JSONL checkpoint file.
   *                 Pass null/empty to run in-memory (no file I/O).
   * @param opts     maxAttempts (default 3), baseBackoffMs (default 1000)
   */
  constructor(
    logPath: string | null | undefined,
    opts?: { maxAttempts?: number; baseBackoffMs?: number },
  ) {
    this._logPath = logPath || null;
    this._maxAttempts = opts?.maxAttempts ?? 3;
    this._baseBackoffMs = opts?.baseBackoffMs ?? 1000;
    if (this._logPath) {
      this._restore();
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  enqueue(input: ProofInput): string {
    const id = randomBytes(8).toString('hex');
    const now = Date.now();
    const job: DurableProofJob = {
      id,
      status: 'pending',
      input,
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };
    this._jobs.set(id, job);
    this._pendingIds.push(id);
    this._append(job);
    return id;
  }

  /**
   * Return the next pending job that is past its backoff window, or null.
   * Sets the returned job to 'processing'.
   */
  dequeue(): DurableProofJob | null {
    const now = Date.now();
    for (let i = 0; i < this._pendingIds.length; i++) {
      const id = this._pendingIds[i]!;
      const job = this._jobs.get(id);

      // Clean up stale references
      if (!job || job.status !== 'pending') {
        this._pendingIds.splice(i, 1);
        i--;
        continue;
      }

      // Still in backoff window — skip, leave in pending list
      if (job.nextRetryAt && job.nextRetryAt > now) {
        continue;
      }

      // Ready to process
      this._pendingIds.splice(i, 1);
      job.status = 'processing';
      job.updatedAt = now;
      this._append(job);
      return job;
    }
    return null;
  }

  /**
   * PA-04: Persist txHash immediately after on-chain submission, before marking done.
   *
   * Reduces the nonce-gap inconsistency window: if the daemon crashes between
   * submitProofOnChain() and complete(), the txHash is already in the JSONL.
   * On next restart, _restore() detects processing+txHash and promotes the job
   * to done without re-enqueuing — avoiding a CommitmentAlreadyUsed resubmit.
   *
   * Job stays in 'processing' state; a subsequent complete() is still required.
   *
   * @param id     Job id (must exist; typically in processing state)
   * @param txHash Transaction hash returned by submitProofOnChain()
   */
  markSubmitted(id: string, txHash: string): void {
    const job = this._jobs.get(id);
    if (!job) throw new Error(`DurableProofQueue: job ${id} not found`);
    job.txHash = txHash;
    job.updatedAt = Date.now();
    this._append(job);
  }

  /**
   * Mark a job as done with its proof result.
   * @param txHash PA-03: optional on-chain tx hash from ReceiptRegistry.submitReceipt().
   *   When provided, the job is considered fully proved on-chain.
   *   When absent (dev mode / chain not configured), proof is generated but not on-chain.
   */
  complete(id: string, result: ProofResult, txHash?: string): void {
    const job = this._jobs.get(id);
    if (!job) throw new Error(`DurableProofQueue: job ${id} not found`);
    job.status = 'done';
    job.result = result;
    if (txHash) job.txHash = txHash;
    job.updatedAt = Date.now();
    this._append(job);
  }

  /**
   * Mark a job as failed.
   * If attempts < maxAttempts: re-enqueue as pending with exponential backoff.
   * If attempts >= maxAttempts: move to dead_letter (terminal).
   */
  fail(id: string, error: string): void {
    const job = this._jobs.get(id);
    if (!job) throw new Error(`DurableProofQueue: job ${id} not found`);
    job.attempts++;
    job.error = error;
    job.updatedAt = Date.now();

    if (job.attempts >= this._maxAttempts) {
      // Dead-letter: no more retries
      job.status = 'dead_letter';
      process.stderr.write(
        `[DurableProofQueue] Job ${id} dead-lettered after ${job.attempts} attempt(s): ${error}\n`,
      );
    } else {
      // Retry with exponential backoff: 2^attempts * baseBackoffMs
      const backoffMs = Math.pow(2, job.attempts) * this._baseBackoffMs;
      job.status = 'pending';
      job.nextRetryAt = Date.now() + backoffMs;
      this._pendingIds.push(id);
      process.stderr.write(
        `[DurableProofQueue] Job ${id} will retry (attempt ${job.attempts}/${this._maxAttempts}) in ${backoffMs}ms\n`,
      );
    }
    this._append(job);
  }

  get(id: string): DurableProofJob | undefined {
    return this._jobs.get(id);
  }

  /** Number of jobs in pending state (including those in backoff). */
  size(): number {
    return this._pendingIds.filter(id => {
      const job = this._jobs.get(id);
      return job?.status === 'pending';
    }).length;
  }

  stats(): DurableQueueStats {
    let pending = 0, processing = 0, done = 0, dead_letter = 0;
    for (const job of this._jobs.values()) {
      if (job.status === 'pending') pending++;
      else if (job.status === 'processing') processing++;
      else if (job.status === 'done') done++;
      else if (job.status === 'dead_letter') dead_letter++;
    }
    return {
      total: this._jobs.size,
      pending,
      processing,
      done,
      failed: 0, // no terminal 'failed' state — kept for API compatibility
      dead_letter,
    };
  }

  // -------------------------------------------------------------------------
  // Persistence (private)
  // -------------------------------------------------------------------------

  /** Append full job snapshot to JSONL. No-op when no logPath. */
  private _append(job: DurableProofJob): void {
    if (!this._logPath) return;
    try {
      appendFileSync(this._logPath, JSON.stringify(job) + '\n', 'utf-8');
    } catch { /* non-critical: job is in-memory */ }
  }

  /**
   * Restore queue state from JSONL on startup.
   *
   * Each line is a full job snapshot; last snapshot per id wins.
   * Jobs with status pending/processing are restored as pending (crash recovery).
   * Terminal jobs (done, dead_letter) are kept in the map but not re-enqueued.
   */
  private _restore(): void {
    if (!this._logPath || !existsSync(this._logPath)) return;
    try {
      const lines = readFileSync(this._logPath, 'utf-8').split('\n').filter(Boolean);

      // Build latest state per jobId
      const latest = new Map<string, DurableProofJob>();
      for (const line of lines) {
        try {
          const job = JSON.parse(line) as DurableProofJob;
          if (typeof job.id === 'string' && job.id.length > 0) {
            latest.set(job.id, job);
          }
        } catch { /* skip malformed lines */ }
      }

      // Rebuild in-memory state
      const toRequeue: DurableProofJob[] = [];
      for (const job of latest.values()) {
        this._jobs.set(job.id, job);
        if (job.status === 'pending' || job.status === 'processing') {
          if (job.status === 'processing' && job.txHash) {
            // PA-04: txHash present → submitProofOnChain() already completed on-chain.
            // Promote to done without re-enqueuing to avoid CommitmentAlreadyUsed.
            job.status = 'done';
            job.updatedAt = Date.now();
            this._append(job);
            process.stderr.write(
              `[DurableProofQueue] Startup: job ${job.id} promoted done (txHash=${job.txHash})\n`,
            );
          } else {
            // No txHash → crash before or during submission; safe to retry.
            job.status = 'pending';
            toRequeue.push(job);
          }
        }
      }

      // Sort by createdAt to preserve approximate enqueue order
      toRequeue.sort((a, b) => a.createdAt - b.createdAt);
      for (const job of toRequeue) {
        this._pendingIds.push(job.id);
        this._append(job); // persist the status reset
      }

      if (toRequeue.length > 0) {
        process.stderr.write(
          `[DurableProofQueue] Startup: restored ${toRequeue.length} pending job(s) from ${this._logPath}\n`,
        );
      }
    } catch {
      process.stderr.write(
        `[DurableProofQueue] Warning: could not restore from ${this._logPath}\n`,
      );
    }
  }
}
