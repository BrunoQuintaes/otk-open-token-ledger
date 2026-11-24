/**
 * H1.5 — Structured Error Codes
 *
 * Centralized error registry with machine-readable OTK codes.
 * All error responses use sendError() for consistent envelope.
 * Backward compatible: preserves { ok: false, error: 'legacy_string' }.
 *
 * @module api/errors
 * @since Wave 2H (H1.5)
 */

import { authDenialsTotal } from '../observability/prometheusMetrics.js';
import type { ServerResponse } from 'node:http';

export interface ErrorDetail {
  field?: string;
  issue: string;
}

export interface ErrorEnvelope {
  ok: false;
  error: string;        // legacy error string (backward compat)
  code: string;         // OTK-4xxx / OTK-5xxx
  message: string;      // human-readable description
  details?: ErrorDetail[];
  requestId?: string;
}

interface ErrorDef {
  status: number;
  message: string;
  legacyError: string;
}

const ERROR_REGISTRY: Record<string, ErrorDef> = {
  // 4xx Client Errors
  'OTK-4001': { status: 400, message: 'Validation error', legacyError: 'missing_required_fields' },
  'OTK-4002': { status: 400, message: 'Invalid JSON body', legacyError: 'invalid_json' },
  'OTK-4003': { status: 400, message: 'Missing required header', legacyError: 'missing_header' },
  'OTK-4004': { status: 400, message: 'Invalid request parameter', legacyError: 'invalid_parameter' },
  'OTK-4010': { status: 401, message: 'Authentication required', legacyError: 'unauthorized' },
  'OTK-4011': { status: 401, message: 'Invalid or expired token', legacyError: 'unauthorized' },
  'OTK-4030': { status: 403, message: 'Insufficient permissions', legacyError: 'forbidden' },
  'OTK-4031': { status: 403, message: 'Tenant boundary violation', legacyError: 'forbidden' },
  'OTK-4040': { status: 404, message: 'Resource not found', legacyError: 'not_found' },
  'OTK-4090': { status: 409, message: 'Duplicate resource', legacyError: 'duplicate' },
  'OTK-4091': { status: 409, message: 'Idempotency conflict', legacyError: 'idempotency_conflict' },
  'OTK-4130': { status: 413, message: 'Request body too large', legacyError: 'body_too_large' },
  'OTK-4290': { status: 429, message: 'Rate limit exceeded', legacyError: 'rate_limit_exceeded' },
  'OTK-4291': { status: 429, message: 'Too many auth failures', legacyError: 'too_many_auth_failures' },

  // 5xx Server Errors
  'OTK-5000': { status: 500, message: 'Internal server error', legacyError: 'internal_error' },
  'OTK-5001': { status: 500, message: 'Proof generation failed', legacyError: 'proof_error' },
  'OTK-5030': { status: 503, message: 'Service temporarily unavailable', legacyError: 'unavailable' },
  'OTK-5031': { status: 503, message: 'Queue backpressure — retry later', legacyError: 'backpressure' },
};

export interface SendErrorOpts {
  details?: ErrorDetail[];
  requestId?: string;
  legacyError?: string;   // override the default legacy error string
  retryAfterMs?: number;
}

export function sendJson(res: ServerResponse, code: number, body: unknown): void {
  // H1.3: Auto-inject requestId into response body if header is set and body is an object
  let finalBody = body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const requestId = typeof res.getHeader === 'function'
      ? (res.getHeader('x-request-id') as string | undefined)
      : undefined;
    if (requestId && !(body as Record<string, unknown>)['requestId']) {
      finalBody = { ...(body as Record<string, unknown>), requestId };
    }
  }
  const data = JSON.stringify(finalBody);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(data));
  res.end(data);
}

export function sendError(res: ServerResponse, otkCode: string, opts?: SendErrorOpts): void {
  // H1.3: Auto-read requestId from response header if not explicitly passed
  const requestId = opts?.requestId || (typeof res.getHeader === 'function'
    ? (res.getHeader('x-request-id') as string | undefined)
    : undefined);

  const def = ERROR_REGISTRY[otkCode];
  if (!def) {
    sendJson(res, 500, {
      ok: false,
      error: opts?.legacyError ?? 'internal_error',
      code: 'OTK-5000',
      message: 'Internal server error',
      requestId,
    });
    return;
  }
  const envelope: ErrorEnvelope = {
    ok: false,
    error: opts?.legacyError ?? def.legacyError,
    code: otkCode,
    message: def.message,
  };
  if (opts?.details?.length) envelope.details = opts.details;
  if (requestId) envelope.requestId = requestId;
  if (opts?.retryAfterMs !== undefined) {
    (envelope as unknown as Record<string, unknown>)['retryAfterMs'] = opts.retryAfterMs;
  }
  sendJson(res, def.status, envelope);
}

/** Map RBAC denial to OTK error code and send. */
export function sendRbacDenial(
  res: ServerResponse,
  denial: { code: number; error: string; retryAfterMs?: number },
  requestId?: string,
): void {
  authDenialsTotal.inc({ status: String(denial.code), error: denial.error }); // H1R2 C5: no identifiers in labels
  if (denial.code === 429) {
    sendError(res, 'OTK-4291', { requestId, legacyError: denial.error, retryAfterMs: denial.retryAfterMs });
  } else if (denial.code === 403) {
    sendError(res, 'OTK-4030', { requestId, legacyError: denial.error });
  } else {
    sendError(res, 'OTK-4010', { requestId, legacyError: denial.error });
  }
}

export function getErrorStatus(otkCode: string): number {
  return ERROR_REGISTRY[otkCode]?.status ?? 500;
}

export { ERROR_REGISTRY };
