/**
 * ReconciliationScheduler — Operational wrapper for ReconciliationSystem (E6.3)
 *
 * Runs `reconcile()` on a configurable interval, stores results to PG via
 * PgReconciliationStore, and exposes the last run status.
 *
 * Follows the RetentionWorker pattern: DB injection, setInterval lifecycle,
 * run-on-startup, graceful stop.
 *
 * Config env vars:
 *   OTK_RECONCILE_INTERVAL_MS  — interval between runs (default: 86400000 = 24h)
 *
 * @module economics/ReconciliationScheduler
 * @since Wave 5 (W5-5B02 / E6.3)
 */

import { reconcile, type OTKRecord, type ExternalBillingRecord, type ReconciliationReport } from './ReconciliationSystem.js';
import type { PgReconciliationStore, StoredReconciliationReport } from '../infra/pg/PgReconciliationStore.js';

const DEFAULT_INTERVAL_MS = 86_400_000; // 24h

export interface ReconciliationSchedulerConfig {
  intervalMs?: number;
}

export interface ReconciliationRunResult {
  ok: boolean;
  reportId?: string;
  durationMs: number;
  error?: string;
}

/**
 * Source provider interfaces — injected to decouple from storage implementation.
 * In production: OTK records come from PgIndexerStore, external from a billing adapter.
 */
export interface IOTKRecordSource {
  listRecords(): Promise<OTKRecord[]>;
}

export interface IExternalBillingSource {
  listRecords(): Promise<ExternalBillingRecord[]>;
}

export class ReconciliationScheduler {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _store: PgReconciliationStore | null;
  private _otkSource: IOTKRecordSource;
  private _externalSource: IExternalBillingSource;
  private _intervalMs: number;
  private _lastRun: ReconciliationRunResult | null = null;
  private _lastReport: StoredReconciliationReport | null = null;

  constructor(
    otkSource: IOTKRecordSource,
    externalSource: IExternalBillingSource,
    store: PgReconciliationStore | null = null,
    config?: ReconciliationSchedulerConfig,
  ) {
    this._otkSource = otkSource;
    this._externalSource = externalSource;
    this._store = store;
    this._intervalMs = config?.intervalMs
      ?? Number(process.env['OTK_RECONCILE_INTERVAL_MS'] ?? DEFAULT_INTERVAL_MS);
  }

  /** Start the scheduler: run immediately, then on interval. */
  start(): void {
    if (this._timer) return;
    void this._run();
    this._timer = setInterval(() => void this._run(), this._intervalMs);
  }

  /** Stop the scheduler. */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Trigger a manual run (e.g., from POST /v1/reconciliation/run). */
  async runNow(runBy = 'manual'): Promise<ReconciliationRunResult> {
    return this._run(runBy);
  }

  /** Last run result (null if never run). */
  getLastRun(): ReconciliationRunResult | null { return this._lastRun; }

  /** Last stored report (null if store is unavailable or never run). */
  getLastReport(): StoredReconciliationReport | null { return this._lastReport; }

  private async _run(runBy = 'scheduler'): Promise<ReconciliationRunResult> {
    const t0 = Date.now();
    try {
      const [otkRecords, externalRecords] = await Promise.all([
        this._otkSource.listRecords(),
        this._externalSource.listRecords(),
      ]);
      const report: ReconciliationReport = reconcile(otkRecords, externalRecords);

      let reportId: string | undefined;
      if (this._store) {
        const stored = await this._store.save(report, runBy);
        this._lastReport = stored;
        reportId = stored.id;
      }

      const result: ReconciliationRunResult = { ok: true, reportId, durationMs: Date.now() - t0 };
      this._lastRun = result;
      return result;
    } catch (err) {
      const result: ReconciliationRunResult = {
        ok: false,
        durationMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
      this._lastRun = result;
      return result;
    }
  }
}

// Singleton for server-wide use
let _scheduler: ReconciliationScheduler | null = null;

export function setReconciliationScheduler(s: ReconciliationScheduler): void { _scheduler = s; }
export function getReconciliationScheduler(): ReconciliationScheduler | null { return _scheduler; }
