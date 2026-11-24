/**
 * PgReconciliationStore — PostgreSQL-backed reconciliation report store (E6.3)
 *
 * Persists ReconciliationReport from ReconciliationScheduler to the
 * `receipt_reconciliation` table (migration 007).
 *
 * @module infra/pg/PgReconciliationStore
 * @since Wave 5 (W5-5B02 / E6.3)
 */

import type { ReconciliationReport } from '../../economics/ReconciliationSystem.js';

export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export interface StoredReconciliationReport extends ReconciliationReport {
  id: string;
  runBy: string;
}

export class PgReconciliationStore {
  private readonly _pool: PgPool;
  private _counter = 0;

  constructor(pool: PgPool) {
    this._pool = pool;
  }

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
