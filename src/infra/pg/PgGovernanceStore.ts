/**
 * PgGovernanceStore — PostgreSQL-backed IGovernanceStore (Wave 3A)
 *
 * Stores governance trail entries in PostgreSQL for cross-instance durability.
 * Table: otk_governance
 *
 * @module infra/pg/PgGovernanceStore
 * @since Wave 3A (PACK 3A-03)
 */

import type { IGovernanceStore } from '../../security/IGovernanceStore.js';
import type { GovernanceEvent, GovernanceEntry } from '../../security/GovernanceTrail.js';
import { sha256Hex, chainHash } from '../../security/AuditLogChain.js';
import { isDeployedEnv } from '../deployEnv.js'; // RV2-RUNS-02 (RUN-S): same rule as the auth guard

export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const GENESIS_HASH = sha256Hex('governance-genesis');

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS otk_governance (
  seq SERIAL PRIMARY KEY,
  ts TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  meta JSONB,
  hash TEXT NOT NULL
)`;

const CREATE_TS_INDEX = `
CREATE INDEX IF NOT EXISTS idx_governance_ts ON otk_governance (ts)`;

export class PgGovernanceStore implements IGovernanceStore {
  private readonly _pool: PgPool;
  private _initialized = false;

  constructor(pool: PgPool) {
    this._pool = pool;
  }

  async init(): Promise<void> {
    if (this._initialized) return;
    await this._pool.query(CREATE_TABLE);
    await this._pool.query(CREATE_TS_INDEX);
    this._initialized = true;
  }

  async append(event: GovernanceEvent, prevHash?: string): Promise<GovernanceEntry> {
    await this.init();
    const prev = prevHash ?? await this.head();
    const record = {
      ts: event.ts,
      tenantId: event.tenantId,
      actor: event.actor,
      action: event.action,
      meta: event.meta,
    };
    const hash = chainHash(prev, record);

    const { rows } = await this._pool.query(
      `INSERT INTO otk_governance (ts, tenant_id, actor, action, meta, hash)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING seq`,
      [
        event.ts,
        event.tenantId,
        event.actor,
        event.action,
        event.meta ? JSON.stringify(event.meta) : null,
        hash,
      ],
    );

    const seq = rows[0]?.seq as number;
    return { ...event, seq, hash };
  }

  async list(opts?: { limit?: number; offset?: number }): Promise<GovernanceEntry[]> {
    await this.init();
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const { rows } = await this._pool.query(
      `SELECT seq, ts, tenant_id, actor, action, meta, hash
       FROM otk_governance
       ORDER BY seq ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map(r => this._toEntry(r));
  }

  async head(): Promise<string> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT hash FROM otk_governance ORDER BY seq DESC LIMIT 1`,
    );
    return rows.length > 0 ? (rows[0]!.hash as string) : GENESIS_HASH;
  }

  async count(): Promise<number> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT COUNT(*)::int AS cnt FROM otk_governance`,
    );
    return (rows[0]?.cnt as number) ?? 0;
  }

  async verifyIntegrity(): Promise<{ valid: boolean; brokenAt?: number }> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT seq, ts, tenant_id, actor, action, meta, hash FROM otk_governance ORDER BY seq ASC`,
    );
    let prev = GENESIS_HASH;
    for (const row of rows) {
      const entry = this._toEntry(row);
      const record = {
        ts: entry.ts,
        tenantId: entry.tenantId,
        actor: entry.actor,
        action: entry.action,
        meta: entry.meta,
      };
      const expected = chainHash(prev, record);
      if (expected !== entry.hash) {
        return { valid: false, brokenAt: entry.seq };
      }
      prev = entry.hash;
    }
    return { valid: true };
  }

  async clear(): Promise<void> {
    // SEC-07: Guard unbounded DELETE in production — requires explicit tenant scope
    if (isDeployedEnv()) {
      throw new Error('[SEC-07] PgGovernanceStore.clear() is not permitted in production. Use tenant-scoped operations.');
    }
    await this.init();
    await this._pool.query(`DELETE FROM otk_governance`);
  }

  private _toEntry(row: Record<string, unknown>): GovernanceEntry {
    return {
      seq: row.seq as number,
      ts: row.ts as string,
      tenantId: row.tenant_id as string,
      actor: row.actor as string,
      action: row.action as string as import('../../security/GovernanceTrail.js').GovernanceAction,
      meta: row.meta ? (typeof row.meta === 'string' ? JSON.parse(row.meta) : row.meta) as Record<string, unknown> : undefined,
      hash: row.hash as string,
    };
  }
}
