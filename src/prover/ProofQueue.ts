/**
 * ProofQueue — In-memory FIFO queue for ZK proof generation requests.
 *
 * Each job has:
 *   - Unique ID (UUID-like hex)
 *   - Input for the circuit (private + public fields)
 *   - Status: pending → processing → done | failed
 *   - Result: proof + publicSignals (when done)
 *
 * Single-worker: processes one proof at a time (CPU-bound).
 * Thread-safe for single-process use (no race conditions without concurrency).
 *
 * @module ProofQueue
 * @since U13 (2026-02-22)
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type JobStatus = 'pending' | 'processing' | 'done' | 'failed';

export interface ProofInput {
  /** Private: userId (bigint-serialized as string) */
  userId: string;
  /** Private: usage (CU value) */
  usage: string;
  /** Private: anti-replay nonce */
  nonce: string;
  /** Public: epoch */
  epoch: string;
  /** v1: maxUsage (public limit) | v2: minUsageBucket (public lower bound) */
  minUsageBucket?: string;
  /** v1: maxUsage (public limit) | v2: maxUsageBucket (public upper bound) */
  maxUsageBucket?: string;
  /** v1 compat: maxUsage alias */
  maxUsage?: string;
  /** N15: registry address the job was created for (stamped by the daemon at enqueue) */
  targetRegistry?: string;
  /** Circuit version: 'v1' | 'v2' */
  circuitVersion?: 'v1' | 'v2';
}

export interface ProofResult {
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  };
  publicSignals: string[];
  proveMs: number;
  /** Key file basename without .zkey extension (S5.2 — key pipeline) */
  keyVersion?: string;
  /** Circuit version used: 'v1' | 'v2' (S5.2) */
  circuitVersion?: string;
}

export interface ProofJob {
  id: string;
  status: JobStatus;
  input: ProofInput;
  result?: ProofResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// ProofQueue
// ---------------------------------------------------------------------------

export class ProofQueue {
  private readonly _jobs = new Map<string, ProofJob>();
  private readonly _pending: string[] = [];

  enqueue(input: ProofInput): string {
    const id = randomBytes(8).toString('hex');
    const now = Date.now();
    const job: ProofJob = {
      id,
      status: 'pending',
      input,
      createdAt: now,
      updatedAt: now,
    };
    this._jobs.set(id, job);
    this._pending.push(id);
    return id;
  }

  dequeue(): ProofJob | null {
    while (this._pending.length > 0) {
      const id = this._pending.shift()!;
      const job = this._jobs.get(id);
      if (job && job.status === 'pending') {
        job.status = 'processing';
        job.updatedAt = Date.now();
        return job;
      }
    }
    return null;
  }

  complete(id: string, result: ProofResult): void {
    const job = this._jobs.get(id);
    if (!job) throw new Error(`ProofQueue: job ${id} not found`);
    job.status = 'done';
    job.result = result;
    job.updatedAt = Date.now();
  }

  fail(id: string, error: string): void {
    const job = this._jobs.get(id);
    if (!job) throw new Error(`ProofQueue: job ${id} not found`);
    job.status = 'failed';
    job.error = error;
    job.updatedAt = Date.now();
  }

  get(id: string): ProofJob | undefined {
    return this._jobs.get(id);
  }

  size(): number {
    return this._pending.length;
  }

  stats(): { total: number; pending: number; processing: number; done: number; failed: number } {
    let pending = 0, processing = 0, done = 0, failed = 0;
    for (const job of this._jobs.values()) {
      if (job.status === 'pending') pending++;
      else if (job.status === 'processing') processing++;
      else if (job.status === 'done') done++;
      else if (job.status === 'failed') failed++;
    }
    return { total: this._jobs.size, pending, processing, done, failed };
  }
}
