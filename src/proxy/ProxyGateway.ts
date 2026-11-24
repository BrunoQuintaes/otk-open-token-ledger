/**
 * RB-052 — Proxy HTTP Gateway (MITM / PROXY-04/05/06)
 *
 * Intercepts HTTP LLM metering events and creates OTK receipts.
 * POST /proxy: accepts provider event JSON, builds RawReceipt, stores via receiptStore.
 *
 * PROXY-04: MITM forwarding — routes requests to upstream LLM providers.
 * PROXY-05: Non-blocking receipt creation after successful forward (setImmediate).
 * PROXY-06: Streaming injection — adds stream_options.include_usage for OpenAI streams.
 *
 * Upstream base URLs:
 *   openai    → https://api.openai.com
 *   anthropic → https://api.anthropic.com
 *   gemini    → https://generativelanguage.googleapis.com
 *
 * Provider resolved from: x-otk-provider header > provider query param > default 'openai'.
 * Admission (R09/RV01): both entries that create receipts (MITM and POST /proxy) require an
 * OTK bearer token with receipts:write and apply the shared plan quota before any effect;
 * unauthenticated MITM relay refused unless explicitly allowed.
 * API key resolved via GlobalKeyStrategy (operator key; per-tenant BYOK not wired — R11).
 *
 * @module proxy/ProxyGateway
 * @since RB-052 (alpha hook: u12.post.d)
 */

import { createServer, type ServerResponse, type Server, type IncomingMessage } from 'node:http';
import { URL } from 'node:url';
import { buildRawReceipt } from '../sdk/OTKSDK.js';
import { computeKnownCu } from '../operations/knownCu.js';
import { storeReceiptDurable } from '../api/receiptStore.js';
import { isAuthEnabled, resolveTokenContext, type TokenContext } from '../api/tenantKeyRegistry.js';
import { isProductionEnv } from '../api/productionGuard.js';
import { isTenantInactive } from '../auth/subjectStatus.js';
import { refreshCredential } from '../auth/credentialAuthority.js';
import { getProxyAuthFailureLimiter, sourceKey } from '../security/authFailureLimiter.js';
import { hasPermission } from '../security/rbac.js';
import { checkMeteringQuotaAsync } from '../billing/meteringQuota.js';
import { getLogger } from '../infra/logging/StructuredLogger.js';
import { getProxyMode } from './ProxySlice.js';
import { readBodyWithLimits } from '../api/limits.js';
import { applySecurityHeaders } from '../api/securityHeaders.js';
import { openUpstream } from './ProxyForwarder.js';
import { extractUsage, type ExtractedUsage } from './UsageExtractor.js';
import { StreamTapper } from './StreamTapper.js';
import { GlobalKeyStrategy } from '../providers/strategies/GlobalKeyStrategy.js';
import type { OperationsContext } from '../operations/context.js';
import { handleDurableMitm } from '../operations/proxyDurable.js';
import { handleOperationRoute, isOperationRoute, type Caller } from '../operations/routes.js';
import { handleAttributionRoute, isAttributionRoute } from '../operations/attributionRoutes.js';

const START_TIME = Date.now();

// PROXY-04: Upstream base URLs per provider
const UPSTREAM_BASE: Record<string, string> = {
  openai: 'https://api.openai.com',
  anthropic: 'https://api.anthropic.com',
  gemini: 'https://generativelanguage.googleapis.com',
  cohere: 'https://api.cohere.ai',
  mistral: 'https://api.mistral.ai',
  meta: 'https://api.llama-api.com',
  deepseek: 'https://api.deepseek.com',
};

const _globalKeyStrategy = new GlobalKeyStrategy();

/**
 * Upstream base per provider. A local controllable provider (tests, rehearsals, S4's pilot
 * dry-run) is reached with OTK_PROXY_UPSTREAM_<PROVIDER>=http://127.0.0.1:<port>, honoured only
 * when OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE=1 (operator configuration, never a request field).
 */
function upstreamBase(provider: string): string {
  if (process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] === '1') {
    const o = process.env[`OTK_PROXY_UPSTREAM_${provider.toUpperCase()}`];
    if (o) return o.replace(/\/+$/, '');
  }
  return UPSTREAM_BASE[provider] ?? UPSTREAM_BASE['openai']!;
}

/** Resolve provider from x-otk-provider header or provider query param. Defaults to 'openai'. */
function resolveProvider(req: IncomingMessage, url: URL): string {
  const fromHeader = req.headers['x-otk-provider'];
  if (fromHeader && typeof fromHeader === 'string' && fromHeader.trim()) {
    return fromHeader.trim().toLowerCase();
  }
  const fromQuery = url.searchParams.get('provider');
  if (fromQuery && fromQuery.trim()) {
    return fromQuery.trim().toLowerCase();
  }
  return 'openai';
}

/** Query parameters that carry a credential in some provider APIs (compared case-insensitively). */
const QUERY_CREDENTIALS = new Set(['key', 'access_token', 'api_key', 'apikey']);
/** OTK's own routing parameter (resolveProvider): meaningful to the OTK only. */
const QUERY_OTK = new Set(['provider']);

/** A copy of the query without credential parameters: the client's credential is for the OTK only. */
export function stripQueryCredentials(q: URLSearchParams): URLSearchParams {
  const out = new URLSearchParams();
  for (const [k, v] of q) if (!QUERY_CREDENTIALS.has(k.toLowerCase()) && !QUERY_OTK.has(k)) out.append(k, v);
  return out;
}

/**
 * OTK token of a request: `Authorization: Bearer`, else `x-api-key` (unmodified Anthropic SDK, R11), else
 * `x-goog-api-key` (unmodified Google GenAI SDK pointed at the OTK). None of them reaches the provider.
 */
function otkToken(req: IncomingMessage): string {
  const auth = req.headers['authorization'] ?? '';
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer) return bearer;
  for (const h of ['x-api-key', 'x-goog-api-key']) {
    const v = req.headers[h];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/** Collect raw headers from IncomingMessage as Record<string, string>. */
function collectIncomingHeaders(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') {
      out[k] = v;
    } else if (Array.isArray(v)) {
      out[k] = v.join(', ');
    }
  }
  return out;
}

/**
 * PROXY-06: For OpenAI streaming requests (body has "stream":true),
 * inject stream_options.include_usage so usage data is present in the final chunk.
 */
function injectStreamOptions(provider: string, body: string): string {
  if (provider !== 'openai') return body;
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed['stream'] !== true) return body;
    // Inject stream_options.include_usage = true
    const streamOptions = (parsed['stream_options'] ?? {}) as Record<string, unknown>;
    streamOptions['include_usage'] = true;
    parsed['stream_options'] = streamOptions;
    return JSON.stringify(parsed);
  } catch {
    // Not valid JSON or already modified — return as-is
    return body;
  }
}

/**
 * R09/RV01: identity and permission for every gateway entry that creates a receipt.
 * Before R09 the MITM path forwarded any request with the operator's provider key; before
 * RV01 POST /proxy resolved only the tenant, so a VIEWER token could create receipts.
 *
 * With auth enabled (OTK_TENANTS): an OTK tenant token with receipts:write is required
 * (the client SDK points base_url at the proxy and uses the OTK token as its api key).
 * The token is read from `Authorization: Bearer`, or from `x-api-key` when there is no
 * Bearer token: that is where an unmodified Anthropic SDK puts its api key (R11).
 * With auth disabled `tenantId` is undefined and each entry applies its development-mode policy.
 */
type Denial = { ok: false; status: number; error: string; retryAfterS?: number };

/**
 * H1-S06 (SEC02-N02): resolve the OTK token behind the per-source limiter of authentication failures. A source that
 * failed too often gets 429 before any token is looked up (valid ones included); each 401 counts one failure for the
 * source, never for the tenant (see security/authFailureLimiter).
 */
function resolveProxyCaller(req: IncomingMessage): TokenContext | Denial {
  const limiter = getProxyAuthFailureLimiter();
  const src = sourceKey(req);
  const wait = limiter.throttledFor(src);
  if (wait > 0) return { ok: false, status: 429, error: 'too_many_auth_failures', retryAfterS: wait };
  const token = otkToken(req);
  const ctx = token ? resolveTokenContext(token) : null;
  // H1-S04 (INF05-F01): a token of a deactivated tenant is refused even if it is still in the registry (e.g. OTK_TENANTS)
  if (!ctx || isTenantInactive(ctx.tenantId)) {
    void limiter.recordFailure(src); // shared-counter update is asynchronous and never rejects
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return ctx;
}

/** Send a denial, with Retry-After when the source is throttled. */
function sendDenial(res: ServerResponse, d: Denial): void {
  if (d.retryAfterS) res.setHeader('Retry-After', String(d.retryAfterS));
  sendJson(res, d.status, { ok: false, error: d.error });
}

function authorizeMeteringWrite(req: IncomingMessage): { ok: true; tenantId?: string } | Denial {
  if (!isAuthEnabled()) {
    // NF-17 / PF-NEW-03 (RUN-S, decision D2): in production the legacy event endpoint follows the MITM rule and is
    // refused without configured authentication; development keeps the permissive mode (tenant from the body).
    if (isProductionEnv() && process.env['OTK_PROXY_ALLOW_UNAUTHENTICATED'] !== '1') {
      return { ok: false, status: 503, error: 'proxy_auth_not_configured' };
    }
    return { ok: true };
  }
  const ctx = resolveProxyCaller(req);
  if ('ok' in ctx) return ctx;
  if (!hasPermission(ctx.role, 'receipts:write')) return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true, tenantId: ctx.tenantId };
}

/** D7: status (receipts:read) and cancel (receipts:write) of the caller's own operations. */
function authorizeOperationAccess(req: IncomingMessage, permission: 'receipts:read' | 'receipts:write'): Caller {
  if (!isAuthEnabled()) {
    return process.env['OTK_PROXY_ALLOW_UNAUTHENTICATED'] === '1'
      ? { ok: true, tenantId: 'default' }
      : { ok: false, status: 503, error: 'proxy_auth_not_configured' };
  }
  const ctx = resolveProxyCaller(req);
  if ('ok' in ctx) return ctx;
  if (!hasPermission(ctx.role, permission)) return { ok: false, status: 403, error: 'forbidden' };
  return { ok: true, tenantId: ctx.tenantId };
}

/** RV01: shared plan quota (billing/meteringQuota), checked before any effect. */
async function quotaDenial(tenantId: string): Promise<Denial | null> {
  // N11: shared balance (Redis when configured)
  return (await checkMeteringQuotaAsync(tenantId)).exceeded ? { ok: false, status: 429, error: 'quota_exceeded' } : null;
}

/**
 * R10: outcome of metering for each forwarded call, kept apart from HTTP success.
 */
export type MeteringOutcome =
  | 'receipt_created' | 'usage_missing' | 'client_aborted'
  | 'upstream_error' | 'metering_failed' | 'persistence_failed';
const _meteringCounts: Record<MeteringOutcome, number> = {
  receipt_created: 0, usage_missing: 0, client_aborted: 0,
  upstream_error: 0, metering_failed: 0, persistence_failed: 0,
};
function recordMetering(outcome: MeteringOutcome, provider: string): void {
  _meteringCounts[outcome]++;
  if (outcome !== 'receipt_created') getLogger().warn('proxy metering outcome', { outcome, provider });
}
/**
 * N8: calls whose usage reports prompt-cache tokens (Anthropic cache_creation/cache_read).
 * The receipt carries input/output tokens only, so these billable categories are not in
 * the CU; how to represent them is a formula decision (D5). Counted so they are visible.
 */
let _cacheTokensOutsideCu = 0;
/** Counters of metering outcomes on the MITM path (monitoring / tests). */
export function proxyMeteringCounts(): Readonly<Record<MeteringOutcome | 'cache_tokens_outside_cu', number>> {
  return { ..._meteringCounts, cache_tokens_outside_cu: _cacheTokensOutsideCu };
}

/** Whether a buffered provider response declares token usage at all (absent is not zero). */
function hasUsageField(provider: string, body: Record<string, unknown>): boolean {
  switch (provider.toLowerCase()) {
    case 'gemini': return body['usageMetadata'] != null;
    case 'cohere': return body['meta'] != null;
    default: return body['usage'] != null;
  }
}

/** Model named in the client request body (fallback when the response does not carry it). */
function requestModel(body: string): string | undefined {
  try {
    const m = (JSON.parse(body) as Record<string, unknown>)['model'];
    return typeof m === 'string' && m.trim() ? m : undefined;
  } catch {
    return undefined;
  }
}

/** RV03: resolve when the client drains its write buffer or goes away. */
function waitForDrainOrClose(res: ServerResponse): Promise<void> {
  // Already closed (its 'close' event is gone) or nothing buffered: do not wait.
  if (res.destroyed || !res.writableNeedDrain) return Promise.resolve();
  return new Promise((resolve) => {
    const done = (): void => { res.off('drain', done); res.off('close', done); resolve(); };
    res.once('drain', done);
    res.once('close', done);
  });
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(data));
  res.end(data);
}

export type ProxyGatewayOpts = {
  port?: number;
  /**
   * D7 durable profile (opt-in): with a runtime, every metered call is an operation admitted
   * durably before the provider is called, kept running when the client leaves, cancellable
   * and queryable. Without it the legacy profile below is unchanged (historical behaviour).
   */
  operations?: OperationsContext;
};

export function startProxyGateway(opts: ProxyGatewayOpts = {}): Server {
  const port = opts.port ?? Number(process.env['OTK_PROXY_PORT'] ?? process.env['PROXY_PORT'] ?? 8788);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const method = req.method ?? 'GET';

    applySecurityHeaders(res, { route: 'api' });

    try {
      // ── /health ──────────────────────────────────────────────────────────────
      if (method === 'GET' && url.pathname === '/health') {
        return sendJson(res, 200, {
          ok: true,
          uptime: ((Date.now() - START_TIME) / 1000).toFixed(1),
          ts: new Date().toISOString(),
          mode: getProxyMode(),
        });
      }

      // H1R2 R-13 / A3: every proxy request may spend (provider call, receipt) or read the caller's operations: the
      // tenant status is read from the authoritative store now; unknown status → 503 (fail closed). The proxy accepts
      // registry tokens only (no dynamic keys).
      const fresh = await refreshCredential(otkToken(req), { strict: true, dynamicKeys: false });
      if (!fresh.ok) {
        res.setHeader('Retry-After', '1');
        return sendJson(res, fresh.status, { ok: false, error: fresh.error });
      }

      // ── D7: operation status / explicit cancel (durable profile only) ────────
      if (opts.operations && isOperationRoute(url.pathname)) {
        return await handleOperationRoute(opts.operations, req, res, url.pathname, method, authorizeOperationAccess);
      }
      if (opts.operations && isAttributionRoute(url.pathname)) {
        return await handleAttributionRoute(opts.operations, req, res, url, method, authorizeOperationAccess);
      }

      // ── PROXY-04: MITM forwarding — /v1/* and /<any path except /proxy> ─────
      // Routes matching /v1/* or explicit provider paths are forwarded to upstream.
      // The /proxy route remains as a legacy metering-event-only endpoint.
      const isMitmPath = url.pathname !== '/proxy' && url.pathname !== '/health';
      if (isMitmPath) {
        const provider = resolveProvider(req, url);
        const baseUrl = upstreamBase(provider);
        // Strip /proxy prefix if present, then forward the remaining path
        const upstreamPath = url.pathname.startsWith('/proxy/')
          ? url.pathname.slice('/proxy'.length)
          : url.pathname;
        // R11: a client credential in the query string (?key=, Gemini style) is not forwarded;
        // FECHAMENTO_GEMINI_AD: any spelling (?KEY=, ?access_token=) is removed as well
        const upstreamQuery = stripQueryCredentials(new URLSearchParams(url.search));
        const qs = upstreamQuery.toString();
        const upstreamUrl = `${baseUrl}${upstreamPath}${qs ? `?${qs}` : ''}`;

        // R09: admit (identity, permission, quota) before touching the provider key.
        // Without auth the MITM path is refused unless OTK_PROXY_ALLOW_UNAUTHENTICATED=1
        // (local development only): an open relay would spend the operator's provider key.
        const who = authorizeMeteringWrite(req);
        if (!who.ok) return sendDenial(res, who);
        if (who.tenantId === undefined && process.env['OTK_PROXY_ALLOW_UNAUTHENTICATED'] !== '1') {
          return sendJson(res, 503, { ok: false, error: 'proxy_auth_not_configured' });
        }
        const mitmTenantId = who.tenantId ?? 'default';
        if (opts.operations) {
          // D7 durable profile: admission (quota, money ceiling, idempotency) happens inside it
          const body = await readBodyWithLimits(req);
          const headers = collectIncomingHeaders(req);
          for (const k of Object.keys(headers)) if (k.toLowerCase().startsWith('x-otk-')) delete headers[k];
          return await handleDurableMitm(opts.operations, {
            req, res, tenantId: mitmTenantId, provider, upstreamPath, upstreamUrl, method, headers, bodyStr: body,
            resolveApiKey: () => _globalKeyStrategy.resolve(provider),
            openUpstream,
          });
        }
        const overQuota = await quotaDenial(mitmTenantId);
        if (overQuota) return sendJson(res, overQuota.status, { ok: false, error: overQuota.error });

        // Resolve API key via GlobalKeyStrategy
        let apiKey: string;
        try {
          apiKey = await _globalKeyStrategy.resolve(provider);
        } catch (keyErr) {
          const keyMsg = keyErr instanceof Error ? keyErr.message : String(keyErr);
          return sendJson(res, 502, { ok: false, error: 'upstream_key_unavailable', detail: keyMsg });
        }

        // Read and optionally modify request body
        let bodyStr = await readBodyWithLimits(req);

        // PROXY-06: For OpenAI streaming requests, inject stream_options.include_usage
        bodyStr = injectStreamOptions(provider, bodyStr);

        const inHeaders = collectIncomingHeaders(req);
        // OTK control headers are not sent to the provider (the OTK token in
        // Authorization is replaced by the provider key inside openUpstream).
        for (const k of Object.keys(inHeaders)) {
          if (k.toLowerCase().startsWith('x-otk-')) delete inHeaders[k];
        }
        const modelFromRequest = requestModel(bodyStr);
        const reqStartMs = Date.now();

        // TEAM-05: Extract teamId from x-otk-team-id header for team-level usage attribution
        const teamIdHeader = req.headers['x-otk-team-id'];
        const teamId: string | undefined = typeof teamIdHeader === 'string' && teamIdHeader.trim()
          ? teamIdHeader.trim()
          : undefined;

        // R10: open upstream and relay the body as it arrives (no full buffering)
        let upstream;
        try {
          upstream = await openUpstream(upstreamUrl, method, inHeaders, bodyStr, apiKey, provider);
        } catch (fwdErr) {
          const fwdMsg = fwdErr instanceof Error ? fwdErr.message : String(fwdErr);
          getLogger().warn('proxy forward failed', { provider, upstreamUrl, error: fwdMsg });
          return sendJson(res, 502, { ok: false, error: 'upstream_unreachable', detail: fwdMsg });
        }

        // Relay upstream response headers + status to client (length is not known upfront)
        for (const [k, v] of Object.entries(upstream.headers)) {
          const key = k.toLowerCase();
          if (key === 'content-length' || key === 'content-encoding' || key === 'transfer-encoding') continue;
          res.setHeader(k, v);
        }
        res.statusCode = upstream.status;
        res.flushHeaders();

        const tapper = upstream.isStream ? new StreamTapper() : null;
        const chunks: Buffer[] = [];
        let clientGone = false;
        res.on('close', () => { if (!res.writableFinished) clientGone = true; });
        // A write to a reset client connection must not become an unhandled 'error' event.
        res.on('error', () => { clientGone = true; });

        let upstreamFailed = false;
        const reader = upstream.body?.getReader();
        try {
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            const buf = Buffer.from(value);
            // RV03: parse in place (the tapper keeps no output that someone must consume)
            if (tapper) tapper.observe(buf); else chunks.push(buf);
            if (clientGone) { await reader.cancel().catch(() => {}); break; }
            // RV03: backpressure — stop reading the provider until a slow client drains
            if (!res.write(buf)) await waitForDrainOrClose(res);
          }
        } catch (streamErr) {
          upstreamFailed = true;
          getLogger().warn('proxy upstream stream failed', { provider, error: streamErr instanceof Error ? streamErr.message : String(streamErr) });
        }
        // Usage is final once finish() returns (synchronous parse of the last line)
        if (tapper) tapper.finish();
        if (!res.writableEnded) res.end();
        const latencyMs = Date.now() - reqStartMs;

        // HTTP success and metering success are distinct observable states (R10)
        if (upstream.status < 200 || upstream.status >= 300) return;
        if (clientGone) { recordMetering('client_aborted', provider); return; }
        if (upstreamFailed) { recordMetering('upstream_error', provider); return; }

        setImmediate(async () => {
          try {
            // R09/R10: use the model the provider reports (Anthropic message_start, N8);
            // otherwise the request's
            const model: string = tapper?.model ?? modelFromRequest ?? 'unknown';
            let usage: ExtractedUsage;
            if (tapper) {
              // usageSeen distinguishes "no usage chunk" from "zero tokens"
              if (!tapper.usageSeen || tapper.usage == null) { recordMetering('usage_missing', provider); return; }
              // RV02: the tapper already normalised each provider's format. Rebuilding an
              // OpenAI-shaped body and passing it to extractUsage(provider) zeroed
              // Anthropic/Gemini, whose extractors read other fields.
              usage = {
                provider,
                model,
                inputTokens: tapper.usage.promptTokens,
                outputTokens: tapper.usage.completionTokens,
                cacheCreationInputTokens: tapper.usage.cacheCreationInputTokens,
                cacheReadInputTokens: tapper.usage.cacheReadInputTokens,
                // N8: correlate the receipt with the provider response (was a random UUID)
                requestId: tapper.messageId,
              };
            } else {
              let responseBody: Record<string, unknown>;
              try {
                responseBody = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as Record<string, unknown>;
              } catch {
                responseBody = {};
              }
              if (!hasUsageField(provider, responseBody)) { recordMetering('usage_missing', provider); return; }
              const parsedModel = responseBody['model'] as string | undefined ?? model;
              usage = extractUsage(provider, parsedModel, responseBody);
            }
            if ((usage.cacheCreationInputTokens ?? 0) > 0 || (usage.cacheReadInputTokens ?? 0) > 0) {
              _cacheTokensOutsideCu++;
              getLogger().warn('proxy usage has cache tokens not represented in CU', {
                provider,
                cacheCreationInputTokens: usage.cacheCreationInputTokens,
                cacheReadInputTokens: usage.cacheReadInputTokens,
              });
            }
            // D5-G04: same server-side calculator as POST /receipts (exact CU, never the bucket)
            const cu = computeKnownCu({ provider: usage.provider, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens });
            if (cu.status !== 'computed') { recordMetering('metering_failed', provider); getLogger().warn('proxy CU not computable', { provider, model: usage.model, status: cu.status }); return; }
            const receiptBase = buildRawReceipt(
              {
                provider: usage.provider,
                model: usage.model,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                latencyMs,
                requestId: usage.requestId ?? crypto.randomUUID(),
                timestamp: Math.floor(Date.now() / 1000),
              },
              BigInt(0),
              BigInt(0),
              () => cu.costUnits,
            );
            // Attach teamId for TEAM-05/06 aggregation; S0-F01b: stamp the weights actually used
            const withContext = { ...receiptBase, cwVersion: cu.weights };
            const receipt = teamId ? { ...withContext, teamId } : withContext;
            // R09: the admitted tenant is persisted with the receipt (R12)
            const stored = await storeReceiptDurable(receipt, mitmTenantId);
            // R13: the provider response was already relayed; a lost receipt must be visible
            if (stored.reason === 'persistence_failed') {
              recordMetering('persistence_failed', provider);
              getLogger().error('proxy receipt not persisted', { provider, requestId: receipt.requestId });
            } else {
              recordMetering('receipt_created', provider);
            }
          } catch (receiptErr) {
            recordMetering('metering_failed', provider);
            getLogger().warn('proxy receipt creation failed', {
              provider,
              error: receiptErr instanceof Error ? receiptErr.message : String(receiptErr),
            });
          }
        });
        return;
      }

      // ── /proxy — legacy metering-event endpoint ───────────────────────────
      if (method === 'POST' && url.pathname === '/proxy') {
        // RV01: same identity/permission rule as the MITM path (env-gated via OTK_TENANTS)
        const who = authorizeMeteringWrite(req);
        if (!who.ok) return sendDenial(res, who);
        const proxyTenantId = who.tenantId;

        const raw = await readBodyWithLimits(req);
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid_json' });
        }

        // Auth-resolved tenantId takes precedence over event payload field
        const effectiveTenantId = proxyTenantId ??
          (event['tenantId'] != null ? String(event['tenantId']) : undefined);
        // RV01: shared quota before the receipt is stored or debited
        const overQuota = await quotaDenial(effectiveTenantId ?? 'default');
        if (overQuota) return sendJson(res, overQuota.status, { ok: false, error: overQuota.error });

        // Build OTK receipt from provider metering event (OpenAI-first format)
        const evProvider = String(event['provider'] ?? 'openai');
        const evModel = String(event['model'] ?? 'unknown');
        const evIn = Number(event['inputTokens'] ?? event['prompt_tokens'] ?? 0);
        const evOut = Number(event['outputTokens'] ?? event['completion_tokens'] ?? 0);
        // D5-G04: server-side CU; an unknown model is refused, never debited as 0
        const evRequestId = String(event['requestId'] ?? event['id'] ?? crypto.randomUUID());
        if (evRequestId.startsWith('op:')) return sendJson(res, 400, { ok: false, error: 'request_id_prefix_reserved' });
        const evCu = computeKnownCu({ provider: evProvider, model: evModel, inputTokens: evIn, outputTokens: evOut });
        if (evCu.status !== 'computed') return sendJson(res, 400, { ok: false, error: 'cu_not_computable', status: evCu.status });
        // S21-F04 (H1 2026-10-13): userId and nonce are integers; anything else is a client error, not a 500 that
        // echoes the parser message
        let evUserId: bigint; let evNonce: bigint;
        try {
          evUserId = BigInt(String(event['userId'] ?? '0'));
          evNonce = BigInt(String(event['nonce'] ?? '0'));
        } catch {
          return sendJson(res, 400, { ok: false, error: 'invalid_integer_field', detail: 'userId and nonce must be integers' });
        }
        const receipt = buildRawReceipt(
          {
            provider: evProvider,
            model: evModel,
            inputTokens: evIn,
            outputTokens: evOut,
            latencyMs: Number(event['latencyMs'] ?? 0),
            requestId: evRequestId,
            timestamp: Math.floor(Date.now() / 1000),
          },
          evUserId,
          evNonce,
          () => evCu.costUnits,
        );

        const stored = await storeReceiptDurable(receipt, effectiveTenantId); // no idempotency contract yet on this path
        // R13: do not acknowledge a metering event that was not durably written
        if (stored.reason === 'persistence_failed') return sendJson(res, 503, { ok: false, error: 'persistence_failed' });

        return sendJson(res, 200, {
          ok: true,
          proxied: true,
          meteringHook: 'active',
          requestId: receipt.requestId,
          costUnits: receipt.costUnits,
        });
      }

      return sendJson(res, 404, { ok: false, error: 'not_found' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return sendJson(res, 500, { ok: false, error: msg });
    }
  });

  server.listen(port, () => {
    getLogger().info('proxy gateway listening', { port, url: `http://127.0.0.1:${port}`, mode: getProxyMode() });
  });

  // E4.4: Graceful shutdown on SIGTERM
  process.once('SIGTERM', () => {
    getLogger().info('proxy gateway SIGTERM — closing');
    server.close(() => {
      getLogger().info('proxy gateway closed');
    });
  });

  return server;
}
