/**
 * PA-07A — BullMQ Proof Queue Adapter
 *
 * Wraps BullMQ Queue for use by ProverDaemon when OTK_REDIS_URL is set.
 * Handles the HTTP-facing side: enqueue, status, stats, size.
 * The BullMQ Worker (processing side) is started separately in ProverDaemon main().
 *
 * PA-04 equivalence: If the BullMQ Worker crashes between submitProofOnChain()
 * returning and returning the job result, BullMQ's stall detection will
 * re-enqueue the job after the lock expires. To avoid CommitmentAlreadyUsed,
 * the Worker stores txHash in job.updateData() so retries can detect it.
 *
 * @since PA-07 (2026-03-13)
 */

import { Queue, type Job } from 'bullmq';
import type { ProofInput, ProofResult } from './ProofQueue.js';

export interface BullMQJobStatus {
  jobId: string;
  status: 'pending' | 'processing' | 'done' | 'dead_letter' | 'not_found';
  attempts: number;
  result?: ProofResult;
  txHash?: string;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

export interface BullMQQueueStats {
  total: number;
  pending: number;
  done: number;
  dead_letter: number;
  failed: number; // compat field — always 0
}

/** Data shape stored in BullMQ job (ProofInput + optional PA-04 txHash guard) */
export interface BullMQJobData extends ProofInput {
  _txHash?: string; // PA-04: set by updateData() after submitProofOnChain() returns
}

/** Return value of the BullMQ Worker processor */
export interface BullMQJobResult {
  result: ProofResult;
  txHash?: string;
}

export class BullMQProofQueue {
  private readonly queue: Queue<BullMQJobData, BullMQJobResult>;
  static readonly QUEUE_NAME = 'otk-proofs';

  constructor(redisUrl: string) {
    // IORedis connection — maxRetriesPerRequest=null required by BullMQ v5
    this.queue = new Queue<BullMQJobData, BullMQJobResult>(
      BullMQProofQueue.QUEUE_NAME,
      {
        connection: { url: redisUrl, maxRetriesPerRequest: null },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 1000 },
          removeOnComplete: { count: 1000 },
          removeOnFail: { count: 500 },
        },
      },
    );
  }

  /** Add a proof job to the queue. Returns the BullMQ job id. */
  async enqueue(input: ProofInput): Promise<string> {
    const job = await this.queue.add('prove', input as BullMQJobData);
    if (!job.id) throw new Error('BullMQProofQueue: job id is null after add');
    return job.id;
  }

  /** Get job status. Returns null if job not found. */
  async getJobStatus(id: string): Promise<BullMQJobStatus | null> {
    let job: Job<BullMQJobData, BullMQJobResult> | undefined;
    try {
      job = await this.queue.getJob(id);
    } catch {
      return null;
    }
    if (!job) return null;

    const state = await job.getState();
    const rv = job.returnvalue;
    const createdAt = job.timestamp ?? Date.now();
    const updatedAt = job.processedOn ?? job.finishedOn ?? createdAt;

    return {
      jobId: id,
      status: this._mapState(state),
      attempts: job.attemptsMade ?? 0,
      result: rv?.result,
      txHash: rv?.txHash ?? job.data._txHash,
      error: job.failedReason ?? undefined,
      createdAt,
      updatedAt,
    };
  }

  /** Pending job count (waiting + delayed). */
  async size(): Promise<number> {
    return this.queue.getWaitingCount();
  }

  /** Aggregate queue stats. */
  async stats(): Promise<BullMQQueueStats> {
    const [pending, active, done, dlq] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
    ]);
    return { total: pending + active + done + dlq, pending, done, dead_letter: dlq, failed: 0 };
  }

  /** Graceful shutdown. */
  async close(): Promise<void> {
    await this.queue.close();
  }

  private _mapState(
    state: string,
  ): BullMQJobStatus['status'] {
    switch (state) {
      case 'waiting':
      case 'delayed':
      case 'prioritized':
        return 'pending';
      case 'active':
        return 'processing';
      case 'completed':
        return 'done';
      case 'failed':
        return 'dead_letter';
      default:
        return 'pending';
    }
  }
}
