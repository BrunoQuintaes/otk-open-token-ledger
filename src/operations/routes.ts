/**
 * D1–D8 / C — operation status and explicit cancellation (D7 §2, D3-G03/G05).
 *
 *   GET  /v1/operations/{operationId}         receipts:read  → state axes, amounts, effects, no text
 *   POST /v1/operations/{operationId}/cancel  receipts:write → cancel_requested (202) or
 *                                                             already_finished (200)
 *   GET  /v1/operations/{operationId}/conference receipts:read → full private receipt v3 and conference
 *                                                             report with their signed envelopes and the
 *                                                             verification result (S4; tenant-scoped export)
 *
 * The tenant comes from the caller's credential; another tenant's id is "not found". The status
 * never shows a missing/incomplete conference as "no divergence": it reports its state.
 *
 * Dispatched from the proxy gateway (`src/proxy/ProxyGateway.ts`), which passes its credential check as a
 * callback. This file is also scanned as text by the route inventory script under `scripts/ops/`, so keep
 * its comments free of code-like routing text.
 *
 * @module src/operations/routes
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OperationKey } from '../types/d1d8/index.js';
import { keyString, legacyReceiptId, type OperationsContext } from './context.js';
import { operationView } from './proxyDurable.js';
import { toJsonValue } from './codec.js';
import { RevisionConflictError } from './PgOperationStore.js';
import { IllegalTransitionError } from './transitions.js';

/** Result of the gateway's credential check: the caller's tenant, or the HTTP status and error code to answer. */
export type Caller = { ok: true; tenantId: string } | { ok: false; status: number; error: string };

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(data));
  res.end(data);
}

const ROUTE = /^\/v1\/operations\/([A-Za-z0-9._:-]{1,128})(\/cancel|\/conference)?$/;

/**
 * Whether a path is an operation status, cancel or conference route (method not checked).
 *
 * @param pathname - URL path without query string.
 * @returns `true` when the path names an operation id of 1 to 128 allowed characters.
 */
export function isOperationRoute(pathname: string): boolean {
  return ROUTE.test(pathname);
}

// Status view of one operation plus its outbox effects, receipt summary and conference state; null when absent.
async function view(ctx: OperationsContext, key: OperationKey) {
  const d = await ctx.store.getDetail(key);
  if (!d) return null;
  const effects = (await ctx.outbox.listFor(key)).map((e) => ({ kind: e.kind, state: e.state, attempts: e.attempts }));
  const conf = await ctx.receiptsV3.getConference(key);
  const receipt = await ctx.receiptsV3.getReceipt(key);
  let legacy: string | null = null;
  if (!ctx.crypto) {
    const t = await ctx.pool.query<{ t: string | null }>("SELECT to_regclass('otk_receipts')::text AS t");
    if (t.rows[0]?.t) legacy = (await ctx.pool.query<{ request_id: string }>("SELECT request_id FROM otk_receipts WHERE request_id = $1 AND receipt_json->>'tenantId' = $2 AND receipt_json->>'operationId' = $3", [legacyReceiptId(key), key.tenantId, key.operationId])).rows[0]?.request_id ?? null;
  }
  return operationView(d.operation, {
    settlementNote: d.settlementNote,
    outbox: effects,
    receipt: receipt ? { schema: receipt.receipt.schema, digest: receipt.digest, signer: receipt.envelope.signer } : legacy ? { schema: 'legacy_raw_receipt', requestId: legacy } : null,
    // D3-G05: absent or incomplete comparison is reported as such, never as zero divergence
    conference: conf
      ? { state: conf.report.state, verdict: conf.report.verdict, calibrated: conf.report.threshold.calibrated, digest: conf.digest }
      : { state: 'not_produced', verdict: 'not_applicable', reason: d.localCount ? 'pending_or_unavailable' : 'no_local_count' },
  });
}

/**
 * Serves one operation request and always writes the response.
 *
 * Status and conference export need `receipts:read`; cancel needs `receipts:write`. Cancelling an operation
 * not yet sent upstream cancels and releases it at once; a running one gets `cancel_requested` and its
 * streaming instance aborts the upstream. Storage failures answer 503 `persistence_unavailable`.
 *
 * @param ctx - Operations context.
 * @param req - The request.
 * @param res - The response to write.
 * @param pathname - URL path.
 * @param method - HTTP method.
 * @param authorize - Credential check for the required permission; returns the caller or a refusal.
 * @returns Resolves once the response has been sent.
 */
export async function handleOperationRoute(ctx: OperationsContext, req: IncomingMessage, res: ServerResponse, pathname: string, method: string, authorize: (req: IncomingMessage, permission: 'receipts:read' | 'receipts:write') => Caller): Promise<void> {
  const m = ROUTE.exec(pathname);
  if (!m) return json(res, 404, { ok: false, error: 'not_found' });
  const operationId = m[1]!;
  const isCancel = m[2] === '/cancel';
  const isConference = m[2] === '/conference';
  if ((isCancel && method !== 'POST') || (!isCancel && method !== 'GET')) return json(res, 405, { ok: false, error: 'method_not_allowed' });
  const who = authorize(req, isCancel ? 'receipts:write' : 'receipts:read');
  if (!who.ok) return json(res, who.status, { ok: false, error: who.error });
  const key: OperationKey = { tenantId: who.tenantId, operationId };
  try {
    if (isConference) {
      // D3-G05/G07: the complete conference (never a "no divergence" stand-in) with the receipt it is
      // bound to, both envelopes, and the operator-side verification result. Tenant from the token.
      const op = await ctx.store.get(key);
      if (!op) return json(res, 404, { ok: false, error: 'operation_not_found' });
      const receipt = await ctx.receiptsV3.getReceipt(key);
      const conference = await ctx.receiptsV3.getConference(key);
      const verification = ctx.crypto && receipt
        ? {
          receipt: ctx.crypto.receiptCrypto.verifyReceipt(receipt.receipt, receipt.envelope),
          conference: conference ? ctx.crypto.receiptCrypto.verifyConference(conference.report, conference.envelope, receipt.receipt) : null,
        }
        : null;
      return json(res, 200, toJsonValue({
        ok: true,
        schema: 'otk.conference_export.v1',
        operationId,
        receipt: receipt ? { digest: receipt.digest, payload: receipt.receipt, envelope: receipt.envelope } : null,
        conference: conference
          ? { digest: conference.digest, payload: conference.report, envelope: conference.envelope }
          : { state: 'not_produced', verdict: 'not_applicable' },
        verification,
        note: 'Operator-signed report of an auxiliary local count; the signature proves origin/integrity of the report, not the correctness of the counter nor a provider signature.',
      }));
    }
    if (!isCancel) {
      const v = await view(ctx, key);
      return v ? json(res, 200, { ok: true, operation: v }) : json(res, 404, { ok: false, error: 'operation_not_found' });
    }
    for (let i = 0; i < 5; i++) {
      const op = await ctx.store.get(key);
      if (!op) return json(res, 404, { ok: false, error: 'operation_not_found' });
      const now = new Date().toISOString();
      try {
        if (op.execution === 'admitted') {
          // nothing was sent to the provider yet: cancelled and released at once (review L2)
          await ctx.store.transition(key, op.revision, { execution: 'cancelled', reservation: { ...op.reservation, state: 'released' }, cancellation: { requestedAt: now, result: 'stopped_upstream' } });
          ctx.log('operation_cancelled_before_start', { key: keyString(key) });
          return json(res, 200, { ok: true, result: 'cancelled_before_start', operation: await view(ctx, key) });
        }
        if (op.execution === 'upstream_started') {
          await ctx.store.transition(key, op.revision, { execution: 'cancel_requested', cancellation: { requestedAt: now, result: null } });
          ctx.inflight.get(keyString(key))?.abort('cancel'); // same instance: immediate; others poll
          ctx.log('operation_cancel_requested', { key: keyString(key) });
          return json(res, 202, { ok: true, result: 'cancel_requested', operation: await view(ctx, key) });
        }
        if (op.execution === 'cancel_requested') {
          ctx.inflight.get(keyString(key))?.abort('cancel');
          return json(res, 202, { ok: true, result: 'cancel_requested', operation: await view(ctx, key) });
        }
        // already terminal: record the attempt once, keep the confirmed usage
        if (op.cancellation === null) await ctx.store.transition(key, op.revision, { cancellation: { requestedAt: now, result: 'already_finished' } });
        return json(res, 200, { ok: true, result: 'already_finished', operation: await view(ctx, key) });
      } catch (err) {
        if (err instanceof RevisionConflictError) continue;
        if (err instanceof IllegalTransitionError) return json(res, 409, { ok: false, error: 'illegal_transition', detail: err.message });
        throw err;
      }
    }
    return json(res, 409, { ok: false, error: 'operation_busy' });
  } catch (err) {
    ctx.log('operation_route_error', { key: keyString(key), error: String(err) });
    return json(res, 503, { ok: false, error: 'persistence_unavailable' });
  }
}
