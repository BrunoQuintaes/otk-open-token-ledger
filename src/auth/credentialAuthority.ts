/**
 * Credential authority — authoritative, per-request freshness of the credential that authenticates a request
 * (H1R2, findings R-13 / F-LB-01 and N-D4 / A3 of the H1 final closure run).
 *
 * Problem (R-13). Dynamic API keys (/keys) are resolved through a per-process hash registry (api/tenantKeyRegistry),
 * filled by createApiKey / emptied by revokeApiKey ON THE REPLICA THAT RAN THEM. A key revoked or rotated on replica A
 * kept working on replica B until B restarted; a key created on A did not work on B at all. The subject status (tenant
 * deactivation, SCIM deprovisioning) was shared through PostgreSQL but read from a snapshot refreshed every TTL (2 s),
 * and a subject never seen as inactive stayed active while the store was down (N-D4, fail open).
 *
 * Contract (applied by the API router and the proxy gateway BEFORE the synchronous authentication of the request):
 *   - dynamic key: when a key authority is configured (the PostgreSQL key metadata store, set by storeBootstrap), the
 *     row of the key is read from it on EVERY request authenticated with a dynamic key. Unknown, revoked or expired →
 *     the key is dropped from the local registry (the request is then answered 401 by the usual path); active → the
 *     local registry is refreshed with the authoritative tenant, role, creation instant and author. A key revoked or
 *     rotated on any replica is therefore refused by every replica for every request that STARTS after the revocation
 *     committed (no restart, no TTL). Store error → 503 credential_status_unavailable (fail closed, every route): an
 *     unknown key state is never admitted, read-only routes included;
 *   - subject status: for privileged or spending requests (isStrictRoute: every non-read method, every read under a
 *     sensitive prefix, and every proxy request) the tenant and the user (JWT userId or the key's author) are re-read
 *     from the subject status store NOW. Store error → 503 (fail closed; N-D4 replaced for these operations). Plain
 *     reads keep the TTL snapshot (bounded staleness ≈ TTL; a subject never seen as inactive stays readable during a
 *     store outage — documented residual, no spend and no privilege);
 *   - without stores (development, tests, single process) the process is the authority: nothing changes.
 * Requests already admitted before a revocation commits are not interrupted (in-flight window, see the R2 report).
 *
 * @module auth/credentialAuthority
 */

import { verifyToken, getJwtSecret } from './jwt.js';
import {
  isAuthEnabled, resolveTokenContext, registerTokenByHash, revokeTokenByHash, registerToken, revokeToken, type TenantRole,
} from '../api/tenantKeyRegistry.js';
import {
  getRegistryTokenAuthority, registryTokenHash, registryTokenGeneration, bumpRegistryTokenGeneration, registryDropPending,
} from './registryTokenAuthority.js';

const REGISTRY_ROLES: ReadonlySet<string> = new Set<TenantRole>(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']);
import { hashKey } from '../api/apiKeyManager.js';
import type { ApiKeyMetadata } from '../api/IApiKeyMetadataStore.js';
import { refreshSubjectsNow, getSubjectStatusStore, type SubjectKind } from './subjectStatus.js';
import { AuthFailureLimiter } from '../security/authFailureLimiter.js';

/** Authoritative source of dynamic keys (the PostgreSQL key metadata store in a deployed environment). */
export interface KeyAuthoritySource {
  getByHash(tokenHash: string): Promise<ApiKeyMetadata | null>;
}

let _source: KeyAuthoritySource | null = null;

/**
 * Every dynamic key is minted as `otk_k_<64 hex>` (apiKeyManager). Other unknown bearer values (a SCIM bearer, a typo, a
 * guess) are not looked up, so they cost no store round trip and do not turn a store outage into 503 for them.
 */
const DYNAMIC_KEY_FORMAT = /^otk_k_[0-9a-f]{64}$/;

/**
 * H1R2 review MED-1: unknown dynamic keys cost a store round trip before any RBAC or rate limit, so a flood of random
 * `otk_k_…` values from one source could exhaust the PostgreSQL pool and, with fail-closed, deny every key user. Each
 * source gets at most OTK_KEY_LOOKUP_MISS_MAX lookups that find no active key per minute (default 20); beyond that its
 * dynamic keys are not looked up (and refused: fail closed) until the window ends. Valid keys never count as misses.
 */
const _missLimiter = new AuthFailureLimiter({
  max: Number(process.env['OTK_KEY_LOOKUP_MISS_MAX'] ?? 20) || 20,
  windowMs: 60_000,
  maxEntries: 10_000,
});
/** @internal Test only. */
export function resetKeyLookupLimiterForTest(): void { _missLimiter.clear(); }

/**
 * H1R2 review LOW-1: generation of each hash's local revocations. A lookup that started before a revocation of the
 * same hash on this process must not re-register the key after it (a slow positive answer racing a newer negative one).
 */
const _revocationGen = new Map<string, number>();
function _dropHash(hash: string): void {
  revokeTokenByHash(hash);
  _revocationGen.set(hash, (_revocationGen.get(hash) ?? 0) + 1);
  if (_revocationGen.size > 50_000) _revocationGen.delete(_revocationGen.keys().next().value as string);
}

/** Configure the key authority (null = none: the local hash registry is authoritative, single process). */
export function setKeyAuthority(source: KeyAuthoritySource | null): void { _source = source; }
export function getKeyAuthority(): KeyAuthoritySource | null { return _source; }

/** Counters for /metrics (no key, hash, tenant or user id is recorded). */
const _stats = {
  keyLookups: 0,
  keyLookupsThrottled: 0,
  keyLookupFailures: 0,
  keysRefusedRevoked: 0,
  keysRefusedUnknown: 0,
  keysRefusedExpired: 0,
  // STOPGATE-01 R-13b: registry tokens (OTK_TENANTS / tenant CRUD / reload) decided by the shared registry table
  registryLookups: 0,
  registryLookupsThrottled: 0,
  registryLookupFailures: 0,
  registryTokensLearned: 0,
  registryTokensRefused: 0,
  subjectChecks: 0,
  subjectCheckFailures: 0,
  failClosed: 0,
};
export function credentialAuthorityStats(): Readonly<typeof _stats> { return { ..._stats }; }
/** @internal Test only. */
export function resetCredentialAuthorityStatsForTest(): void { for (const k of Object.keys(_stats) as Array<keyof typeof _stats>) _stats[k] = 0; }

export type FreshnessResult = { ok: true } | { ok: false; status: 503; error: 'credential_status_unavailable'; detail: string };

const FAIL = (detail: string): FreshnessResult => {
  _stats.failClosed++;
  return { ok: false, status: 503, error: 'credential_status_unavailable', detail };
};

const READ_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);
/** Read routes whose answer is itself privileged (tenant/user administration, keys, money, personal data, audit). */
const SENSITIVE_READ_PREFIXES: readonly string[] = [
  '/admin', '/scim', '/keys', '/billing', '/invoices', '/accounting', '/data', '/gdpr', '/webhooks', '/teams',
  '/users', '/auth', '/flags', '/ratelimit', '/plans',
  // H1R2 review LOW-2 / MED-2: provider-key metadata, reconciliation and team reports, and the live event stream
  '/tenants', '/reconciliation', '/reports', '/stream',
];

/**
 * True when the request is privileged or spends resources, so the status of its subject must be read from the
 * authoritative store now (fail closed). `routePath` is the path without the /v1 prefix.
 */
export function isStrictRoute(method: string, routePath: string): boolean {
  if (!READ_METHODS.has(method.toUpperCase())) return true;
  // H1R2 review LOW-2: routes declared with a literal /v1/ are reached as /v1/v1/... and arrive here as /v1/...
  const p = routePath.startsWith('/v1/') ? routePath.slice(3) : routePath;
  return SENSITIVE_READ_PREFIXES.some((x) => p === x || p.startsWith(`${x}/`));
}

/** The OTK credential of a request: `Authorization: Bearer`, else `x-api-key` / `x-goog-api-key` (proxy SDKs). */
export function presentedCredential(headers: Record<string, string | string[] | undefined> | undefined, opts: { apiKeyHeaders?: boolean } = {}): string {
  const auth = headers?.['authorization'];
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (bearer || !opts.apiKeyHeaders) return bearer;
  for (const h of ['x-api-key', 'x-goog-api-key']) {
    const v = headers?.[h];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return '';
}

/**
 * Bring the local view of `token` (and of its subjects) up to date with the authoritative stores before the request is
 * authenticated synchronously. Never authenticates by itself: it only refreshes or drops local state, or asks the
 * caller to answer 503 when the authoritative state cannot be read and the request may not run on stale state.
 *   - strict: privileged / spending request (see isStrictRoute) → subjects re-read now, fail closed;
 *   - dynamicKeys: false for entrypoints that never accept dynamic keys (the MITM proxy accepts registry tokens only).
 */
export async function refreshCredential(token: string, opts: { strict: boolean; dynamicKeys?: boolean; source?: string }): Promise<FreshnessResult> {
  if (!token || !isAuthEnabled()) return { ok: true };
  const subjects: Array<{ kind: SubjectKind; id: string }> = [];

  // 1. access JWT (same acceptance rule as authMiddleware: a verified token with a subject)
  let isJwt = false;
  const secret = getJwtSecret();
  if (secret && token.split('.').length === 3) {
    const p = verifyToken(token, secret) as ({ sub?: unknown; userId?: unknown; type?: unknown }) | null;
    if (p && typeof p.sub === 'string' && p.sub.trim() !== '') {
      isJwt = true;
      subjects.push({ kind: 'tenant', id: p.sub });
      if (typeof p.userId === 'string' && p.userId) subjects.push({ kind: 'user', id: p.userId });
    }
  }

  if (!isJwt) {
    // 2a. registry token: the shared registry decides on EVERY request when it is configured (R-13b)
    if (getRegistryTokenAuthority() && !token.startsWith('otk_k_')) {
      const r = await refreshRegistryToken(token, opts);
      if (!r.ok) return r;
    }
    const staticCtx = resolveTokenContext(token);
    if (staticCtx) {
      // 2. registry token (OTK_TENANTS / tenant CRUD): its existence is the tenant registry; status by subject below
      subjects.push({ kind: 'tenant', id: staticCtx.tenantId });
    } else if (_source && opts.dynamicKeys !== false && token.startsWith('otk_k_')) {
      // 3. dynamic key: the authority decides on EVERY request (R-13)
      const hash = hashKey(token);
      // a value that cannot be a minted key is never looked up (and never admitted)
      if (!DYNAMIC_KEY_FORMAT.test(token)) { _dropHash(hash); return { ok: true }; }
      const src = opts.source ?? '';
      if (src && _missLimiter.throttledFor(src) > 0) { _stats.keyLookupsThrottled++; _dropHash(hash); return { ok: true }; }
      const genAtStart = _revocationGen.get(hash) ?? 0;
      let meta: ApiKeyMetadata | null;
      _stats.keyLookups++;
      try {
        meta = await _source.getByHash(hash);
      } catch {
        _stats.keyLookupFailures++;
        _dropHash(hash); // a stale positive entry must not survive the outage either
        return FAIL('the key store did not answer; the key state is unknown');
      }
      const miss = (k: 'keysRefusedUnknown' | 'keysRefusedRevoked' | 'keysRefusedExpired'): FreshnessResult => {
        _stats[k]++; _dropHash(hash);
        if (src) void _missLimiter.recordFailure(src);
        return { ok: true };
      };
      if (!meta) return miss('keysRefusedUnknown');
      if (meta.revokedAt) return miss('keysRefusedRevoked');
      if (meta.expiresAt && Date.parse(meta.expiresAt) <= Date.now()) return miss('keysRefusedExpired');
      // LOW-1: a revocation of this hash processed meanwhile on this process is newer than this answer
      if ((_revocationGen.get(hash) ?? 0) !== genAtStart) return { ok: true };
      registerTokenByHash(hash, {
        tenantId: meta.tenantId,
        role: meta.role as TenantRole,
        expiresAt: meta.expiresAt,
        createdAt: meta.createdAt,
        createdBy: meta.createdBy ?? null,
      });
      subjects.push({ kind: 'tenant', id: meta.tenantId });
      if (meta.createdBy) subjects.push({ kind: 'user', id: meta.createdBy });
    }
  }

  // 4. subject status: authoritative for privileged / spending requests (A3, N-D4 fail closed)
  if (opts.strict && subjects.length > 0 && getSubjectStatusStore()) {
    _stats.subjectChecks++;
    if (!(await refreshSubjectsNow(subjects))) {
      _stats.subjectCheckFailures++;
      return FAIL('the subject status store did not answer; privileged and spending operations are refused while the status is unknown');
    }
  }
  return { ok: true };
}

/**
 * STOPGATE-01 R-13b: bring the local registry entry of a static registry token up to date with the shared registry.
 *   - row active → registered locally with the authoritative tenant and role (created or changed on another replica);
 *   - row revoked or suspended → dropped locally (the request is then answered 401 by the usual path);
 *   - no row → the local registry decides (OTK_TENANTS tokens never changed through the API);
 *   - store error → a token known locally has an unknown state: 503 for privileged or spending requests (fail closed),
 *     snapshot for plain reads (same documented residual as A3); a token not known locally cannot be learned and stays
 *     unknown (401).
 * Lookups of values that are not known locally and find no row count as misses of the source (same limiter as R-13).
 */
async function refreshRegistryToken(token: string, opts: { strict: boolean; source?: string }): Promise<FreshnessResult> {
  const src = getRegistryTokenAuthority();
  if (!src) return { ok: true };
  const known = resolveTokenContext(token) !== null;
  const source = opts.source ?? '';
  if (!known && source && _missLimiter.throttledFor(source) > 0) { _stats.registryLookupsThrottled++; return { ok: true }; }
  const hash = registryTokenHash(token);
  const genAtStart = registryTokenGeneration(hash);
  _stats.registryLookups++;
  let row: Awaited<ReturnType<typeof src.getByHash>>;
  try {
    row = await src.getByHash(hash);
  } catch {
    _stats.registryLookupFailures++;
    if (known && opts.strict) return FAIL('the registry store did not answer; the token state is unknown');
    return { ok: true };
  }
  if (!row) {
    if (!known && source) void _missLimiter.recordFailure(source);
    return { ok: true };
  }
  // cycle 2: a row with an unknown role is never admitted (review LOW-8); a revocation/suspension queued on this process
  // and not yet written wins over the older active row (review MED-2)
  if (row.revoked || row.suspended || !REGISTRY_ROLES.has(row.role) || registryDropPending(hash, row.tenantId)) {
    _stats.registryTokensRefused++;
    bumpRegistryTokenGeneration(hash);
    revokeToken(token);
    return { ok: true };
  }
  if (registryTokenGeneration(hash) !== genAtStart) return { ok: true }; // revoked meanwhile on this process
  if (!known) _stats.registryTokensLearned++;
  registerToken(token, row.tenantId, row.role as TenantRole);
  return { ok: true };
}
