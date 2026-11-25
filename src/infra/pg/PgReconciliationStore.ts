/**
 * PgReconciliationStore — PostgreSQL-backed reconciliation report store (E6.3)
 *
 * Persists ReconciliationReport from ReconciliationScheduler to the
 * `receipt_reconciliation` table (migration 007).
 *
 * The table is created by the SQL migration, not by this class. Report ids are `recon-<epoch ms>-<per-process
 * counter>`. Line items are stored as JSON text with `JSON.stringify`, which cannot serialize the bigint `otkCU`
 * field: at the evaluated version a report with at least one platform receipt makes `save` throw. No code in
 * `src/` constructs this store at the evaluated version.
 *
 * @module src/infra/pg/PgReconciliationStore
 * @since Wave 5 (W5-5B02 / E6.3)
 */

import type { ReconciliationReport } from '../../economics/ReconciliationSystem.js';

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

/** A reconciliation report as stored, with its id and who triggered the run. */
export interface StoredReconciliationReport extends ReconciliationReport {
  /** Report id. */
  id: string;
  /** `scheduler`, `manual` or another label given by the caller. */
  runBy: string;
}

/** Reconciliation report store in the PostgreSQL table `receipt_reconciliation`. */
export class PgReconciliationStore {
  private readonly _pool: PgPool;
  private _counter = 0;

  /**
   * Wraps a pool; nothing is queried here.
   *
   * @param pool - PostgreSQL pool.
   */
  constructor(pool: PgPool) {
    this._pool = pool;
  }

  /**
   * Inserts one report.
   *
   * @param report - Report from `reconcile()`.
   * @param runBy - Label of who triggered the run (default `scheduler`).
   * @returns The report with its new id.
   * @throws {TypeError} When a line item holds a bigint (see the module comment).
   * @throws {Error} When the insert fails.
   */
  async save(report: ReconciliationReport, runBy = 'scheduler'): Promise<StoredReconciliationReport> {
    this._counter++;
    const id = `recon-${Date.now()}-${this._counter}`;
    await this._pool.query(
      `INSERT INTO receipt_reconciliation
         (id, generated_at, total_otk, total_external, matched, otk_only, external_only, items_json, run_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        id,
        report.generatedAt,
        report.totalOTK,
        report.totalExternal,
        report.matched,
        report.otkOnly,
        report.externalOnly,
        JSON.stringify(report.items),
        runBy,
      ],
    );
    return { ...report, id, runBy };
  }

  /**
   * Lists the most recent reports.
   *
   * @param limit - Maximum reports (default 20).
   * @returns Reports, newest `generated_at` first.
   */
  async list(limit = 20): Promise<StoredReconciliationReport[]> {
    const { rows } = await this._pool.query(
      `SELECT id, generated_at, total_otk, total_external, matched, otk_only, external_only, items_json, run_by
       FROM receipt_reconciliation
       ORDER BY generated_at DESC
       LIMIT $1`,
      [limit],
    );
    return rows.map(r => this._fromRow(r));
  }

  /**
   * Reads one report.
   *
   * @param id - Report id.
   * @returns The report, or null when unknown.
   */
  async getById(id: string): Promise<StoredReconciliationReport | null> {
    const { rows } = await this._pool.query(
      `SELECT id, generated_at, total_otk, total_external, matched, otk_only, external_only, items_json, run_by
       FROM receipt_reconciliation
       WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return this._fromRow(rows[0]);
  }

  private _fromRow(r: Record<string, unknown>): StoredReconciliationReport {
    return {
      id: r['id'] as string,
      generatedAt: r['generated_at'] as string,
      totalOTK: r['total_otk'] as number,
      totalExternal: r['total_external'] as number,
      matched: r['matched'] as number,
      otkOnly: r['otk_only'] as number,
      externalOnly: r['external_only'] as number,
      items: JSON.parse(r['items_json'] as string),
      runBy: r['run_by'] as string,
    };
  }
}
