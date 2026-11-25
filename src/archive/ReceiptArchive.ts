/**
 * ReceiptArchive — PostgreSQL-backed receipt archive for querying/analytics
 *
 * Wraps PostgresReceiptStore with archive-oriented operations:
 *   - archiveReceipt: insert into pg with indexing
 *   - queryReceipts: parametric query with tenant/epoch/provider/model/date filters
 *   - getArchiveStats: count, oldest, newest timestamps
 *
 * Falls back gracefully when DB is unavailable (returns empty results, no crash).
 * Uses existing OTK_DB_URL connection pattern from PostgresReceiptStore.
 *
 * It opens its own pool (max 3 connections) on `init()`; TLS is required in deployed environments (rule of
 * `src/infra/deployEnv.ts`). Table: `otk_receipt_archive`, with indexes on tenant, epoch, provider and timestamp.
 * In this version no module under `src/` calls it (only its unit tests). Its `epoch_id` is the UTC day number
 * (timestamp / 86 400), not the receipt epoch of `deriveEpoch` (hourly).
 * Environment variable read: OTK_DB_URL (by `getReceiptArchive`).
 *
 * @module src/archive/ReceiptArchive
 * @since Wave 2 Pack 14 (E3.1)
 */

import type { RawReceipt } from '../types/receipt.js';
import { isDeployedEnv } from '../infra/deployEnv.js'; // RV2-RUNS-02 (RUN-S): same rule as the auth guard

/** Query filter for receipt archive */
export interface ArchiveQuery {
  /** Exact tenant id. */
  tenantId?: string;
  /** Exact archive epoch id (UTC day number as a string). */
  epochId?: string;
  provider?: string;
  model?: string;
  /** Lower bound on the receipt timestamp, seconds since epoch (inclusive). */
  from?: number;
  /** Upper bound on the receipt timestamp, seconds since epoch (inclusive). */
  to?: number;
  /** Page size; default 100, capped at 1000. */
  limit?: number;
  /** Rows to skip; default 0. */
  offset?: number;
}

/** Archive statistics */
export interface ArchiveStats {
  /** Number of archived receipts. */
  count: number;
  /** Smallest receipt timestamp (seconds), or `null` when empty. */
  oldest: number | null;
  /** Largest receipt timestamp (seconds), or `null` when empty. */
  newest: number | null;
}

/** Result of an archive query */
export interface ArchiveQueryResult {
  /** Receipts of the requested page, newest first. */
  receipts: RawReceipt[];
  /** Number of rows matching the filters (all pages). */
  total: number;
  /** The query as received. */
  query: ArchiveQuery;
}

/**
 * ReceiptArchive — archive-oriented PostgreSQL receipt store.
 *
 * Designed for long-term storage and querying of historical receipts.
 * All operations are non-throwing: DB unavailability returns empty results.
 */
export class ReceiptArchive {
  private _pool: any = null;
  private _initialized = false;
  private readonly _connectionString: string;

  constructor(connectionString: string) {
    this._connectionString = connectionString;
  }

  /**
   * Initialize the archive table if it does not exist.
   * Returns true on success, false on failure (DB unreachable).
   *
   * @returns `true` when the table and indexes exist, `false` when the database could not be reached.
   */
  async init(): Promise<boolean> {
    try {
      const { Pool } = await import('pg');
      // SEC-06: enforce SSL in production
      const archiveSsl = isDeployedEnv() ? { rejectUnauthorized: true } : false;
      this._pool = new Pool({ connectionString: this._connectionString, max: 3, ssl: archiveSsl });
      // N12: idle client errors must not terminate the process
      this._pool.on('error', (err: Error) => {
        process.stderr.write(JSON.stringify({ event: 'pg_pool_idle_error', pool: 'archive', error: err.message, ts: Date.now() }) + '\n');
      });
      await this._pool.query(`
        CREATE TABLE IF NOT EXISTS otk_receipt_archive (
          request_id   TEXT PRIMARY KEY,
          tenant_id    TEXT NOT NULL DEFAULT 'default',
          epoch_id     TEXT NOT NULL DEFAULT '0',
          provider     TEXT NOT NULL,
          model        TEXT NOT NULL,
          cost_units   DOUBLE PRECISION NOT NULL DEFAULT 0,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          latency_ms   INTEGER NOT NULL DEFAULT 0,
          timestamp    BIGINT NOT NULL DEFAULT 0,
          receipt_json JSONB NOT NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      // Create indexes for common query patterns (idempotent)
      await this._pool.query(`CREATE INDEX IF NOT EXISTS idx_archive_tenant ON otk_receipt_archive (tenant_id)`);
      await this._pool.query(`CREATE INDEX IF NOT EXISTS idx_archive_epoch ON otk_receipt_archive (epoch_id)`);
      await this._pool.query(`CREATE INDEX IF NOT EXISTS idx_archive_provider ON otk_receipt_archive (provider)`);
      await this._pool.query(`CREATE INDEX IF NOT EXISTS idx_archive_ts ON otk_receipt_archive (timestamp)`);
      this._initialized = true;
      return true;
    } catch {
      this._initialized = false;
      return false;
    }
  }

  /**
   * Whether the archive has been successfully initialized.
   *
   * @returns `true` after a successful `init()` and before `close()`.
   */
  get isReady(): boolean {
    return this._initialized && this._pool !== null;
  }

  /**
   * Archive a receipt into PostgreSQL.
   * Returns true if stored, false on duplicate or DB failure.
   *
   * @param receipt - Receipt to archive; its archive epoch is derived from the timestamp (seconds).
   * @returns `true` when inserted; `false` for a duplicate requestId, before `init()` or on any database error.
   */
  async archiveReceipt(receipt: RawReceipt): Promise<boolean> {
    if (!this._pool) return false;
    try {
      const epochId = String(Math.floor(receipt.timestamp / 86400));
      const serialized = {
        ...receipt,
        userId: String(receipt.userId),
        nonce: String(receipt.nonce),
      };
      const result = await this._pool.query(
        `INSERT INTO otk_receipt_archive
         (request_id, tenant_id, epoch_id, provider, model, cost_units,
          input_tokens, output_tokens, latency_ms, timestamp, receipt_json)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
         ON CONFLICT (request_id) DO NOTHING`,
        [
          receipt.requestId,
          receipt.tenantId ?? 'default',
          epochId,
          receipt.provider,
          receipt.model,
          receipt.costUnits,
          receipt.inputTokens,
          receipt.outputTokens,
          receipt.latencyMs,
          receipt.timestamp,
          JSON.stringify(serialized),
        ],
      );
      return (result.rowCount ?? 0) > 0;
    } catch {
      return false;
    }
  }

  /**
   * Query archived receipts with parametric filters.
   * Returns empty results on DB failure.
   *
   * @param query - Filters and paging; all filters are exact matches combined with AND.
   * @returns The page and the total count; an empty result before `init()` or on any database error.
   */
  async queryReceipts(query: ArchiveQuery = {}): Promise<ArchiveQueryResult> {
    const empty: ArchiveQueryResult = { receipts: [], total: 0, query };
    if (!this._pool) return empty;

    try {
      const conditions: string[] = [];
      const params: unknown[] = [];
      let paramIdx = 1;

      if (query.tenantId) {
        conditions.push(`tenant_id = $${paramIdx++}`);
        params.push(query.tenantId);
      }
      if (query.epochId) {
        conditions.push(`epoch_id = $${paramIdx++}`);
        params.push(query.epochId);
      }
      if (query.provider) {
        conditions.push(`provider = $${paramIdx++}`);
        params.push(query.provider);
      }
      if (query.model) {
        conditions.push(`model = $${paramIdx++}`);
        params.push(query.model);
      }
      if (query.from !== undefined) {
        conditions.push(`timestamp >= $${paramIdx++}`);
        params.push(query.from);
      }
      if (query.to !== undefined) {
        conditions.push(`timestamp <= $${paramIdx++}`);
        params.push(query.to);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
      const limit = Math.min(query.limit ?? 100, 1000);
      const offset = query.offset ?? 0;

      // Get total count
      const countResult = await this._pool.query(
        `SELECT COUNT(*) AS count FROM otk_receipt_archive ${where}`,
        params,
      );
      const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

      // Get paginated results
      const dataResult = await this._pool.query(
        `SELECT receipt_json FROM otk_receipt_archive ${where}
         ORDER BY timestamp DESC LIMIT $${paramIdx++} OFFSET $${paramIdx++}`,
        [...params, limit, offset],
      );

      const receipts: RawReceipt[] = dataResult.rows.map((row: any) => {
        const r = typeof row.receipt_json === 'string' ? JSON.parse(row.receipt_json) : row.receipt_json;
        return {
          provider: r.provider,
          model: r.model,
          inputTokens: Number(r.inputTokens),
          outputTokens: Number(r.outputTokens),
          costUnits: Number(r.costUnits),
          latencyMs: Number(r.latencyMs),
          timestamp: Number(r.timestamp),
          requestId: r.requestId,
          userId: BigInt(String(r.userId ?? '0')),
          nonce: BigInt(String(r.nonce ?? '0')),
          tenantId: r.tenantId ?? undefined,
          cwVersion: r.cwVersion ?? undefined,
        };
      });

      return { receipts, total, query };
    } catch {
      return empty;
    }
  }

  /**
   * Get archive statistics: count, oldest, newest.
   * Returns zeroed stats on DB failure.
   *
   * @returns Count and timestamp range; zeroed before `init()` or on any database error.
   */
  async getArchiveStats(): Promise<ArchiveStats> {
    const empty: ArchiveStats = { count: 0, oldest: null, newest: null };
    if (!this._pool) return empty;

    try {
      const result = await this._pool.query(
        `SELECT COUNT(*) AS count, MIN(timestamp) AS oldest, MAX(timestamp) AS newest
         FROM otk_receipt_archive`,
      );
      const row = result.rows[0];
      return {
        count: parseInt(row?.count ?? '0', 10),
        oldest: row?.oldest != null ? Number(row.oldest) : null,
        newest: row?.newest != null ? Number(row.newest) : null,
      };
    } catch {
      return empty;
    }
  }

  /** Graceful shutdown. */
  async close(): Promise<void> {
    if (this._pool) {
      try { await this._pool.end(); } catch { /* non-critical */ }
      this._pool = null;
      this._initialized = false;
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let _instance: ReceiptArchive | null = null;

/**
 * Get or create the singleton archive.
 * Returns null if OTK_DB_URL is not configured.
 *
 * @returns The shared archive (not yet initialized on first call), or `null` without OTK_DB_URL.
 */
export function getReceiptArchive(): ReceiptArchive | null {
  const url = process.env['OTK_DB_URL'];
  if (!url) return null;
  if (!_instance) {
    _instance = new ReceiptArchive(url);
  }
  return _instance;
}

/** Reset singleton for tests. */
export function resetArchiveForTest(): void {
  _instance = null;
}
