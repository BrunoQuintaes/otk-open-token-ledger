/**
 * Registry token authority — cross-replica state of the static registry tokens managed at runtime
 * (STOPGATE-01 P1.1, finding R-13b of the H1 final closure run).
 *
 * Problem (R-13b). The tenant registry (api/tenantKeyRegistry + api/tenantCrud) is per process: memory plus an optional
 * local JSONL. A token created by POST /admin/tenants on replica A was 401 on replica B; a token rotated or removed on
 * A kept the state B had; POST /admin/tenants/reload changed A only. R-13 had closed the same gap for dynamic keys.
 *
 * Contract:
 *   - every registry change made through the API (create, rotate, role change, deactivation, reactivation, reload) is
 *     queued here, in order, as a change keyed by the SHA-256 of the token (the token itself is never stored), and the
 *     route answers only after the queue was written to the authority (PostgreSQL, set by storeBootstrap); a write that
 *     fails leaves the change applied on this replica and queued, and the route answers 503 (retry flushes it);
 *   - credentialAuthority.refreshCredential reads the row of a presented registry token on EVERY request: active → the
 *     local registry is refreshed with the authoritative tenant and role (a token created on another replica works);
 *     revoked or suspended → the token is dropped locally (refused at the next request that starts after the change
 *     committed); no row → the local registry decides (OTK_TENANTS deployments keep working unchanged);
 *   - without an authority (development, tests, single process) the queue is not used and nothing changes.
 *
 * Callers: `src/api/tenantCrud.ts` and `src/api/routes.ts` queue and flush changes; `src/auth/credentialAuthority.ts`
 * reads rows; `src/infra/storeBootstrap.ts` installs the PostgreSQL source. Reads no environment variable. State is
 * per process (queue, pending drops, generations).
 *
 * @module src/auth/registryTokenAuthority
 */

import crypto from 'node:crypto';

/** Authoritative row of a registry token. */
export interface RegistryTokenRow {
  /** Tenant the token belongs to. */
  tenantId: string;
  /** Role name as stored (checked against the five tenant roles by the reader). */
  role: string;
  /** `true` once the token was revoked for good. */
  revoked: boolean;
  /** tenant deactivated: refused until the tenant is reactivated (soft delete keeps the token) */
  suspended: boolean;
}

/** Authoritative source of registry tokens (the PostgreSQL table otk_tenant_tokens in a deployed environment). */
export interface RegistryTokenSource {
  /** The row for a token hash (SHA-256 hex), or `null` when none exists. */
  getByHash(tokenHash: string): Promise<RegistryTokenRow | null>;
  /** upsert: the token belongs to tenantId with role; not revoked; suspended as given */
  put(tokenHash: string, tenantId: string, role: string, suspended: boolean): Promise<void>;
  /** the token is revoked for good (rotation, removal by reload) */
  revoke(tokenHash: string, tenantId: string): Promise<void>;
  /** every non-revoked token of the tenant is suspended (deactivation) or resumed (reactivation) */
  setTenantSuspended(tenantId: string, suspended: boolean): Promise<void>;
  /** true when the tenant has at least one non-revoked token row */
  hasTenant(tenantId: string): Promise<boolean>;
}

/** One queued change; tokens appear only as their SHA-256 hash. */
export type RegistryTokenChange =
  | { op: 'put'; hash: string; tenantId: string; role: string; suspended: boolean }
  | { op: 'revoke'; hash: string; tenantId: string }
  | { op: 'suspend' | 'resume'; tenantId: string };

/**
 * The token is already bound to ANOTHER tenant in the shared registry (created on another replica): the write is refused
 * and the change dropped (cross-replica form of H1-S06: a registry write never moves a token between tenants).
 */
export class RegistryTokenConflictError extends Error {
  constructor() { super('registry token bound to another tenant'); this.name = 'RegistryTokenConflictError'; }
}

let _source: RegistryTokenSource | null = null;
const _queue: RegistryTokenChange[] = [];
let _conflicts = 0;

/**
 * STOPGATE-01 cycle 2 (review MED-2): revocations and suspensions queued on this process and not yet written. Until they
 * are, a lookup still finds the old (active) row; the token must not be learned again from it.
 */
const _pendingHashes = new Map<string, number>();
const _pendingTenants = new Map<string, number>();
const inc = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const dec = (m: Map<string, number>, k: string) => { const n = (m.get(k) ?? 0) - 1; if (n > 0) m.set(k, n); else m.delete(k); };

/**
 * True when a local revocation of the hash or a suspension of the tenant is still waiting to be written.
 *
 * @param hash - SHA-256 hex hash of the token.
 * @param tenantId - Tenant of the row being considered.
 * @returns Whether a pending local drop must win over the row read from the authority.
 */
export function registryDropPending(hash: string, tenantId: string): boolean {
  return _pendingHashes.has(hash) || _pendingTenants.has(tenantId);
}

/**
 * Number of changes dropped because the token belongs to another tenant since the last call (and resets it).
 *
 * @returns The count since the previous call.
 */
export function takeRegistryTokenConflicts(): number { const n = _conflicts; _conflicts = 0; return n; }
let _flushing: Promise<boolean> = Promise.resolve(true);

/**
 * Same digest as the dynamic keys (api/apiKeyManager.hashKey).
 *
 * @param token - Raw registry token.
 * @returns Lowercase hex SHA-256 digest.
 */
export function registryTokenHash(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Configure the authority (null = none: the process registry is authoritative, single process).
 *
 * Passing `null` also discards the queue and the pending drops.
 *
 * @param source - The shared registry store, or `null`.
 */
export function setRegistryTokenAuthority(source: RegistryTokenSource | null): void {
  _source = source;
  if (!source) { _queue.length = 0; _pendingHashes.clear(); _pendingTenants.clear(); }
}
/**
 * Returns the configured authority.
 *
 * @returns The source, or `null`.
 */
export function getRegistryTokenAuthority(): RegistryTokenSource | null { return _source; }

/**
 * Local revocation generation of each hash: a lookup that started before this process revoked the hash must not
 * register it again after (a slow positive answer racing a newer local change).
 */
const _gen = new Map<string, number>();
/**
 * Current local revocation generation of a hash.
 *
 * @param hash - SHA-256 hex hash of the token.
 * @returns The generation (0 when never revoked here).
 */
export function registryTokenGeneration(hash: string): number { return _gen.get(hash) ?? 0; }
/**
 * Increments the local revocation generation of a hash; at most 50 000 hashes are tracked (oldest evicted).
 *
 * @param hash - SHA-256 hex hash of the token.
 */
export function bumpRegistryTokenGeneration(hash: string): void {
  _gen.set(hash, (_gen.get(hash) ?? 0) + 1);
  if (_gen.size > 50_000) _gen.delete(_gen.keys().next().value as string);
}

/**
 * Queue a registry change for the authority (no-op without an authority). Tokens are hashed here.
 *
 * @param change - The change, with the raw token for `put` and `revoke`.
 */
export function queueRegistryTokenChange(
  change:
    | { op: 'put'; token: string; tenantId: string; role: string; suspended: boolean }
    | { op: 'revoke'; token: string; tenantId: string }
    | { op: 'suspend' | 'resume'; tenantId: string },
): void {
  if (!_source) return;
  if (change.op === 'put') {
    _queue.push({ op: 'put', hash: registryTokenHash(change.token), tenantId: change.tenantId, role: change.role, suspended: change.suspended });
  } else if (change.op === 'revoke') {
    const hash = registryTokenHash(change.token);
    bumpRegistryTokenGeneration(hash);
    inc(_pendingHashes, hash);
    _queue.push({ op: 'revoke', hash, tenantId: change.tenantId });
  } else {
    if (change.op === 'suspend') inc(_pendingTenants, change.tenantId);
    _queue.push({ op: change.op, tenantId: change.tenantId });
  }
}

/**
 * Number of changes not yet written to the authority.
 *
 * @returns Queue length.
 */
export function pendingRegistryTokenChanges(): number { return _queue.length; }

/**
 * Write the queued changes to the authority, in order, one flush at a time. True when the queue is empty afterwards;
 * false when the authority failed (the failed change and the ones after it stay queued for the next flush).
 *
 * @returns Resolves to `true` when nothing is left queued, `false` after a store failure (never rejects).
 */
export function flushRegistryTokenChanges(): Promise<boolean> {
  const run = async (): Promise<boolean> => {
    const src = _source;
    if (!src) { _queue.length = 0; return true; }
    while (_queue.length > 0) {
      const c = _queue[0]!;
      try {
        if (c.op === 'put') await src.put(c.hash, c.tenantId, c.role, c.suspended);
        else if (c.op === 'revoke') await src.revoke(c.hash, c.tenantId);
        else await src.setTenantSuspended(c.tenantId, c.op === 'suspend');
      } catch (err) {
        // a token of another tenant is never moved: drop the change (not retryable) and report it; anything else is an
        // outage: keep the change queued (in order) for the next flush
        if (!(err instanceof RegistryTokenConflictError)) return false;
        _conflicts++;
      }
      _queue.shift();
      if (c.op === 'revoke') dec(_pendingHashes, c.hash);
      else if (c.op === 'suspend') dec(_pendingTenants, c.tenantId);
    }
    return true;
  };
  _flushing = _flushing.then(run, run);
  return _flushing;
}

/**
 * Clears the authority, queue, generations, pending drops and conflict count.
 *
 * @internal Test only.
 */
export function resetRegistryTokenAuthorityForTest(): void {
  _source = null;
  _queue.length = 0;
  _gen.clear();
  _pendingHashes.clear();
  _pendingTenants.clear();
  _conflicts = 0;
  _flushing = Promise.resolve(true);
}
