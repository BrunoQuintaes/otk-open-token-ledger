/**
 * dataExport.ts — Async tenant data export handler (NEW-4.01 / GDPR Art. 20)
 *
 * Provides async job pattern for tenant data export:
 *   POST /v1/data/export      → create export job → { jobId, status: 'pending' }
 *   GET  /v1/data/export/status/:jobId → poll status → when done, returns data
 *
 * H1R2 S23-F03: the job was a stub that always finished with { records: [], count: 0 } (a false success). Now:
 *   - the job reads ALL the receipts of the caller tenant (gdpr.ts collectTenantReceipts: receipt store memory +
 *     every PostgreSQL page, plus the GDPR store when configured) — read-only, nothing is modified;
 *   - the result states its scope (`scope: ['receipts']`) and what it does NOT contain (`notIncluded`);
 *   - `?type=` other than `receipts` (a data type with no export implementation) → 501 `export_type_not_implemented`;
 *   - `?format=` other than json/csv → 400 OTK-4004 (before: accepted and echoed); csv adds `data.csv`;
 *   - a source that cannot be read → job `failed` with `error: 'export_source_unavailable'` (never an empty `done`).
 *   The minimum role (M24-DYN-08) is a pending product decision and is NOT changed here.
 *
 * Where it sits: the export routes in `src/api/routes.ts` call `handleCreateExportJob` and
 * `handleExportJobStatus`; the receipts come from `src/api/gdpr.ts`. Jobs live only in this process's memory,
 * so a status poll must reach the same replica and jobs are lost on restart.
 *
 * Environment variables read: `OTK_EXPORT_JOB_TTL_MS` (finished-job lifetime, ms; default 3 600 000) and
 * `OTK_EXPORT_MAX_JOBS` (jobs kept per process; default 1000).
 *
 * @module src/api/dataExport
 * @since Wave 4 (4C-PACK-4C03 / NEW-4.01)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { sendJson, sendError } from './errors.js';
import { collectTenantReceipts, gdprReceiptsCsv, type GdprReceipt } from './gdpr.js';

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

/** Lifecycle of an export job. */
export type ExportJobStatus = 'pending' | 'processing' | 'done' | 'failed';
/** Output format requested with `?format=`; `csv` adds a `csv` field to the result when it is read. */
export type ExportFormat = 'json' | 'csv';

/** One export job, held in memory. */
export interface ExportJob {
  /** Random 16-hex-character job id. */
  jobId: string;
  /** Tenant whose data is exported (the caller's tenant). */
  tenantId: string;
  format: ExportFormat;
  status: ExportJobStatus;
  /** Creation time, epoch ms. */
  createdAt: number;
  /** Last status change, epoch ms (completion time once `done` or `failed`). */
  updatedAt: number;
  /** Present only when `done`. */
  result?: ExportResult;
  /** Error code when `failed` (`export_source_unavailable`). */
  error?: string;
}

/** Data types this export implements (H1R2 S23-F03). */
export const EXPORT_TYPES_IMPLEMENTED = ['receipts'] as const;
/** Tenant data that exists in the system but is NOT part of this export (stated in every result). */
export const EXPORT_NOT_INCLUDED = [
  'operations_v3', 'ledger', 'audit_log', 'dead_letters', 'webhook_deliveries', 'api_keys', 'users', 'memberships',
] as const;

/** Content of a finished export. */
export interface ExportResult {
  /** The tenant's receipts. */
  records: GdprReceipt[];
  /** Number of records. */
  count: number;
  /** Data types included (`EXPORT_TYPES_IMPLEMENTED`). */
  scope: string[];
  /** Data types that exist but are not exported (`EXPORT_NOT_INCLUDED`). */
  notIncluded: string[];
  /** Where the receipts were read from (as reported by `collectTenantReceipts`). */
  sources: string[];
  /** CSV rendering of `records`; added only in the status response when the format is `csv`, never stored. */
  csv?: string;
}

// ──────────────────────────────────────────────────────────
// In-memory job store
// ──────────────────────────────────────────────────────────

const _jobs = new Map<string, ExportJob>();

/**
 * H1R2 review MED-3: the job map used to grow forever and any credential could start unbounded concurrent exports of
 * its whole tenant. Now: at most one active (pending/processing) job per tenant (a second request gets 409
 * export_in_progress with the active job id); finished jobs expire OTK_EXPORT_JOB_TTL_MS after completion (default
 * 1 h); at most OTK_EXPORT_MAX_JOBS jobs are kept (default 1000; the oldest finished ones are evicted first). The CSV
 * text is rendered when the status is read, not stored next to the records.
 */
function _ttlMs(): number { const v = Number(process.env['OTK_EXPORT_JOB_TTL_MS'] ?? 3_600_000); return Number.isFinite(v) && v >= 0 ? v : 3_600_000; }
function _maxJobs(): number { const v = Number(process.env['OTK_EXPORT_MAX_JOBS'] ?? 1000); return Number.isFinite(v) && v > 0 ? Math.floor(v) : 1000; }
const _active = (j: ExportJob) => j.status === 'pending' || j.status === 'processing';

// Drops expired finished jobs, then evicts the oldest finished jobs while the map is at capacity.
function _prune(now: number = Date.now()): void {
  const ttl = _ttlMs();
  for (const [id, j] of _jobs) if (!_active(j) && now - j.updatedAt >= ttl) _jobs.delete(id);
  if (_jobs.size < _maxJobs()) return;
  for (const [id, j] of _jobs) { if (_jobs.size < _maxJobs()) break; if (!_active(j)) _jobs.delete(id); } // insertion order = oldest first
}

/**
 * Returns an export job by id, after dropping expired jobs.
 *
 * @param jobId - Job id returned at creation.
 * @returns The job, or `undefined` when unknown or expired.
 */
export function getExportJob(jobId: string): ExportJob | undefined {
  _prune();
  return _jobs.get(jobId);
}

/**
 * Removes every export job.
 *
 * @internal Test only.
 */
export function clearExportJobsForTest(): void { _jobs.clear(); }

// ──────────────────────────────────────────────────────────
// Handlers
// ──────────────────────────────────────────────────────────

/**
 * POST /v1/data/export
 * Creates an async export job for the caller's tenant.
 *
 * Answers 202 with the job id, or 400 (bad `format`), 501 (unimplemented `type`), 409 (a job of this tenant
 * is still active) or 503 (job capacity reached). The data is collected after the response is sent.
 *
 * @param req - The request; only its URL query (`format`, `type`) is read.
 * @param res - Response; it is always sent here.
 * @param tenantId - Authenticated caller's tenant (resolved by the route, not by this handler).
 */
export async function handleCreateExportJob(
  req: IncomingMessage,
  res: ServerResponse,
  tenantId: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawFormat = url.searchParams.get('format') ?? 'json';
  if (rawFormat !== 'json' && rawFormat !== 'csv') {
    sendError(res, 'OTK-4004', { details: [{ field: 'format', issue: 'must be json or csv' }] });
    return;
  }
  const format: ExportFormat = rawFormat;
  const type = url.searchParams.get('type') ?? 'receipts';
  if (!(EXPORT_TYPES_IMPLEMENTED as readonly string[]).includes(type)) {
    // S23-F03: say it is not implemented instead of finishing a job with an empty (false) result
    sendJson(res, 501, { ok: false, error: 'export_type_not_implemented', detail: `export of '${type.slice(0, 64)}' is not implemented; implemented: ${EXPORT_TYPES_IMPLEMENTED.join(',')}` });
    return;
  }

  _prune();
  for (const j of _jobs.values()) {
    if (j.tenantId === tenantId && _active(j)) {
      sendJson(res, 409, { ok: false, error: 'export_in_progress', detail: 'an export job of this tenant is still running; poll it', jobId: j.jobId });
      return;
    }
  }
  if (_jobs.size >= _maxJobs()) {
    sendJson(res, 503, { ok: false, error: 'export_capacity', detail: 'too many export jobs in progress on this replica; retry later' });
    return;
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const now = Date.now();

  const job: ExportJob = {
    jobId,
    tenantId,
    format,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  _jobs.set(jobId, job);

  // Processed asynchronously in this process (jobs are in memory)
  setImmediate(() => {
    job.status = 'processing';
    job.updatedAt = Date.now();
    collectTenantReceipts(tenantId).then(({ receipts, sources }) => {
      job.result = {
        records: receipts,
        count: receipts.length,
        scope: [...EXPORT_TYPES_IMPLEMENTED],
        notIncluded: [...EXPORT_NOT_INCLUDED],
        sources,
      };
      job.status = 'done';
      job.updatedAt = Date.now();
    }, () => {
      job.status = 'failed';
      job.error = 'export_source_unavailable';
      job.updatedAt = Date.now();
    });
  });

  sendJson(res, 202, { jobId, status: 'pending', format, tenantId });
}

/**
 * GET /v1/data/export/status/:jobId
 * Returns current status of an export job. When done, includes inline data.
 *
 * Answers 404 (OTK-4040) when the job is unknown. It does not check the caller's tenant; the route does.
 *
 * @param _req - Unused.
 * @param res - Response; it is always sent here.
 * @param jobId - Job id from the URL.
 */
export function handleExportJobStatus(
  _req: IncomingMessage,
  res: ServerResponse,
  jobId: string,
): void {
  const job = _jobs.get(jobId);
  if (!job) {
    sendError(res, 'OTK-4040');
    return;
  }

  if (job.status === 'done') {
    sendJson(res, 200, {
      jobId: job.jobId,
      status: job.status,
      tenantId: job.tenantId,
      format: job.format,
      data: job.format === 'csv' && job.result ? { ...job.result, csv: gdprReceiptsCsv(job.result.records) } : job.result,
      completedAt: new Date(job.updatedAt).toISOString(),
    });
    return;
  }

  sendJson(res, 200, {
    jobId: job.jobId,
    status: job.status,
    tenantId: job.tenantId,
    format: job.format,
    ...(job.status === 'failed' ? { error: job.error } : {}),
  });
}
