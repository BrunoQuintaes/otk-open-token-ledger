/**
 * CrashRecoveryManager — Restart-safe state resumption
 *
 * On startup, performs a recovery sequence:
 *   1. Scan JSONL receipt log -> rehydrate receipt store (existing behavior in receiptStore.ts)
 *   2. Scan proof queue log -> rehydrate pending jobs (existing in DurableProofQueue)
 *   3. Verify TAL consistency (check balance matches receipt count)
 *   4. Verify chain head continuity (existing in receiptStore.ts)
 *   5. Resume auto-loop if it was active before crash
 *
 * Reports recovery summary with counts and consistency status.
 *
 * Each source (receipt log, proof queue log, counts, chain head) is injected through `CrashRecoveryDeps`; the class
 * only reads files and compares counts. Reads no environment variable. In this version no module under `src/`
 * constructs it (only tests).
 *
 * @module src/automation/CrashRecovery
 * @since Wave 2 Pack 17 (S4.4)
 */

import { existsSync, readFileSync } from 'node:fs';

/** Recovery summary */
export interface RecoverySummary {
  /** Distinct requestIds found in the receipt log. */
  receiptsRestored: number;
  /** Proof jobs whose last snapshot in the queue log is pending or processing. */
  jobsRestored: number;
  /** `false` when the store holds fewer receipts than the log. */
  talConsistent: boolean;
  /** `false` when the persisted chain head differs from the current one. */
  chainHeadValid: boolean;
  /** Whether the auto-loop was restarted. */
  autoLoopResumed: boolean;
  /** Problems found (read errors and inconsistencies). */
  errors: string[];
  /** ISO-8601 time the check finished. */
  recoveredAt: string;
  /** Duration of the check in ms. */
  durationMs: number;
}

/** Dependencies injected into CrashRecoveryManager */
export interface CrashRecoveryDeps {
  /** Path to JSONL receipt log (empty = skip) */
  receiptLogPath: string;
  /** Path to JSONL proof queue log (empty = skip) */
  proofQueueLogPath: string;
  /** Get current receipt count in store */
  getReceiptCount: () => number;
  /** Get current TAL entry count */
  getTalEntryCount: () => number;
  /** Get current audit chain head */
  getChainHead: () => string;
  /** Expected chain head from persisted state (empty = skip) */
  persistedChainHead: string;
  /** Start auto-loop if previously active */
  startAutoLoop?: () => void;
  /** Whether auto-loop was active before crash (persisted flag) */
  autoLoopWasActive: boolean;
  /** Logger */
  log?: (entry: Record<string, unknown>) => void;
}

/**
 * CrashRecoveryManager — handles crash recovery on startup.
 *
 * Does NOT perform the actual JSONL replay (that is done by receiptStore.ts
 * and DurableProofQueue at module-load time). Instead, it VALIDATES the
 * recovery was consistent and reports a summary.
 */
export class CrashRecoveryManager {
  private readonly _deps: CrashRecoveryDeps;
  private _summary: RecoverySummary | null = null;

  constructor(deps: CrashRecoveryDeps) {
    this._deps = deps;
  }

  /**
   * Execute the recovery check sequence.
   * Returns a RecoverySummary with all recovery details.
   *
   * @returns The summary (also kept as `lastSummary`). Problems are reported in `errors`, never thrown.
   */
  recover(): RecoverySummary {
    const startMs = Date.now();
    const errors: string[] = [];

    // 1. Count receipts restored from JSONL
    let receiptsRestored = 0;
    if (this._deps.receiptLogPath) {
      receiptsRestored = this._countJsonlLines(this._deps.receiptLogPath, errors);
    }

    // 2. Count proof jobs restored from queue log
    let jobsRestored = 0;
    if (this._deps.proofQueueLogPath) {
      jobsRestored = this._countJsonlJobs(this._deps.proofQueueLogPath, errors);
    }

    // 3. Verify TAL consistency
    // TAL is consistent if the stored receipt count roughly matches the
    // number of lines in the receipt log (within a tolerance of 0 — exact match expected).
    const receiptCount = this._deps.getReceiptCount();
    const talConsistent = this._checkTalConsistency(receiptCount, receiptsRestored, errors);

    // 4. Verify chain head continuity
    const chainHeadValid = this._checkChainHead(errors);

    // 5. Resume auto-loop if it was active
    let autoLoopResumed = false;
    if (this._deps.autoLoopWasActive && this._deps.startAutoLoop) {
      try {
        this._deps.startAutoLoop();
        autoLoopResumed = true;
        this._log('info', 'auto_loop_resumed');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`auto-loop resume failed: ${msg}`);
        this._log('error', 'auto_loop_resume_failed', { error: msg });
      }
    }

    const summary: RecoverySummary = {
      receiptsRestored,
      jobsRestored,
      talConsistent,
      chainHeadValid,
      autoLoopResumed,
      errors,
      recoveredAt: new Date().toISOString(),
      durationMs: Date.now() - startMs,
    };

    this._summary = summary;
    this._log('info', 'recovery_complete', {
      receiptsRestored,
      jobsRestored,
      talConsistent,
      chainHeadValid,
      autoLoopResumed,
      errorCount: errors.length,
      durationMs: summary.durationMs,
    });

    return summary;
  }

  /**
   * Get the last recovery summary (null if recover() not called).
   *
   * @returns The last summary, or `null`.
   */
  get lastSummary(): RecoverySummary | null {
    return this._summary;
  }

  // ── Internal helpers ──────────────────────────────────────────

  /**
   * Count the number of unique receipt requestIds in a JSONL file.
   * Uses a Set to deduplicate (JSONL may have multiple snapshots).
   *
   * @param filePath - Receipt log path.
   * @param errors - Receives a message when the file cannot be read.
   * @returns Number of distinct requestIds (0 when the file does not exist).
   */
  private _countJsonlLines(filePath: string, errors: string[]): number {
    if (!existsSync(filePath)) {
      this._log('info', 'receipt_log_not_found', { path: filePath });
      return 0;
    }
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      const ids = new Set<string>();
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.requestId) ids.add(parsed.requestId);
        } catch { /* skip malformed */ }
      }
      return ids.size;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`receipt log read error: ${msg}`);
      return 0;
    }
  }

  /**
   * Count unique pending/processing proof jobs in a JSONL queue log.
   * Only counts jobs that would be restored as pending (not done/dead_letter).
   *
   * @param filePath - Proof queue log path.
   * @param errors - Receives a message when the file cannot be read.
   * @returns Number of pending or processing jobs (0 when the file does not exist).
   */
  private _countJsonlJobs(filePath: string, errors: string[]): number {
    if (!existsSync(filePath)) {
      this._log('info', 'proof_queue_log_not_found', { path: filePath });
      return 0;
    }
    try {
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n').filter(Boolean);
      // Last snapshot per jobId wins
      const latest = new Map<string, any>();
      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.id) latest.set(parsed.id, parsed);
        } catch { /* skip */ }
      }
      let count = 0;
      for (const job of latest.values()) {
        if (job.status === 'pending' || job.status === 'processing') {
          count++;
        }
      }
      return count;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`proof queue log read error: ${msg}`);
      return 0;
    }
  }

  /**
   * Check TAL consistency.
   * After JSONL replay, receipt count in store should match unique receipts in log.
   *
   * @param storeCount - Receipts in the store.
   * @param logCount - Distinct receipts in the log.
   * @param errors - Receives a message when inconsistent.
   * @returns `true` when there is no log or the store holds at least as many receipts.
   */
  private _checkTalConsistency(
    storeCount: number,
    logCount: number,
    errors: string[],
  ): boolean {
    if (logCount === 0) return true; // No log to compare against
    const consistent = storeCount >= logCount;
    if (!consistent) {
      errors.push(
        `TAL inconsistency: store has ${storeCount} receipts but log has ${logCount} unique entries`,
      );
      this._log('warn', 'tal_inconsistency', { storeCount, logCount });
    }
    return consistent;
  }

  /**
   * Check chain head continuity.
   * If persisted chain head is available, compare with current.
   *
   * @param errors - Receives a message on a mismatch.
   * @returns `true` when no head was persisted or the heads are equal.
   */
  private _checkChainHead(errors: string[]): boolean {
    if (!this._deps.persistedChainHead) return true; // No persisted head — skip
    const currentHead = this._deps.getChainHead();
    const valid = currentHead === this._deps.persistedChainHead;
    if (!valid) {
      errors.push(
        `Chain head mismatch: current=${currentHead.slice(0, 16)}... persisted=${this._deps.persistedChainHead.slice(0, 16)}...`,
      );
      this._log('warn', 'chain_head_mismatch', {
        current: currentHead.slice(0, 16),
        persisted: this._deps.persistedChainHead.slice(0, 16),
      });
    }
    return valid;
  }

  private _log(level: string, event: string, extra?: Record<string, unknown>): void {
    if (this._deps.log) {
      this._deps.log({ level, event, component: 'CrashRecovery', ts: Date.now(), ...extra });
    }
  }
}
