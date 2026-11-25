/**
 * PgGovernanceStore — PostgreSQL-backed IGovernanceStore (Wave 3A)
 *
 * Stores governance trail entries in PostgreSQL for cross-instance durability.
 * Table: otk_governance
 *
 * Each row stores `chainHash(previous hash, event)`, so the table is a hash chain starting at
 * sha256("governance-genesis"). Installed by `src/infra/storeBootstrap.ts`. Query errors propagate. `append`
 * reads the head and then inserts without a lock, so two concurrent appends can fork the chain (detected later by
 * `verifyIntegrity`).
 *
 * @module src/infra/pg/PgGovernanceStore
 * @since Wave 3A (PACK 3A-03)
 */

import type { IGovernanceStore } from '../../security/IGovernanceStore.js';
import type { GovernanceEvent, GovernanceEntry } from '../../security/GovernanceTrail.js';
import { sha256Hex, chainHash } from '../../security/AuditLogChain.js';
import { isDeployedEnv } from '../deployEnv.js'; // RV2-RUNS-02 (RUN-S): same rule as the auth guard

/** The part of a `pg.Pool` this store uses. */
export interface PgPool {
  /**
   * Runs one parameterized query.
   *
   * @param text - SQL text with `$n` placeholders.
   * @param params - Parameter values.
   * @returns The result rows.
   */
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

/** `IGovernanceStore` in the PostgreSQL table `otk_governance` (append-only hash chain). */
export class PgGovernanceStore implements IGovernanceStore {
  private readonly _pool: PgPool;
  private _initialized = false;

  /**
   * Wraps a pool; nothing is queried until the first call.
   *
   * @param pool - PostgreSQL pool.
   */
  constructor(pool: PgPool) {
    this._pool = pool;
  }

  /**
   * Creates the table and index if missing (idempotent, once per instance).
   *
   * @throws {Error} When a DDL statement fails.
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    await this._pool.query(CREATE_TABLE);
    await this._pool.query(CREATE_TS_INDEX);
    this._initialized = true;
  }

  /**
   * Appends one event to the chain.
   *
   * @param event - Governance event.
   * @param prevHash - Hash to chain from; the current head when omitted.
   * @returns The event with its sequence number and hash.
   */
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

  /**
   * Lists entries in chain order.
   *
   * @param opts - `limit` (default 100) and `offset` (default 0).
   * @returns The page of entries.
   */
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

  /**
   * Returns the hash of the last entry.
   *
   * @returns The head hash, or the genesis hash when the table is empty.
   */
  async head(): Promise<string> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT hash FROM otk_governance ORDER BY seq DESC LIMIT 1`,
    );
    return rows.length > 0 ? (rows[0]!.hash as string) : GENESIS_HASH;
  }

  /**
   * Counts entries.
   *
   * @returns Number of rows.
   */
  async count(): Promise<number> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT COUNT(*)::int AS cnt FROM otk_governance`,
    );
    return (rows[0]?.cnt as number) ?? 0;
  }

  /**
   * Recomputes the whole chain from genesis (reads every row).
   *
   * @returns `valid: true`, or `valid: false` with the sequence number of the first broken entry.
   */
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

  /**
   * Deletes every entry (tests only).
   *
   * @throws {Error} In a deployed environment (`isDeployedEnv()`).
   */
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
