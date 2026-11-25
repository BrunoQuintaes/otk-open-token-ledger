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
 * Receipts and reports are private (exact usage); this module never logs them. It does not verify
 * signatures: it only checks schema ids, envelope domain and digest binding.
 *
 * @module src/operations/receiptV3Store
 */
import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync } from 'node:fs';
import type { ConferenceReport, Hex32, OperationKey, PrivateReceiptV3, SignedEnvelope } from '../types/d1d8/index.js';
import { decodeConference, decodeReceiptV3, encodeJson } from './codec.js';
import type { PgQueryable } from './schema.js';

/** Thrown when a different receipt or report (different digest) is already stored for the same key. */
export class ReceiptConflictError extends Error {
  /**
   * Builds the error naming what conflicted and for which operation.
   *
   * @param what - `'receipt'` or `'conference report'`.
   * @param key - Tenant and operation id.
   */
  constructor(what: string, key: OperationKey) { super(`${what} for ${key.tenantId}/${key.operationId} differs from the stored one`); this.name = 'ReceiptConflictError'; }
}
/** Thrown when a schema id, envelope domain/digest, or receipt binding of a report is wrong. */
export class BindingMismatchError extends Error {
  /**
   * Builds the error.
   *
   * @param message - What did not match.
   */
  constructor(message: string) { super(message); this.name = 'BindingMismatchError'; }
}

/** A stored private receipt v3 with its signed envelope and digest. */
export interface StoredReceipt { receipt: PrivateReceiptV3; envelope: SignedEnvelope; digest: Hex32 }
/** A stored conference report with its signed envelope and digest. */
export interface StoredConference { report: ConferenceReport; envelope: SignedEnvelope; digest: Hex32 }

/** Storage contract shared by the PostgreSQL and JSONL implementations (rules in the file header). */
export interface ReceiptV3Store {
  /**
   * Stores a signed receipt once per key.
   *
   * @param receipt - The private receipt.
   * @param envelope - Its signed envelope (domain `OTK_PRIVATE_RECEIPT_V3`).
   * @param digest - Receipt digest computed by the crypto module.
   * @returns `'stored'`, or `'duplicate'` when the same digest is already stored.
   * @throws {@link BindingMismatchError} When the schema, envelope domain or envelope digest is wrong.
   * @throws {@link ReceiptConflictError} When a different receipt is stored for the key.
   */
  putReceipt(receipt: PrivateReceiptV3, envelope: SignedEnvelope, digest: Hex32): Promise<'stored' | 'duplicate'>;
  /**
   * Stores a signed conference report once per key, bound to the stored receipt.
   *
   * @param report - The conference report.
   * @param envelope - Its signed envelope (domain `OTK_CONFERENCE_V1`).
   * @param digest - Report digest.
   * @returns `'stored'` or `'duplicate'`.
   * @throws {@link BindingMismatchError} When the receipt is missing, the report names another receipt, or a
   *   schema/state/envelope check fails.
   * @throws {@link ReceiptConflictError} When a different report is stored for the key.
   */
  putConference(report: ConferenceReport, envelope: SignedEnvelope, digest: Hex32): Promise<'stored' | 'duplicate'>;
  /**
   * Reads a stored receipt.
   *
   * @param key - Tenant and operation id.
   * @returns The receipt, or `null` when absent.
   */
  getReceipt(key: OperationKey): Promise<StoredReceipt | null>;
  /**
   * Reads a stored conference report.
   *
   * @param key - Tenant and operation id.
   * @returns The report, or `null` when absent.
   */
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

/** PostgreSQL implementation over `otk_receipts_v3` and `otk_conferences`. */
export class PgReceiptV3Store implements ReceiptV3Store {
  /**
   * Binds the store to a database connection.
   *
   * @param pool - PostgreSQL pool (or client).
   */
  constructor(private readonly pool: PgQueryable) {}

  /** @inheritDoc */
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

  /** @inheritDoc */
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

  /** @inheritDoc */
  async getReceipt(key: OperationKey): Promise<StoredReceipt | null> {
    const r = await this.pool.query<{ receipt: unknown; envelope: SignedEnvelope; receipt_digest: string }>(
      'SELECT receipt, envelope, receipt_digest FROM otk_receipts_v3 WHERE tenant_id = $1 AND operation_id = $2',
      [key.tenantId, key.operationId],
    );
    const row = r.rows[0];
    return row ? { receipt: decodeReceiptV3(row.receipt), envelope: row.envelope, digest: row.receipt_digest as Hex32 } : null;
  }

  /** @inheritDoc */
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
 *
 * Single-process only (the in-memory index is not shared); appends are synchronous.
 */
export class JsonlReceiptV3Store implements ReceiptV3Store {
  private readonly receipts = new Map<string, StoredReceipt>();
  private readonly reports = new Map<string, StoredConference>();
  /** Lines that could not be parsed on open (torn tail after a crash). */
  readonly skippedLines: number;

  /**
   * Opens the store and replays the file synchronously (a missing file means an empty store).
   *
   * @param path - JSONL file path; created on the first write.
   */
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

  /** @inheritDoc */
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

  /** @inheritDoc */
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

  /** @inheritDoc */
  async getReceipt(key: OperationKey): Promise<StoredReceipt | null> { return this.receipts.get(k(key)) ?? null; }
  /** @inheritDoc */
  async getConference(key: OperationKey): Promise<StoredConference | null> { return this.reports.get(k(key)) ?? null; }
}
