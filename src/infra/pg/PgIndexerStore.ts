/**
 * PgIndexerStore — PostgreSQL-backed IIndexerStore (Wave 3A)
 *
 * Stores indexed receipt data in PostgreSQL for cross-instance visibility.
 * Table: otk_indexed_receipts
 *
 * @module infra/pg/PgIndexerStore
 * @since Wave 3A (PACK 3A-03)
 */

import type { IIndexerStore, IndexedReceipt, TenantSummary } from '../../dashboard/IIndexerStore.js';

export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS otk_indexed_receipts (
  request_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INT NOT NULL,
  output_tokens INT NOT NULL,
  cost_units NUMERIC NOT NULL,
  latency_ms INT NOT NULL,
  timestamp BIGINT NOT NULL,
  tenant_id TEXT NOT NULL,
  indexed_at BIGINT NOT NULL
)`;

const CREATE_TENANT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_indexed_receipts_tenant ON otk_indexed_receipts (tenant_id)`;

const CREATE_TIMESTAMP_INDEX = `
CREATE INDEX IF NOT EXISTS idx_indexed_receipts_ts ON otk_indexed_receipts (indexed_at DESC)`;

export class PgIndexerStore implements IIndexerStore {
  private readonly _pool: PgPool;
  private _initialized = false;

  constructor(pool: PgPool) {
    this._pool = pool;
  }

  async init(): Promise<void> {
    if (this._initialized) return;
    await this._pool.query(CREATE_TABLE);
    await this._pool.query(CREATE_TENANT_INDEX);
    await this._pool.query(CREATE_TIMESTAMP_INDEX);
    this._initialized = true;
  }

  async index(receipt: IndexedReceipt): Promise<void> {
    await this.init();
    await this._pool.query(
      `INSERT INTO otk_indexed_receipts
         (request_id, provider, model, input_tokens, output_tokens, cost_units,
          latency_ms, timestamp, tenant_id, indexed_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (request_id) DO UPDATE SET
         indexed_at = EXCLUDED.indexed_at`,
      [
        receipt.requestId,
        receipt.provider,
        receipt.model,
        receipt.inputTokens,
        receipt.outputTokens,
        receipt.costUnits,
        receipt.latencyMs,
        receipt.timestamp,
        receipt.tenantId,
        receipt.indexedAt,
      ],
    );
  }

  async getRecentReceipts(opts?: { limit?: number; offset?: number; tenantId?: string }): Promise<IndexedReceipt[]> {
    await this.init();
    const limit = opts?.limit ?? 50;
    const offset = opts?.offset ?? 0;

    let query: string;
    let params: unknown[];

    if (opts?.tenantId) {
      query = `SELECT * FROM otk_indexed_receipts WHERE tenant_id = $1 ORDER BY indexed_at DESC LIMIT $2 OFFSET $3`;
      params = [opts.tenantId, limit, offset];
    } else {
      query = `SELECT * FROM otk_indexed_receipts ORDER BY indexed_at DESC LIMIT $1 OFFSET $2`;
      params = [limit, offset];
    }

    const { rows } = await this._pool.query(query, params);
    return rows.map(r => this._toReceipt(r));
  }

  async getTenantSummary(): Promise<TenantSummary[]> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT
         tenant_id AS "tenantId",
         COUNT(*)::int AS "totalReceipts",
         SUM(cost_units)::float AS "totalCU",
         MAX(indexed_at)::bigint AS "lastActivityAt"
       FROM otk_indexed_receipts
       GROUP BY tenant_id
       ORDER BY MAX(indexed_at) DESC`,
    );
    return rows.map(r => ({
      tenantId: r.tenantId as string,
      totalReceipts: r.totalReceipts as number,
      totalCU: Number(r.totalCU ?? 0),
      lastActivityAt: Number(r.lastActivityAt ?? 0),
    }));
  }

  async size(): Promise<number> {
    await this.init();
    const { rows } = await this._pool.query(`SELECT COUNT(*)::int AS cnt FROM otk_indexed_receipts`);
    return (rows[0]?.cnt as number) ?? 0;
  }

  async clear(): Promise<void> {
    await this.init();
    await this._pool.query(`DELETE FROM otk_indexed_receipts`);
  }

  private _toReceipt(row: Record<string, unknown>): IndexedReceipt {
    return {
      requestId: row.request_id as string,
      provider: row.provider as string,
      model: row.model as string,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      costUnits: Number(row.cost_units ?? 0),
      latencyMs: row.latency_ms as number,
      timestamp: Number(row.timestamp ?? 0),
      tenantId: row.tenant_id as string,
      indexedAt: Number(row.indexed_at ?? 0),
    };
  }
}
