/**
 * `otk receipts export`: tira os recibos v3 (e as conferências deles) do PostgreSQL do OTK para um
 * .jsonl no formato do JsonlReceiptV3Store ({kind, digest, envelope, receipt|report}), que o
 * `otk verify` e a página aceitam, mais um MANIFEST com contagem e sha256.
 *
 * Os objetos saem como estão no banco (JSONB, bigint já como texto decimal): o exportador não decodifica
 * nem recalcula nada, para que a verificação continue independente. Filtro por timing.admittedAt.
 *
 * English summary: exports v3 receipts and their conference reports from OTK's PostgreSQL tables
 * (`otk_receipts_v3`, `otk_conferences`) to a JSONL file that `otk verify` and the verifier web page accept, plus a
 * manifest with counts and the file's sha256. Rows are copied as stored (nothing decoded or recomputed), so the
 * verification stays independent of this exporter. Used by the `receipts export` command of `otk.ts`; it only
 * runs two read-only queries and returns the text (the caller writes the files).
 *
 * @module scripts/verify/receiptsExport
 */
import { ethers } from 'ethers';
import type { PgQueryable } from '../../src/operations/schema.js';

/** Schema id written into the export manifest. */
export const EXPORT_MANIFEST_SCHEMA = 'otk.receipts_export_manifest.v1' as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Export window and optional tenant filter. `since` and `until` are UTC calendar days (YYYY-MM-DD), both inclusive;
 * `tenant` null/undefined means every tenant.
 */
export interface ExportOptions { since: string; until: string; tenant?: string | null }

/** Export output, ready to be written by the caller. */
export interface ExportResult {
  /** `recibos_<since>_<until>[_<tenant>].jsonl` (tenant sanitized to `[A-Za-z0-9._-]`). */
  fileName: string;
  /** One JSON object per line (receipts first, then conferences); empty string when nothing matched. */
  jsonl: string;
  /** `MANIFEST_<since>_<until>[_<tenant>].json`. */
  manifestName: string;
  /** Manifest JSON text: window, tenant, file name, sha256 (hex) of `jsonl`, counts. */
  manifest: string;
  /** Number of receipt lines. */
  receipts: number;
  /** Number of conference lines. */
  conferences: number;
}

/**
 * Next UTC calendar day of a date.
 *
 * @param d - Day as YYYY-MM-DD.
 * @returns The following day as YYYY-MM-DD.
 * @throws {Error} On an impossible date such as 2026-02-30.
 */
function nextDay(d: string): string {
  const t = new Date(`${d}T00:00:00.000Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) throw new Error(`data inválida: ${d}`);
  return new Date(t.getTime() + 86_400_000).toISOString().slice(0, 10);
}

/**
 * Reads the receipts admitted in the window (by `receipt.timing.admittedAt`, UTC) and their conferences.
 *
 * @param pool - Open PostgreSQL connection or pool (only read; not closed here).
 * @param o - Window and tenant filter.
 * @returns File names, file contents and counts.
 * @throws {Error} When `since`/`until` are not YYYY-MM-DD, `since` is after `until`, `until` is not a real date,
 *   or a query fails (the driver error is passed on; `otk.ts` hides its message).
 */
export async function exportReceipts(pool: PgQueryable, o: ExportOptions): Promise<ExportResult> {
  if (!DAY.test(o.since) || !DAY.test(o.until)) throw new Error('--since e --until devem ser AAAA-MM-DD');
  if (o.since > o.until) throw new Error('--since depois de --until');
  const from = `${o.since}T00:00:00.000Z`;
  const to = `${nextDay(o.until)}T00:00:00.000Z`;
  const tenant = o.tenant ?? null;
  const where = `(r.receipt->'timing'->>'admittedAt') >= $1 AND (r.receipt->'timing'->>'admittedAt') < $2 AND ($3::text IS NULL OR r.tenant_id = $3)`;
  const rec = await pool.query<{ tenant_id: string; operation_id: string; receipt_digest: string; receipt: unknown; envelope: unknown }>(
    `SELECT r.tenant_id, r.operation_id, r.receipt_digest, r.receipt, r.envelope FROM otk_receipts_v3 r WHERE ${where} ORDER BY r.tenant_id, r.operation_id`,
    [from, to, tenant],
  );
  const conf = await pool.query<{ tenant_id: string; operation_id: string; report_digest: string; report: unknown; envelope: unknown }>(
    `SELECT c.tenant_id, c.operation_id, c.report_digest, c.report, c.envelope FROM otk_conferences c JOIN otk_receipts_v3 r ON r.tenant_id = c.tenant_id AND r.operation_id = c.operation_id WHERE ${where} ORDER BY c.tenant_id, c.operation_id`,
    [from, to, tenant],
  );
  const lines: string[] = [];
  for (const r of rec.rows) lines.push(JSON.stringify({ kind: 'receipt', digest: r.receipt_digest, envelope: r.envelope, receipt: r.receipt }));
  for (const c of conf.rows) lines.push(JSON.stringify({ kind: 'conference', digest: c.report_digest, envelope: c.envelope, report: c.report }));
  const jsonl = lines.length ? lines.join('\n') + '\n' : '';
  const suffix = tenant ? `_${tenant.replace(/[^A-Za-z0-9._-]/g, '_')}` : '';
  const fileName = `recibos_${o.since}_${o.until}${suffix}.jsonl`;
  const manifestName = `MANIFEST_${o.since}_${o.until}${suffix}.json`;
  const manifest = JSON.stringify({
    schema: EXPORT_MANIFEST_SCHEMA,
    periodo: { since: o.since, until: o.until, campo: 'receipt.timing.admittedAt (UTC)' },
    tenant,
    arquivo: fileName,
    sha256: ethers.sha256(ethers.toUtf8Bytes(jsonl)).slice(2),
    recibos: rec.rows.length,
    conferencias: conf.rows.length,
    aviso: 'O MANIFEST só ajuda a conferir que o arquivo chegou inteiro; ele não prova nada sobre os recibos. Quem prova é o otk verify com o chaveiro ancorado.',
  }, null, 2) + '\n';
  return { fileName, jsonl, manifestName, manifest, receipts: rec.rows.length, conferences: conf.rows.length };
}
