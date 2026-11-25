/**
 * TenantKeyRegistry — Bearer token → TokenContext registry (E1.2 live-reload)
 *
 * Populated from OTK_TENANTS env: "tenantA:tokenABC,tenantB:tokenXYZ"
 *
 * Format: comma-separated pairs of "tenantId:token" or "tenantId/ROLE:token"
 *   - tenantId: MUST NOT contain ':' or '/'
 *   - token: MAY contain ':' (everything after the FIRST ':' is the token)
 *   - ROLE (optional): one of OWNER, ADMIN, OPERATOR, MEMBER, VIEWER
 *     - if omitted, defaults to OPERATOR (backward-compatible)
 *     - if present but invalid, the entry is silently skipped
 *   - Examples:
 *     - "acme:tok"               → tenantId="acme", role=OPERATOR, token="tok"
 *     - "acme/OWNER:tok"         → tenantId="acme", role=OWNER, token="tok"
 *     - "acme/VIEWER:tok"        → tenantId="acme", role=VIEWER, token="tok"
 *     - "acme:my:token:with:colon" → tenantId="acme", role=OPERATOR, token="my:token:with:colon"
 *     - "acme/ADMIN:tok:with:colon" → tenantId="acme", role=ADMIN, token="tok:with:colon"
 *
 * When OTK_TENANTS is unset, auth enforcement is disabled and all callers
 * are treated as tenantId='default' / role='OWNER' (backward-compatible — see routes.ts checkRbac).
 *
 * E1.2: live reload via loadTenantsFromString() — called by POST /admin/tenants/reload.
 * E1.4: per-token role bootstrap via "tenantId/ROLE:token" format.
 *
 * In-process only: each replica holds its own copy. The registry tokens are kept here in plain text (they come from
 * OTK_TENANTS or the tenant CRUD); dynamic API keys are held only by SHA-256 hash in a second map. Used by the
 * credential checks in `src/auth/`, by `src/api/tenantCrud.ts`, `src/api/apiKeyManager.ts` and `src/api/routes.ts`.
 * Environment variables read: OTK_TENANTS (at module load) and NODE_ENV through `src/infra/deployEnv.ts` (the clear
 * functions refuse to run in deployed environments).
 *
 * @module src/api/tenantKeyRegistry
 * @since u12.alpha.d | u12.closure.b (format documented, clearRegistry guarded)
 * @since E1.2 (2026-03-13) — TokenContext, resolveTokenContext, loadTenantsFromString
 * @since E1.4 (2026-03-14) — role bootstrap via tenantId/ROLE:token format
 */

/** Canonical role set for E1 (ADR-0206). RBAC enforcement in E1.3. Role bootstrap via env in E1.4. */
import { isDeployedEnv } from '../infra/deployEnv.js'; // RV2-RUNS-02 (RUN-S): same rule as the auth guard
/** Tenant roles, from most to least privileged; permissions per role are defined in `src/security/rbac.ts`. */
export type TenantRole = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER';

/** Context resolved from a bearer token. */
export interface TokenContext {
  /** Tenant the token belongs to. */
  tenantId: string;
  /** Role for this token.
   * Defaults to 'OPERATOR' when format is "tenantId:token".
   * Explicit role when format is "tenantId/ROLE:token" (E1.4).
   * Auth-disabled path returns OPERATOR here (routes.ts checkRbac uses OWNER virtual). */
  role: TenantRole;
}

const _registry = new Map<string, TokenContext>(); // bearerToken → TokenContext
let _authEnabled = false;

/** Valid roles accepted in the OTK_TENANTS format. */
const VALID_ROLES: ReadonlySet<string> = new Set<TenantRole>(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']);

/**
 * Parse OTK_TENANTS-format string and reload registry atomically.
 *
 * Format: "tenantId:token" or "tenantId/ROLE:token" (comma-separated).
 *   - Splits on comma, then on first ':' to separate left-side from token
 *   - Token may contain ':' (everything after the first ':' is the token)
 *   - Left-side without '/' → tenantId + role=OPERATOR (backward-compatible)
 *   - Left-side with '/' → tenantId/ROLE; role must be valid (OWNER|ADMIN|OPERATOR|MEMBER|VIEWER)
 *   - Invalid pairs (no ':' separator, empty tenantId, empty token, invalid role) are silently skipped
 *
 * Returns the count of successfully loaded tenant entries.
 * If raw is empty or all pairs are invalid, auth is disabled (authEnabled=false).
 *
 * Safe to call at any time — clears previous state atomically.
 *
 * @param raw - OTK_TENANTS-format string.
 * @returns Number of entries loaded (distinct tokens).
 */
export function loadTenantsFromString(raw: string): { loaded: number } {
  const next = parseTenantsString(raw);
  _registry.clear();
  for (const [token, ctx] of next) _registry.set(token, ctx);
  _authEnabled = next.size > 0;
  _staticSet = new Map(next);
  return { loaded: next.size };
}

/** STOPGATE-01 R-13b: the entries of the last OTK_TENANTS-format load (env or reload), to diff a reload. */
let _staticSet = new Map<string, TokenContext>();
/**
 * Copy of the entries of the last OTK_TENANTS-format load.
 *
 * @returns A new map from token to context (changes do not affect the registry).
 */
export function staticRegistrySnapshot(): ReadonlyMap<string, TokenContext> { return new Map(_staticSet); }

/**
 * Parse an OTK_TENANTS-format string WITHOUT touching the registry (format rules above). AUD-FC-01 (FINAL CLOSURE):
 * the HTTP reload validates with this first, so a reload that would load nothing (and disable auth) is refused
 * before any state changes.
 *
 * @param raw - OTK_TENANTS-format string.
 * @returns Map from token to context; a later duplicate token overwrites an earlier one.
 */
export function parseTenantsString(raw: string): Map<string, TokenContext> {
  const next = new Map<string, TokenContext>();
  if (!raw.trim()) return next;
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;
    const leftSide = trimmed.slice(0, colonIdx).trim();
    const token = trimmed.slice(colonIdx + 1).trim();
    if (!token) continue;

    let tenantId: string;
    let role: TenantRole;

    const slashIdx = leftSide.indexOf('/');
    if (slashIdx > 0) {
      // "tenantId/ROLE" format (E1.4)
      tenantId = leftSide.slice(0, slashIdx).trim();
      const roleStr = leftSide.slice(slashIdx + 1).trim();
      if (!VALID_ROLES.has(roleStr)) continue; // invalid role → skip silently
      role = roleStr as TenantRole;
    } else {
      // legacy format: tenantId only → default role=OPERATOR
      tenantId = leftSide;
      role = 'OPERATOR';
    }

    if (tenantId && token) next.set(token, { tenantId, role });
  }
  return next;
}

// Parse OTK_TENANTS at module load
const _rawEnv = process.env['OTK_TENANTS'] ?? '';
if (_rawEnv.trim()) {
  loadTenantsFromString(_rawEnv);
}

/**
 * Returns true when auth enforcement is active (OTK_TENANTS is set or was reloaded).
 *
 * Registering any token or key hash at runtime also turns it on.
 *
 * @returns Whether authentication is enforced.
 */
export function isAuthEnabled(): boolean {
  return _authEnabled;
}

/**
 * Resolve a bearer token to its tenantId.
 * Returns null if token is not registered (and auth is enabled).
 * Returns 'default' when auth is disabled.
 *
 * Backward-compatible: behavior unchanged from pre-E1.2.
 *
 * @param bearerToken - Raw registry token presented by the client.
 * @returns The tenant id, `'default'` when auth is disabled, or `null`.
 */
export function resolveTenantId(bearerToken: string): string | null {
  if (!_authEnabled) return 'default';
  return _registry.get(bearerToken)?.tenantId ?? null;
}

/**
 * Resolve a bearer token to its full TokenContext (tenantId + role).
 *
 * Returns null if token is not registered (and auth is enabled).
 * Returns { tenantId: 'default', role: 'OPERATOR' } when auth is disabled.
 *
 * E1.2 addition — used by admin endpoints that need role context.
 * Full RBAC enforcement deferred to E1.3.
 *
 * @param bearerToken - Raw registry token presented by the client.
 * @returns The context (a stored object, not a copy), the default context, or `null`.
 */
export function resolveTokenContext(bearerToken: string): TokenContext | null {
  if (!_authEnabled) return { tenantId: 'default', role: 'OPERATOR' };
  return _registry.get(bearerToken) ?? null;
}

/**
 * Register a token → tenantId mapping programmatically.
 * Used in integration tests and runtime re-configuration.
 * Role defaults to 'OPERATOR' for backward compatibility.
 *
 * Turns auth enforcement on.
 *
 * @param token - Raw registry token.
 * @param tenantId - Tenant it belongs to.
 * @param role - Role granted (default `OPERATOR`).
 */
export function registerToken(token: string, tenantId: string, role: TenantRole = 'OPERATOR'): void {
  _registry.set(token, { tenantId, role });
  _authEnabled = true;
}

/** H1-S06 (INF05-F02): true when the bearer token is already registered for some tenant (static registry). */
/**
 * Checks whether a registry token is already bound to a tenant.
 *
 * @param token - Raw registry token.
 * @returns Whether the token is in the registry.
 */
export function isTokenRegistered(token: string): boolean {
  return _registry.has(token);
}

/**
 * Remove a token registration.
 *
 * @param token - Raw registry token; unknown tokens are ignored. Auth enforcement stays on.
 */
export function revokeToken(token: string): void {
  _registry.delete(token);
}

// ── Wave 3C: Hash-based registry for dynamic API keys ────────────────────────
// Populated by apiKeyManager.createApiKey() / revokeApiKey().
// Enables synchronous auth resolution for keys created at runtime without
// requiring an async ITokenStore lookup in the hot request path.
// Multi-instance note: this cache is per-process; warm-up from IApiKeyMetadataStore
// at startup (Wave 4B) ensures cross-instance consistency after restarts.

/** Context of a dynamic API key, held by key hash. */
export interface HashTokenContext extends TokenContext {
  /** ISO-8601 expiry; `null` means no expiry. */
  expiresAt: string | null;
  /** H1 lane B: creation instant (ISO) — compared with revocation "not before" instants of the tenant and the author */
  createdAt?: string;
  /** H1 lane B (S05 residual): user id of the author, null/absent when the key has no user author */
  createdBy?: string | null;
}

const _hashRegistry = new Map<string, HashTokenContext>();

/**
 * Register a token hash → context mapping (called from apiKeyManager.createApiKey).
 *
 * Turns auth enforcement on.
 *
 * @param hash - SHA-256 hex hash of the raw key.
 * @param ctx - The key's context.
 */
export function registerTokenByHash(hash: string, ctx: HashTokenContext): void {
  _hashRegistry.set(hash, ctx);
  _authEnabled = true;
}

/**
 * Revoke a token hash entry (called from apiKeyManager.revokeApiKey).
 *
 * @param hash - SHA-256 hex hash of the raw key; unknown hashes are ignored.
 */
export function revokeTokenByHash(hash: string): void {
  _hashRegistry.delete(hash);
}

/**
 * Resolve a token hash to its context.
 * Returns null if not found or if the key has expired.
 *
 * @param hash - SHA-256 hex hash of the raw key.
 * @returns Tenant and role, or `null`.
 */
export function resolveByHash(hash: string): TokenContext | null {
  const ctx = _hashRegistry.get(hash);
  if (!ctx) return null;
  if (ctx.expiresAt && new Date(ctx.expiresAt) < new Date()) return null;
  return { tenantId: ctx.tenantId, role: ctx.role };
}

/**
 * Full context of a dynamic key hash (tenant, role, creation instant, author), or null if unknown or expired.
 * Used by the auth path to apply revocations that depend on when and by whom the key was minted.
 *
 * @param hash - SHA-256 hex hash of the raw key.
 * @returns A copy of the context, or `null`.
 */
export function resolveHashContext(hash: string): HashTokenContext | null {
  const ctx = _hashRegistry.get(hash);
  if (!ctx) return null;
  if (ctx.expiresAt && new Date(ctx.expiresAt) < new Date()) return null;
  return { ...ctx };
}

/**
 * Clear hash registry (test only).
 *
 * @throws {Error} In a deployed environment (any NODE_ENV other than development, dev or test).
 */
export function clearHashRegistryForTest(): void {
  if (isDeployedEnv()) {
    throw new Error('[TenantKeyRegistry] clearHashRegistryForTest() is not permitted in production.');
  }
  _hashRegistry.clear();
  // Reset _authEnabled if _registry is also empty (ensures test isolation)
  if (_registry.size === 0) _authEnabled = false;
}

/**
 * Clear all registered tokens and disable auth enforcement.
 *
 * @internal Test/development only — NOT for production use.
 * In production (NODE_ENV=production), throws to prevent accidental invocation.
 * Use revokeToken() to remove individual tokens in production.
 * @throws {Error} In a deployed environment (any NODE_ENV other than development, dev or test).
 */
export function clearRegistry(): void {
  if (isDeployedEnv()) {
    throw new Error('[TenantKeyRegistry] clearRegistry() is not permitted in production. Use revokeToken() instead.');
  }
  _registry.clear();
  _authEnabled = false;
}

/**
 * H1-S01 (FA-06): true when some registered credential (static registry token or dynamic key hash) belongs to the
 * tenant. Used to refuse plan assignments to tenants that do not exist (a typo or an unknown id used to create a
 * phantom paid assignment that a later tenant with that id would inherit).
 *
 * @param tenantId - Tenant id.
 * @returns Whether a registry token or a dynamic key hash of this process belongs to it.
 */
export function hasRegisteredTenant(tenantId: string): boolean {
  for (const ctx of _registry.values()) if (ctx.tenantId === tenantId) return true;
  for (const ctx of _hashRegistry.values()) if (ctx.tenantId === tenantId) return true;
  return false;
}
