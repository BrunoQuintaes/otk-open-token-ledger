/**
 * D1–D8 / OVERNIGHT 20261005 (Phase 7) — tenant-scoped attribution routes on the durable proxy.
 *
 *   POST /v1/attribution/projects      receipts:write  {projectId, label?} → registers (or re-activates) a project
 *   POST /v1/attribution/applications  receipts:write  {applicationId, label?}
 *   GET  /v1/attribution/summary?epochId=…           receipts:read → totals by project + unattributed, the
 *                                                     canonical ledger total and the invariant check; application
 *                                                     and task type as separate, non-additive dimensions
 *   GET  /v1/attribution/export?epochId=…&projectId=… receipts:read → one row per operation with its attribution,
 *                                                     the signed statement, the receipt it is bound to and the
 *                                                     verification result (re-checkable offline with the key ring)
 *
 * The tenant always comes from the credential; another tenant's project ids are unknown here. Labels stay private
 * (never published, never on chain). Amounts are integers with their scale (CU micro units; money pico-USD).
 *
 * Dispatched from the proxy gateway (`src/proxy/ProxyGateway.ts`), which passes its credential check as a
 * callback. Any storage failure answers 503 `persistence_unavailable` and is logged without the request body.
 *
 * @module src/operations/attributionRoutes
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AttributionStatementV1, SignedEnvelope } from '../types/d1d8/index.js';
import { ATTRIBUTION_LABEL_RE, PgAttributionStore } from './attribution.js';
import { toJsonValue } from './codec.js';
import { keyString, type OperationsContext } from './context.js';
import type { Caller } from './routes.js';

const ROUTE = /^\/v1\/attribution\/(projects|applications|summary|export)$/;

/**
 * Whether a path is one of the four attribution routes (method not checked).
 *
 * @param pathname - URL path without query string.
 * @returns `true` for the projects, applications, summary and export paths.
 */
export function isAttributionRoute(pathname: string): boolean {
  return ROUTE.test(pathname);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(toJsonValue(body));
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(data));
  res.end(data);
}

// Bodies over `max` characters, non-JSON and non-object bodies all read as null (answered 400 by the caller).
async function readSmallJson(req: IncomingMessage, max = 4096): Promise<Record<string, unknown> | null> {
  let raw = '';
  for await (const c of req) { raw += String(c); if (raw.length > max) return null; }
  try { const v = JSON.parse(raw) as unknown; return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
}

const EPOCH_RE = /^[0-9]{1,20}$/;

/**
 * Serves one attribution request and always writes the response.
 *
 * Write routes need the `receipts:write` permission and read routes `receipts:read`. The export verifies each
 * signed statement against its receipt when the crypto context supports it (`verification` is `null` otherwise).
 *
 * @param ctx - Operations context (pool, receipt store, crypto, logger).
 * @param req - The request (its body is read for write routes, at most 4096 characters).
 * @param res - The response to write.
 * @param url - Parsed request URL.
 * @param method - HTTP method.
 * @param authorize - Credential check for the required permission; returns the caller or a refusal.
 * @returns Resolves once the response has been sent.
 */
export async function handleAttributionRoute(ctx: OperationsContext, req: IncomingMessage, res: ServerResponse, url: URL, method: string,
  authorize: (req: IncomingMessage, permission: 'receipts:read' | 'receipts:write') => Caller): Promise<void> {
  const m = ROUTE.exec(url.pathname);
  if (!m) return json(res, 404, { ok: false, error: 'not_found' });
  const what = m[1]!;
  const write = what === 'projects' || what === 'applications';
  if ((write && method !== 'POST') || (!write && method !== 'GET')) return json(res, 405, { ok: false, error: 'method_not_allowed' });
  const who = authorize(req, write ? 'receipts:write' : 'receipts:read');
  if (!who.ok) return json(res, who.status, { ok: false, error: who.error });
  const store = new PgAttributionStore(ctx.pool);
  try {
    if (write) {
      const body = await readSmallJson(req);
      const idField = what === 'projects' ? 'projectId' : 'applicationId';
      const id = body?.[idField];
      const label = body?.['label'];
      if (typeof id !== 'string' || !ATTRIBUTION_LABEL_RE.test(id)) return json(res, 400, { ok: false, error: 'invalid_id', detail: `${idField} must match ${ATTRIBUTION_LABEL_RE.source}` });
      if (label !== undefined && label !== null && (typeof label !== 'string' || label.length > 200)) return json(res, 400, { ok: false, error: 'invalid_label' });
      if (what === 'projects') await store.registerProject(who.tenantId, id, (label as string | undefined) ?? null);
      else await store.registerApplication(who.tenantId, id, (label as string | undefined) ?? null);
      return json(res, 200, { ok: true, [idField]: id });
    }
    const epochId = url.searchParams.get('epochId');
    if (epochId !== null && !EPOCH_RE.test(epochId)) return json(res, 400, { ok: false, error: 'invalid_epoch' });
    if (what === 'summary') return json(res, 200, { ok: true, schema: 'otk.attribution_summary.v1', ...(await store.summary(who.tenantId, epochId)) });
    const projectId = url.searchParams.get('projectId') ?? undefined;
    if (projectId !== undefined && !ATTRIBUTION_LABEL_RE.test(projectId)) return json(res, 400, { ok: false, error: 'invalid_project' });
    const rows = await store.exportRows(who.tenantId, epochId, projectId);
    const out = [];
    for (const r of rows) {
      const key = { tenantId: who.tenantId, operationId: r.operationId };
      const receipt = await ctx.receiptsV3.getReceipt(key);
      let verification: unknown = null;
      if (r.statement && r.envelope && receipt && ctx.crypto?.receiptCrypto.verifyAttribution) {
        verification = ctx.crypto.receiptCrypto.verifyAttribution(r.statement as AttributionStatementV1, r.envelope as SignedEnvelope, receipt.receipt);
      }
      out.push({ operationId: r.operationId, cuUnits: r.cuUnits, attribution: r.attribution, statementDigest: r.statementDigest, statement: r.statement, envelope: r.envelope,
        receipt: receipt ? { digest: receipt.digest, payload: receipt.receipt, envelope: receipt.envelope } : null, verification });
    }
    return json(res, 200, { ok: true, schema: 'otk.attribution_export.v1', tenantId: who.tenantId, epochId, projectId: projectId ?? null, cuScale: 1_000_000n, rows: out,
      note: 'Attribution statements are signed by the OTK operator and bound to the receipt digest; they attest what the client declared and the OTK admitted, not who benefited from the call.' });
  } catch (err) {
    ctx.log('attribution_route_error', { route: what, tenant: keyString({ tenantId: who.tenantId, operationId: '-' }), error: String(err) });
    return json(res, 503, { ok: false, error: 'persistence_unavailable' });
  }
}
