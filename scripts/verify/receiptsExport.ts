/**
 * `otk receipts export`: tira os recibos v3 (e as conferências deles) do PostgreSQL do OTK para um
 * .jsonl no formato do JsonlReceiptV3Store ({kind, digest, envelope, receipt|report}), que o
 * `otk verify` e a página aceitam, mais um MANIFEST com contagem e sha256.
 *
 * Os objetos saem como estão no banco (JSONB, bigint já como texto decimal): o exportador não decodifica
 * nem recalcula nada, para que a verificação continue independente. Filtro por timing.admittedAt.
 */
import { ethers } from 'ethers';
import type { PgQueryable } from '../../src/operations/schema.js';

export const EXPORT_MANIFEST_SCHEMA = 'otk.receipts_export_manifest.v1' as const;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface ExportOptions { since: string; until: string; tenant?: string | null }

export interface ExportResult {
  fileName: string;
  jsonl: string;
  manifestName: string;
  manifest: string;
  receipts: number;
  conferences: number;
}

function nextDay(d: string): string {
  const t = new Date(`${d}T00:00:00.000Z`);
  if (Number.isNaN(t.getTime()) || t.toISOString().slice(0, 10) !== d) throw new Error(`data inválida: ${d}`);
  return new Date(t.getTime() + 86_400_000).toISOString().slice(0, 10);
}

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
