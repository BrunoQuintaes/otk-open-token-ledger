/**
 * H3.2 — Auth Middleware
 *
 * Unified authentication: tries JWT first, then API key (static or dynamic).
 * Extracts tenantId + role for downstream RBAC.
 *
 * Called by `src/api/routes.ts` for every authenticated route. It is synchronous: it reads only in-process state
 * (token registry, key-hash registry, subject status); keeping that state current across replicas is the job of
 * `src/auth/credentialAuthority.ts` before this runs. Side effect: on a successful API-key match it updates the key's
 * `lastUsedAt` in the metadata store (fire-and-forget). Environment: the JWT secret through `src/auth/jwt.ts`, and
 * NODE_ENV through the production guard (with auth disabled, deployed environments authenticate nobody).
 *
 * @module src/auth/authMiddleware
 * @since Wave 2H (H3.2)
 */

import type { IncomingMessage } from 'node:http';
import { verifyToken, getJwtSecret, type JWTPayload } from './jwt.js';
import { isAuthEnabled, resolveTokenContext, resolveHashContext, type TokenContext } from '../api/tenantKeyRegistry.js';
import { hashKey } from '../api/apiKeyManager.js';
import { getApiKeyMetadataStore } from '../api/IApiKeyMetadataStore.js';
import { isProductionEnv } from '../api/productionGuard.js';
import { isTenantInactive, jwtSubjectDenial, dynamicKeyDenial } from './subjectStatus.js';

/** Tenant roles a JWT may carry (same set as the token registry); anything else does not authenticate. */
const ACCESS_ROLES: ReadonlySet<string> = new Set(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']);

/** Outcome of `authenticateRequest`. */
export interface AuthResult {
  /** Whether the request is authenticated. */
  authenticated: boolean;
  /** Tenant of the credential; empty when not authenticated, `default` when auth is disabled in development. */
  tenantId: string;
  /** Role of the credential; empty when not authenticated. */
  role: string;
  /** Which credential authenticated the request (`none` also when auth is disabled). */
  method: 'jwt' | 'api_key' | 'none';
  /** Verified JWT payload, only for `method: 'jwt'`. */
  jwtPayload?: JWTPayload;
  teamId?: string;   // TEAM-04: optional team context carried from JWT payload
  /** H1 R-06: author (user id) of the dynamic key that authenticated the request, when recorded. */
  keyCreatedBy?: string | null;
}

/**
 * Authenticate a request. Returns auth result with method used.
 *
 * Priority:
 * 1. JWT (Authorization: Bearer <jwt-token> — detected by JWT structure)
 * 2. API key (Authorization: Bearer <api-key> — resolved via TenantKeyRegistry)
 * 3. Auth disabled → default OWNER context
 * 4. No credentials → unauthenticated
 *
 * @param req - Incoming request; only its headers are read.
 * @returns The result; never throws for a bad credential (it is reported as not authenticated).
 */
export function authenticateRequest(req: IncomingMessage): AuthResult {
  if (!isAuthEnabled()) {
    // SEC-10: In production, OTK_TENANTS must be configured.
    // Returning unauthenticated prevents OWNER-bypass misconfiguration.
    // Development/test environments (NODE_ENV development, dev, test or unset) preserve backward compat.
    // RV-RUNS-05 (RUN-S): same deployed-environment rule as the startup guard (production, staging, prod, ...)
    if (isProductionEnv()) {
      return { authenticated: false, tenantId: '', role: '', method: 'none' };
    }
    return { authenticated: true, tenantId: 'default', role: 'OWNER', method: 'none' };
  }

  const headers = req.headers as Record<string, string | undefined> | undefined;
  const auth = headers?.['authorization'] ?? '';

  if (auth.startsWith('Bearer ')) {
    const token = auth.slice(7).trim();
    if (!token) {
      return { authenticated: false, tenantId: '', role: '', method: 'none' };
    }

    // Try JWT first (has 3 dot-separated parts)
    const jwtSecret = getJwtSecret();
    if (jwtSecret && token.split('.').length === 3) {
      const payload = verifyToken(token, jwtSecret);
      // M24-DYN-06/07 (RUN-M1-24H; PF-NEW-10, M24-SEC-11): only an ACCESS token with a tenant and a role authenticates a
      // request; a refresh token or a signed token without sub/role used to authenticate with an empty tenant, which some
      // handlers read as "default" or as "every tenant"
      // ADV-M24-15: blank values, a refresh type in any case and roles outside the five tenant roles are refused too
      const p = payload as (JWTPayload & { type?: unknown }) | null;
      if (p && String(p.type ?? '').trim().toLowerCase() !== 'refresh' && typeof p.sub === 'string' && p.sub.trim() !== ''
          && typeof p.role === 'string' && ACCESS_ROLES.has(p.role)) {
        // H1-S04 (INF05-F01): a JWT of a deactivated tenant (or issued before its deactivation) does not authenticate
        if (jwtSubjectDenial(p)) return { authenticated: false, tenantId: '', role: '', method: 'none' };
        return {
          authenticated: true,
          tenantId: p.sub,
          role: p.role,
          method: 'jwt',
          jwtPayload: p,
          teamId: p.teamId,
        };
      }
      // JWT verification failed — fall through to API key check
    }

    // Hash once — used by both static and dynamic key paths below.
    // Computed here to avoid redundant hashing since hashKey is deterministic.
    const tokenHash = hashKey(token);

    // Try API key via TenantKeyRegistry (legacy static tokens from OTK_TENANTS env)
    const ctx: TokenContext | null = resolveTokenContext(token);
    // H1-S04 (INF05-F01): every credential of a deactivated tenant is refused, not only its registry token
    if (ctx && isTenantInactive(ctx.tenantId)) return { authenticated: false, tenantId: '', role: '', method: 'none' };
    if (ctx) {
      // Fire-and-forget: update lastUsedAt for API key tracking (AUD-021)
      getApiKeyMetadataStore().updateLastUsedByHash(tokenHash).catch(() => {});
      return {
        authenticated: true,
        tenantId: ctx.tenantId,
        role: ctx.role,
        method: 'api_key',
      };
    }

    // Try dynamic Wave 3C API key via hash registry (keys created at runtime)
    const hashCtx = resolveHashContext(tokenHash);
    if (hashCtx && isTenantInactive(hashCtx.tenantId)) return { authenticated: false, tenantId: '', role: '', method: 'none' };
    // H1 lane B: revocations that depend on who minted the key and when (author deprovisioned — S05 residual)
    if (hashCtx && dynamicKeyDenial(hashCtx)) return { authenticated: false, tenantId: '', role: '', method: 'none' };
    if (hashCtx) {
      getApiKeyMetadataStore().updateLastUsedByHash(tokenHash).catch(() => {});
      return {
        authenticated: true,
        tenantId: hashCtx.tenantId,
        role: hashCtx.role,
        method: 'api_key',
        keyCreatedBy: hashCtx.createdBy ?? null,
      };
    }
  }

  return { authenticated: false, tenantId: '', role: '', method: 'none' };
}
