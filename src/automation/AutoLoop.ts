/**
 * AutoLoop — Automated batch trigger + on-chain submission loop
 *
 * Orchestrates the full automated pipeline:
 *   1. Monitors incoming receipt count / TAL changes
 *   2. When PublishPolicy window_k threshold is met, triggers flushBatch()
 *   3. After batch finalization, if proof is available, auto-submits on-chain
 *
 * Polling interval: OTK_AUTO_LOOP_INTERVAL_MS (default: 5000ms)
 * Integrates with existing storeReceipt -> flushBatch -> BatchAggregator flow.
 *
 * Events emitted:
 *   'batch_triggered' — flushBatch() was called
 *   'submit_initiated' — on-chain submission started
 *   'submit_completed' — on-chain submission succeeded
 *   'submit_failed'    — on-chain submission failed
 *
 * Environment variables read at module load (defaults of the config): OTK_AUTO_LOOP_INTERVAL_MS, PUBLISH_MIN_BATCH_K
 * (default 10) and OTK_AUTO_SUBMIT (`true` enables submission). The receipt count, the flush and the on-chain submit
 * are injected (`AutoLoopDeps`); this class calls no store or chain by itself. In this version no module under `src/`
 * constructs it (only tests).
 *
 * @module src/automation/AutoLoop
 * @since Wave 2 Pack 16 (S4.2 + S4.3)
 */

import { EventEmitter } from 'node:events';

/** AutoLoop configuration */
export interface AutoLoopConfig {
  /** Polling interval in ms (default: 5000) */
  intervalMs: number;
  /** Minimum receipts to trigger a batch (default: 10, from PublishPolicy.minBatchK) */
  batchThreshold: number;
  /** Whether to attempt on-chain submission after batch (default: false) */
  autoSubmit: boolean;
  /** Clock function for testing (default: Date.now) */
  now?: () => number;
}

/** Dependencies injected into AutoLoop */
export interface AutoLoopDeps {
  /** Get current receipt count */
  getReceiptCount: () => number;
  /** Flush receipts into a batch */
  flushBatch: () => any;
  /** Submit proof on-chain (async — returns txHash or null) */
  submitOnChain?: () => Promise<string | null>;
  /** Logger (optional) */
  log?: (entry: Record<string, unknown>) => void;
}

/** AutoLoop event types */
/** Names of the events emitted by `AutoLoop` (`loop_tick` and `loop_error` besides those in the file header). */
export type AutoLoopEvent =
  | 'batch_triggered'
  | 'submit_initiated'
  | 'submit_completed'
  | 'submit_failed'
  | 'loop_tick'
  | 'loop_error';

/** Loop state for diagnostics */
/** Counters and timestamps of a loop (timestamps in ms from the injected clock; `null` = not yet). */
export interface AutoLoopState {
  running: boolean;
  tickCount: number;
  batchesTriggered: number;
  submitsInitiated: number;
  submitsCompleted: number;
  submitsFailed: number;
  lastTickAt: number | null;
  lastBatchAt: number | null;
  startedAt: number | null;
}

const DEFAULT_CONFIG: AutoLoopConfig = {
  intervalMs: Number(process.env['OTK_AUTO_LOOP_INTERVAL_MS'] ?? 5000),
  batchThreshold: Number(process.env['PUBLISH_MIN_BATCH_K'] ?? 10),
  autoSubmit: process.env['OTK_AUTO_SUBMIT'] === 'true',
};

/**
 * AutoLoop — orchestrates automated batch + submit cycle.
 */
/**
 * Polls the receipt count on a timer, flushes a batch when the threshold is reached and optionally submits it on-chain.
 *
 * Ticks do not overlap-protect each other: a slow on-chain submit can run while the next tick starts.
 */
export class AutoLoop extends EventEmitter {
  private readonly _config: AutoLoopConfig;
  private readonly _deps: AutoLoopDeps;
  private readonly _now: () => number;

  private _running = false;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _state: AutoLoopState = {
    running: false,
    tickCount: 0,
    batchesTriggered: 0,
    submitsInitiated: 0,
    submitsCompleted: 0,
    submitsFailed: 0,
    lastTickAt: null,
    lastBatchAt: null,
    startedAt: null,
  };

  constructor(deps: AutoLoopDeps, config?: Partial<AutoLoopConfig>) {
    super();
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._deps = deps;
    this._now = config?.now ?? Date.now;
  }

  /**
   * Whether the auto-loop is currently running.
   *
   * @returns `true` between `start()` and `stop()`.
   */
  isRunning(): boolean {
    return this._running;
  }

  /**
   * Current state snapshot (for diagnostics).
   *
   * @returns A shallow copy of the state.
   */
  inspect(): AutoLoopState {
    return { ...this._state };
  }

  /** Start the auto-loop. No-op if already running. */
  start(): void {
    if (this._running) return;
    this._running = true;
    this._state.running = true;
    this._state.startedAt = this._now();

    this._timer = setInterval(() => {
      this._tick().catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this._log('error', 'loop_error', { error: msg });
        this.emit('loop_error', msg);
      });
    }, this._config.intervalMs);

    // Don't keep process alive just for auto-loop
    if (this._timer && typeof this._timer === 'object' && 'unref' in this._timer) {
      (this._timer as NodeJS.Timeout).unref();
    }

    this._log('info', 'auto_loop_started', {
      intervalMs: this._config.intervalMs,
      batchThreshold: this._config.batchThreshold,
      autoSubmit: this._config.autoSubmit,
    });
  }

  /** Stop the auto-loop. No-op if not running. */
  stop(): void {
    if (!this._running) return;
    this._running = false;
    this._state.running = false;

    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }

    this._log('info', 'auto_loop_stopped', {
      tickCount: this._state.tickCount,
      batchesTriggered: this._state.batchesTriggered,
    });
  }

  /**
   * Execute a single tick (exposed for testing).
   *
   * @returns Resolves when the tick, including any on-chain submit, has finished.
   */
  async tick(): Promise<void> {
    return this._tick();
  }

  // ── Internal ────────────────────────────────────────────────

  // One poll: flush when the count reaches the threshold, then submit when enabled; submit errors are counted, not thrown.
  private async _tick(): Promise<void> {
    const now = this._now();
    this._state.tickCount++;
    this._state.lastTickAt = now;

    const receiptCount = this._deps.getReceiptCount();

    // Check if batch threshold is met
    if (receiptCount >= this._config.batchThreshold) {
      this._log('info', 'batch_threshold_met', { receiptCount, threshold: this._config.batchThreshold });

      // Trigger batch flush
      const batchResult = this._deps.flushBatch();
      this._state.batchesTriggered++;
      this._state.lastBatchAt = now;
      this.emit('batch_triggered', batchResult);

      // Auto-submit on-chain if configured and batch was produced
      if (this._config.autoSubmit && batchResult && this._deps.submitOnChain) {
        this._state.submitsInitiated++;
        this.emit('submit_initiated');

        try {
          const txHash = await this._deps.submitOnChain();
          if (txHash) {
            this._state.submitsCompleted++;
            this.emit('submit_completed', txHash);
            this._log('info', 'submit_completed', { txHash });
          } else {
            // null = chain not configured (dev mode)
            this._log('info', 'submit_skipped', { reason: 'no_chain_config' });
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this._state.submitsFailed++;
          this.emit('submit_failed', msg);
          this._log('error', 'submit_failed', { error: msg });
        }
      }
    }

    this.emit('loop_tick', { receiptCount, tickCount: this._state.tickCount });
  }

  // Forwards a structured log entry to the injected logger, if any.
  private _log(level: string, event: string, extra?: Record<string, unknown>): void {
    if (this._deps.log) {
      this._deps.log({ level, event, ts: this._now(), ...extra });
    }
  }
}
