/**
 * RB-062 — REST API Routes (Minimum)
 *
 * Endpoints: GET /health, GET /version, POST /ping
 *
 * @module api/routes
 * @since RB-062
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import crypto from 'node:crypto';
import { URL, fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { getCollector } from '../observability/runtime.js';
import { getDispatcher } from '../publisher/runtime.js';
import { getDistributedRateLimiter } from '../security/IDistributedRateLimiter.js';
import { buildRateLimitKey } from '../security/rateLimitTypes.js';
import { sourceKey } from '../security/authFailureLimiter.js'; // F-H1-07
import { assertTenantBoundary } from '../security/AuthorityBoundary.js';
import { getAccountingLayer, sharedBalance } from '../security/talRuntime.js';
import { isAuthEnabled, loadTenantsFromString, parseTenantsString, hasRegisteredTenant, staticRegistrySnapshot, type TokenContext } from './tenantKeyRegistry.js';
import {
  queueRegistryTokenChange, flushRegistryTokenChanges, getRegistryTokenAuthority, takeRegistryTokenConflicts, registryTokenHash,
} from '../auth/registryTokenAuthority.js';
import { getLogger } from '../infra/logging/StructuredLogger.js';
import { isDeployedEnv } from '../infra/deployEnv.js';
import { authenticateRequest } from '../auth/authMiddleware.js';
import { refreshCredential, presentedCredential, isStrictRoute } from '../auth/credentialAuthority.js';
import { hasPermission, type Permission } from '../security/rbac.js';
import { storeReceiptDurable, getReceiptDurable, flushBatch, chainHead, auditCount, getProofStatus, circuitBreakerStatus, size as receiptStoreSize, transactionalQuotaActive, persistenceStatus, reprojectRedis } from './receiptStore.js';
import { computeKnownCu } from '../operations/knownCu.js';
import { OPERATION_RECEIPT_PREFIX } from './PostgresReceiptStore.js';
import { ACCOUNTING_SCALE } from '../operations/accounting.js';
import type { RawReceipt } from '../types/receipt.js';
import { addDeadLetter, listDeadLetters, getDeadLetter, markRetried, markDiscarded, deadLetterCount, pendingCount } from './deadLetterStore.js';
import { createTenant, getTenant, listTenants, updateTenant, deleteTenant, tenantAuditStatus, deactivateExternalTenant, reactivateExternalTenant, RESERVED_PREFIX_ERROR } from './tenantCrud.js';
import { getApiKeyMetadataStore } from './IApiKeyMetadataStore.js';
import { getPlanRateLimit, assignPlan, getAllPlans, listAssignments, getTenantPlanVersioned, PLAN_RANK, PlanVersionConflictError, type PlanTier } from '../billing/PlanRegistry.js';
import { checkMeteringQuotaAsync, reserveMeteringQuota, quotaUnitsFor } from '../billing/meteringQuota.js';
import { getReconciliationScheduler } from '../economics/ReconciliationScheduler.js';
import { generateInvoice, serializeInvoice } from '../billing/InvoiceService.js';
import { getRedisClient } from '../infra/redis/redisClient.js';
import { handleDashboardRequest } from '../dashboard/app.js';
import { handleLoginRequest } from '../dashboard/login.js';
import { getIndexer } from '../dashboard/indexer.js';
import { sendJson, sendError, sendRbacDenial } from './errors.js';
import { parseCorsConfig, applyCors, handlePreflight } from './cors.js';
import { validateBody } from './validate.js';
import { ReceiptSubmissionSchema, TenantCreateSchema, TenantUpdateSchema, PlanAssignmentSchema, TenantsReloadSchema, ApiKeyCreateSchema, SignupSchema, LoginSchema, VerifyEmailSchema, FeatureFlagUpsertSchema } from './schemas.js';
import { applySecurityHeaders } from './securityHeaders.js';
import { readBodyWithLimits, BodyTooLargeError, RequestTimeoutError } from './limits.js';
import { checkIdempotency, storeIdempotencyResponse } from './idempotency.js';
import { getMetricsText, getMetricsContentType } from '../observability/prometheusMetrics.js';
import { metricsAccessAllowed } from '../observability/metricsAccess.js';
import { startSpan, endSpan, isTracingEnabled, generateTraceId } from '../observability/tracing.js';
import { getProxyMode } from '../proxy/ProxySlice.js';
import { createApiKey as createApiKeyHandler, getApiKey as getApiKeyHandler, listApiKeys as listApiKeysHandler, revokeApiKey as revokeApiKeyHandler, rotateApiKey as rotateApiKeyHandler, revokeApiKeysOfTenantThrough } from './apiKeyManager.js';
import { getAdminKey, getStripeSecretKey, getStripeWebhookSecret } from '../infra/secretsBootstrap.js';
import { hashPassword, verifyPassword, verifyPasswordForUnknownUser } from '../auth/password.js';
import { generateVerificationToken, validateVerificationToken } from '../auth/emailVerification.js';
import { getUserStore } from '../users/IUserStore.js';
import { getEmailAdapter } from '../email/IEmailAdapter.js';
import { welcomeTemplate } from '../email/templates.js';
import { signToken, getJwtSecret, getJwtExpiryS, signRefreshToken, verifyRefreshToken, blacklistToken } from '../auth/jwt.js';
import { getTeamStore } from '../users/teamStore.js';
import { getVault } from '../security/ProviderKeyVault.js';
import { isProductionEnv, PRODUCTION_A0_OPEN_ROUTES } from './productionGuard.js';
import { refreshSubjectsNow, isTenantInactive, issuedBeforeTenantRevocation, markUserDeprovisioned, isUserDeprovisioned, issuedBeforeUserRevocation, flushSubjectStatus } from '../auth/subjectStatus.js';

const API_VERSION = 'rb-062-min';
const START_TIME = Date.now();
const _corsConfig = parseCorsConfig(process.env['OTK_CORS_ORIGINS']);

// E4.3: Multi-instance identification — identifies which API instance responded
const INSTANCE_ID = process.env['OTK_INSTANCE_ID'] ?? 'default';

// P1.2: OpenAPI spec loader — lazy cached, resolved relative to this module file.
// Works in dev (src/api/routes.ts → ../../docs/api/openapi.json) and in Docker
// (requires COPY docs/api/ ./docs/api/ in Dockerfile).
const _specPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../docs/api/openapi.json');
let _specCache: string | undefined;
function _loadSpec(): string | undefined {
  if (_specCache !== undefined) return _specCache || undefined;
  try {
    _specCache = readFileSync(_specPath, 'utf8');
  } catch {
    _specCache = ''; // mark as failed — subsequent calls return undefined
  }
  return _specCache || undefined;
}

// P1.2: Redoc HTML template — CDN-only, no backend dep. spec-url points to /openapi.json.
const _API_DOCS_HTML = [
  '<!DOCTYPE html>',
  '<html lang="en">',
  '<head>',
  '  <meta charset="utf-8"/>',
  '  <meta name="viewport" content="width=device-width, initial-scale=1">',
  '  <title>OTK zk-Metering API Docs</title>',
  '  <style>body{margin:0;padding:0;}</style>',
  '</head>',
  '<body>',
  '  <redoc spec-url="/openapi.json"></redoc>',
  '  <script src="https://cdn.jsdelivr.net/npm/redoc@2.1.5/bundles/redoc.standalone.js"></script>',
  '</body>',
  '</html>',
].join('\n');

// PA-06: simple in-process receipt counters exposed in /metrics (additive, backward-compat)
let _receiptsTotal = 0;
let _receiptsDuplicates = 0;

// Auth failure rate-limit: prevents brute-force of bearer tokens (GAP-B-004)
// Default: 20 failures per 60s per token-prefix (first 8 chars) or 'anon' if no token
const AUTH_FAIL_RL_CONFIG = {
  windowSeconds: 60,
  maxRequests: Number(process.env['OTK_AUTH_FAIL_MAX'] ?? 20),
};

/**
 * E1.3 / H3.2: Resolve full TokenContext from bearer token.
 *
 * Delegates to authenticateRequest() which tries JWT first, then API key.
 * Returns null when auth is enabled and token is missing/invalid (→ 401).
 * Returns { tenantId: 'default', role: 'OWNER' } when auth is disabled
 * (OWNER = all permissions pass → backward compat for auth-disabled deployments).
 */
function resolveCallerContext(req: IncomingMessage): TokenContext | null {
  const auth = authenticateRequest(req);
  if (!auth.authenticated) return null;
  return { tenantId: auth.tenantId, role: auth.role as any };
}

/**
 * F-OVN2-06 (FINAL CLOSURE, decision of the author 2026-10-07): tenant roles (OWNER, ADMIN, ...) administer ONLY their
 * own tenant. The target tenant comes from the body or the path, so it is compared with the tenant of the credential;
 * the body can never substitute the caller's context. Acting on another tenant needs a platform role that does not
 * exist in this version (future work: PLATFORM_ADMIN). With auth disabled the legacy OTK_ADMIN_KEY path is the
 * platform operator and is not restricted here. Returns true when a response was sent (denied).
 */
function denyCrossTenant(req: IncomingMessage, res: ServerResponse, targetTenantId: unknown): boolean {
  if (!isAuthEnabled()) return false;
  const caller = resolveCallerContext(req);
  if (!caller) { sendRbacDenial(res, { code: 401, error: 'unauthorized' }); return true; }
  if (typeof targetTenantId !== 'string' || targetTenantId.trim() === '' || targetTenantId !== caller.tenantId) {
    sendJson(res, 403, { ok: false, error: 'cross_tenant_forbidden', detail: 'tenant roles administer only their own tenant; no platform role exists in this version' });
    return true;
  }
  return false;
}

/**
 * AUD-FC-01/02 (FINAL CLOSURE, adversarial audit 2026-10-07): operations on the whole platform (replacing the tenant
 * registry, global finance) are not tenant administration, so no tenant role may run them, OWNER included. With auth
 * enabled they need the platform operator credential that already exists (OTK_ADMIN_KEY in x-admin-key, the same
 * credential that guards these routes when auth is disabled); without it configured they are refused. No new role.
 * Without that credential the usual RBAC answer is kept (401 unauthenticated, 403 forbidden without the permission);
 * a tenant role that HAS the permission gets 403 platform_operation_forbidden. Returns true when a response was sent.
 */
/** True when the request carries the platform operator credential (OTK_ADMIN_KEY configured and presented). */
function isPlatformCaller(req: IncomingMessage): boolean {
  const adminKey = getAdminKey();
  const presented = (req.headers as Record<string, string | string[] | undefined> | undefined)?.['x-admin-key'];
  if (!adminKey || typeof presented !== 'string') return false;
  const a = Buffer.from(presented); const b = Buffer.from(adminKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function denyPlatformOperation(req: IncomingMessage, res: ServerResponse, permission: Permission): Promise<boolean> {
  if (!isAuthEnabled()) return false;
  if (isPlatformCaller(req)) return false;
  const rbacDenial = await checkRbac(req, permission);
  if (rbacDenial) { sendRbacDenial(res, rbacDenial); return true; }
  sendJson(res, 403, { ok: false, error: 'platform_operation_forbidden', detail: 'tenant roles cannot run platform operations; the platform operator credential is required' });
  return true;
}

/**
 * AUD-FC-05 (FINAL CLOSURE re-audit, 2026-10-07): API keys addressed by id belong to one tenant. With auth enabled a
 * key of another tenant is answered exactly like a key that does not exist (404), before any read, revoke or rotate,
 * so a tenant OWNER can neither revoke another tenant's key nor rotate it to obtain a live token. Returns true when a
 * response was sent.
 */
async function denyForeignApiKey(req: IncomingMessage, res: ServerResponse, keyId: string): Promise<boolean> {
  if (!isAuthEnabled()) return false;
  const caller = resolveCallerContext(req);
  const meta = await getApiKeyHandler(keyId);
  if (!caller || !meta || meta.tenantId !== caller.tenantId) {
    sendError(res, 'OTK-4040', { legacyError: 'key not found' });
    return true;
  }
  return false;
}

/**
 * H1-S05 (SEC02-N03 / SEC02-N04): gate on minting API keys (POST /keys, POST /keys/:id/rotate) for a JWT that carries a
 * user (signup/login tokens). The user store is re-read (durable, cross-replica): a missing or deprovisioned user → 401;
 * an e-mail not verified → 403 email_not_verified. POLICY=PENDING_HUMAN_APPROVAL (D3): the e-mail gate is a product
 * decision, on by default. Registry tokens, dynamic keys and JWTs without userId are not affected. Returns true when a
 * response was sent.
 */
async function denyUnverifiedOrDeprovisionedUser(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (!isAuthEnabled()) return false;
  const auth = authenticateRequest(req);
  const userId = auth.method === 'jwt' ? auth.jwtPayload?.userId : undefined;
  if (typeof userId !== 'string' || userId === '') return false;
  const store = getUserStore();
  let user: Awaited<ReturnType<NonNullable<typeof store>['getUser']>> = null;
  try {
    user = store ? await store.getUser(userId) : null;
  } catch {
    // H1 lane B (S05 residual): the user store failing must not let a key be minted (fail closed)
    sendJson(res, 503, { ok: false, error: 'user_store_unavailable' });
    return true;
  }
  if (!user || user.deprovisionedAt) {
    if (user?.deprovisionedAt) markUserDeprovisioned(user.id, Date.parse(user.deprovisionedAt) || Date.now());
    sendRbacDenial(res, { code: 401, error: 'unauthorized' });
    return true;
  }
  if (!user.emailVerified) {
    sendJson(res, 403, { ok: false, error: 'email_not_verified', detail: 'verify the account e-mail (POST /verify-email) before creating or rotating API keys' });
    return true;
  }
  return false;
}

/**
 * H1 lane B (S04 residual): wait for the subject status to reach the durable store shared by the replicas. On failure
 * the change already holds on this replica (a deactivation is enforced here: fail closed) but other replicas do not see
 * it: answer 503 so that the operator retries. Returns true when a response was sent.
 */
async function denySubjectStatusUnsaved(res: ServerResponse, tenantId: string): Promise<boolean> {
  const r = await flushSubjectStatus({ kind: 'tenant', id: tenantId }); // H1 R-05: this tenant's write, not another's
  if (r.ok) return false;
  sendJson(res, 503, { ok: false, error: 'subject_status_unavailable', detail: 'the change applies on this replica but could not be written to the shared status store; retry' });
  return true;
}

/**
 * STOPGATE-01 R-13b: a registry change (token created, rotated, removed, suspended) must reach the shared registry before
 * the operator is told it is done; otherwise other replicas keep the old state. The change stays queued on this replica:
 * answer 503 so that the operator retries (the retry flushes it). Returns true when a response was sent.
 */
/**
 * STOPGATE-01 cycle 2 (review MED-3): before a token is bound to `tenantId` on this replica, the shared registry must not
 * hold it for another tenant (a replica only knows its own registry). Store error → 503, nothing changed.
 * Returns true when a response was sent.
 */
async function denyTokenBoundElsewhere(res: ServerResponse, token: string | undefined, tenantId: string): Promise<boolean> {
  const src = getRegistryTokenAuthority();
  if (!src || !token) return false;
  let row: Awaited<ReturnType<typeof src.getByHash>>;
  try { row = await src.getByHash(registryTokenHash(token.trim())); }
  catch { sendJson(res, 503, { ok: false, error: 'registry_unavailable', detail: 'the shared registry did not answer; nothing was changed; retry' }); return true; }
  if (!row || row.tenantId === tenantId) return false;
  sendError(res, 'OTK-4090', { legacyError: 'token already in use' });
  return true;
}

/**
 * STOPGATE-01 P1.2 (R2-D8): deployed environments need OTK_METRICS_TOKEN (Bearer) or the platform credential to read the
 * metrics routes (observability/metricsAccess). Returns true when a 401 was sent.
 */
function denyMetricsAccess(res: ServerResponse, headers: Record<string, string | undefined> | undefined): boolean {
  if (metricsAccessAllowed(headers)) return false;
  if (typeof res.setHeader === 'function') res.setHeader('WWW-Authenticate', 'Bearer realm="otk-metrics"');
  sendJson(res, 401, { ok: false, error: 'metrics_unauthorized', detail: 'metrics need the scraper bearer (OTK_METRICS_TOKEN) or the platform credential' });
  return true;
}

async function denyRegistryChangeUnsaved(res: ServerResponse): Promise<boolean> {
  if (await flushRegistryTokenChanges()) {
    // cycle 2 (review MED-3): a token already bound to another tenant in the shared registry was not moved
    if (takeRegistryTokenConflicts() === 0) return false;
    sendJson(res, 409, { ok: false, error: 'registry_token_conflict', detail: 'the token belongs to another tenant in the shared registry; the shared registry was not changed' });
    return true;
  }
  sendJson(res, 503, { ok: false, error: 'registry_change_unsaved', detail: 'the change applies on this replica but could not be written to the shared registry; retry' });
  return true;
}

/**
 * H1R2 review LOW-3: before changing the status of a tenant outside the registry, read its current status from the
 * shared store (the caller's own refresh covers the caller, not the target). Store error → 503, nothing changed.
 * Returns true when a response was sent.
 */
async function denyTargetStatusUnknown(res: ServerResponse, tenantId: string): Promise<boolean> {
  if (await refreshSubjectsNow([{ kind: 'tenant', id: tenantId }])) return false;
  sendJson(res, 503, { ok: false, error: 'subject_status_unavailable', detail: 'the current status of the tenant could not be read from the shared store; nothing was changed; retry' });
  return true;
}

/** H1 lane B (S05 residual): userId of the access JWT that authenticates the request, or null (other credentials). */
function jwtUserIdOf(req: IncomingMessage): string | null {
  const auth = authenticateRequest(req);
  // H1 R-06 (adversarial review): a key minted or rotated with a dynamic key inherits that key's author; before, it
  // was born without author and survived the author's SCIM deprovisioning ("authorship laundering")
  const uid = auth.method === 'jwt' ? auth.jwtPayload?.userId : auth.method === 'api_key' ? auth.keyCreatedBy : undefined;
  return typeof uid === 'string' && uid !== '' ? uid : null;
}

/**
 * AUD-FC-09..11 (FINAL CLOSURE re-audit sweep, 2026-10-07): a resource addressed by id (export job, webhook endpoint,
 * team) belongs to one tenant. With auth enabled a resource of another tenant is answered like a missing one (404),
 * before any read or change. ownerTenantId null = resource not found. Returns true when a response was sent.
 */
function denyForeignResource(req: IncomingMessage, res: ServerResponse, ownerTenantId: string | null | undefined): boolean {
  if (!isAuthEnabled()) return false;
  const caller = resolveCallerContext(req);
  if (!caller) { sendRbacDenial(res, { code: 401, error: 'unauthorized' }); return true; }
  if (!ownerTenantId || ownerTenantId !== caller.tenantId) { sendError(res, 'OTK-4040'); return true; }
  return false;
}

/** H1R2 S21-F01: spellings of the webhook collection besides '/webhooks' (prefix cut once: /v1/v1/webhooks → '/v1/webhooks'). */
const WEBHOOK_COLLECTION_ALIASES = new Set(['/webhooks/', '/v1/webhooks', '/v1/webhooks/']);

/** H1R2 S21-F01: list/create of webhook endpoints are disabled; authenticate first (401), then an explicit 501. */
function webhookManagementDisabled(req: IncomingMessage, res: ServerResponse): void {
  if (isAuthEnabled() && !resolveCallerContext(req)) return sendError(res, 'OTK-4010');
  return sendJson(res, 501, { ok: false, error: 'webhook_management_disabled', detail: 'listing and creating webhook endpoints is not enabled in this version (S21-F01: destination policy ready, role policy pending); endpoints by id remain under /v1/v1/webhooks/{id}' });
}

/** Tenant id of the caller when auth is enabled (listings are then restricted to it); null = auth disabled. */
function callerTenantScope(req: IncomingMessage): string | null {
  return isAuthEnabled() ? (resolveCallerContext(req)?.tenantId ?? null) : null;
}

/**
 * PF-DL / PF-TAL (RUN-S 2026-10-09, decision D4 of the author: HIGH, fix): dead-letters and the TAL summary hold data
 * of every tenant. A tenant role sees and acts only on its own tenant; the platform credential (x-admin-key) and the
 * legacy auth-disabled path see all (null). Called after checkRbac, so with auth enabled the caller is authenticated;
 * an unresolved caller gets a scope that matches no tenant.
 */
function tenantScopeUnlessPlatform(req: IncomingMessage): string | null {
  if (!isAuthEnabled() || isPlatformCaller(req)) return null;
  return resolveCallerContext(req)?.tenantId ?? '\u0000no-tenant';
}

/**
 * Check RBAC for a request. Returns a denial descriptor { code, error } or null if allowed.
 * When auth is disabled, always returns null (OWNER context → all perms pass).
 * Records auth-fail rate-limit on 401 when rateLimit=true.
 */
async function checkRbac(
  req: IncomingMessage,
  permission: Permission,
  rateLimit = false,
): Promise<{ code: number; error: string; retryAfterMs?: number } | null> {
  const ctx = resolveCallerContext(req);
  if (ctx === null) {
    if (rateLimit && await checkAuthFailRateLimit(req)) {
      return { code: 429, error: 'too_many_auth_failures' };
    }
    return { code: 401, error: 'unauthorized' };
  }
  if (!hasPermission(ctx.role, permission)) {
    return { code: 403, error: 'forbidden' };
  }
  return null;
}

/**
 * Check and record an auth failure for rate-limiting purposes.
 * Returns true if the caller should be throttled (429), false if still within limit.
 * F-H1-07 (H1 lane B): keyed by SOURCE address (same normalisation as the proxy limiter: IPv6 /64, X-Forwarded-For only
 * with OTK_PROXY_TRUSTED_HOPS>0). It used to be keyed by the first 8 characters of the presented token: guesses with
 * distinct prefixes were never throttled, and wrong tokens sharing a victim token's prefix throttled that prefix for
 * every source. The token never enters the key (GAP-B-004 still holds).
 */
async function checkAuthFailRateLimit(req: IncomingMessage): Promise<boolean> {
  const rlKey = buildRateLimitKey({ tenantId: `__auth_fail__:${sourceKey(req)}` });
  const decision = await getDistributedRateLimiter().check(rlKey, AUTH_FAIL_RL_CONFIG);
  return !decision.allowed;
}

/**
 * F-H1-10 (H1 lane B): user behind a refresh token, or null when the token must not mint an access token: no userId
 * (unbound legacy token), no user store, store error, unknown or deprovisioned user (durable store re-read, so it holds
 * across replicas), a token issued before the user's deprovisioning, or a user that is not a member of the tenant.
 */
async function refreshTokenUser(decoded: { tenantId: string; iat: number; userId?: string }): Promise<string | null> {
  if (!decoded.userId) return null;
  const store = getUserStore();
  if (!store) return null;
  try {
    const user = await store.getUser(decoded.userId);
    if (!user) return null;
    if (user.deprovisionedAt) {
      markUserDeprovisioned(user.id, Date.parse(user.deprovisionedAt) || Date.now());
      return null;
    }
    if (isUserDeprovisioned(user.id) || issuedBeforeUserRevocation(user.id, decoded.iat)) return null;
    const memberships = await store.getMemberships(user.id);
    if (!memberships.some((m) => m.orgId === decoded.tenantId)) return null;
    return user.id;
  } catch {
    return null; // fail closed
  }
}

// H1.8: readBody replaced by readBodyWithLimits (imported from limits.ts)
const readBody = readBodyWithLimits;

/**
 * Check legacy X-Admin-Key header (when auth is disabled).
 * Returns true if the request should be denied. Extracted to reduce copy-paste.
 */
function checkLegacyAdminKey(req: IncomingMessage, res: ServerResponse): boolean {
  const adminKey = getAdminKey();
  if (!adminKey) {
    // PF-NEW-03 / NF-22 (RUN-S): without a key the legacy path is open only outside production
    if (!isProductionEnv()) return false; // development: no key configured → allow
    sendError(res, 'OTK-4010');
    return true;
  }
  // NF-22 (RUN-S): constant-time comparison, same as isPlatformCaller
  if (!isPlatformCaller(req)) {
    sendError(res, 'OTK-4010');
    return true; // denied
  }
  return false; // allowed
}

/**
 * H1-S01/S03: an existing, active tenant as far as the platform can tell: tenant registry record (active), a registered
 * credential, or a /signup organization. Auth disabled (development A0) has no tenant registry: every id is accepted.
 */
async function tenantKnownToPlatform(tenantId: string): Promise<boolean> {
  if (!isAuthEnabled()) return true;
  const crud = getTenant(tenantId);
  if (crud) return crud.active;
  // H1R2 R-14: a deactivated /signup organization is not an active tenant; R-13: keys created on another replica count
  if (isTenantInactive(tenantId)) return false;
  return hasRegisteredTenant(tenantId) || await tenantExistsOutsideRegistry(tenantId);
}

/**
 * H1R2 R-13 / R-14: a tenant that exists without a registry record — a /signup organization, or a tenant with an
 * active dynamic key in the shared key store (created on any replica). Store errors propagate (callers fail closed).
 */
async function tenantExistsOutsideRegistry(tenantId: string): Promise<boolean> {
  if (!tenantId) return false;
  if (await getUserStore()?.getOrg(tenantId)) return true;
  // STOPGATE-01 R-13b: a registry tenant created on another replica (known here only through the shared registry)
  if (await getRegistryTokenAuthority()?.hasTenant(tenantId)) return true;
  return (await getApiKeyMetadataStore().listByTenant(tenantId, { limit: 1 })).length > 0;
}

/**
 * H1-S03: checkout redirect allowlist. OTK_BILLING_REDIRECT_ORIGINS is a comma-separated list of origins
 * (e.g. "https://app.example.com"). Without it, deployed environments refuse every redirect (fail closed) and
 * development accepts only http(s) URLs on localhost.
 */
function checkoutRedirectAllowed(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const allowed = (process.env['OTK_BILLING_REDIRECT_ORIGINS'] ?? '').split(',').map((o) => o.trim()).filter(Boolean);
  if (allowed.length > 0) return allowed.includes(u.origin);
  return !isDeployedEnv() && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
}

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const base = `http://localhost`;
  const url = new URL(req.url ?? '/', base);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  // H1.3: Request-ID — passthrough from client or generate UUID v4
  const headers = req.headers as Record<string, string | undefined> | undefined;
  const requestId = headers?.['x-request-id'] || crypto.randomUUID();
  if (typeof res.setHeader === 'function') res.setHeader('x-request-id', requestId);

  // H5.1: W3C tracing — parse incoming traceparent or generate new trace context
  const incomingTraceparent = headers?.['traceparent'];
  let traceId: string | undefined;
  let parentSpanId: string | undefined;
  if (incomingTraceparent) {
    const parts = incomingTraceparent.split('-');
    if (parts.length >= 3) {
      traceId = parts[1];
      parentSpanId = parts[2];
    }
  }
  const span = isTracingEnabled()
    ? startSpan(`${method} ${pathname}`, {
        traceId: traceId ?? generateTraceId(),
        parentSpanId,
        attributes: { 'http.method': method, 'http.url': pathname, 'request_id': requestId },
      })
    : null;
  if (span && typeof res.setHeader === 'function') {
    res.setHeader('traceparent', `00-${span.traceId}-${span.spanId}-01`);
  }

  // H1.9: Security headers on every response
  if (typeof res.setHeader === 'function') applySecurityHeaders(res);

  // H1.2: CORS — apply headers on every response, short-circuit OPTIONS preflight
  if (typeof res.setHeader === 'function') {
    applyCors(req, res, _corsConfig);
    if (method === 'OPTIONS') {
      handlePreflight(req, res, _corsConfig);
      return;
    }
  }

  // H1.1: API Versioning — /v1/ prefix stripping. Infra + dashboard routes bypass.
  const INFRA_ROUTES = new Set(['/health', '/version', '/healthz', '/readyz', '/metrics', '/metrics/prover', '/openapi.json', '/api-docs']);
  let routePath = pathname;
  if (pathname.startsWith('/v1/')) {
    routePath = pathname.slice(3); // '/v1/receipts' → '/receipts'
  } else if (
    process.env['OTK_STRICT_VERSIONING'] === '1' &&
    !INFRA_ROUTES.has(pathname) &&
    !pathname.startsWith('/app') &&
    pathname !== '/system/status'
  ) {
    if (typeof res.writeHead === 'function') {
      // H1R2 S21-F03: 308 keeps method and body for POST/PUT/PATCH/DELETE (a 301 is replayed as GET by most clients,
      // dropping the body); GET/HEAD keep 301 for compatibility with existing clients and caches.
      const redirectStatus = method === 'GET' || method === 'HEAD' ? 301 : 308;
      res.writeHead(redirectStatus, { 'Location': `/v1${pathname}${url.search}` });
      res.end();
      return;
    }
  }

  // PF-NEW-03 (RUN-S, decision D2): production with authentication disabled fails closed. The server refuses to start
  // in this state (productionGuard); this covers any other way of reaching the handler. Liveness probes stay open.
  if (isProductionEnv() && !isAuthEnabled() && !PRODUCTION_A0_OPEN_ROUTES.has(routePath)) {
    return sendJson(res, 503, { ok: false, error: 'auth_not_configured', detail: 'authentication is disabled (OTK_TENANTS empty) in production' });
  }

  // H1R2 R-13 / A3: the credential (dynamic key row, subject status) is brought up to date with the authoritative stores
  // before any route authenticates synchronously; unknown state of a key, or of the subject of a privileged/spending
  // request, is answered 503 (fail closed). Infra probes are not affected.
  if (!INFRA_ROUTES.has(routePath)) {
    const fresh = await refreshCredential(presentedCredential(headers), { strict: isStrictRoute(method, routePath), source: sourceKey(req) });
    if (!fresh.ok) {
      if (typeof res.setHeader === 'function') res.setHeader('Retry-After', '1');
      return sendJson(res, fresh.status, { ok: false, error: fresh.error, detail: fresh.detail });
    }
  }

  try {
    if (method === 'GET' && routePath === '/health') {
      return sendJson(res, 200, {
        ok: true,
        uptime: ((Date.now() - START_TIME) / 1000).toFixed(1),
        ts: new Date().toISOString(),
        instanceId: INSTANCE_ID,
      });
    }

    // NEW-4.02: Public system status page (no auth)
    if (method === 'GET' && (routePath === '/status' || routePath === '/status/')) {
      const { renderStatusPage, resolveDefaultStatus } = await import('../dashboard/status.js');
      const data = resolveDefaultStatus();
      const html = renderStatusPage(data);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // NEW-4.01: Tenant data export (async job)
    if (routePath === '/data/export' || routePath.startsWith('/data/export/status/')) {
      const { handleCreateExportJob, handleExportJobStatus } = await import('./dataExport.js');
      const callerCtx = resolveCallerContext(req);
      if (!callerCtx) return sendError(res, 'OTK-4010');
      const tenantId = callerCtx?.tenantId ?? 'default';

      if (method === 'POST' && routePath === '/data/export') {
        return handleCreateExportJob(req, res, tenantId);
      }
      if (method === 'GET' && routePath.startsWith('/data/export/status/')) {
        const jobId = decodeURIComponent(routePath.slice('/data/export/status/'.length));
        // AUD-FC-09: the job of another tenant is "not found"
        const { getExportJob } = await import('./dataExport.js');
        if (denyForeignResource(req, res, getExportJob(jobId)?.tenantId ?? null)) return;
        return handleExportJobStatus(req, res, jobId);
      }
    }

    // P4.1: Public pricing page (no auth)
    if (method === 'GET' && (routePath === '/pricing' || routePath === '/pricing/')) {
      const { renderPricingPage } = await import('../dashboard/pricing.js');
      const html = renderPricingPage();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // P4.3: Analytics dashboard page (no auth required for page; data auth via tenant)
    if (method === 'GET' && (routePath === '/analytics' || routePath === '/analytics/')) {
      const { getAnalyticsHtml } = await import('../dashboard/analytics.js');
      const html = getAnalyticsHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // P4.3: CU trend data endpoint (analytics)
    if (method === 'GET' && routePath === '/analytics/cu-trend') {
      const { getCuTrendData } = await import('../dashboard/analytics.js');
      let tenantId = url.searchParams.get('tenantId') ?? undefined;
      // AUD-FC-12: with auth enabled the trend is the caller's own tenant (platform credential: any or all tenants)
      if (isAuthEnabled() && !isPlatformCaller(req)) {
        const caller = resolveCallerContext(req);
        if (!caller) return sendRbacDenial(res, { code: 401, error: 'unauthorized' });
        tenantId = tenantId ?? caller.tenantId;
        if (denyCrossTenant(req, res, tenantId)) return;
      }
      const days = Math.min(90, Math.max(1, Number(url.searchParams.get('days') ?? '7')));
      const trend = getCuTrendData(tenantId, days);
      return sendJson(res, 200, trend);
    }

    // P4.2: Demo sandbox page (no auth)
    if (method === 'GET' && (routePath === '/demo' || routePath === '/demo/')) {
      const { getDemoHtml } = await import('../dashboard/demo.js');
      const html = getDemoHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // NEW-6.02: Changelog page + JSON API — no auth required
    if (method === 'GET' && (routePath === '/changelog' || routePath === '/changelog/')) {
      const { handleChangelogHtml } = await import('../dashboard/changelog.js');
      handleChangelogHtml(req, res);
      return;
    }
    if (method === 'GET' && routePath === '/changelog/json') {
      const { handleChangelogJson } = await import('../dashboard/changelog.js');
      handleChangelogJson(req, res);
      return;
    }

    // P4.4 + NEW-5.02: Legal pages (ToS, Privacy, DPA) — no auth required
    if (method === 'GET' && (routePath === '/terms' || routePath === '/terms/')) {
      const { renderTermsPage } = await import('../dashboard/legal.js');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderTermsPage());
      return;
    }
    if (method === 'GET' && (routePath === '/privacy' || routePath === '/privacy/')) {
      const { renderPrivacyPage } = await import('../dashboard/legal.js');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderPrivacyPage());
      return;
    }
    if (method === 'GET' && (routePath === '/dpa' || routePath === '/dpa/')) {
      const { renderDpaPage } = await import('../dashboard/legal.js');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderDpaPage());
      return;
    }

    // H4.4: Liveness probe — process is alive
    if (method === 'GET' && routePath === '/healthz') {
      return sendJson(res, 200, {
        status: 'ok',
        uptime: ((Date.now() - START_TIME) / 1000).toFixed(1),
        instanceId: INSTANCE_ID,
      });
    }

    // H4.4: Readiness probe — can serve traffic (checks deps)
    if (method === 'GET' && routePath === '/readyz') {
      const redisOk = (() => { try { const r = getRedisClient(); return r?.isReady ?? false; } catch { return false; } })();
      // RV30-01: configured PostgreSQL that is unreachable makes the instance not ready (writes
      // are refused with 503 until the store reconnects)
      const persistence = persistenceStatus();
      const ready = (redisOk || !process.env['OTK_REDIS_URL']) && persistence.mode !== 'pg-unavailable';
      return sendJson(res, ready ? 200 : 503, {
        status: ready ? 'ready' : 'not_ready',
        instanceId: INSTANCE_ID,
        checks: {
          redis: { status: redisOk ? 'up' : (process.env['OTK_REDIS_URL'] ? 'down' : 'not_configured') },
          persistence: { status: persistence.mode === 'pg-unavailable' ? 'down' : 'up', mode: persistence.mode },
        },
      });
    }

    if (method === 'GET' && routePath === '/version') {
      return sendJson(res, 200, {
        apiVersion: API_VERSION,
        gitHead: process.env['GIT_HEAD'] ?? null,
      });
    }

    if (method === 'POST' && routePath === '/ping') {
      const body = await readBody(req);
      return sendJson(res, 200, { ok: true, echo: body });
    }

    if (method === 'GET' && routePath === '/metrics') {
      if (denyMetricsAccess(res, headers)) return; // STOPGATE-01 P1.2 (R2-D8)
      // Prometheus text format (default) or JSON (legacy, ?format=json)
      const format = url.searchParams.get('format');
      if (format === 'json') {
        return sendJson(res, 200, {
          ...getCollector().snapshot(),
          receipts: { total: _receiptsTotal, duplicates: _receiptsDuplicates },
        });
      }
      const text = await getMetricsText();
      res.statusCode = 200;
      if (typeof res.setHeader === 'function') {
        res.setHeader('content-type', getMetricsContentType());
      }
      res.end(text);
      return;
    }

    if (method === 'GET' && routePath === '/events/latest') {
      const nParam = url.searchParams.get('n');
      const n = nParam ? Math.max(1, Math.min(100, parseInt(nParam, 10) || 10)) : 10;
      // PF-NEW-05 (RUN-S): with auth enabled the events of every tenant (key ids, labels, roles, usage) need a
      // credential and are filtered to the caller tenant; events without a tenant are platform-only. A0 unchanged.
      const evScope = tenantScopeUnlessPlatform(req);
      if (evScope !== null) {
        const _denyEv = await checkRbac(req, 'receipts:read');
        if (_denyEv) return sendRbacDenial(res, _denyEv);
        // RV-RUNS-09 (RUN-S review): key events (key ids, labels, roles) are key administration data
        const seesKeys = hasPermission((resolveCallerContext(req)?.role ?? '') as never, 'admin:keys');
        const own = getDispatcher().latest(100).filter((e) => (e.payload as Record<string, unknown> | undefined)?.['tenantId'] === evScope
          && (seesKeys || !String(e.eventKind).startsWith('key_')));
        return sendJson(res, 200, { ok: true, events: own.slice(-n) });
      }
      return sendJson(res, 200, { ok: true, events: getDispatcher().latest(n) });
    }

    if (method === 'GET' && routePath === '/ratelimit/status') {
      return sendJson(res, 200, { ok: true, status: 'distributed' });
    }

    // --- P1.2: OpenAPI spec + docs viewer (public — no auth required) ---

    if (method === 'GET' && routePath === '/openapi.json') {
      const spec = _loadSpec();
      if (!spec) return sendError(res, 'OTK-5030', { legacyError: 'spec_unavailable' });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.setHeader('content-length', Buffer.byteLength(spec));
      res.end(spec);
      return;
    }

    if (method === 'GET' && routePath === '/api-docs') {
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.setHeader('content-length', Buffer.byteLength(_API_DOCS_HTML));
      res.end(_API_DOCS_HTML);
      return;
    }

    // --- S4.1: System status polling endpoint (Wave 2 Pack 13) ---

    if (method === 'GET' && routePath === '/system/status') {
      // Public health/status endpoint — no auth required (same as /health)
      const cb = circuitBreakerStatus();
      const redisClient = getRedisClient();

      // Probe ProverDaemon /health (1s timeout, non-blocking)
      let daemonReachable = false;
      const proverUrl = process.env['PROVER_URL'] ?? 'http://localhost:3001';
      if (proverUrl !== 'disabled') {
        try {
          const resp = await fetch(`${proverUrl}/health`, { signal: AbortSignal.timeout(1000) });
          daemonReachable = resp.ok;
        } catch { daemonReachable = false; }
      }

      return sendJson(res, 200, {
        ok: true,
        uptime: ((Date.now() - START_TIME) / 1000).toFixed(1),
        receiptCount: receiptStoreSize(),
        queueDepth: 0, // updated by caller if ProductionQueue is available
        lastProofAt: null, // TODO: expose from ProverDaemon metrics when available
        workerState: 'unknown', // TODO: expose from ProverDaemon when available
        circuitBreakerStatus: { open: cb.open, consecutiveFails: cb.consecutiveFails },
        daemonReachable,
        deadLetterPending: await pendingCount(),
        redisConnected: redisClient ? redisClient.isReady : false,
        pgConnected: !!process.env['OTK_DB_URL'],
        instanceId: INSTANCE_ID,
        proxyMode: getProxyMode(),
        ts: new Date().toISOString(),
      });
    }

    // --- Receipt endpoints (PACK D — u12.post.d / u12.alpha.d hardening) ---

    if (method === 'POST' && routePath === '/receipts') {
      // E1.3: RBAC — receipts:write (rate-limits auth failures, backward-compat when auth disabled)
      const _deny0 = await checkRbac(req, 'receipts:write', true);
      if (_deny0) return sendRbacDenial(res, _deny0);
      const callerCtx0 = resolveCallerContext(req)!;
      const callerTenantId = callerCtx0.tenantId;

      // Rate limit: plan-based sliding window (E6.4 — replaces flat RECEIPT_RL_CONFIG)
      const rlKey = buildRateLimitKey({ tenantId: callerTenantId });
      // H1-S01b: the plan (rate limit, then quota) comes from the store, not from a cache another replica made stale
      await getTenantPlanVersioned(callerTenantId);
      const planRLConfig = getPlanRateLimit(callerTenantId);
      const rlDecision = await getDistributedRateLimiter().check(rlKey, planRLConfig);
      if (!rlDecision.allowed) {
        return sendError(res, 'OTK-4290', { retryAfterMs: rlDecision.retryAfterMs ?? 0 });
      }

      // Quota pre-check (E6.4). RV01: same rule and source (TAL) as the proxy entries;
      // the budget tracker read before was never debited, so this check never triggered.
      // N11: shared balance (Redis when configured), not only this process's memory
      const quota = await checkMeteringQuotaAsync(callerTenantId);
      if (quota.exceeded) {
        return sendError(res, 'OTK-4290', { details: [{ issue: `quota_exceeded: ${quota.current}/${quota.quota} CU this epoch` }] });
      }

      const body = await readBody(req);

      // H1.6: Idempotency-Key check (before any processing)
      // M24-DYN-01/02 (RUN-M1-24H): keys are scoped to the caller's tenant (length-prefixed, unambiguous); a global key
      // let tenant A block tenant B's receipt (409) or read B's cached response by replaying B's key and body
      const rawIdempKey = headers?.['idempotency-key'] as string | undefined;
      const idempKey = rawIdempKey ? `${String(callerTenantId ?? '').length}:${callerTenantId ?? ''}:${rawIdempKey}` : undefined;
      const idempResult = await checkIdempotency(idempKey, body);
      if ('cached' in idempResult && idempResult.cached) {
        res.statusCode = idempResult.response.status;
        if (typeof res.setHeader === 'function') {
          res.setHeader('content-type', 'application/json; charset=utf-8');
        }
        res.end(idempResult.response.body);
        return;
      }
      if ('conflict' in idempResult && idempResult.conflict) {
        return sendError(res, 'OTK-4091');
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return sendError(res, 'OTK-4002');
      }
      // H1.4: Zod validation replaces manual field checks
      const validation = validateBody(payload, ReceiptSubmissionSchema);
      if (!validation.success) {
        await addDeadLetter({
          originalPayload: body,
          error: 'missing_required_fields',
          reason: 'validation_error',
          source: 'POST /receipts',
          tenantId: callerTenantId,
        });
        return sendError(res, 'OTK-4001', { details: validation.issues });
      }
      const p = validation.data;
      // review MEDIUM-4: ids of durable-operation receipts are reserved (no squatting/probing)
      if (p.requestId.startsWith(OPERATION_RECEIPT_PREFIX)) return sendError(res, 'OTK-4001', { details: [{ issue: 'request_id_prefix_reserved' }] });
      // D5-G04: the debit uses CU computed by the server from the token totals; a client value
      // is kept only as a declaration. Unknown model/provider → refused, never debited as 0.
      const cu = computeKnownCu({ provider: p.provider, model: p.model, inputTokens: p.inputTokens, outputTokens: p.outputTokens });
      if (cu.status !== 'computed') {
        return sendError(res, 'OTK-4001', { details: [{ issue: `cu_not_computable: ${cu.status} (${cu.detail})` }] });
      }
      const receipt: RawReceipt & { clientDeclaredCostUnits?: number; cuFormula?: string } = {
        provider: p.provider,
        model: p.model,
        inputTokens: p.inputTokens,
        outputTokens: p.outputTokens,
        costUnits: cu.costUnits,
        latencyMs: p.latencyMs ?? 0,
        timestamp: p.timestamp ?? Math.floor(Date.now() / 1000),
        requestId: p.requestId,
        userId: BigInt(p.userId ?? '0'),
        nonce: BigInt(p.nonce ?? '0'),
        tenantId: isAuthEnabled() ? callerTenantId : (p.tenantId ?? undefined),
        // S0-F01b: stamp the weights actually used by the calculator; a loaded table that did
        // not influence this value is no longer stamped as if it had
        cwVersion: cu.weights,
        cuFormula: cu.formula,
        ...(p.costUnits !== undefined && p.costUnits !== cu.costUnits ? { clientDeclaredCostUnits: p.costUnits } : {}),
      };
      // R13: in Postgres mode the row is written before the acknowledgement.
      // RV30-05: there the quota is checked inside the same transaction, under a row lock shared
      // by every instance; other modes keep this process's reservation (single instance).
      let storeOutcome: Awaited<ReturnType<typeof storeReceiptDurable>>;
      if (transactionalQuotaActive()) {
        storeOutcome = await storeReceiptDurable(receipt, receipt.tenantId, { quota: quotaUnitsFor(receipt.tenantId ?? 'default') });
      } else {
        // Same tenant and epoch as the debit (the receipt's timestamp). An old timestamp still
        // lands in an old epoch with its own quota: accepting only recent timestamps is part of
        // the pending quota policy (second review, 2026-09-30).
        const reservation = await reserveMeteringQuota(receipt.tenantId ?? 'default', BigInt(receipt.costUnits), receipt.timestamp);
        if (reservation.exceeded) {
          return sendError(res, 'OTK-4290', { details: [{ issue: `quota_exceeded: ${reservation.current}/${reservation.quota} CU this epoch` }] });
        }
        try {
          storeOutcome = await storeReceiptDurable(receipt, receipt.tenantId);
        } finally {
          reservation.release();
        }
      }
      const { stored, reason: storeReason } = storeOutcome;
      if (storeReason === 'quota_exceeded' && storeOutcome.quota) {
        const toCu = (u: bigint) => (u / ACCOUNTING_SCALE).toString();
        return sendError(res, 'OTK-4290', { details: [{ issue: `quota_exceeded: ${toCu(storeOutcome.quota.current)}/${toCu(storeOutcome.quota.quota)} CU this epoch` }] });
      }
      // R13: a receipt that could not be durably written is not acknowledged
      if (storeReason === 'persistence_failed') return sendError(res, 'OTK-5030');
      // D3-G03: a requestId already used by another tenant is not this tenant's duplicate
      if (storeReason === 'tenant_mismatch') return sendError(res, 'OTK-4090', { details: [{ issue: 'request_id_in_use_by_another_tenant' }] });
      // P2.1: index receipt for dashboard (only new receipts)
      if (stored) getIndexer().index(receipt);
      // PA-06: update receipt counters
      _receiptsTotal++;
      if (!stored) _receiptsDuplicates++;
      // Idempotent: duplicate requestId → 200 (no side effects), new → 201
      const status = stored ? 201 : 200;
      const responseBody = {
        ok: true, requestId: receipt.requestId, costUnits: receipt.costUnits, duplicate: !stored,
        // D5-G04: visible when the client declared a different value (never debited)
        ...(receipt.clientDeclaredCostUnits !== undefined ? { clientDeclaredCostUnits: receipt.clientDeclaredCostUnits, cuFormula: receipt.cuFormula } : {}),
      };
      // H1.6: Cache response for idempotency
      await storeIdempotencyResponse(idempKey, status, JSON.stringify(responseBody), body);
      return sendJson(res, status, responseBody);
    }

    if (method === 'GET' && routePath.startsWith('/receipts/')) {
      // E1.3: RBAC — receipts:read (rate-limits auth failures, backward-compat when auth disabled)
      const _deny1 = await checkRbac(req, 'receipts:read', true);
      if (_deny1) return sendRbacDenial(res, _deny1);
      const callerCtx1 = resolveCallerContext(req)!;
      const callerTenantId = callerCtx1.tenantId;

      const requestId = decodeURIComponent(routePath.slice('/receipts/'.length));
      // N11: falls back to Postgres for receipts stored by another instance
      const receipt = await getReceiptDurable(requestId);
      if (!receipt) return sendError(res, 'OTK-4040');

      // AuthorityBoundary: prevent cross-tenant read (env-gated)
      if (isAuthEnabled() && receipt.tenantId) {
        try {
          assertTenantBoundary({
            actorTenantId: callerTenantId,
            resourceTenantId: receipt.tenantId,
            operation: 'read_receipt',
          });
        } catch {
          return sendError(res, 'OTK-4031');
        }
      }

      const proof = await getProofStatus(requestId);
      return sendJson(res, 200, {
        ok: true,
        receipt: {
          ...receipt,
          userId: String(receipt.userId),
          nonce: String(receipt.nonce),
        },
        proofStatus: proof.proofStatus,
        ...(proof.jobId ? { jobId: proof.jobId } : {}),
        ...(proof.attempts !== undefined ? { proofAttempts: proof.attempts } : {}),
        ...(proof.nextRetryAt ? { nextRetryAt: proof.nextRetryAt } : {}),
        ...(proof.error ? { proofError: proof.error } : {}),
        ...(proof.txHash ? { txHash: proof.txHash } : {}),
      });
    }

    // --- Accounting endpoint (TAL — u12.alpha.d) ---

    if (method === 'GET' && routePath === '/accounting/balance') {
      // E1.3: RBAC — accounting:read (when auth enabled; open when disabled for backward compat)
      let tid = url.searchParams.get('tenantId') ?? 'default';
      if (isAuthEnabled()) {
        const _deny2 = await checkRbac(req, 'accounting:read');
        if (_deny2) return sendRbacDenial(res, _deny2);
        // Cross-tenant read guard: the caller may only read its own balance.
        // Before, any authenticated tenant could pass another tenant's id in the query.
        const callerTenantId2 = resolveCallerContext(req)!.tenantId;
        tid = url.searchParams.get('tenantId') ?? callerTenantId2;
        try {
          assertTenantBoundary({ actorTenantId: callerTenantId2, resourceTenantId: tid, operation: 'read_balance' });
        } catch {
          return sendError(res, 'OTK-4031');
        }
      }
      const eid = url.searchParams.get('epochId') ?? '0';
      const balance = await sharedBalance(tid, eid);
      return sendJson(res, 200, {
        ok: true,
        tenantId: balance.tenantId,
        epochId: balance.epochId,
        totalCU: String(balance.totalCU),
        entryCount: balance.entryCount,
      });
    }

    // D7-G08: rebuild the Redis projection from PostgreSQL after Redis was lost/replaced
    if (method === 'POST' && routePath === '/admin/redis/reproject') {
      if (isAuthEnabled()) {
        if (!isPlatformCaller(req)) {
          const _denyRp = await checkRbac(req, 'admin:flush');
          if (_denyRp) return sendRbacDenial(res, _denyRp);
        }
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      let filter: { tenantId?: string; epochId?: string } = {};
      const raw = await readBody(req);
      if (raw.trim()) {
        try { filter = JSON.parse(raw) as { tenantId?: string; epochId?: string }; } catch { return sendError(res, 'OTK-4002'); }
        // RV2-RUNS-04 (RUN-S review): null, arrays and primitives are a bad request, not a 500 TypeError
        if (filter === null || typeof filter !== 'object' || Array.isArray(filter)) return sendError(res, 'OTK-4002');
      }
      // RV-RUNS-01 / NF-27 (RUN-S): a tenant role rebuilds only its own tenant; an empty filter (all tenants) is platform-only
      if (!isPlatformCaller(req) && denyCrossTenant(req, res, filter.tenantId)) return;
      const rearmed = await reprojectRedis({ tenantId: typeof filter.tenantId === 'string' ? filter.tenantId : null, epochId: typeof filter.epochId === 'string' ? filter.epochId : null });
      if (rearmed === null) return sendError(res, 'OTK-5030', { details: [{ issue: 'requires_postgres_mode' }] });
      return sendJson(res, 202, { ok: true, rearmed });
    }

    if (method === 'POST' && routePath === '/admin/flush-batch') {
      // E1.3: RBAC when auth enabled; legacy OTK_ADMIN_KEY when auth disabled (backward compat)
      if (isAuthEnabled()) {
        // RV-RUNS-01 (RUN-S): platform-wide operation or aggregate, not tenant administration
        if (await denyPlatformOperation(req, res, 'admin:flush')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const result = flushBatch();
      if (!result) return sendJson(res, 200, { ok: true, flushed: 0, batch: null });
      return sendJson(res, 200, {
        ok: true,
        flushed: result.proofs.length,
        batch: {
          root: result.header.root,
          count: result.header.count,
          epoch: String(result.header.epoch),
          totalCUBucket: String(result.header.totalCUBucket),
        },
      });
    }

    // --- E5.2: ProverDaemon status endpoint ---
    if (method === 'GET' && routePath === '/admin/prover/status') {
      if (isAuthEnabled()) {
        // RV-RUNS-01 (RUN-S): platform-wide operation or aggregate, not tenant administration
        if (await denyPlatformOperation(req, res, 'admin:chain-head')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const { getProverDaemonManager } = await import('../prover/ProverDaemonManager.js');
      const mgr = getProverDaemonManager();
      return sendJson(res, 200, { ok: true, prover: mgr.status });
    }

    // --- Admin observability endpoints (GAP-C-004) ---
    // Protected by same OTK_ADMIN_KEY as flush-batch when configured.

    if (method === 'GET' && routePath === '/admin/chain-head') {
      // E1.3: RBAC when auth enabled; legacy OTK_ADMIN_KEY when auth disabled
      if (isAuthEnabled()) {
        // RV-RUNS-01 (RUN-S): platform-wide operation or aggregate, not tenant administration
        if (await denyPlatformOperation(req, res, 'admin:chain-head')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      return sendJson(res, 200, {
        ok: true,
        chainHead: chainHead(),
        auditEntryCount: auditCount(),
        ts: new Date().toISOString(),
      });
    }

    if (method === 'GET' && routePath === '/admin/tal-summary') {
      // E1.3: RBAC when auth enabled; legacy OTK_ADMIN_KEY when auth disabled
      if (isAuthEnabled()) {
        // RV-RUNS-07 (RUN-S): the platform credential alone is enough here
        const _deny5 = isPlatformCaller(req) ? null : await checkRbac(req, 'admin:tal-summary');
        if (_deny5) return sendRbacDenial(res, _deny5);
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const tal = getAccountingLayer();
      const tid = url.searchParams.get('tenantId');
      const eid = url.searchParams.get('epochId');
      const talScope = tenantScopeUnlessPlatform(req);
      if (talScope !== null && tid && denyCrossTenant(req, res, tid)) return;
      // the entry counter covers every tenant: only the platform sees it
      const base = talScope === null
        ? { ok: true, totalEntries: tal.size(), ts: new Date().toISOString() }
        : { ok: true, ts: new Date().toISOString() };
      if (tid && eid) {
        const bal = tal.balance(tid, eid);
        return sendJson(res, 200, {
          ...base,
          balance: {
            tenantId: bal.tenantId,
            epochId: bal.epochId,
            totalCU: String(bal.totalCU),
            entryCount: bal.entryCount,
          },
        });
      }
      return sendJson(res, 200, {
        ...base,
        hint: 'Add ?tenantId=<id>&epochId=<id> to get balance for a specific tenant/epoch',
      });
    }

    // --- E1.2: Live tenant key rotation (POST /admin/tenants/reload) ---
    // Reloads the TenantKeyRegistry from a new OTK_TENANTS-format string without restart.
    // Auth: requires x-admin-key when OTK_ADMIN_KEY is configured.

    if (method === 'POST' && routePath === '/admin/tenants/reload') {
      // Replacing the registry acts on every tenant: platform operation (AUD-FC-01), never a tenant role, OWNER
      // included. Auth disabled: legacy OTK_ADMIN_KEY as before.
      if (isAuthEnabled()) {
        if (await denyPlatformOperation(req, res, 'admin:keys')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const body = await readBody(req);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const rv = validateBody(payload, TenantsReloadSchema);
      if (!rv.success) return sendError(res, 'OTK-4001', { details: rv.issues });
      // a reload that loads no valid entry would switch authentication off for everyone: refused, registry unchanged
      if (isAuthEnabled() && parseTenantsString(rv.data.tenants).size === 0) {
        return sendJson(res, 400, { ok: false, error: 'reload_would_disable_auth', detail: 'no valid tenant entry; registry unchanged' });
      }
      const before = staticRegistrySnapshot();
      const { loaded } = loadTenantsFromString(rv.data.tenants);
      // STOPGATE-01 R-13b: the reload reaches every replica through the shared registry (removed → revoked)
      if (getRegistryTokenAuthority()) {
        const after = staticRegistrySnapshot();
        for (const [t, ctx] of before) if (!after.has(t)) queueRegistryTokenChange({ op: 'revoke', token: t, tenantId: ctx.tenantId });
        // cycle 2 (review MED-1): only entries the reload adds or changes become rows; tokens loaded from OTK_TENANTS at
        // startup and kept by the reload stay row-less (each replica's environment keeps deciding them)
        for (const [t, ctx] of after) {
          const prev = before.get(t);
          if (!prev || prev.tenantId !== ctx.tenantId || prev.role !== ctx.role) queueRegistryTokenChange({ op: 'put', token: t, tenantId: ctx.tenantId, role: ctx.role, suspended: false });
        }
        if (await denyRegistryChangeUnsaved(res)) return;
      }
      return sendJson(res, 200, { ok: true, loaded, authEnabled: isAuthEnabled() });
    }

    // --- S2.1/S2.2: Plan + Invoice endpoints ---

    if (method === 'GET' && routePath === '/plans') {
      return sendJson(res, 200, { ok: true, plans: getAllPlans().map(p => ({ ...p, cuQuotaPerEpoch: String(p.cuQuotaPerEpoch) })) });
    }

    if (method === 'GET' && routePath === '/invoices') {
      if (isAuthEnabled()) {
        const _denyInv = await checkRbac(req, 'accounting:read');
        if (_denyInv) return sendRbacDenial(res, _denyInv);
      }
      const callerCtx = resolveCallerContext(req);
      const tid = url.searchParams.get('tenantId') ?? callerCtx?.tenantId ?? 'default';
      if (denyCrossTenant(req, res, tid)) return; // AUD-FC-14: only the caller's own invoice
      const eid = url.searchParams.get('epochId') ?? '0';
      const invoice = generateInvoice(tid, eid);
      return sendJson(res, 200, { ok: true, invoice: serializeInvoice(invoice) });
    }

    // --- NEW-4.03: SSO SAML/OIDC ---
    if (routePath.startsWith('/auth/saml/') || routePath.startsWith('/auth/oidc/')) {
      const { SamlProvider } = await import('../auth/sso/SamlProvider.js');

      if (method === 'GET' && routePath === '/auth/saml/metadata') {
        const sp = new SamlProvider();
        res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8' });
        res.end(sp.getMetadata());
        return;
      }

      if (method === 'POST' && routePath === '/auth/saml/acs') {
        // PF-NEW-01 (RUN-S, decision D2): SamlProvider only parses the NameID; it checks no signature, certificate,
        // issuer, audience, destination, validity window or replay, and the NameID was taken as the tenant. Until
        // real validation exists no assertion is accepted and no token is issued, in any environment.
        return sendJson(res, 501, { ok: false, error: 'saml_not_supported', detail: 'SAML assertion validation is not implemented in this version; SSO login is disabled' });
      }

      if (method === 'GET' && routePath === '/auth/oidc/callback') {
        // RUN-S-N02 (RUN-S, same class as PF-NEW-01): OidcProvider.exchangeCode is a stub outside production whose
        // subject is derived from the code chosen by the caller, and the subject was taken as the tenant. No token is
        // issued until a real code exchange with ID token validation exists.
        return sendJson(res, 501, { ok: false, error: 'oidc_not_supported', detail: 'OIDC code exchange is not implemented in this version; SSO login is disabled' });
      }
    }

    // --- NEW-4.04: SCIM 2.0 provisioning ---
    if (routePath.startsWith('/scim/v2/')) {
      const { handleScimRequest } = await import('../auth/scim/ScimRouter.js');
      const store = getUserStore();
      await handleScimRequest(req, res, routePath, method, store);
      return;
    }

    // --- P5.2: SSE real-time stream ---
    if (method === 'GET' && routePath === '/stream') {
      if (isAuthEnabled()) {
        const _denySSE = await checkRbac(req, 'accounting:read');
        if (_denySSE) return sendRbacDenial(res, _denySSE);
      }
      const sseCtx = resolveCallerContext(req);
      const tenantId = sseCtx?.tenantId ?? 'anonymous';
      const { handleSseStream } = await import('../streaming/SseRouter.js');
      handleSseStream(req, res, tenantId);
      // H1R2 review MED-2: a stream outlives its admission; the credential is re-checked against the authoritative
      // stores every OTK_SSE_REAUTH_MS (default 5000) and the stream is closed once it is revoked, its tenant or author
      // deactivated, or its state unknown (fail closed)
      if (isAuthEnabled()) {
        const reauthMs = Math.max(250, Number(process.env['OTK_SSE_REAUTH_MS'] ?? 5000) || 5000);
        const token = presentedCredential(headers);
        const timer = setInterval(() => {
          void (async () => {
            const f = await refreshCredential(token, { strict: true, source: sourceKey(req) });
            const a = authenticateRequest(req);
            if (!f.ok || !a.authenticated || a.tenantId !== tenantId) { clearInterval(timer); res.end(); }
          })().catch(() => { clearInterval(timer); res.end(); });
        }, reauthMs);
        timer.unref?.();
        res.on('close', () => clearInterval(timer));
      }
      return; // connection stays open
    }

    // --- E6.6 / NEW-4.05: Webhook management ---
    // H1R2 S21-F01: listing/creating endpoints is NOT enabled (SSRF surface; minimum role M24-DYN-09 is
    // PENDING_HUMAN_POLICY). Every spelling (/webhooks, /v1/webhooks, /v1/v1/webhooks, trailing slash) answers an explicit
    // 501 after authentication instead of a 404. Guarded service ready for activation: src/webhooks/WebhookManagement.ts.
    if (method === 'GET' && (routePath === '/webhooks' || WEBHOOK_COLLECTION_ALIASES.has(routePath))) return webhookManagementDisabled(req, res);
    if (method === 'POST' && (routePath === '/webhooks' || WEBHOOK_COLLECTION_ALIASES.has(routePath))) return webhookManagementDisabled(req, res);

    if (routePath.startsWith('/v1/webhooks')) {
      const { getWebhookStore } = await import('../webhooks/WebhookRegistry.js');
      const wStore = getWebhookStore();
      const webhookCtx = resolveCallerContext(req);
      if (isAuthEnabled() && !webhookCtx) return sendError(res, 'OTK-4010');

      // AUD-FC-10: every by-id webhook operation is limited to endpoints of the caller tenant
      const epIdMatch = routePath.match(/^\/v1\/webhooks\/([^/]+)(?:\/.*)?$/);
      if (epIdMatch && epIdMatch[1] !== undefined) {
        const owner = (await wStore.getEndpoint(epIdMatch[1]))?.tenantId ?? null;
        if (denyForeignResource(req, res, owner)) return;
      }

      const epDeleteMatch = routePath.match(/^\/v1\/webhooks\/([^/]+)$/);
      if (method === 'DELETE' && epDeleteMatch) {
        const deleted = await wStore.deleteEndpoint(epDeleteMatch[1]!);
        return sendJson(res, deleted ? 200 : 404, { ok: deleted });
      }

      const dlMatch = routePath.match(/^\/v1\/webhooks\/([^/]+)\/deliveries$/);
      if (method === 'GET' && dlMatch) {
        const deliveries = await wStore.listDeliveries(dlMatch[1]!);
        return sendJson(res, 200, { ok: true, deliveries });
      }

      const replayMatch = routePath.match(/^\/v1\/webhooks\/([^/]+)\/deliveries\/([^/]+)\/replay$/);
      if (method === 'POST' && replayMatch) {
        const dls = await wStore.listDeadLetters(replayMatch[1]);
        const entry = dls.find(d => d.id === replayMatch[2]);
        if (!entry) return sendError(res, 'OTK-4040'); // M24-DYN-03: OTK-4044 is not a registered code (answered 500)
        await wStore.updateDeadLetterReplay(entry.id);
        return sendJson(res, 200, { ok: true, replayedId: entry.id });
      }
    }

    // --- BILL-02/05: Billing cycles API ---
    if (method === 'GET' && routePath === '/billing/cycles') {
      if (isAuthEnabled()) {
        // RV-RUNS-07 (RUN-S): the platform credential alone is enough here
        const _denyCycles = isPlatformCaller(req) ? null : await checkRbac(req, 'admin:billing');
        if (_denyCycles) return sendRbacDenial(res, _denyCycles);
      }
      const { getMemStoreCycles } = await import('../billing/BillingCycleWorker.js');
      let all = getMemStoreCycles();
      // F-PF-SEC-01 (POST-FREEZE review): a tenant sees only its own billing cycle (platform credential: all)
      if (isAuthEnabled() && !isPlatformCaller(req)) {
        const caller = resolveCallerContext(req);
        if (!caller) return sendRbacDenial(res, { code: 401, error: 'unauthorized' });
        all = all.filter((c) => c.tenantId === caller.tenantId);
      }
      const cycles = all.map(c => ({
        ...c,
        totalCU: String(c.totalCU),
      }));
      return sendJson(res, 200, { cycles });
    }

    // --- P4.5: Stripe billing + webhook ---
    if (method === 'POST' && routePath === '/billing/checkout') {
      if (isAuthEnabled()) {
        const _denyBill = await checkRbac(req, 'admin:tenants');
        if (_denyBill) return sendRbacDenial(res, _denyBill);
      }
      const body = await readBody(req);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const { tier, successUrl, cancelUrl, email } = payload as Record<string, string>;
      if (!tier || !successUrl || !cancelUrl) return sendError(res, 'OTK-4001', { legacyError: 'tier, successUrl, cancelUrl required' });
      // H1-S03: only a known paid tier; redirects only to allowed origins (open redirect through the checkout page)
      if (tier !== 'STARTER' && tier !== 'PRO') return sendError(res, 'OTK-4001', { legacyError: 'tier must be STARTER or PRO' });
      if (!checkoutRedirectAllowed(successUrl) || !checkoutRedirectAllowed(cancelUrl)) {
        return sendJson(res, 400, { ok: false, error: 'redirect_not_allowed', detail: 'successUrl and cancelUrl must use an origin listed in OTK_BILLING_REDIRECT_ORIGINS' });
      }
      const callerCtx = resolveCallerContext(req);
      // H1-S03: with authentication on, the checkout belongs to the caller's tenant; no implicit 'default' tenant
      if (isAuthEnabled() && !callerCtx?.tenantId) return sendJson(res, 400, { ok: false, error: 'tenant_context_required' });
      const stripeKey = getStripeSecretKey();
      if (!stripeKey) return sendError(res, 'OTK-5000', { legacyError: 'Stripe not configured (OTK_STRIPE_SECRET_KEY missing)' });
      const { StripeClient } = await import('../billing/stripe/StripeClient.js');
      const tenantId = callerCtx?.tenantId ?? 'default';
      const client = new StripeClient(stripeKey);
      const session = await client.createCheckoutSession({ tenantId, tier: tier as any, successUrl, cancelUrl, customerEmail: email });
      return sendJson(res, 200, { ok: true, sessionId: session.id, url: session.url });
    }

    if (method === 'POST' && routePath === '/webhooks/stripe') {
      // Raw body required for Stripe signature verification — skip JSON parse
      const rawBody = await readBody(req);
      const sig = String(req.headers['stripe-signature'] ?? '');
      const stripeSecret = getStripeWebhookSecret();
      if (!stripeSecret) return sendError(res, 'OTK-5000', { legacyError: 'Stripe webhook secret not configured' });
      const stripeApiKey = getStripeSecretKey();
      if (!stripeApiKey) return sendError(res, 'OTK-5000', { legacyError: 'Stripe not configured (OTK_STRIPE_SECRET_KEY missing)' });
      const { StripeClient } = await import('../billing/stripe/StripeClient.js');
      const { StripeWebhookHandler } = await import('../billing/stripe/StripeWebhookHandler.js');
      const client = new StripeClient(stripeApiKey);
      let event: unknown;
      try {
        event = client.constructWebhookEvent(rawBody, sig, stripeSecret);
      } catch {
        return sendError(res, 'OTK-4010', { legacyError: 'invalid Stripe webhook signature' });
      }
      // H1-S03b: a signed event naming a tenant that does not exist creates no plan row
      const handler = new StripeWebhookHandler({ tenantExists: tenantKnownToPlatform });
      const result = await handler.handle(event as any);
      // H1-S03 (INF02-O2): an effect that was not persisted is not acknowledged; Stripe redelivers on non-2xx
      if (result.retryable) return sendJson(res, 503, { received: false, result });
      return sendJson(res, 200, { received: true, result });
    }

    // --- VAULT-03/04/05: Provider Key CRUD (per-tenant) ---

    if (method === 'POST' && routePath.match(/^\/v1\/tenants\/[^/]+\/provider-keys$/)) {
      if (isAuthEnabled()) {
        const _denyVault1 = await checkRbac(req, 'admin:tenants');
        if (_denyVault1) return sendRbacDenial(res, _denyVault1);
      }
      const tenantId = decodeURIComponent(routePath.split('/')[3]!);
      if (denyCrossTenant(req, res, tenantId)) return; // AUD-FC-06: only the caller's own vault
      const body = await readBody(req);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const p = payload as Record<string, unknown>;
      if (!p || typeof p['provider'] !== 'string' || typeof p['key'] !== 'string' || !p['provider'] || !p['key']) {
        return sendError(res, 'OTK-4001', { legacyError: 'provider and key are required' });
      }
      getVault().storeKey(tenantId, String(p['provider']), String(p['key']));
      return sendJson(res, 201, { ok: true, tenantId, provider: String(p['provider']).toLowerCase() });
    }

    if (method === 'GET' && routePath.match(/^\/v1\/tenants\/[^/]+\/provider-keys$/)) {
      if (isAuthEnabled()) {
        const _denyVault2 = await checkRbac(req, 'admin:tenants');
        if (_denyVault2) return sendRbacDenial(res, _denyVault2);
      }
      const tenantId = decodeURIComponent(routePath.split('/')[3]!);
      if (denyCrossTenant(req, res, tenantId)) return; // AUD-FC-06
      const maskedKeys = getVault().listKeys(tenantId);
      return sendJson(res, 200, { ok: true, tenantId, keys: maskedKeys });
    }

    if (method === 'DELETE' && routePath.match(/^\/v1\/tenants\/[^/]+\/provider-keys\/[^/]+$/)) {
      if (isAuthEnabled()) {
        const _denyVault3 = await checkRbac(req, 'admin:tenants');
        if (_denyVault3) return sendRbacDenial(res, _denyVault3);
      }
      const parts = routePath.split('/');
      const tenantId = decodeURIComponent(parts[3]!);
      if (denyCrossTenant(req, res, tenantId)) return; // AUD-FC-06
      const provider = decodeURIComponent(parts[5]!);
      const deleted = getVault().deleteKey(tenantId, provider);
      if (!deleted) return sendError(res, 'OTK-4040');
      return sendJson(res, 200, { ok: true, tenantId, provider: provider.toLowerCase() });
    }

    // --- E5.5+E5.6: GDPR export + right-to-erasure ---
    if (routePath.startsWith('/admin/gdpr/')) {
      if (isAuthEnabled()) {
        const _denyGdpr = await checkRbac(req, 'admin:gdpr');
        if (_denyGdpr) return sendRbacDenial(res, _denyGdpr);
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const { handleGdprExport, handleGdprErase } = await import('./gdpr.js');
      if (method === 'GET' && routePath.startsWith('/admin/gdpr/export/')) {
        const tenantId = decodeURIComponent(routePath.slice('/admin/gdpr/export/'.length));
        if (denyCrossTenant(req, res, tenantId)) return; // AUD-FC-07: only the caller's own tenant
        return handleGdprExport(req, res, tenantId);
      }
      if (method === 'DELETE' && routePath.startsWith('/admin/gdpr/erase/')) {
        const tenantId = decodeURIComponent(routePath.slice('/admin/gdpr/erase/'.length));
        if (denyCrossTenant(req, res, tenantId)) return; // AUD-FC-07
        return handleGdprErase(req, res, tenantId);
      }
    }

    // --- NEW-6.01: Feature Flags CRUD (admin only) ---
    if (routePath.startsWith('/admin/flags')) {
      // AUD-FC-08: flags and their per-tenant overrides are platform configuration (a global flag affects every
      // tenant; an override changes another tenant): no tenant role may manage them.
      if (isAuthEnabled()) {
        if (await denyPlatformOperation(req, res, 'admin:flags')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const { getFeatureFlagService } = await import('../features/FeatureFlagService.js');
      const svc = getFeatureFlagService();

      // GET /admin/flags — list all
      if (method === 'GET' && (routePath === '/admin/flags' || routePath === '/admin/flags/')) {
        return sendJson(res, 200, { ok: true, flags: svc.list() });
      }

      // POST /admin/flags — create/update global flag
      if (method === 'POST' && (routePath === '/admin/flags' || routePath === '/admin/flags/')) {
        const body = await readBody(req);
        let payload: unknown;
        try { payload = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
        // SEC-12: Zod validation for feature flag upsert body
        const ffValidation = validateBody(payload, FeatureFlagUpsertSchema);
        if (!ffValidation.success) return sendError(res, 'OTK-4001', { legacyError: ffValidation.issues.map(i => i.issue).join('; ') });
        const { key, enabled, description } = ffValidation.data;
        try {
          const flag = svc.upsert(key, enabled, description);
          return sendJson(res, 200, { ok: true, flag });
        } catch (e) {
          return sendError(res, 'OTK-4001', { legacyError: e instanceof Error ? e.message : String(e) });
        }
      }

      // Normalize path: strip ALL trailing slashes before pattern matching.
      // The list endpoint (GET/POST /admin/flags[/]) is fully handled above and
      // never reaches this point, so no special-case preservation is needed.
      const flagsPath = routePath.replace(/\/+$/, '');

      // PUT/DELETE /admin/flags/:key/override/:tenantId — must be evaluated BEFORE the
      // generic :key handlers, because startsWith('/admin/flags/') would otherwise
      // intercept the override path and call svc.delete() with a mangled key.
      const overrideMatch = flagsPath.match(/^\/admin\/flags\/([^/]+)\/override\/([^/]+)$/);

      // GET /admin/flags/:key — get single flag (exclude override sub-paths)
      if (method === 'GET' && flagsPath.startsWith('/admin/flags/') && !overrideMatch) {
        const key = decodeURIComponent(flagsPath.slice('/admin/flags/'.length));
        const flag = svc.get(key);
        if (!flag) return sendError(res, 'OTK-4040', { legacyError: `flag "${key}" not found` });
        return sendJson(res, 200, { ok: true, flag });
      }

      // PUT /admin/flags/:key/override/:tenantId — set per-tenant override
      if (method === 'PUT' && overrideMatch) {
        const key = decodeURIComponent(overrideMatch[1]);
        const tenantId = decodeURIComponent(overrideMatch[2]);
        const body = await readBody(req);
        let payload: unknown;
        try { payload = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
        const { enabled } = payload as Record<string, unknown>;
        if (typeof enabled !== 'boolean') {
          return sendError(res, 'OTK-4001', { legacyError: 'enabled (boolean) required' });
        }
        try {
          const flag = svc.setOverride(key, tenantId, enabled);
          return sendJson(res, 200, { ok: true, flag });
        } catch (e) {
          return sendError(res, 'OTK-4001', { legacyError: e instanceof Error ? e.message : String(e) });
        }
      }

      // DELETE /admin/flags/:key/override/:tenantId — clear override
      if (method === 'DELETE' && overrideMatch) {
        const key = decodeURIComponent(overrideMatch[1]);
        const tenantId = decodeURIComponent(overrideMatch[2]);
        const removed = svc.clearOverride(key, tenantId);
        return sendJson(res, 200, { ok: true, removed });
      }

      // DELETE /admin/flags/:key — delete flag (must come after overrideMatch check)
      if (method === 'DELETE' && flagsPath.startsWith('/admin/flags/') && !overrideMatch) {
        const key = decodeURIComponent(flagsPath.slice('/admin/flags/'.length));
        const deleted = svc.delete(key);
        return sendJson(res, 200, { ok: true, deleted });
      }

      // GET /v1/flags/evaluate?key=xxx&tenantId=yyy — public evaluation
    }

    // GET /v1/flags/evaluate — public flag evaluation (tenant-scoped, no admin required)
    if (method === 'GET' && routePath === '/flags/evaluate') {
      const key = url.searchParams.get('key') ?? '';
      let tenantId = url.searchParams.get('tenantId') ?? undefined;
      // NF-21 (RUN-S): with auth enabled a credential is needed and a tenant evaluates only its own flags
      const flScope = tenantScopeUnlessPlatform(req);
      if (flScope !== null) {
        const _denyFl = await checkRbac(req, 'receipts:read');
        if (_denyFl) return sendRbacDenial(res, _denyFl);
        if (tenantId !== undefined && denyCrossTenant(req, res, tenantId)) return;
        tenantId = flScope;
      }
      if (!key) return sendError(res, 'OTK-4001', { legacyError: 'key query param required' });
      const { getFeatureFlagService } = await import('../features/FeatureFlagService.js');
      const decision = getFeatureFlagService().evaluate(key, tenantId);
      return sendJson(res, 200, { ok: true, ...decision });
    }

    // --- P5.1: Evidence Index Automation (admin only) ---
    if (method === 'POST' && routePath === '/admin/evidence/index') {
      if (isAuthEnabled()) {
        // RV-RUNS-01 (RUN-S): platform-wide operation or aggregate, not tenant administration
        if (await denyPlatformOperation(req, res, 'admin:chain-head')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const { runIndexer } = await import('../automation/EvidenceIndexer.js');
      const index = runIndexer(process.cwd());
      return sendJson(res, 200, { ok: true, generatedAt: index.generatedAt, totalEvds: index.totalEvds });
    }

    if (method === 'POST' && routePath === '/admin/plans/assign') {
      // SEC02-N01 (OTK-MOR-01 INF-02): the platform credential may assign any tier to any tenant
      const _platformPlan = isAuthEnabled() && isPlatformCaller(req);
      if (isAuthEnabled()) {
        if (!_platformPlan) {
          const _denyPlan = await checkRbac(req, 'admin:tenants');
          if (_denyPlan) return sendRbacDenial(res, _denyPlan);
        }
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const body = await readBody(req);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const pv = validateBody(payload, PlanAssignmentSchema);
      if (!pv.success) return sendError(res, 'OTK-4001', { details: pv.issues });
      if (!_platformPlan && denyCrossTenant(req, res, pv.data.tenantId)) return;
      const planTid = pv.data.tenantId;
      // H1-S01 (FA-06): the platform can only give a plan to an existing, active tenant (tenant registry record,
      // registered credential or /signup organization); a tenant role is already bound to its own tenant above
      if (_platformPlan) {
        if (!(await tenantKnownToPlatform(planTid))) return sendJson(res, 404, { ok: false, error: 'tenant_not_found', tenantId: planTid });
      }
      try {
        // H1-S01: the decision and the write use the same version; a concurrent change in between → 409, nothing written
        const current = await getTenantPlanVersioned(planTid);
        // SEC02-N01: a tenant role keeps or lowers its own tier; raising it (more CU quota, PRO = no hard limit on the
        // operator's provider key) needs the platform credential or the signed Stripe checkout webhook
        if (!_platformPlan && isAuthEnabled() && PLAN_RANK[pv.data.tier as PlanTier] > PLAN_RANK[current.tier]) {
          return sendJson(res, 403, { ok: false, error: 'plan_upgrade_requires_platform', detail: 'tenant roles cannot raise their own plan; use the billing checkout or the platform operator credential' });
        }
        const actor = _platformPlan ? 'platform' : (resolveCallerContext(req)?.tenantId ?? (isAuthEnabled() ? 'unknown' : 'legacy-admin'));
        const done = await assignPlan(planTid, pv.data.tier as PlanTier, { expectedVersion: current.version, actor, source: 'admin_api' });
        return sendJson(res, 200, { ok: true, tenantId: planTid, tier: done.tier, previous: done.previous, version: done.version });
      } catch (err) {
        if (err instanceof PlanVersionConflictError) {
          return sendJson(res, 409, { ok: false, error: 'plan_version_conflict', detail: 'the plan changed concurrently; read it again and retry' });
        }
        // H1-S01 (FA-01/FA-03): unconfirmed write → explicit error, never a success
        getLogger().error('plan assignment not persisted', { tenantId: planTid, error: err instanceof Error ? err.message : String(err) });
        return sendJson(res, 503, { ok: false, error: 'plan_store_unavailable', detail: 'the plan change was not confirmed by the store; retry' });
      }
    }

    if (method === 'GET' && routePath === '/admin/plans/assignments') {
      if (isAuthEnabled()) {
        const _denyPlanList = await checkRbac(req, 'admin:tenants');
        if (_denyPlanList) return sendRbacDenial(res, _denyPlanList);
      }
      const scopePlans = callerTenantScope(req);
      return sendJson(res, 200, { ok: true, assignments: listAssignments().filter((a) => scopePlans === null || a.tenantId === scopePlans) });
    }

    // --- S1.5: Dead-Letter Store endpoints ---

    if (method === 'GET' && routePath === '/admin/dead-letters') {
      if (isAuthEnabled()) {
        // RV-RUNS-07 (RUN-S): the platform credential alone is enough here
        const _denyDL = isPlatformCaller(req) ? null : await checkRbac(req, 'admin:dead-letters');
        if (_denyDL) return sendRbacDenial(res, _denyDL);
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const status = url.searchParams.get('status') as 'pending' | 'retried' | 'discarded' | null;
      const reason = url.searchParams.get('reason') as string | null;
      const tenant = url.searchParams.get('tenantId');
      const dlScope = tenantScopeUnlessPlatform(req);
      if (dlScope !== null && tenant && denyCrossTenant(req, res, tenant)) return;
      const limitParam = url.searchParams.get('limit');
      const limit = limitParam ? Math.max(1, Math.min(500, parseInt(limitParam, 10) || 50)) : 50;
      const entries = await listDeadLetters({
        status: status || undefined,
        reason: reason as any || undefined,
        tenantId: (dlScope ?? tenant) || undefined,
        limit,
      });
      if (dlScope !== null) {
        // counters of the caller tenant, not of the whole platform (RV-RUNS-02: counted in the store)
        return sendJson(res, 200, { ok: true, total: await deadLetterCount(dlScope), pending: await pendingCount(dlScope), entries });
      }
      return sendJson(res, 200, {
        ok: true,
        total: await deadLetterCount(),
        pending: await pendingCount(),
        entries,
      });
    }

    if (method === 'GET' && routePath.startsWith('/admin/dead-letters/') && !routePath.endsWith('/retry') && !routePath.endsWith('/discard')) {
      if (isAuthEnabled()) {
        // RV-RUNS-07 (RUN-S): the platform credential alone is enough here
        const _denyDL2 = isPlatformCaller(req) ? null : await checkRbac(req, 'admin:dead-letters');
        if (_denyDL2) return sendRbacDenial(res, _denyDL2);
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const dlId = decodeURIComponent(routePath.slice('/admin/dead-letters/'.length));
      const entry = await getDeadLetter(dlId);
      // an entry of another tenant (or without tenant) is answered like a missing one
      const dlScope2 = tenantScopeUnlessPlatform(req);
      if (!entry || (dlScope2 !== null && entry.tenantId !== dlScope2)) return sendError(res, 'OTK-4040');
      return sendJson(res, 200, { ok: true, entry });
    }

    if (method === 'POST' && routePath.match(/^\/admin\/dead-letters\/[^/]+\/retry$/)) {
      if (isAuthEnabled()) {
        // RV-RUNS-07 (RUN-S): the platform credential alone is enough here
        const _denyDL3 = isPlatformCaller(req) ? null : await checkRbac(req, 'admin:dead-letters');
        if (_denyDL3) return sendRbacDenial(res, _denyDL3);
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const parts = routePath.split('/');
      const dlId = decodeURIComponent(parts[3]);
      const dlScope3 = tenantScopeUnlessPlatform(req);
      if (dlScope3 !== null && (await getDeadLetter(dlId))?.tenantId !== dlScope3) return sendError(res, 'OTK-4040');
      const updated = await markRetried(dlId);
      if (!updated) return sendError(res, 'OTK-4040');
      return sendJson(res, 200, { ok: true, entry: updated });
    }

    if (method === 'POST' && routePath.match(/^\/admin\/dead-letters\/[^/]+\/discard$/)) {
      if (isAuthEnabled()) {
        // RV-RUNS-07 (RUN-S): the platform credential alone is enough here
        const _denyDL4 = isPlatformCaller(req) ? null : await checkRbac(req, 'admin:dead-letters');
        if (_denyDL4) return sendRbacDenial(res, _denyDL4);
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const parts = routePath.split('/');
      const dlId = decodeURIComponent(parts[3]);
      const dlScope4 = tenantScopeUnlessPlatform(req);
      if (dlScope4 !== null && (await getDeadLetter(dlId))?.tenantId !== dlScope4) return sendError(res, 'OTK-4040');
      const updated = await markDiscarded(dlId);
      if (!updated) return sendError(res, 'OTK-4040');
      return sendJson(res, 200, { ok: true, entry: updated });
    }

    // --- E6.3: Reconciliation endpoints (W5-5B02) ---

    if (method === 'GET' && routePath === '/v1/reconciliation/reports') {
      if (isAuthEnabled()) {
        if (await denyPlatformOperation(req, res, 'admin:dead-letters')) return; // AUD-FC-16: global report
      }
      const scheduler = getReconciliationScheduler();
      if (!scheduler) return sendJson(res, 200, { reports: [], note: 'scheduler not configured' });
      const lastReport = scheduler.getLastReport();
      return sendJson(res, 200, { reports: lastReport ? [lastReport] : [], lastRun: scheduler.getLastRun() });
    }

    if (method === 'GET' && routePath.startsWith('/v1/reconciliation/reports/')) {
      if (isAuthEnabled()) {
        if (await denyPlatformOperation(req, res, 'admin:dead-letters')) return; // AUD-FC-16
      }
      const reportId = decodeURIComponent(routePath.slice('/v1/reconciliation/reports/'.length));
      const scheduler = getReconciliationScheduler();
      if (!scheduler) return sendError(res, 'OTK-4040');
      const last = scheduler.getLastReport();
      if (!last || last.id !== reportId) return sendError(res, 'OTK-4040');
      return sendJson(res, 200, last);
    }

    if (method === 'POST' && routePath === '/v1/reconciliation/run') {
      if (isAuthEnabled()) {
        if (await denyPlatformOperation(req, res, 'admin:gdpr')) return; // AUD-FC-16: platform-wide run
      }
      const scheduler = getReconciliationScheduler();
      if (!scheduler) return sendError(res, 'OTK-5030', { details: [{ issue: 'scheduler not configured' }] });
      const result = await scheduler.runNow('api');
      return sendJson(res, result.ok ? 200 : 500, result);
    }

    // --- S1.6: Tenant CRUD endpoints ---

    if (method === 'POST' && routePath === '/admin/tenants') {
      // M24-SEC-01 (RUN-M1-24H): the registry holds the static tokens the MITM proxy accepts, and the proxy spends the
      // operator's provider keys; a tenant role (OWNER from /signup included) could mint one for its own tenant. Every
      // write to the registry is now a platform operation (x-admin-key). Also closes M24-SEC-05 / F-FC-01.
      if (isAuthEnabled()) {
        if (await denyPlatformOperation(req, res, 'admin:tenants')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const body = await readBody(req);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const tv = validateBody(payload, TenantCreateSchema);
      if (!tv.success) return sendError(res, 'OTK-4001', { details: tv.issues });
      const callerCtx = resolveCallerContext(req);
      if (await denyTokenBoundElsewhere(res, tv.data.token, tv.data.tenantId)) return;
      const result = createTenant({
        tenantId: tv.data.tenantId,
        token: tv.data.token,
        role: tv.data.role as any || undefined,
        actor: callerCtx?.tenantId ?? 'system',
      });
      if (!result.ok) {
        const otkCode = result.error === 'tenant already exists' || result.error === 'token already in use' ? 'OTK-4090' : 'OTK-4001';
        return sendError(res, otkCode, { legacyError: result.error });
      }
      if (await denyRegistryChangeUnsaved(res)) return; // STOPGATE-01 R-13b: other replicas must accept the token
      return sendJson(res, 201, { ok: true, tenant: result.tenant });
    }

    if (method === 'GET' && routePath === '/admin/tenants') {
      const platformCaller = isAuthEnabled() && isPlatformCaller(req);
      if (isAuthEnabled()) {
        if (!platformCaller) {
          const _denyT2 = await checkRbac(req, 'admin:tenants');
          if (_denyT2) return sendRbacDenial(res, _denyT2);
        }
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const activeParam = url.searchParams.get('active');
      const roleParam = url.searchParams.get('role') as string | null;
      const scopeTenants = platformCaller ? null : callerTenantScope(req);
      const tenants = listTenants({
        active: activeParam === 'true' ? true : activeParam === 'false' ? false : undefined,
        role: roleParam as any || undefined,
      }).filter((t) => scopeTenants === null || t.tenantId === scopeTenants);
      // M24-SEC-04: the audit head/count covers every tenant's CRUD; only the platform (or A0) sees it
      const showAudit = !isAuthEnabled() || platformCaller;
      return sendJson(res, 200, { ok: true, count: tenants.length, tenants, ...(showAudit ? { audit: tenantAuditStatus() } : {}) });
    }

    if (method === 'GET' && routePath.startsWith('/admin/tenants/') && routePath !== '/admin/tenants/reload') {
      const platformCaller = isAuthEnabled() && isPlatformCaller(req);
      if (isAuthEnabled()) {
        if (!platformCaller) {
          const _denyT3 = await checkRbac(req, 'admin:tenants');
          if (_denyT3) return sendRbacDenial(res, _denyT3);
        }
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const tid = decodeURIComponent(routePath.slice('/admin/tenants/'.length));
      if (!platformCaller && denyCrossTenant(req, res, tid)) return;
      const tenant = getTenant(tid);
      if (!tenant) return sendError(res, 'OTK-4040');
      return sendJson(res, 200, { ok: true, tenant });
    }

    if (method === 'PUT' && routePath.startsWith('/admin/tenants/') && routePath !== '/admin/tenants/reload') {
      // M24-SEC-01 / M24-SEC-05: changing a registry token or role is a platform operation
      if (isAuthEnabled()) {
        if (await denyPlatformOperation(req, res, 'admin:tenants')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const tid = decodeURIComponent(routePath.slice('/admin/tenants/'.length));
      const body = await readBody(req);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const uv = validateBody(payload, TenantUpdateSchema);
      if (!uv.success) return sendError(res, 'OTK-4001', { details: uv.issues });
      const callerCtx = resolveCallerContext(req);
      if (!getTenant(tid) && await tenantExistsOutsideRegistry(tid)) {
        // H1R2 R-14: outside the registry only the active flag exists (no registry token or role to change)
        if (uv.data.token !== undefined || uv.data.role !== undefined || uv.data.active === undefined) {
          return sendError(res, 'OTK-4001', { legacyError: 'tenant is not in the registry: only "active" (and "restoreKeys") can be changed' });
        }
        if (await denyTargetStatusUnknown(res, tid)) return; // H1R2 review LOW-3: act on the shared status, not a snapshot
        if (uv.data.active === false) deactivateExternalTenant({ tenantId: tid, actor: callerCtx?.tenantId ?? 'system' });
        else {
          const ext = reactivateExternalTenant({ tenantId: tid, restoreKeys: uv.data.restoreKeys, actor: callerCtx?.tenantId ?? 'system' });
          if (ext.reactivated?.keysRevokedThrough) {
            try { await revokeApiKeysOfTenantThrough(tid, ext.reactivated.keysRevokedThrough); }
            catch { return sendJson(res, 503, { ok: false, error: 'key_revocation_failed', detail: 'the tenant is active; its old keys stay refused at authentication; retry to revoke them in the key store' }); }
          }
        }
        if (await denyRegistryChangeUnsaved(res)) return;
        if (await denySubjectStatusUnsaved(res, tid)) return;
        return sendJson(res, 200, { ok: true, tenant: { tenantId: tid, active: !isTenantInactive(tid), registry: false } });
      }
      if (await denyTokenBoundElsewhere(res, uv.data.token, tid)) return;
      const result = updateTenant({
        tenantId: tid,
        token: uv.data.token,
        role: uv.data.role as any || undefined,
        active: uv.data.active,
        restoreKeys: uv.data.restoreKeys,
        actor: callerCtx?.tenantId ?? 'system',
      });
      if (!result.ok) return sendError(res, result.error === 'token already in use' ? 'OTK-4090' : result.error === RESERVED_PREFIX_ERROR ? 'OTK-4001' : 'OTK-4040', { legacyError: result.error });
      // H1 lane B, POLICY PENDING (D4): a reactivation without restoreKeys revokes the dynamic keys minted before the
      // deactivation (they are already refused at authentication time on every replica through the subject status)
      if (result.reactivated?.keysRevokedThrough) {
        try { await revokeApiKeysOfTenantThrough(tid, result.reactivated.keysRevokedThrough); }
        catch { return sendJson(res, 503, { ok: false, error: 'key_revocation_failed', detail: 'the tenant is active; its old keys stay refused at authentication; retry to revoke them in the key store' }); }
      }
      if (await denyRegistryChangeUnsaved(res)) return; // STOPGATE-01 R-13b: rotation/role/status on every replica
      if (await denySubjectStatusUnsaved(res, tid)) return;
      return sendJson(res, 200, { ok: true, tenant: result.tenant });
    }

    if (method === 'DELETE' && routePath.startsWith('/admin/tenants/') && routePath !== '/admin/tenants/reload') {
      // M24-SEC-01: removing a registry entry (and revoking its token) is a platform operation
      if (isAuthEnabled()) {
        if (await denyPlatformOperation(req, res, 'admin:tenants')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const tid = decodeURIComponent(routePath.slice('/admin/tenants/'.length));
      const callerCtx = resolveCallerContext(req);
      const result = deleteTenant({ tenantId: tid, actor: callerCtx?.tenantId ?? 'system' });
      if (!result.ok) {
        // H1R2 R-14: a /signup organization (or a tenant known only by its keys) is deactivated through the shared
        // subject status, without creating a registry record
        if (!(await tenantExistsOutsideRegistry(tid))) return sendError(res, 'OTK-4040', { legacyError: result.error });
        if (await denyTargetStatusUnknown(res, tid)) return;
        deactivateExternalTenant({ tenantId: tid, actor: callerCtx?.tenantId ?? 'system' });
      }
      if (await denyRegistryChangeUnsaved(res)) return; // STOPGATE-01 R-13b: the token rows are suspended everywhere
      if (await denySubjectStatusUnsaved(res, tid)) return; // H1 lane B: other replicas must see the deactivation
      return sendJson(res, 200, { ok: true, deleted: tid });
    }

    // --- P3.1: Signup + Login + Email Verification (Wave 3E) ---

    if (method === 'POST' && routePath === '/signup') {
      const body = await readBodyWithLimits(req);
      // S08-F04 (H1): invalid JSON is a client error (400 OTK-4002), not a 500 that also adds a dead letter
      let _json: unknown;
      try { _json = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const parsed = validateBody(_json, SignupSchema);
      if (!parsed.success) return sendError(res, 'OTK-4001', { legacyError: 'validation_failed', details: parsed.issues });
      const { email, password, name, orgName } = parsed.data;

      const store = getUserStore();
      if (!store) return sendError(res, 'OTK-5000', { legacyError: 'user store not configured' });

      // Check email uniqueness
      const existing = await store.getUserByEmail(email);
      if (existing) return sendError(res, 'OTK-4090', { legacyError: 'email already registered' });

      // Create user + org + membership
      const userId = `usr_${crypto.randomUUID()}`;
      const orgId = `org_${crypto.randomUUID()}`;
      const slug = orgName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
      const now = new Date().toISOString();
      const passwordHash = await hashPassword(password);

      await store.createOrg({ id: orgId, name: orgName, slug: `${slug}-${orgId.slice(4, 12)}`, plan: 'FREE', createdAt: now, updatedAt: now });
      await store.createUser({ id: userId, email, emailVerified: false, name, passwordHash, createdAt: now, updatedAt: now });
      await store.addMembership({ userId, orgId, role: 'OWNER', joinedAt: now });

      // Send welcome email with verification link
      const emailAdapter = getEmailAdapter();
      const verifyToken = generateVerificationToken(userId);
      if (emailAdapter) {
        const tpl = welcomeTemplate({ name, orgName, verifyToken });
        emailAdapter.send({ to: email, subject: tpl.subject, html: tpl.html, text: tpl.text }).catch(() => {});
      }

      // Issue JWT
      const secret = getJwtSecret();
      const token = secret ? signToken({ sub: orgId, role: 'OWNER', userId }, secret, getJwtExpiryS()) : undefined;

      return sendJson(res, 201, { ok: true, userId, orgId, token });
    }

    if (method === 'POST' && routePath === '/login') {
      const body = await readBodyWithLimits(req);
      // S08-F04 (H1): invalid JSON is a client error (400 OTK-4002), not a 500 that also adds a dead letter
      let _json: unknown;
      try { _json = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const parsed = validateBody(_json, LoginSchema);
      if (!parsed.success) return sendError(res, 'OTK-4001', { legacyError: 'validation_failed', details: parsed.issues });
      const { email, password } = parsed.data;

      const store = getUserStore();
      if (!store) return sendError(res, 'OTK-5000', { legacyError: 'user store not configured' });

      const user = await store.getUserByEmail(email);
      if (!user || !user.passwordHash) {
        // F-H1-09 (H1 lane B): same scrypt work as a wrong password (no timing oracle for account existence)
        await verifyPasswordForUnknownUser(password);
        return sendError(res, 'OTK-4010', { legacyError: 'invalid credentials' });
      }

      const valid = await verifyPassword(password, user.passwordHash);
      if (!valid) return sendError(res, 'OTK-4010', { legacyError: 'invalid credentials' });
      // H1-S05 (SEC02-N04): a deprovisioned user (SCIM DELETE) gets no token; same answer as a wrong password
      if (user.deprovisionedAt) {
        markUserDeprovisioned(user.id, Date.parse(user.deprovisionedAt) || Date.now());
        return sendError(res, 'OTK-4010', { legacyError: 'invalid credentials' });
      }

      // Find user's org (first membership)
      const memberships = await store.getMemberships(user.id);
      // H1R2 review H1: a user without membership used to get a JWT for the tenant 'default' (which also owns legacy
      // receipts without tenantId); no membership = no tenant = same answer as a wrong password
      if (!memberships[0]?.orgId) return sendError(res, 'OTK-4010', { legacyError: 'invalid credentials' });
      const orgId = memberships[0].orgId;
      // H1R2 review H3: the org and the user are read from the shared status store before a token is issued
      if (!(await refreshSubjectsNow([{ kind: 'tenant', id: orgId }, { kind: 'user', id: user.id }]))) {
        return sendJson(res, 503, { ok: false, error: 'credential_status_unavailable', detail: 'the account status could not be confirmed; retry' });
      }
      // H1-S04: no token for the org of a deactivated tenant (it would be refused anyway)
      if (isTenantInactive(orgId)) return sendError(res, 'OTK-4010', { legacyError: 'invalid credentials' });
      const role = memberships[0]?.role ?? 'MEMBER';

      const secret = getJwtSecret();
      const token = secret ? signToken({ sub: orgId, role, userId: user.id }, secret, getJwtExpiryS()) : undefined;

      return sendJson(res, 200, { ok: true, userId: user.id, orgId, token });
    }

    if (method === 'POST' && routePath === '/verify-email') {
      const body = await readBodyWithLimits(req);
      // S08-F04 (H1): invalid JSON is a client error (400 OTK-4002), not a 500 that also adds a dead letter
      let _json: unknown;
      try { _json = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const parsed = validateBody(_json, VerifyEmailSchema);
      if (!parsed.success) return sendError(res, 'OTK-4001', { legacyError: 'validation_failed', details: parsed.issues });

      const userId = validateVerificationToken(parsed.data.token);
      if (!userId) return sendError(res, 'OTK-4010', { legacyError: 'invalid or expired verification token' });

      const store = getUserStore();
      if (!store) return sendError(res, 'OTK-5000', { legacyError: 'user store not configured' });

      const updated = await store.updateUser(userId, { emailVerified: true });
      if (!updated) return sendError(res, 'OTK-4040', { legacyError: 'user not found' });

      return sendJson(res, 200, { ok: true, emailVerified: true });
    }

    // --- NEW-3.06: API Key Management (/v1/keys) ---

    if (method === 'POST' && routePath === '/keys') {
      if (isAuthEnabled()) {
        const _denyK1 = await checkRbac(req, 'admin:keys');
        if (_denyK1) return sendRbacDenial(res, _denyK1);
        if (await denyUnverifiedOrDeprovisionedUser(req, res)) return; // H1-S05 (SEC02-N03/N04)
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const body = await readBodyWithLimits(req);
      // S08-F04 (H1): invalid JSON is a client error (400 OTK-4002), not a 500 that also adds a dead letter
      let _json: unknown;
      try { _json = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const parsed = validateBody(_json, ApiKeyCreateSchema);
      if (!parsed.success) return sendError(res, 'OTK-4001', { legacyError: 'validation_failed', details: parsed.issues });
      const { label, role, expiresAt } = parsed.data;
      const callerCtx = resolveCallerContext(req);
      const tenantId = callerCtx?.tenantId ?? 'default';
      // H1 lane B (S05 residual): the user behind the JWT (if any) is recorded as the author of the key
      const result = await createApiKeyHandler(tenantId, label, role as import('./tenantKeyRegistry.js').TenantRole, expiresAt, jwtUserIdOf(req));
      return sendJson(res, 201, { ok: true, key: result });
    }

    if (method === 'GET' && routePath === '/keys') {
      if (isAuthEnabled()) {
        const _denyK2 = await checkRbac(req, 'admin:keys');
        if (_denyK2) return sendRbacDenial(res, _denyK2);
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const callerCtx = resolveCallerContext(req);
      const tenantId = callerCtx?.tenantId ?? 'default';
      const keys = await listApiKeysHandler(tenantId);
      return sendJson(res, 200, { ok: true, keys });
    }

    if (method === 'GET' && routePath.startsWith('/keys/') && !routePath.includes('/rotate')) {
      if (isAuthEnabled()) {
        const _denyK3 = await checkRbac(req, 'admin:keys');
        if (_denyK3) return sendRbacDenial(res, _denyK3);
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const keyId = decodeURIComponent(routePath.slice('/keys/'.length));
      if (await denyForeignApiKey(req, res, keyId)) return;
      const meta = await getApiKeyHandler(keyId);
      if (!meta) return sendError(res, 'OTK-4040', { legacyError: 'key not found' });
      return sendJson(res, 200, { ok: true, key: meta });
    }

    if (method === 'DELETE' && routePath.startsWith('/keys/')) {
      if (isAuthEnabled()) {
        const _denyK4 = await checkRbac(req, 'admin:keys');
        if (_denyK4) return sendRbacDenial(res, _denyK4);
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const keyId = decodeURIComponent(routePath.slice('/keys/'.length));
      if (await denyForeignApiKey(req, res, keyId)) return;
      const meta = await revokeApiKeyHandler(keyId);
      if (!meta) return sendError(res, 'OTK-4040', { legacyError: 'key not found or already revoked' });
      return sendJson(res, 200, { ok: true, revoked: meta });
    }

    // S08-F02 (H1): only /keys/:id/rotate is a key rotation (endsWith('/rotate') also matched any other path)
    if (method === 'POST' && routePath.match(/^\/keys\/[^/]+\/rotate$/)) {
      if (isAuthEnabled()) {
        const _denyK5 = await checkRbac(req, 'admin:keys');
        if (_denyK5) return sendRbacDenial(res, _denyK5);
        if (await denyUnverifiedOrDeprovisionedUser(req, res)) return; // H1-S05 (SEC02-N03/N04)
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const keyId = decodeURIComponent(routePath.slice('/keys/'.length, routePath.indexOf('/rotate')));
      if (await denyForeignApiKey(req, res, keyId)) return;
      const result = await rotateApiKeyHandler(keyId, jwtUserIdOf(req));
      if (!result) return sendError(res, 'OTK-4040', { legacyError: 'key not found or already revoked' });
      return sendJson(res, 200, { ok: true, key: result });
    }

    // --- P2.1/P2.2: Dashboard + Login routes ---

    if (routePath.startsWith('/app')) {
      // Login/logout routes first (no auth required)
      if (handleLoginRequest(req, res, routePath)) return;
      // AUD-FC-13: the dashboard JSON API and the webhook page are platform-wide aggregates. With auth enabled they
      // need the platform credential; a tenant caller only gets its own usage and receipts; no credential → 401.
      if (isAuthEnabled() && method === 'GET' && (routePath.startsWith('/app/api/') || routePath === '/app/webhooks') && !isPlatformCaller(req)) {
        const caller = resolveCallerContext(req);
        // M24-SEC-11 (RUN-M1-24H): a verified credential without a tenant must never read as "every tenant" below
        if (!caller || typeof caller.tenantId !== 'string' || caller.tenantId === '') return sendRbacDenial(res, { code: 401, error: 'unauthorized' });
        if (routePath === '/app/api/usage') {
          const asked = url.searchParams.get('tenantId');
          if (asked && denyCrossTenant(req, res, asked)) return;
          return sendJson(res, 200, { ok: true, usage: getIndexer().getUsageByProvider(caller.tenantId) });
        }
        if (routePath === '/app/api/receipts') {
          return sendJson(res, 200, { ok: true, receipts: getIndexer().getReceiptsByTenant(caller.tenantId, 100) });
        }
        if (routePath === '/app/api/providers/health') {
          // M24-SEC-03 (RUN-M1-24H): per-provider CU and request counts of the caller's tenant only
          return sendJson(res, 200, { ok: true, providers: getIndexer().getProviderHealth(caller.tenantId) });
        }
        return sendJson(res, 403, { ok: false, error: 'platform_operation_forbidden', detail: 'platform-wide dashboard data requires the platform operator credential' });
      }
      // Dashboard routes (auth check inside handleDashboardRequest)
      if (await handleDashboardRequest(req, res, routePath, resolveCallerContext)) return;
    }

    // --- W8-C TEAM-07: Team CRUD API ---

    if (method === 'POST' && routePath === '/teams') {
      const _denyT1 = await checkRbac(req, 'receipts:write');
      if (_denyT1) return sendRbacDenial(res, _denyT1);
      const callerCtxT1 = resolveCallerContext(req)!;
      const body = await readBody(req);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const p = payload as Record<string, unknown>;
      if (!p || typeof p['name'] !== 'string' || !p['name']) {
        return sendError(res, 'OTK-4001', { details: [{ field: 'name', issue: 'required' }] });
      }
      const team = {
        id: crypto.randomUUID(),
        name: String(p['name']),
        ownerId: callerCtxT1.tenantId,
        createdAt: new Date().toISOString(),
      };
      await getTeamStore().createTeam(team);
      return sendJson(res, 201, { ok: true, team });
    }

    if (method === 'GET' && routePath === '/teams') {
      const _denyT2 = await checkRbac(req, 'receipts:read');
      if (_denyT2) return sendRbacDenial(res, _denyT2);
      const callerCtxT2 = resolveCallerContext(req)!;
      const teams = await getTeamStore().listTeams(callerCtxT2.tenantId);
      return sendJson(res, 200, { ok: true, teams });
    }

    if (method === 'POST' && routePath.match(/^\/teams\/[^/]+\/members$/)) {
      const _denyT3 = await checkRbac(req, 'receipts:write');
      if (_denyT3) return sendRbacDenial(res, _denyT3);
      const teamId = decodeURIComponent(routePath.split('/')[2]!);
      if (denyForeignResource(req, res, (await getTeamStore().getTeam(teamId))?.ownerId ?? null)) return; // AUD-FC-11
      const body = await readBody(req);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const p = payload as Record<string, unknown>;
      if (!p || typeof p['tenantId'] !== 'string' || !p['tenantId']) {
        return sendError(res, 'OTK-4001', { details: [{ field: 'tenantId', issue: 'required' }] });
      }
      const role = p['role'] === 'admin' ? 'admin' : 'member';
      const membership = {
        teamId,
        tenantId: String(p['tenantId']),
        role: role as 'admin' | 'member',
        joinedAt: new Date().toISOString(),
      };
      await getTeamStore().addMember(membership);
      return sendJson(res, 201, { ok: true, membership });
    }

    if (method === 'DELETE' && routePath.match(/^\/teams\/[^/]+\/members\/[^/]+$/)) {
      const _denyT4 = await checkRbac(req, 'receipts:write');
      if (_denyT4) return sendRbacDenial(res, _denyT4);
      const parts = routePath.split('/');
      const teamId = decodeURIComponent(parts[2]!);
      if (denyForeignResource(req, res, (await getTeamStore().getTeam(teamId))?.ownerId ?? null)) return; // AUD-FC-11
      const memberTenantId = decodeURIComponent(parts[4]!);
      await getTeamStore().removeMember(teamId, memberTenantId);
      return sendJson(res, 200, { ok: true });
    }

    if (method === 'GET' && routePath.match(/^\/teams\/[^/]+\/members$/)) {
      const _denyT5 = await checkRbac(req, 'receipts:read');
      if (_denyT5) return sendRbacDenial(res, _denyT5);
      const teamId = decodeURIComponent(routePath.split('/')[2]!);
      if (denyForeignResource(req, res, (await getTeamStore().getTeam(teamId))?.ownerId ?? null)) return; // AUD-FC-11
      const members = await getTeamStore().listMembers(teamId);
      return sendJson(res, 200, { ok: true, members });
    }

    // --- TEAM-10: Team spend report ---

    if (method === 'GET' && routePath === '/v1/reports/teams') {
      if (isAuthEnabled()) {
        const _denyReport = await checkRbac(req, 'receipts:read');
        if (_denyReport) return sendRbacDenial(res, _denyReport);
      }
      let teamUsage = getIndexer().getUsageByTeam();
      // AUD-FC-15: a tenant sees only the teams it owns (platform credential: all)
      if (isAuthEnabled() && !isPlatformCaller(req)) {
        const caller = resolveCallerContext(req);
        if (!caller) return sendRbacDenial(res, { code: 401, error: 'unauthorized' });
        const own = new Set((await getTeamStore().listTeams(caller.tenantId)).map((t) => t.id));
        // M24-DYN-05 (PF-NEW-07): only this tenant's receipts are summed; another tenant could stamp our team id
        teamUsage = getIndexer().getUsageByTeam(caller.tenantId).filter((t) => own.has(t.teamId));
      }
      return sendJson(res, 200, { ok: true, teams: teamUsage });
    }

    // --- PI-05/PI-06: Price Intelligence (W7-A) ---
    if (routePath === '/v1/admin/prices' || routePath === '/v1/admin/prices/refresh') {
      if (isAuthEnabled()) {
        // RV-RUNS-01 (RUN-S): platform-wide operation or aggregate, not tenant administration
        if (await denyPlatformOperation(req, res, 'admin:chain-head')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }

      if (method === 'GET' && routePath === '/v1/admin/prices') {
        // PI-05: price table with updatedAt + staleness per model
        const { listPrices } = await import('../pricing/PriceStore.js');
        const { getPriceSchedulerStatus } = await import('../pricing/PriceScheduler.js');
        const prices = await listPrices();
        const scheduler = getPriceSchedulerStatus();
        return sendJson(res, 200, { ok: true, prices, scheduler, count: prices.length });
      }

      if (method === 'POST' && routePath === '/v1/admin/prices/refresh') {
        // PI-06: manual price scrape trigger (OWNER+ADMIN only)
        if (isAuthEnabled() && !isPlatformCaller(req)) {
          const callerRole = resolveCallerContext(req)?.role ?? '';
          if (!['OWNER', 'ADMIN'].includes(callerRole)) {
            return sendError(res, 'OTK-4030', { legacyError: 'OWNER or ADMIN role required' });
          }
        }
        const { runPriceScrape } = await import('../pricing/PriceScheduler.js');
        const result = await runPriceScrape();
        return sendJson(res, 200, { ok: true, ...result });
      }
    }

    // --- W9-A PAY-03: Finance dashboard endpoint (admin only) ---
    if (method === 'GET' && routePath === '/admin/finance') {
      // global payouts and totals of every tenant: platform operation (AUD-FC-02), not tenant billing
      if (isAuthEnabled()) {
        if (await denyPlatformOperation(req, res, 'admin:billing')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const { getPaymentRouter } = await import('../billing/ProviderPaymentRouter.js');
      const { getMemStoreCycles } = await import('../billing/BillingCycleWorker.js');
      const router = getPaymentRouter();
      const cycles = getMemStoreCycles();
      const totalCollectedUsd = cycles.reduce((s, c) => s + c.totalUsd, 0);
      const totalOwedUsd = router.getTotalOwedUsd();
      return sendJson(res, 200, {
        pendingPayouts: router.getPendingPayouts(),
        totalOwedUsd,
        totalCollectedUsd,
        netMarginUsd: totalCollectedUsd - totalOwedUsd,
      });
    }

    // --- W9-B OPS-01: Prover metrics (no auth — metrics path) ---
    if (method === 'GET' && routePath === '/metrics/prover') {
      if (denyMetricsAccess(res, headers)) return; // STOPGATE-01 P1.2 (R2-D8)
      const { getProverDaemonManager } = await import('../prover/ProverDaemonManager.js');
      return sendJson(res, 200, getProverDaemonManager().getProverMetrics());
    }

    // --- W9-B OPS-02: Refresh token rotation ---
    if (method === 'POST' && (routePath === '/auth/refresh' || routePath === '/v1/auth/refresh')) {
      const body = await readBody(req);
      let payload: unknown;
      try { payload = JSON.parse(body); } catch { return sendError(res, 'OTK-4002'); }
      const p = payload as Record<string, unknown>;
      const refreshToken = typeof p['refreshToken'] === 'string' ? p['refreshToken'] : null;
      if (!refreshToken) return sendError(res, 'OTK-4001', { legacyError: 'refreshToken required' });
      const jwtSecret = getJwtSecret();
      if (!jwtSecret) return sendJson(res, 500, { error: 'JWT secret not configured' });
      const decoded = verifyRefreshToken(refreshToken, jwtSecret);
      if (!decoded) return sendError(res, 'OTK-4010', { legacyError: 'invalid or expired refresh token' });
      // H1-S04 (INF05-F01): a deactivated tenant (or a refresh token issued before its deactivation) mints no access token
      if (isTenantInactive(decoded.tenantId) || issuedBeforeTenantRevocation(decoded.tenantId, decoded.iat)) {
        return sendError(res, 'OTK-4010', { legacyError: 'invalid or expired refresh token' });
      }
      // Blacklist old refresh token (extract jti from token body)
      try {
        const parts = refreshToken.split('.');
        if (parts.length === 3) {
          const oldPayload = JSON.parse(Buffer.from(
            (parts[1]!).replace(/-/g, '+').replace(/_/g, '/') + '==',
            'base64',
          ).toString()) as { jti?: string; exp?: number };
          if (oldPayload.jti && oldPayload.exp) {
            await blacklistToken(oldPayload.jti, oldPayload.exp);
          }
        }
      } catch { /* non-fatal: best-effort blacklist */ }
      // F-H1-10 (H1 lane B): a refresh token must be bound to a user that still exists, is not deprovisioned and is a
      // member of the tenant. It used to mint a MEMBER JWT from the tenant alone, with no user behind it (no SCIM
      // deprovisioning could ever revoke it). No route issues refresh tokens today; unbound ones are refused (fail
      // closed), and so is a refresh while the user store is missing or failing.
      const refreshUser = await refreshTokenUser(decoded);
      if (!refreshUser) return sendError(res, 'OTK-4010', { legacyError: 'invalid or expired refresh token' });
      // Issue new access JWT + new refresh token (role capped at MEMBER, as before; now bound to the user)
      const newAccessToken = signToken({ sub: decoded.tenantId, role: 'MEMBER', userId: refreshUser }, jwtSecret, getJwtExpiryS());
      const newRefreshToken = signRefreshToken(decoded.tenantId, jwtSecret, refreshUser);
      return sendJson(res, 200, { ok: true, token: newAccessToken, refreshToken: newRefreshToken });
    }

    // --- W9-B OPS-04: Full health check (admin only) ---
    if (method === 'GET' && routePath === '/admin/health/full') {
      if (isAuthEnabled()) {
        // RV-RUNS-01 (RUN-S): platform-wide operation or aggregate, not tenant administration
        if (await denyPlatformOperation(req, res, 'admin:chain-head')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const { getProverDaemonManager } = await import('../prover/ProverDaemonManager.js');
      const tal = getAccountingLayer();
      const indexer = getIndexer();
      const dlPending = await pendingCount(); // RV-RUNS-14: was serialized as a Promise
      const proverMetrics = getProverDaemonManager().getProverMetrics();
      const { getMemStoreCycles } = await import('../billing/BillingCycleWorker.js');
      const openCycles = getMemStoreCycles().filter(c => c.status === 'open').length;
      const talStatus = { status: 'ok' as const, entryCount: tal.size() };
      const indexerStatus = { status: 'ok' as const, receiptCount: indexer.getSystemOverview().totalReceipts };
      const dlStatus = { status: 'ok' as const, pendingCount: dlPending };
      const proverStatus = { status: proverMetrics.activeProvers > 0 ? 'ok' as const : 'degraded' as const, activeProvers: proverMetrics.activeProvers };
      const billingStatus = { status: 'ok' as const, openCycles };
      const allOk = proverStatus.status === 'ok';
      return sendJson(res, 200, {
        status: allOk ? 'ok' : 'degraded',
        components: {
          tal: talStatus,
          indexer: indexerStatus,
          deadLetterQueue: dlStatus,
          prover: proverStatus,
          billing: billingStatus,
        },
        checkedAt: new Date().toISOString(),
      });
    }

    // --- GA: GA Readiness Check (admin:chain-head) ---
    if (method === 'GET' && routePath === '/v1/admin/ga-readiness') {
      if (isAuthEnabled()) {
        // RV-RUNS-01 (RUN-S): platform-wide operation or aggregate, not tenant administration
        if (await denyPlatformOperation(req, res, 'admin:chain-head')) return;
      } else {
        if (checkLegacyAdminKey(req, res)) return;
      }
      const { checkGAReadiness, isGAReady } = await import('./gaReadinessCheck.js');
      const requirements = checkGAReadiness();
      return sendJson(res, 200, {
        ok: true,
        gaReady: isGAReady(requirements),
        requirements,
        checkedAt: new Date().toISOString(),
      });
    }

    return sendError(res, 'OTK-4040');
  } catch (err) {
    // H1.8: Handle body-too-large and timeout as specific error codes
    if (err instanceof BodyTooLargeError) {
      return sendError(res, 'OTK-4130');
    }
    if (err instanceof RequestTimeoutError) {
      return sendError(res, 'OTK-5030', { legacyError: 'request_timeout' });
    }
    const msg = err instanceof Error ? err.message : String(err);
    // S1.5: capture unhandled processing errors into dead-letter store
    await addDeadLetter({
      originalPayload: `${req.method} ${req.url}`,
      error: msg,
      reason: 'processing_error',
      source: 'handleRequest',
    });
    return sendError(res, 'OTK-5000', { legacyError: msg });
  } finally {
    // H5.1: End tracing span when request completes
    if (span) endSpan(span);
  }
}
