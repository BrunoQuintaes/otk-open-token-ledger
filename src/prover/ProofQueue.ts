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
 * Also the home of the shared proof types ({@link ProofInput}, {@link ProofResult}) imported by the other
 * prover queues and the client. Nothing is persisted: jobs are lost on restart.
 *
 * @module src/prover/ProofQueue
 * @since U13 (2026-02-22)
 */

import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lifecycle state of an in-memory proof job. */
export type JobStatus = 'pending' | 'processing' | 'done' | 'failed';

/** Circuit inputs of one legacy (v1/v2) proof, as decimal strings. Contains private values: never log it. */
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

/** A Groth16 proof in snarkjs JSON form, with its public signals and timing. */
export interface ProofResult {
  proof: {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  };
  publicSignals: string[];
  /** Proving time, ms. */
  proveMs: number;
  /** Key file basename without .zkey extension (S5.2 — key pipeline) */
  keyVersion?: string;
  /** Circuit version used: 'v1' | 'v2' (S5.2) */
  circuitVersion?: string;
}

/** A job of {@link ProofQueue}; times are epoch ms. */
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

/** Minimal in-memory FIFO of proof jobs (no retry; see `DurableProofQueue.ts` for retries). */
export class ProofQueue {
  private readonly _jobs = new Map<string, ProofJob>();
  private readonly _pending: string[] = [];

  /**
   * Adds a pending job.
   *
   * @param input - Proof inputs.
   * @returns The new job id (16 hex characters).
   */
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

  /**
   * Takes the oldest pending job and marks it processing.
   *
   * @returns The job (mutated in place), or `null` when none is pending.
   */
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

  /**
   * Marks a job done.
   *
   * @param id - Job id.
   * @param result - Proof result.
   * @throws {Error} When the job id is unknown.
   */
  complete(id: string, result: ProofResult): void {
    const job = this._jobs.get(id);
    if (!job) throw new Error(`ProofQueue: job ${id} not found`);
    job.status = 'done';
    job.result = result;
    job.updatedAt = Date.now();
  }

  /**
   * Marks a job failed (terminal; no retry).
   *
   * @param id - Job id.
   * @param error - Failure message.
   * @throws {Error} When the job id is unknown.
   */
  fail(id: string, error: string): void {
    const job = this._jobs.get(id);
    if (!job) throw new Error(`ProofQueue: job ${id} not found`);
    job.status = 'failed';
    job.error = error;
    job.updatedAt = Date.now();
  }

  /**
   * Reads a job.
   *
   * @param id - Job id.
   * @returns The live job object, or `undefined`.
   */
  get(id: string): ProofJob | undefined {
    return this._jobs.get(id);
  }

  /**
   * Pending job count.
   *
   * @returns Number of queued ids not yet dequeued.
   */
  size(): number {
    return this._pending.length;
  }

  /**
   * Counts all jobs by state.
   *
   * @returns The counts.
   */
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
