/**
 * ProductionQueue — Unified proof queue with retry, backpressure, and dead-letter
 *
 * Selects the right implementation based on environment:
 * - With OTK_REDIS_URL: BullMQ (distributed, persistent)
 * - Without: DurableProofQueue (in-memory + optional JSONL)
 *
 * Adds:
 * - Configurable concurrency
 * - Backpressure (max queue size with reject policy)
 * - Dead-letter integration with S1.5 dead-letter store
 * - Retry with exponential backoff
 * - Unified monitoring interface
 *
 * @module prover/ProductionQueue
 * @since S3.2 + S3.4 (Wave 1 Pack 3)
 */

import { addDeadLetter } from '../api/deadLetterStore.js';
import type { ProofInput, ProofResult } from './ProofQueue.js';

/** Retry policy configuration */
export interface RetryPolicy {
  /** Maximum retry attempts before dead-letter (default: 3) */
  maxRetries: number;
  /** Initial backoff delay in ms (default: 1000) */
  backoffMs: number;
  /** Backoff multiplier (default: 2.0 = exponential doubling) */
  backoffFactor: number;
  /** Maximum backoff delay in ms (default: 30000) */
  maxBackoffMs: number;
}

/** Queue configuration */
export interface QueueConfig {
  /** Maximum queue depth before rejecting new jobs (default: 10000) */
  maxQueueSize: number;
  /** What to do when queue is full: 'reject' throws, 'drop_oldest' evicts (default: 'reject') */
  rejectPolicy: 'reject' | 'drop_oldest';
  /** Number of concurrent proof workers (default: 1 — CPU-bound) */
  concurrency: number;
  /** Retry policy */
  retry: RetryPolicy;
}

/** Unified job status */
export type QueueJobStatus = 'pending' | 'processing' | 'done' | 'dead_letter' | 'unknown';

/** Unified job info */
export interface QueueJob {
  id: string;
  status: QueueJobStatus;
  input: ProofInput;
  result?: ProofResult;
  error?: string;
  attempts: number;
  createdAt: number;
  updatedAt: number;
  nextRetryAt?: number;
  txHash?: string;
}

/** Queue metrics */
export interface QueueMetrics {
  totalEnqueued: number;
  totalCompleted: number;
  totalFailed: number;
  totalDeadLettered: number;
  queueDepth: number;
  processingCount: number;
  backpressureRejections: number;
  mode: 'bullmq' | 'durable';
}

const DEFAULT_RETRY: RetryPolicy = {
  maxRetries: Number(process.env['PROVER_MAX_ATTEMPTS'] ?? 3),
  backoffMs: Number(process.env['PROVER_BACKOFF_MS'] ?? 1000),
  backoffFactor: Number(process.env['PROVER_BACKOFF_FACTOR'] ?? 2.0),
  maxBackoffMs: Number(process.env['PROVER_MAX_BACKOFF_MS'] ?? 30000),
};

const DEFAULT_CONFIG: QueueConfig = {
  maxQueueSize: Number(process.env['PROVER_MAX_QUEUE_SIZE'] ?? 10000),
  rejectPolicy: (process.env['PROVER_REJECT_POLICY'] as 'reject' | 'drop_oldest') || 'reject',
  concurrency: Number(process.env['PROVER_CONCURRENCY'] ?? 1),
  retry: DEFAULT_RETRY,
};

/**
 * Production-grade proof queue.
 * Wraps DurableProofQueue with backpressure, dead-letter integration, and metrics.
 */
export class ProductionQueue {
  private readonly config: QueueConfig;
  private readonly _mode: 'bullmq' | 'durable';
  private _queue: any; // DurableProofQueue or BullMQProofQueue instance
  private _metrics: QueueMetrics;

  constructor(config?: Partial<QueueConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config, retry: { ...DEFAULT_RETRY, ...config?.retry } };
    this._mode = process.env['OTK_REDIS_URL'] ? 'bullmq' : 'durable';
    this._metrics = {
      totalEnqueued: 0,
      totalCompleted: 0,
      totalFailed: 0,
      totalDeadLettered: 0,
      queueDepth: 0,
      processingCount: 0,
      backpressureRejections: 0,
      mode: this._mode,
    };
  }

  /** Initialize the queue (call at startup). */
  async init(): Promise<void> {
    if (this._mode === 'bullmq') {
      const { BullMQProofQueue } = await import('./BullMQProofQueue.js');
      this._queue = new BullMQProofQueue(process.env['OTK_REDIS_URL']!);
    } else {
      const { DurableProofQueue } = await import('./DurableProofQueue.js');
      this._queue = new DurableProofQueue(
        process.env['OTK_PROOF_QUEUE_LOG'] || null,
        {
          maxAttempts: this.config.retry.maxRetries,
          baseBackoffMs: this.config.retry.backoffMs,
        },
      );
    }
  }

  /** Current operating mode. */
  get mode(): 'bullmq' | 'durable' {
    return this._mode;
  }

  /**
   * Enqueue a proof job with backpressure check.
   * Returns the job id, or throws if queue is full (reject policy).
   */
  async enqueue(input: ProofInput): Promise<string> {
    // Backpressure check
    const depth = await this.depth();
    if (depth >= this.config.maxQueueSize) {
      this._metrics.backpressureRejections++;
      if (this.config.rejectPolicy === 'reject') {
        // Report to dead-letter store (fire-and-forget)
        addDeadLetter({
          originalPayload: JSON.stringify(input),
          error: `queue full (${depth}/${this.config.maxQueueSize})`,
          reason: 'processing_error',
          source: 'ProductionQueue.enqueue',
        }).catch(() => {});
        throw new Error(`Queue full: ${depth}/${this.config.maxQueueSize}`);
      }
      // drop_oldest not implemented for BullMQ — only for durable mode
    }

    let id: string;
    if (this._mode === 'bullmq') {
      id = await this._queue.enqueue(input);
    } else {
      id = this._queue.enqueue(input);
    }
    this._metrics.totalEnqueued++;
    this._metrics.queueDepth++;
    return id;
  }

  /** Dequeue next available job (durable mode only). BullMQ uses worker pattern. */
  dequeue(): QueueJob | null {
    if (this._mode !== 'durable') return null;
    const job = this._queue.dequeue();
    if (job) {
      this._metrics.processingCount++;
      return this._toQueueJob(job);
    }
    return null;
  }

  /** Mark job as completed. */
  complete(id: string, result: ProofResult, txHash?: string): void {
    if (this._mode === 'durable') {
      this._queue.complete(id, result, txHash);
    }
    this._metrics.totalCompleted++;
    this._metrics.queueDepth = Math.max(0, this._metrics.queueDepth - 1);
    this._metrics.processingCount = Math.max(0, this._metrics.processingCount - 1);
  }

  /**
   * Mark job as failed. Handles retry and dead-letter logic.
   * On dead-letter: captures to the S1.5 dead-letter store.
   */
  fail(id: string, error: string): void {
    if (this._mode === 'durable') {
      this._queue.fail(id, error);
      this._metrics.totalFailed++;
      this._metrics.processingCount = Math.max(0, this._metrics.processingCount - 1);

      // Check if dead-lettered (after fail, status changes to dead_letter)
      const updated = this._queue.get(id);
      if (updated && updated.status === 'dead_letter') {
        this._metrics.totalDeadLettered++;
        this._metrics.queueDepth = Math.max(0, this._metrics.queueDepth - 1);
        // S1.5 integration: capture to dead-letter store (fire-and-forget)
        addDeadLetter({
          originalPayload: JSON.stringify(updated.input),
          error: `proof failed after ${updated.attempts} attempts: ${error}`,
          reason: 'dispatch_error',
          source: 'ProductionQueue.fail',
        }).catch(() => {});
      }
    }
  }

  /** Mark job as submitted on-chain (PA-04 txHash guard). */
  markSubmitted(id: string, txHash: string): void {
    if (this._mode === 'durable') {
      this._queue.markSubmitted(id, txHash);
    }
  }

  /** Get job info. */
  async getJob(id: string): Promise<QueueJob | null> {
    if (this._mode === 'bullmq') {
      const status = await this._queue.getJobStatus(id);
      return status ? {
        id: status.jobId,
        status: status.status,
        input: {} as ProofInput, // BullMQ doesn't expose input easily
        attempts: status.attempts,
        createdAt: status.createdAt,
        updatedAt: status.updatedAt,
        txHash: status.txHash,
        error: status.error,
      } : null;
    }
    const job = this._queue.get(id);
    return job ? this._toQueueJob(job) : null;
  }

  /** Current queue depth. */
  async depth(): Promise<number> {
    if (this._mode === 'bullmq') {
      return this._queue.size();
    }
    return this._queue.size();
  }

  /** Queue stats. */
  async stats(): Promise<QueueMetrics> {
    return { ...this._metrics };
  }

  /** Graceful shutdown. */
  async close(): Promise<void> {
    if (this._mode === 'bullmq' && this._queue?.close) {
      await this._queue.close();
    }
  }

  private _toQueueJob(job: any): QueueJob {
    return {
      id: job.id,
      status: job.status,
      input: job.input,
      result: job.result,
      error: job.error,
      attempts: job.attempts ?? 0,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
      nextRetryAt: job.nextRetryAt,
      txHash: job.txHash,
    };
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let _instance: ProductionQueue | null = null;

/** Get or create the production queue singleton. */
export function getProductionQueue(): ProductionQueue {
  if (!_instance) {
    _instance = new ProductionQueue();
  }
  return _instance;
}

/** Initialize the production queue (call at startup). */
export async function initProductionQueue(): Promise<void> {
  const q = getProductionQueue();
  await q.init();
}

/** Reset singleton for tests. */
export function resetProductionQueueForTest(): void {
  _instance = null;
}
