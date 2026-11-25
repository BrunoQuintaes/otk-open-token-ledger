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
 * The process-wide instance is registered with `setReconciliationScheduler()` and read by the reconciliation
 * routes in `src/api/routes.ts` through `getReconciliationScheduler()`. A failed run is recorded in
 * `getLastRun()` (never thrown). Without a store nothing is persisted; only the last run result is kept.
 *
 * @module src/economics/ReconciliationScheduler
 * @since Wave 5 (W5-5B02 / E6.3)
 */

import { reconcile, type OTKRecord, type ExternalBillingRecord, type ReconciliationReport } from './ReconciliationSystem.js';
import type { PgReconciliationStore, StoredReconciliationReport } from '../infra/pg/PgReconciliationStore.js';

const DEFAULT_INTERVAL_MS = 86_400_000; // 24h

/** Optional scheduler settings. */
export interface ReconciliationSchedulerConfig {
  /** Milliseconds between runs; overrides `OTK_RECONCILE_INTERVAL_MS`. */
  intervalMs?: number;
}

/** Outcome of one reconciliation run. */
export interface ReconciliationRunResult {
  ok: boolean;
  /** Id of the stored report; absent when no store is configured or the run failed. */
  reportId?: string;
  /** Wall-clock duration of the run in milliseconds. */
  durationMs: number;
  /** Error message when `ok` is false. */
  error?: string;
}

/**
 * Source provider interfaces — injected to decouple from storage implementation.
 * In production: OTK records come from PgIndexerStore, external from a billing adapter.
 */
export interface IOTKRecordSource {
  /**
   * Lists the platform's receipts to reconcile.
   *
   * @returns Receipt records, possibly several per transaction hash.
   */
  listRecords(): Promise<OTKRecord[]>;
}

/** Source of the external (provider or billing system) records to reconcile against. */
export interface IExternalBillingSource {
  /**
   * Lists the external billing records.
   *
   * @returns Records keyed by transaction hash.
   */
  listRecords(): Promise<ExternalBillingRecord[]>;
}

/** Runs `reconcile()` on a timer and keeps the last result and report. */
export class ReconciliationScheduler {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _store: PgReconciliationStore | null;
  private _otkSource: IOTKRecordSource;
  private _externalSource: IExternalBillingSource;
  private _intervalMs: number;
  private _lastRun: ReconciliationRunResult | null = null;
  private _lastReport: StoredReconciliationReport | null = null;

  /**
   * Creates a stopped scheduler.
   *
   * @param otkSource - Source of the platform's receipts.
   * @param externalSource - Source of the external billing records.
   * @param store - Where reports are saved; null to keep nothing.
   * @param config - Interval override.
   */
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

  /**
   * Trigger a manual run (e.g., from POST /v1/reconciliation/run).
   *
   * @param runBy - Label saved with the report (default `'manual'`).
   * @returns The run result; failures are reported in it, not thrown.
   */
  async runNow(runBy = 'manual'): Promise<ReconciliationRunResult> {
    return this._run(runBy);
  }

  /**
   * Last run result (null if never run).
   *
   * @returns The most recent result.
   */
  getLastRun(): ReconciliationRunResult | null { return this._lastRun; }

  /**
   * Last stored report (null if store is unavailable or never run).
   *
   * @returns The most recent stored report.
   */
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

/**
 * Registers the process-wide scheduler.
 *
 * @param s - The scheduler instance.
 */
export function setReconciliationScheduler(s: ReconciliationScheduler): void { _scheduler = s; }
/**
 * Returns the process-wide scheduler.
 *
 * @returns The registered instance, or null when none was registered.
 */
export function getReconciliationScheduler(): ReconciliationScheduler | null { return _scheduler; }
