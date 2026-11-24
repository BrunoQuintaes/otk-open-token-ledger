/**
 * D1–D8 / C — persistence of private receipt v3 and conference report with their envelopes
 * (D3 §6–7, D3-G02/G03/G05/G06). PostgreSQL and JSONL implementations with the same rules:
 *
 *  - key = (tenantId, operationId); the same operation id in two tenants is two records;
 *  - same key + same digest = duplicate (no second row); same key + different digest = conflict;
 *  - the envelope must carry the expected domain and the stored digest (A computes digests);
 *  - a report is accepted only for the receipt of the same key whose digest it names
 *    (a report moved to another receipt is refused) — cryptographic verification of the
 *    envelope is A's verifyConference, called by consumers;
 *  - objects are stored whole (codec keeps unknown additive fields) and read back exactly.
 *
 * @module operations/receiptV3Store
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import type { ConferenceReport, Hex32, OperationKey, PrivateReceiptV3, SignedEnvelope } from '../types/d1d8/index.js';
import { decodeConference, decodeReceiptV3, encodeJson } from './codec.js';
import type { PgQueryable } from './schema.js';

export class ReceiptConflictError extends Error {
  constructor(what: string, key: OperationKey) { super(`${what} for ${key.tenantId}/${key.operationId} differs from the stored one`); this.name = 'ReceiptConflictError'; }
}
export class BindingMismatchError extends Error {
  constructor(message: string) { super(message); this.name = 'BindingMismatchError'; }
}

export interface StoredReceipt { receipt: PrivateReceiptV3; envelope: SignedEnvelope; digest: Hex32 }
export interface StoredConference { report: ConferenceReport; envelope: SignedEnvelope; digest: Hex32 }

export interface ReceiptV3Store {
  putReceipt(receipt: PrivateReceiptV3, envelope: SignedEnvelope, digest: Hex32): Promise<'stored' | 'duplicate'>;
  putConference(report: ConferenceReport, envelope: SignedEnvelope, digest: Hex32): Promise<'stored' | 'duplicate'>;
  getReceipt(key: OperationKey): Promise<StoredReceipt | null>;
  getConference(key: OperationKey): Promise<StoredConference | null>;
}

function checkEnvelope(env: SignedEnvelope, domain: SignedEnvelope['domain'], digest: Hex32): void {
  if (env.schema !== 'otk.envelope.v1') throw new BindingMismatchError(`unsupported envelope schema ${String(env.schema)}`);
  if (env.domain !== domain) throw new BindingMismatchError(`envelope domain ${env.domain}, expected ${domain}`);
  if (env.payloadDigest.toLowerCase() !== digest.toLowerCase()) throw new BindingMismatchError('envelope payloadDigest differs from the stored digest');
}

function checkReceipt(r: PrivateReceiptV3): void {
  if (r.schema !== 'otk.receipt.v3') throw new BindingMismatchError(`unsupported receipt schema ${String(r.schema)}`);
}
function checkReport(rep: ConferenceReport): void {
  if (rep.schema !== 'otk.conference.v1') throw new BindingMismatchError(`unsupported conference schema ${String(rep.schema)}`);
  if (rep.state !== 'compared' && rep.verdict !== 'not_applicable') {
    // only 'compared' may carry a divergence verdict (D3 §4, D3-G05)
    throw new BindingMismatchError(`state ${rep.state} cannot carry verdict ${rep.verdict}`);
  }
}

export class PgReceiptV3Store implements ReceiptV3Store {
  constructor(private readonly pool: PgQueryable) {}

  async putReceipt(receipt: PrivateReceiptV3, envelope: SignedEnvelope, digest: Hex32): Promise<'stored' | 'duplicate'> {
    checkReceipt(receipt);
    checkEnvelope(envelope, 'OTK_PRIVATE_RECEIPT_V3', digest);
    const ins = await this.pool.query(
      `INSERT INTO otk_receipts_v3 (tenant_id, operation_id, schema, source, receipt_digest, receipt, envelope)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) ON CONFLICT (tenant_id, operation_id) DO NOTHING`,
      [receipt.key.tenantId, receipt.key.operationId, receipt.schema, receipt.source, digest, encodeJson(receipt), encodeJson(envelope)],
    );
    if ((ins.rowCount ?? 0) === 1) return 'stored';
    const cur = await this.getReceipt(receipt.key);
    if (cur?.digest !== digest) throw new ReceiptConflictError('receipt', receipt.key);
    return 'duplicate';
  }

  async putConference(report: ConferenceReport, envelope: SignedEnvelope, digest: Hex32): Promise<'stored' | 'duplicate'> {
    checkReport(report);
    checkEnvelope(envelope, 'OTK_CONFERENCE_V1', digest);
    const rec = await this.getReceipt(report.key);
    if (!rec) throw new BindingMismatchError(`no receipt stored for ${report.key.tenantId}/${report.key.operationId}`);
    if (rec.digest.toLowerCase() !== report.receiptDigest.toLowerCase()) throw new BindingMismatchError('report.receiptDigest names another receipt');
    const ins = await this.pool.query(
      `INSERT INTO otk_conferences (tenant_id, operation_id, schema, receipt_digest, state, verdict, report_digest, report, envelope)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb) ON CONFLICT (tenant_id, operation_id) DO NOTHING`,
      [report.key.tenantId, report.key.operationId, report.schema, rec.digest, report.state, report.verdict, digest, encodeJson(report), encodeJson(envelope)],
    );
    if ((ins.rowCount ?? 0) === 1) return 'stored';
    const cur = await this.getConference(report.key);
    if (cur?.digest !== digest) throw new ReceiptConflictError('conference report', report.key);
    return 'duplicate';
  }

  async getReceipt(key: OperationKey): Promise<StoredReceipt | null> {
    const r = await this.pool.query<{ receipt: unknown; envelope: SignedEnvelope; receipt_digest: string }>(
      'SELECT receipt, envelope, receipt_digest FROM otk_receipts_v3 WHERE tenant_id = $1 AND operation_id = $2',
      [key.tenantId, key.operationId],
    );
    const row = r.rows[0];
    return row ? { receipt: decodeReceiptV3(row.receipt), envelope: row.envelope, digest: row.receipt_digest as Hex32 } : null;
  }

  async getConference(key: OperationKey): Promise<StoredConference | null> {
    const r = await this.pool.query<{ report: unknown; envelope: SignedEnvelope; report_digest: string }>(
      'SELECT report, envelope, report_digest FROM otk_conferences WHERE tenant_id = $1 AND operation_id = $2',
      [key.tenantId, key.operationId],
    );
    const row = r.rows[0];
    return row ? { report: decodeConference(row.report), envelope: row.envelope, digest: row.report_digest as Hex32 } : null;
  }
}

const k = (key: OperationKey): string => JSON.stringify([key.tenantId, key.operationId]);

/**
 * JSONL implementation: one append-only file, each line fsync'd before put() resolves. The file
 * is replayed on open; a torn last line (crash during append) is ignored and reported.
 */
export class JsonlReceiptV3Store implements ReceiptV3Store {
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly reports = new Map<string, StoredConference>();
  /** Lines that could not be parsed on open (torn tail after a crash). */
  readonly skippedLines: number;

  constructor(private readonly path: string) {
    let skipped = 0;
    if (existsSync(path)) {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { kind: string; digest: Hex32; envelope: SignedEnvelope; receipt?: unknown; report?: unknown };
          if (rec.kind === 'receipt') {
            const receipt = decodeReceiptV3(rec.receipt);
            this.receipts.set(k(receipt.key), { receipt, envelope: rec.envelope, digest: rec.digest });
          } else if (rec.kind === 'conference') {
            const report = decodeConference(rec.report);
            this.reports.set(k(report.key), { report, envelope: rec.envelope, digest: rec.digest });
          } else skipped++;
        } catch { skipped++; }
      }
    }
    this.skippedLines = skipped;
  }

  private append(line: string): void {
    const fd = openSync(this.path, 'a');
    try {
      appendFileSync(fd, line + '\n', 'utf8');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  async putReceipt(receipt: PrivateReceiptV3, envelope: SignedEnvelope, digest: Hex32): Promise<'stored' | 'duplicate'> {
    checkReceipt(receipt);
    checkEnvelope(envelope, 'OTK_PRIVATE_RECEIPT_V3', digest);
    const cur = this.receipts.get(k(receipt.key));
    if (cur) {
      if (cur.digest !== digest) throw new ReceiptConflictError('receipt', receipt.key);
      return 'duplicate';
    }
    this.append(encodeJson({ kind: 'receipt', digest, envelope, receipt }));
    this.receipts.set(k(receipt.key), { receipt: decodeReceiptV3(JSON.parse(encodeJson(receipt))), envelope, digest });
    return 'stored';
  }

  async putConference(report: ConferenceReport, envelope: SignedEnvelope, digest: Hex32): Promise<'stored' | 'duplicate'> {
    checkReport(report);
    checkEnvelope(envelope, 'OTK_CONFERENCE_V1', digest);
    const rec = this.receipts.get(k(report.key));
    if (!rec) throw new BindingMismatchError(`no receipt stored for ${report.key.tenantId}/${report.key.operationId}`);
    if (rec.digest.toLowerCase() !== report.receiptDigest.toLowerCase()) throw new BindingMismatchError('report.receiptDigest names another receipt');
    const cur = this.reports.get(k(report.key));
    if (cur) {
      if (cur.digest !== digest) throw new ReceiptConflictError('conference report', report.key);
      return 'duplicate';
    }
    this.append(encodeJson({ kind: 'conference', digest, envelope, report }));
    this.reports.set(k(report.key), { report: decodeConference(JSON.parse(encodeJson(report))), envelope, digest });
    return 'stored';
  }

  async getReceipt(key: OperationKey): Promise<StoredReceipt | null> { return this.receipts.get(k(key)) ?? null; }
  async getConference(key: OperationKey): Promise<StoredConference | null> { return this.reports.get(k(key)) ?? null; }
}
