/**
 * RetentionWorker — Data lifecycle compaction worker (E5.3)
 *
 * Marks receipts and audit log entries older than the retention policy as
 * archived_at = now(). Runs on startup and then every 24 hours.
 *
 * Config env vars:
 *   OTK_RECEIPT_RETENTION_DAYS  — days before receipts are archived (default: 90)
 *   OTK_AUDIT_RETENTION_DAYS    — days before audit entries are archived (default: 365)
 *   OTK_RETENTION_INTERVAL_MS   — interval between runs in ms (default: 86400000 = 24h)
 *
 * @module infra/retention/RetentionWorker
 * @since Wave 4 (4B-PACK-4B03 / E5.3)
 */

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export interface RetentionConfig {
  receiptRetentionDays: number;
  auditRetentionDays: number;
  intervalMs: number;
}

export interface RetentionRunResult {
  ok: boolean;
  receiptsArchived: number;
  auditEntriesArchived: number;
  durationMs: number;
  error?: string;
}

/** Minimal PG client interface (compatible with pg.Pool / pg.Client) */
export interface IPgClient {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null }>;
}

// ──────────────────────────────────────────────────────────
// RetentionWorker
// ──────────────────────────────────────────────────────────

export class RetentionWorker {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _config: RetentionConfig;
  private _db: IPgClient | null;
  private _lastRun: RetentionRunResult | null = null;

  constructor(db: IPgClient | null = null, config?: Partial<RetentionConfig>) {
    this._db = db;
    this._config = {
      receiptRetentionDays: config?.receiptRetentionDays
        ?? Number(process.env['OTK_RECEIPT_RETENTION_DAYS'] ?? 90),
      auditRetentionDays: config?.auditRetentionDays
        ?? Number(process.env['OTK_AUDIT_RETENTION_DAYS'] ?? 365),
      intervalMs: config?.intervalMs
        ?? Number(process.env['OTK_RETENTION_INTERVAL_MS'] ?? 86400000),
    };
  }

  /** Start the worker: run once immediately, then schedule recurring runs. */
  start(): void {
    void this.run();
    this._timer = setInterval(() => void this.run(), this._config.intervalMs);
    // Allow process to exit without waiting for timer
    if (this._timer.unref) this._timer.unref();
  }

  /** Stop the worker (clears interval). */
  stop(): void {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** Run one retention pass. Resolves with result (never rejects). */
  async run(): Promise<RetentionRunResult> {
    const start = Date.now();
    let receiptsArchived = 0;
    let auditEntriesArchived = 0;

    if (!this._db) {
      const result: RetentionRunResult = {
        ok: true,
        receiptsArchived: 0,
        auditEntriesArchived: 0,
        durationMs: Date.now() - start,
      };
      this._lastRun = result;
      return result;
    }

    try {
      // Archive old receipts
      const receiptResult = await this._db.query(
        `UPDATE receipts
           SET archived_at = NOW()
         WHERE archived_at IS NULL
           AND created_at < NOW() - INTERVAL '${this._config.receiptRetentionDays} days'`,
      );
      receiptsArchived = receiptResult.rowCount ?? 0;

      // Archive old audit log entries (table may not exist)
      try {
        const auditResult = await this._db.query(
          `UPDATE audit_log
             SET archived_at = NOW()
           WHERE archived_at IS NULL
             AND created_at < NOW() - INTERVAL '${this._config.auditRetentionDays} days'`,
        );
        auditEntriesArchived = auditResult.rowCount ?? 0;
      } catch {
        // audit_log table may not exist — non-fatal
      }

      const result: RetentionRunResult = {
        ok: true,
        receiptsArchived,
        auditEntriesArchived,
        durationMs: Date.now() - start,
      };
      this._lastRun = result;
      return result;
    } catch (err) {
      const result: RetentionRunResult = {
        ok: false,
        receiptsArchived: 0,
        auditEntriesArchived: 0,
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      };
      this._lastRun = result;
      return result;
    }
  }

  get config(): RetentionConfig {
    return { ...this._config };
  }

  get lastRun(): RetentionRunResult | null {
    return this._lastRun;
  }
}
