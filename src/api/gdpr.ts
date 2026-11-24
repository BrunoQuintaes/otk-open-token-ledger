/**
 * GDPR Handler — Data export + right-to-erasure (E5.5 + E5.6)
 *
 * Endpoints (wired in routes.ts):
 *   GET  /v1/admin/gdpr/export/:tenantId  — export all tenant data as JSON or CSV
 *   DELETE /v1/admin/gdpr/erase/:tenantId — soft-erase all tenant receipts
 *
 * Auth: OWNER role required (admin:gdpr permission).
 *
 * Export response:
 *   JSON (default): { tenant, receipts[], auditLog[], exportedAt }
 *   CSV (?format=csv): flat CSV of receipt fields
 *
 * Erasure:
 *   - Delegated to the configured IGdprStore (eraseReceiptsForTenant): soft-erase of the tenant receipts
 *   - tombstoneHash = SHA-256 of the data seen before erasure (returned to the caller; persisting it is the store's job)
 *   - H1-S23: an audit log entry `gdpr_erasure` (tenant, count, tombstone hash, request id) is written for every erasure,
 *     and `gdpr_erasure_refused` when it is refused
 *   - H1-S23 (S23-F01): with no store configured (setGdprStore never called) the erasure is REFUSED with 501
 *     `gdpr_store_not_configured`; before, the in-memory fallback answered ok:true / erasedCount 0, a false
 *     confirmation of erasure.
 *
 * Export (H1R2 S23-F02): the export reads ALL the receipts of the tenant held by the receipt store (memory + every
 * page of PostgreSQL, src/api/receiptStore.ts listReceiptsForTenant) merged with the configured GDPR store, if any
 * (dedup by requestId). Before, it read only the GDPR store, never configured in src/: 200 with empty lists while
 * the receipt store held receipts of the tenant. A configured source that cannot be read → 503
 * `export_source_unavailable` (never a partial list presented as complete). Header `x-otk-export-sources` lists the
 * sources read. Read-only: nothing is modified (signed receipts, hashes and the audit chain are untouched).
 *
 * @module api/gdpr
 * @since Wave 4 (4B-PACK-4B04 / E5.5+E5.6)
 */

import { escapeHtml } from '../dashboard/sanitize.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { sendJson } from './errors.js';
import { getEmailAdapter } from '../email/IEmailAdapter.js';
import { getGdprNotifyEmail } from '../infra/secretsBootstrap.js';
import { getLogger } from '../infra/logging/StructuredLogger.js';
import type { RawReceipt } from '../types/receipt.js';

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export interface GdprReceipt {
  id: string;
  tenantId: string;
  userId?: string;
  costUnits?: number;
  timestamp?: number;
  requestId?: string;
  erased?: boolean;
}

export interface GdprExportResult {
  tenant: string;
  receipts: GdprReceipt[];
  auditLog: unknown[];
  exportedAt: string;
}

export interface GdprEraseResult {
  ok: boolean;
  tenantId: string;
  erasedCount: number;
  tombstoneHash: string;
  erasedAt: string;
}

/** Minimal store interface for GDPR operations */
export interface IGdprStore {
  getReceiptsForTenant(tenantId: string): Promise<GdprReceipt[]>;
  eraseReceiptsForTenant(tenantId: string): Promise<{ erasedCount: number }>;
  getAuditLogForTenant?(tenantId: string): Promise<unknown[]>;
}

// ──────────────────────────────────────────────────────────
// In-memory fallback store (when DB not configured)
// ──────────────────────────────────────────────────────────

const _inMemoryStore: IGdprStore = {
  async getReceiptsForTenant(_tenantId: string): Promise<GdprReceipt[]> {
    return []; // No in-memory receipts for GDPR export
  },
  async eraseReceiptsForTenant(_tenantId: string): Promise<{ erasedCount: number }> {
    return { erasedCount: 0 };
  },
  async getAuditLogForTenant(_tenantId: string): Promise<unknown[]> {
    return [];
  },
};

let _store: IGdprStore = _inMemoryStore;
/** H1-S23: true once a real store was configured; the in-memory fallback cannot erase anything. */
let _configured = false;

export function setGdprStore(store: IGdprStore): void {
  _store = store;
  _configured = true;
}

/** True when a GDPR store was configured (setGdprStore); false = in-memory fallback, which holds no data. */
export function isGdprStoreConfigured(): boolean {
  return _configured;
}

/** Back to the in-memory fallback, not configured (tests). */
export function resetGdprStoreForTest(): void {
  _store = _inMemoryStore;
  _configured = false;
}

export function getGdprStore(): IGdprStore {
  return _store;
}

// ──────────────────────────────────────────────────────────
// H1R2 S23-F02: complete receipt source of an export
// ──────────────────────────────────────────────────────────

/** Exported view of a receipt-store receipt (the documented GdprReceipt field set; bigint userId as string). */
export function receiptToGdpr(r: RawReceipt): GdprReceipt {
  return {
    id: r.requestId,
    tenantId: r.tenantId ?? 'default',
    userId: String(r.userId),
    costUnits: r.costUnits,
    timestamp: r.timestamp,
    requestId: r.requestId,
  };
}

/** CSV of exported receipts (fixed header). */
/**
 * H1R2 review INFO-3: one CSV cell (RFC 4180 quoting; a leading = + - @ tab or CR is prefixed with ' so that a
 * spreadsheet does not evaluate it as a formula). Plain values are unchanged.
 */
export function csvCell(v: unknown): string {
  let t = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(t) && !/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(t)) t = `'${t}`;
  return /[",\r\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
}

export function gdprReceiptsCsv(receipts: GdprReceipt[]): string {
  const header = 'id,tenantId,userId,costUnits,timestamp,requestId\n';
  const rows = receipts.map(r =>
    [r.id, r.tenantId, r.userId ?? '', r.costUnits ?? '', r.timestamp ?? '', r.requestId ?? ''].map(csvCell).join(',')
  ).join('\n');
  return header + rows;
}

/**
 * All receipts of a tenant: the configured GDPR store (if any) merged with the WHOLE receipt store (memory + every
 * PostgreSQL page), dedup by requestId (GDPR store rows win: they carry `erased`). Read-only. Throws
 * ExportSourceUnavailableError when a configured source cannot be read.
 */
export async function collectTenantReceipts(tenantId: string): Promise<{ receipts: GdprReceipt[]; sources: string[] }> {
  const { listReceiptsForTenant } = await import('./receiptStore.js');
  const fromStore = await listReceiptsForTenant(tenantId);
  const byKey = new Map<string, GdprReceipt>();
  const sources: string[] = [];
  if (_configured) {
    for (const r of await _store.getReceiptsForTenant(tenantId)) {
      if (r.tenantId === tenantId) byKey.set(r.requestId ?? r.id, r);
    }
    sources.push('gdpr_store');
  }
  for (const r of fromStore.receipts) {
    if ((r.tenantId ?? 'default') === tenantId && !byKey.has(r.requestId)) byKey.set(r.requestId, receiptToGdpr(r));
  }
  return { receipts: [...byKey.values()], sources: [...sources, ...fromStore.sources] };
}

// ──────────────────────────────────────────────────────────
// Export handler
// ──────────────────────────────────────────────────────────

/**
 * Handle GET /v1/admin/gdpr/export/:tenantId
 *
 * Returns JSON or CSV of all tenant receipt data.
 * Sends GDPR notification email after successful export.
 */
export async function handleGdprExport(
  req: IncomingMessage,
  res: ServerResponse,
  tenantId: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://localhost`);
  const format = url.searchParams.get('format') ?? 'json';

  let collected: { receipts: GdprReceipt[]; sources: string[] };
  try {
    collected = await collectTenantReceipts(tenantId);
  } catch (err) {
    // H1R2 S23-F02: an unreadable source is an error, not an empty or partial export
    const requestId = typeof res.getHeader === 'function' ? res.getHeader('x-request-id') : undefined;
    getLogger().warn('gdpr_export_refused', { tenantId, reason: 'export_source_unavailable', error: (err as Error).message, requestId });
    sendJson(res, 503, { ok: false, error: 'export_source_unavailable', detail: 'a receipt source could not be read; nothing was exported (retry)' });
    return;
  }
  const receipts = collected.receipts;
  if (typeof res.setHeader === 'function') res.setHeader('x-otk-export-sources', collected.sources.join(','));
  const auditLog = _store.getAuditLogForTenant
    ? await _store.getAuditLogForTenant(tenantId)
    : [];

  const exportedAt = new Date().toISOString();

  // Send GDPR notification email (non-blocking, non-fatal). STOPGATE-01 P1.4 (S23-F04): the recipient used to be a fixed
  // address of an external domain (the tenant id left the operator's control whenever SMTP was configured); it is now
  // the operator's OTK_GDPR_NOTIFY_EMAIL, and nothing is sent without it.
  const notifyTo = getGdprNotifyEmail();
  const emailAdapter = notifyTo ? getEmailAdapter() : null;
  void emailAdapter?.send({
    to: notifyTo!,
    subject: `GDPR Data Export — Tenant ${tenantId}`,
    text: `GDPR data export completed for tenant ${tenantId} at ${exportedAt}. Receipts: ${receipts.length}.`,
    html: `<p>${escapeHtml(`GDPR data export completed for tenant ${tenantId} at ${exportedAt}. Receipts: ${receipts.length}.`)}</p>`,
  }).catch(() => { /* non-fatal */ });

  if (format === 'csv') {
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': `attachment; filename="gdpr_export_${tenantId}.csv"` });
    res.end(gdprReceiptsCsv(receipts));
    return;
  }

  const result: GdprExportResult = {
    tenant: tenantId,
    receipts,
    auditLog,
    exportedAt,
  };

  sendJson(res, 200, result);
}

// ──────────────────────────────────────────────────────────
// Erasure handler
// ──────────────────────────────────────────────────────────

/**
 * Handle DELETE /v1/admin/gdpr/erase/:tenantId
 *
 * Soft-erases all tenant receipts. Stores tombstone hash for chain integrity.
 */
export async function handleGdprErase(
  _req: IncomingMessage,
  res: ServerResponse,
  tenantId: string,
): Promise<void> {
  const requestId = typeof res.getHeader === 'function' ? res.getHeader('x-request-id') : undefined;
  if (!_configured) {
    // S23-F01: nothing would be erased; refuse instead of confirming an erasure that did not happen
    getLogger().warn('gdpr_erasure_refused', { tenantId, reason: 'gdpr_store_not_configured', requestId });
    sendJson(res, 501, { ok: false, error: 'gdpr_store_not_configured', detail: 'no GDPR store is configured in this deployment; nothing was erased' });
    return;
  }
  const receipts = await _store.getReceiptsForTenant(tenantId);

  // Compute tombstone hash from the original data before erasure
  const dataForHash = JSON.stringify({ tenantId, receipts, erasureRequest: new Date().toISOString() });
  const tombstoneHash = crypto.createHash('sha256').update(dataForHash).digest('hex');

  const { erasedCount } = await _store.eraseReceiptsForTenant(tenantId);
  const erasedAt = new Date().toISOString();
  // H1-S23: audit trail of the erasure (identifiers and counts only, no receipt content)
  getLogger().info('gdpr_erasure', { tenantId, erasedCount, tombstoneHash, erasedAt, requestId });

  const result: GdprEraseResult = {
    ok: true,
    tenantId,
    erasedCount,
    tombstoneHash,
    erasedAt,
  };

  sendJson(res, 200, result);
}
