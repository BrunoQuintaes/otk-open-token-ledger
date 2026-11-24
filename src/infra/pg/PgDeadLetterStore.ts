/**
 * PgDeadLetterStore — PostgreSQL-backed IDeadLetterStore (Wave 3A)
 *
 * Stores dead-letter entries in PostgreSQL for cross-instance visibility.
 * Table: otk_dead_letters
 *
 * @module infra/pg/PgDeadLetterStore
 * @since Wave 3A (PACK 3A-01)
 */

import type { IDeadLetterStore, DeadLetterEntry, DeadLetterStatus } from '../../api/IDeadLetterStore.js';

export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS otk_dead_letters (
  id TEXT PRIMARY KEY,
  original_payload TEXT NOT NULL,
  error TEXT NOT NULL,
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  tenant_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retried_at TIMESTAMPTZ,
  discarded_at TIMESTAMPTZ
)`;

const CREATE_STATUS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_dead_letters_status ON otk_dead_letters (status)`;

export class PgDeadLetterStore implements IDeadLetterStore {
  private readonly _pool: PgPool;
  private _counter = 0;
  private _initialized = false;

  constructor(pool: PgPool) {
    this._pool = pool;
  }

  async init(): Promise<void> {
    if (this._initialized) return;
    await this._pool.query(CREATE_TABLE);
    await this._pool.query(CREATE_STATUS_INDEX);
    this._initialized = true;
  }

  async add(entry: Omit<DeadLetterEntry, 'id' | 'status' | 'createdAt'>): Promise<DeadLetterEntry> {
    await this.init();
    this._counter++;
    const id = `dl-${Date.now()}-${this._counter}`;
    const now = new Date().toISOString();
    await this._pool.query(
      `INSERT INTO otk_dead_letters (id, original_payload, error, reason, source, tenant_id, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)`,
      [id, entry.originalPayload, entry.error, entry.reason, entry.source, entry.tenantId ?? null, now],
    );
    return {
      id,
      originalPayload: entry.originalPayload,
      error: entry.error,
      reason: entry.reason,
      source: entry.source,
      tenantId: entry.tenantId,
      status: 'pending',
      createdAt: now,
    };
  }

  async get(id: string): Promise<DeadLetterEntry | null> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT * FROM otk_dead_letters WHERE id = $1`, [id],
    );
    if (rows.length === 0) return null;
    return this._toEntry(rows[0]);
  }

  async list(opts?: { limit?: number; offset?: number; status?: DeadLetterStatus; tenantId?: string }): Promise<DeadLetterEntry[]> {
    await this.init();
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (opts?.status) {
      conditions.push(`status = $${paramIdx++}`);
      params.push(opts.status);
    }
    // RV-RUNS-02 (RUN-S): tenant filter in SQL, before LIMIT, so another tenant cannot push entries out of the window
    if (opts?.tenantId !== undefined) {
      conditions.push(`tenant_id = $${paramIdx++}`);
      params.push(opts.tenantId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    params.push(limit, offset);

    const { rows } = await this._pool.query(
      `SELECT * FROM otk_dead_letters ${where} ORDER BY created_at DESC LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params,
    );
    return rows.map(r => this._toEntry(r));
  }

  async markRetried(id: string): Promise<DeadLetterEntry | null> {
    await this.init();
    const { rows } = await this._pool.query(
      `UPDATE otk_dead_letters SET status = 'retried', retried_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id],
    );
    if (rows.length === 0) return null;
    return this._toEntry(rows[0]);
  }

  async markDiscarded(id: string): Promise<DeadLetterEntry | null> {
    await this.init();
    const { rows } = await this._pool.query(
      `UPDATE otk_dead_letters SET status = 'discarded', discarded_at = NOW()
       WHERE id = $1 RETURNING *`,
      [id],
    );
    if (rows.length === 0) return null;
    return this._toEntry(rows[0]);
  }

  async count(tenantId?: string): Promise<number> {
    await this.init();
    const { rows } = tenantId === undefined
      ? await this._pool.query(`SELECT COUNT(*)::int AS cnt FROM otk_dead_letters`)
      : await this._pool.query(`SELECT COUNT(*)::int AS cnt FROM otk_dead_letters WHERE tenant_id = $1`, [tenantId]);
    return (rows[0]?.cnt as number) ?? 0;
  }

  async pendingCount(tenantId?: string): Promise<number> {
    await this.init();
    const { rows } = tenantId === undefined
      ? await this._pool.query(`SELECT COUNT(*)::int AS cnt FROM otk_dead_letters WHERE status = 'pending'`)
      : await this._pool.query(`SELECT COUNT(*)::int AS cnt FROM otk_dead_letters WHERE status = 'pending' AND tenant_id = $1`, [tenantId]);
    return (rows[0]?.cnt as number) ?? 0;
  }

  async clear(): Promise<void> {
    await this.init();
    await this._pool.query(`DELETE FROM otk_dead_letters`);
    this._counter = 0;
  }

  private _toEntry(row: Record<string, unknown>): DeadLetterEntry {
    return {
      id: row.id as string,
      originalPayload: row.original_payload as string,
      error: row.error as string,
      reason: row.reason as string,
      source: row.source as string,
      tenantId: (row.tenant_id as string) ?? undefined,
      status: row.status as DeadLetterStatus,
      createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : new Date().toISOString(),
      retriedAt: row.retried_at ? new Date(row.retried_at as string).toISOString() : undefined,
      discardedAt: row.discarded_at ? new Date(row.discarded_at as string).toISOString() : undefined,
    };
  }
}
