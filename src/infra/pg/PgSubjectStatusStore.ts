/**
 * PgSubjectStatusStore — PostgreSQL-backed ISubjectStatusStore (H1 lane B, S04 residual)
 *
 * Authoritative, cross-replica status of deactivated tenants and deprovisioned users (auth/subjectStatus keeps a
 * synchronous cache refreshed from here with bounded staleness). One row per subject that was ever deactivated.
 * Table: otk_subject_status. The "not before" instants only grow (GREATEST), so a late or replayed write never
 * re-validates old credentials; the inactive flag is last-writer-wins.
 *
 * Installed by `src/infra/storeBootstrap.ts`. Every method first runs `init()`. Query errors propagate. Times are
 * Unix seconds (fractions are floored on write).
 *
 * @module src/infra/pg/PgSubjectStatusStore
 */

import type { ISubjectStatusStore, SubjectStatusRecord, SubjectKind } from '../../auth/subjectStatus.js';

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

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS otk_subject_status (
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  inactive BOOLEAN NOT NULL,
  not_before_s BIGINT NOT NULL DEFAULT 0,
  keys_not_before_s BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (kind, id)
)`;

/** `ISubjectStatusStore` in the PostgreSQL table `otk_subject_status`. */
export class PgSubjectStatusStore implements ISubjectStatusStore {
  private _initialized = false;
  /**
   * Wraps a pool; nothing is queried until the first call.
   *
   * @param _pool - PostgreSQL pool.
   */
  constructor(private readonly _pool: PgPool) {}

  /**
   * Creates the table if missing (idempotent, once per instance).
   *
   * @throws {Error} When the DDL statement fails.
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    await this._pool.query(CREATE_TABLE);
    this._initialized = true;
  }

  /**
   * Upserts a subject's status; "not before" instants never move back, `inactive` is overwritten.
   *
   * @param rec - Kind, id, inactive flag and "not before" instants in Unix seconds.
   */
  async put(rec: SubjectStatusRecord): Promise<void> {
    await this.init();
    await this._pool.query(
      `INSERT INTO otk_subject_status (kind, id, inactive, not_before_s, keys_not_before_s, updated_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (kind, id) DO UPDATE SET
         inactive = EXCLUDED.inactive,
         not_before_s = GREATEST(otk_subject_status.not_before_s, EXCLUDED.not_before_s),
         keys_not_before_s = GREATEST(otk_subject_status.keys_not_before_s, EXCLUDED.keys_not_before_s),
         updated_at = NOW()`,
      [rec.kind, rec.id, rec.inactive, Math.floor(rec.notBeforeS), Math.floor(rec.keysNotBeforeS)],
    );
  }

  /**
   * Reads every stored subject status.
   *
   * @returns All rows with a known kind (`tenant` or `user`).
   */
  async listAll(): Promise<SubjectStatusRecord[]> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT kind, id, inactive, not_before_s, keys_not_before_s FROM otk_subject_status`,
    );
    return this._map(rows);
  }

  /**
   * H1R2 A3: rows of the given subjects only (primary-key lookups), for the per-request authoritative check.
   *
   * @param subjects - Kind and id of each subject to read.
   * @returns The rows found (subjects never deactivated have none).
   */
  async getMany(subjects: ReadonlyArray<{ kind: SubjectKind; id: string }>): Promise<SubjectStatusRecord[]> {
    await this.init();
    if (subjects.length === 0) return [];
    const { rows } = await this._pool.query(
      `SELECT s.kind, s.id, s.inactive, s.not_before_s, s.keys_not_before_s
         FROM otk_subject_status s
         JOIN unnest($1::text[], $2::text[]) AS w(kind, id) ON s.kind = w.kind AND s.id = w.id`,
      [subjects.map((x) => x.kind), subjects.map((x) => x.id)],
    );
    return this._map(rows);
  }

  // Drops rows with an unknown kind or a non-string id instead of failing the whole read.
  private _map(rows: Record<string, unknown>[]): SubjectStatusRecord[] {
    const out: SubjectStatusRecord[] = [];
    for (const r of rows) {
      const kind = r.kind === 'tenant' || r.kind === 'user' ? (r.kind as SubjectKind) : null;
      if (!kind || typeof r.id !== 'string') continue;
      out.push({
        kind,
        id: r.id,
        inactive: r.inactive === true,
        // BIGINT arrives as a string from node-postgres
        notBeforeS: Number(r.not_before_s) || 0,
        keysNotBeforeS: Number(r.keys_not_before_s) || 0,
      });
    }
    return out;
  }
}
