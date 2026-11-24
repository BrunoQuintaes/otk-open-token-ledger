/**
 * PublishPolicy — temporal batching gate for on-chain receipt publication.
 *
 * ## Threat model
 *
 * Without batching, an adversary observing on-chain `ReceiptSubmitted` events
 * can correlate *timing* with AI API calls (e.g., "this user called GPT-4 at
 * exactly 14:03:27"). Publishing in batches of at least K receipts after a
 * minimum window of W milliseconds provides k-anonymity within the batch:
 * even if the adversary knows the bucket (bucketed CU from U5.3), they cannot
 * pinpoint which of the ≥K on-chain receipts corresponds to which API call.
 *
 * ## Feature flag
 *
 * CU_PUBLISH_POLICY env:
 *   off       — passthrough; add() always returns a single-element batch immediately.
 *   window_k  — accumulate until (elapsed >= PUBLISH_WINDOW_MS) AND (count >= K).
 *   (default) — window_k
 *
 * ## Parameters (env vars, all optional)
 *
 *   PUBLISH_WINDOW_MS    — minimum elapsed time before publishing (default 60 000 ms).
 *   PUBLISH_MIN_BATCH_K  — minimum batch size before publishing (default 10).
 *
 * ## Usage
 *
 * ```ts
 * const policy = PublishPolicy.fromEnv<DualReceipt>();
 *
 * for (const receipt of incomingReceipts) {
 *   const batch = policy.add(receipt);
 *   if (batch) await submitBatch(batch);
 * }
 * // Graceful shutdown: flush remaining receipts regardless of policy.
 * const remaining = policy.flush();
 * if (remaining.length > 0) await submitBatch(remaining);
 * ```
 *
 * @module PublishPolicy
 * @since U5.3.1
 */

/** Supported publish policy modes. */
export type PublishPolicyMode = 'off' | 'window_k';

/** Constructor options for PublishPolicy. */
export interface PublishPolicyOptions {
  /**
   * Policy mode.
   *   'off'      — passthrough (always publish immediately).
   *   'window_k' — batch until window AND K conditions are both met.
   */
  mode: PublishPolicyMode;

  /**
   * Minimum elapsed time (ms) since the FIRST receipt in the current batch
   * before the batch may be released. Only relevant for window_k mode.
   * Default: 60 000.
   */
  windowMs: number;

  /**
   * Minimum number of receipts required before releasing the batch.
   * Only relevant for window_k mode. Default: 10.
   */
  minBatchK: number;

  /**
   * Clock function returning current time in ms (injectable for testing).
   * Defaults to Date.now.
   */
  now?: () => number;
}

/** Read-only snapshot of current policy state (for diagnostics). */
export interface PublishPolicyState {
  mode: PublishPolicyMode;
  windowMs: number;
  minBatchK: number;
  pendingCount: number;
  batchOpenSince: number | null;
  elapsedMs: number | null;
}

/**
 * Resolve PublishPolicyOptions from environment variables.
 *
 * CU_PUBLISH_POLICY: 'off' | 'window_k' (default 'window_k')
 * PUBLISH_WINDOW_MS:  positive integer ms (default 60 000)
 * PUBLISH_MIN_BATCH_K: positive integer (default 10)
 */
export function optionsFromEnv(overrides?: Partial<PublishPolicyOptions>): PublishPolicyOptions {
  const rawMode = process.env['CU_PUBLISH_POLICY'] ?? 'window_k';
  const mode: PublishPolicyMode = rawMode === 'off' ? 'off' : 'window_k';

  const windowRaw = parseInt(process.env['PUBLISH_WINDOW_MS'] ?? '', 10);
  const windowMs = Number.isFinite(windowRaw) && windowRaw > 0 ? windowRaw : 60_000;

  const kRaw = parseInt(process.env['PUBLISH_MIN_BATCH_K'] ?? '', 10);
  const minBatchK = Number.isFinite(kRaw) && kRaw >= 1 ? kRaw : 10;

  return { mode, windowMs, minBatchK, ...overrides };
}

/**
 * PublishPolicy<T> — generic temporal batching gate.
 *
 * Type parameter T is the receipt type being batched (e.g., DualReceipt).
 */
export class PublishPolicy<T> {
  private readonly _mode: PublishPolicyMode;
  private readonly _windowMs: number;
  private readonly _minBatchK: number;
  private readonly _now: () => number;

  private _pending: T[] = [];
  private _batchOpenAt: number | null = null;

  constructor(opts: PublishPolicyOptions) {
    if (opts.windowMs <= 0) {
      throw new RangeError(`windowMs must be > 0, got ${opts.windowMs}`);
    }
    if (opts.minBatchK < 1) {
      throw new RangeError(`minBatchK must be >= 1, got ${opts.minBatchK}`);
    }
    this._mode = opts.mode;
    this._windowMs = opts.windowMs;
    this._minBatchK = opts.minBatchK;
    this._now = opts.now ?? Date.now;
  }

  /** Create a PublishPolicy from environment variables. */
  static fromEnv<T>(overrides?: Partial<PublishPolicyOptions>): PublishPolicy<T> {
    return new PublishPolicy<T>(optionsFromEnv(overrides));
  }

  /** Active mode. */
  get mode(): PublishPolicyMode { return this._mode; }

  /** Configured minimum window (ms). */
  get windowMs(): number { return this._windowMs; }

  /** Configured minimum batch size. */
  get minBatchK(): number { return this._minBatchK; }

  /** Number of receipts currently held in the pending batch. */
  get pendingCount(): number { return this._pending.length; }

  /**
   * Add a receipt to the policy.
   *
   * Returns a batch (array) when the publish conditions are met, or `null`
   * when the receipt has been buffered but the batch is not yet ready.
   *
   * In 'off' mode, always returns a single-element array immediately.
   */
  add(receipt: T): T[] | null {
    if (this._mode === 'off') {
      return [receipt];
    }

    // Record batch open time on the first receipt in this batch
    if (this._pending.length === 0) {
      this._batchOpenAt = this._now();
    }

    this._pending.push(receipt);

    return this._shouldRelease() ? this._release() : null;
  }

  /**
   * Force-release the pending batch regardless of policy conditions.
   *
   * Returns the pending receipts (may be empty). Resets internal state.
   * Use during graceful shutdown or explicit flush.
   */
  flush(): T[] {
    return this._release();
  }

  /**
   * Read-only snapshot of current state (for diagnostics / monitoring).
   */
  inspect(): PublishPolicyState {
    const now = this._now();
    const elapsed = this._batchOpenAt !== null ? now - this._batchOpenAt : null;
    return {
      mode:         this._mode,
      windowMs:     this._windowMs,
      minBatchK:    this._minBatchK,
      pendingCount: this._pending.length,
      batchOpenSince: this._batchOpenAt,
      elapsedMs:    elapsed,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private _shouldRelease(): boolean {
    if (this._pending.length < this._minBatchK) return false;
    if (this._batchOpenAt === null) return false;
    const elapsed = this._now() - this._batchOpenAt;
    return elapsed >= this._windowMs;
  }

  private _release(): T[] {
    const batch = this._pending.splice(0);
    this._batchOpenAt = null;
    return batch;
  }
}
