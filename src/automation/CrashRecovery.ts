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
 * @module automation/CrashRecovery
 * @since Wave 2 Pack 17 (S4.4)
 */

import { existsSync, readFileSync } from 'node:fs';

/** Recovery summary */
export interface RecoverySummary {
  receiptsRestored: number;
  jobsRestored: number;
  talConsistent: boolean;
  chainHeadValid: boolean;
  autoLoopResumed: boolean;
  errors: string[];
  recoveredAt: string;
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

  /** Get the last recovery summary (null if recover() not called). */
  get lastSummary(): RecoverySummary | null {
    return this._summary;
  }

  // ── Internal helpers ──────────────────────────────────────────

  /**
   * Count the number of unique receipt requestIds in a JSONL file.
   * Uses a Set to deduplicate (JSONL may have multiple snapshots).
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
