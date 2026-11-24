/**
 * Subject status — synchronous view of deactivated tenants and deprovisioned users, consulted at authentication time
 * (H1-S04 / INF05-F01, H1-S05 / SEC02-N04), backed by an optional durable store shared by every replica (H1 lane B).
 *
 * Before this module the deactivation of a tenant (DELETE /admin/tenants/:id) only removed its registry token, and a
 * SCIM DELETE only cleared emailVerified: dynamic API keys, access JWTs and refresh tokens of the subject kept working.
 *
 * Rules (design notes: docs/_ops/H1/S04_INF05_F01_20261013, docs/_ops/H1/LANEB_20261013):
 *   - while a tenant is inactive, EVERY credential of the tenant is refused (registry token, dynamic /keys key,
 *     access JWT, refresh token, proxy token);
 *   - while a user is deprovisioned, every JWT carrying its userId is refused and /login issues no token;
 *   - each deactivation records a "not before" instant: tokens with an `iat` at or before it stay invalid FOREVER,
 *     even after reactivation (reactivation restores access only for credentials issued afterwards, plus the registry
 *     token);
 *   - H1 lane B, POLICY PENDING (D4): reactivating a tenant does NOT restore the dynamic keys minted before its
 *     deactivation unless the platform asks for it explicitly (PUT /admin/tenants/:id {active:true, restoreKeys:true}).
 *     The default records a "keys not before" instant equal to the deactivation instant;
 *   - the comparison is at second granularity (`iat` is in seconds) and conservative: a token issued in the same
 *     second as the deactivation is treated as issued before it.
 *
 * Replicas and restarts (H1 lane B, S04 residual). The view is a per-process cache. When a durable store is configured
 * (setSubjectStatusStore; PostgreSQL via storeBootstrap when OTK_DB_URL is set) it is the authoritative source:
 *   - writes: every local change (deactivation, reactivation, deprovisioning) is applied to the cache at once and
 *     written to the store; callers that must report the outcome await flushSubjectStatus() (the admin routes answer 503
 *     when the write failed, so the operator retries);
 *   - reads: the cache is refreshed from the store at most OTK_SUBJECT_STATUS_TTL_MS after the previous refresh (default
 *     2000 ms): a check made after the TTL starts a refresh in the background, and a timer refreshes idle processes.
 *     A change made on one replica is therefore enforced on every other replica within about TTL + one store round
 *     trip (bounded staleness). A restart hydrates the cache from the store before traffic (storeBootstrap awaits it);
 *   - store errors: the last snapshot is kept. A subject seen as deactivated stays deactivated (fail closed: a
 *     reactivation made elsewhere is not applied until the store answers again). A subject never seen as deactivated
 *     stays active (availability: refusing every tenant during a store outage would turn it into a full outage);
 *     its deactivation on another replica becomes effective here when the store answers again. In a deployed
 *     environment the process does not start without PostgreSQL (storeBootstrap / deployedStoreProblems).
 * Without a store the behaviour is the previous one: per process, the tenant CRUD log (OTK_TENANT_LOG) and the user
 * store (deprovisionedAt) are re-applied at startup / on privileged routes.
 *
 * Memory is bounded by the number of deactivated subjects (only platform and SCIM operations add entries).
 *
 * @module auth/subjectStatus
 */

export type SubjectKind = 'tenant' | 'user';

/** Durable status of one subject. Instants are epoch seconds; 0 = none. */
export interface SubjectStatusRecord {
  kind: SubjectKind;
  id: string;
  inactive: boolean;
  /** tokens issued at or before this instant are refused forever */
  notBeforeS: number;
  /** tenant only: dynamic keys minted at or before this instant are refused (reactivation without restoreKeys) */
  keysNotBeforeS: number;
}

/** Durable store shared by replicas. `put` never lowers notBeforeS / keysNotBeforeS (monotonic max). */
export interface ISubjectStatusStore {
  put(rec: SubjectStatusRecord): Promise<void>;
  listAll(): Promise<SubjectStatusRecord[]>;
  /**
   * H1R2 A3: rows of the given subjects only (absent = never deactivated). Used for the authoritative per-request check
   * of privileged and spending operations (refreshSubjectsNow). Optional: a store without it is read with listAll.
   */
  getMany?(subjects: ReadonlyArray<{ kind: SubjectKind; id: string }>): Promise<SubjectStatusRecord[]>;
}

/** In-memory store (tests; a single process). Several clients may share one instance as a common backend. */
export class MemorySubjectStatusStore implements ISubjectStatusStore {
  private readonly _rows = new Map<string, SubjectStatusRecord>();
  async put(rec: SubjectStatusRecord): Promise<void> {
    const k = `${rec.kind}\u0000${rec.id}`;
    const prev = this._rows.get(k);
    this._rows.set(k, {
      ...rec,
      notBeforeS: Math.max(prev?.notBeforeS ?? 0, rec.notBeforeS),
      keysNotBeforeS: Math.max(prev?.keysNotBeforeS ?? 0, rec.keysNotBeforeS),
    });
  }
  async listAll(): Promise<SubjectStatusRecord[]> {
    return [...this._rows.values()].map((r) => ({ ...r }));
  }
  async getMany(subjects: ReadonlyArray<{ kind: SubjectKind; id: string }>): Promise<SubjectStatusRecord[]> {
    const out: SubjectStatusRecord[] = [];
    for (const s of subjects) { const r = this._rows.get(`${s.kind}\u0000${s.id}`); if (r) out.push({ ...r }); }
    return out;
  }
}

const _inactiveTenants = new Set<string>();
const _tenantNotBefore = new Map<string, number>(); // tenantId → epoch seconds
const _tenantKeysNotBefore = new Map<string, number>(); // tenantId → epoch seconds
const _deprovisionedUsers = new Set<string>();
const _userNotBefore = new Map<string, number>(); // userId → epoch seconds

// ── durable store state ──
let _store: ISubjectStatusStore | null = null;
let _lastSyncStartMs = 0;
let _lastSyncOkMs = 0;
let _lastSyncError: string | null = null;
let _syncInFlight: Promise<boolean> | null = null;
let _timer: ReturnType<typeof setInterval> | null = null;
const _pendingWrites = new Set<Promise<void>>();
const _writeErrors: string[] = [];
/** subjects whose last write to the store failed: the next mark* call writes them again even without a change */
const _unsynced = new Set<string>();
/** subjects with a local write not yet confirmed by the store: a refresh must not overwrite their inactive flag */
const _dirty = new Map<string, number>();
/** sequence number of the last local change of each subject; a refresh started before it must not overwrite it */
let _seq = 0;
const _localChangeSeq = new Map<string, number>();

function _ttlMs(): number {
  const raw = process.env['OTK_SUBJECT_STATUS_TTL_MS'];
  const v = raw === undefined || raw.trim() === '' ? NaN : Number(raw);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : 2000;
}

const _key = (kind: SubjectKind, id: string) => `${kind}\u0000${id}`;

function _record(kind: SubjectKind, id: string): SubjectStatusRecord {
  return kind === 'tenant'
    ? { kind, id, inactive: _inactiveTenants.has(id), notBeforeS: _tenantNotBefore.get(id) ?? 0, keysNotBeforeS: _tenantKeysNotBefore.get(id) ?? 0 }
    : { kind, id, inactive: _deprovisionedUsers.has(id), notBeforeS: _userNotBefore.get(id) ?? 0, keysNotBeforeS: 0 };
}

/** Write the current local status of a subject to the store (no-op without store). */
function _persist(kind: SubjectKind, id: string): void {
  const store = _store;
  if (!store) return;
  const k = _key(kind, id);
  _dirty.set(k, (_dirty.get(k) ?? 0) + 1);
  _localChangeSeq.set(k, ++_seq);
  const p: Promise<void> = (async () => {
    try {
      await store.put(_record(kind, id));
      _unsynced.delete(k);
    } catch (err) {
      _unsynced.add(k);
      _writeErrors.push(`${kind}:${id}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      const n = (_dirty.get(k) ?? 1) - 1;
      if (n <= 0) _dirty.delete(k); else _dirty.set(k, n);
    }
  })();
  _pendingWrites.add(p);
  void p.finally(() => _pendingWrites.delete(p));
}

function _bumpNotBefore(map: Map<string, number>, id: string, atMs: number): boolean {
  const s = Math.floor(atMs / 1000);
  const prev = map.get(id) ?? 0;
  if (s <= prev && map.has(id)) return false;
  map.set(id, Math.max(prev, s));
  return true;
}

/** Start a background refresh when the snapshot is older than the TTL. */
function _maybeRefresh(): void {
  if (!_store || _syncInFlight) return;
  if (Date.now() - _lastSyncStartMs < _ttlMs()) return;
  void syncSubjectStatusNow();
}

/** Mark a tenant inactive (deactivation). Tokens issued at or before `atMs` stay invalid after reactivation. */
export function markTenantInactive(tenantId: string, atMs: number = Date.now()): void {
  const changed = !_inactiveTenants.has(tenantId) || _unsynced.has(_key('tenant', tenantId));
  _inactiveTenants.add(tenantId);
  if (_bumpNotBefore(_tenantNotBefore, tenantId, atMs) || changed) _persist('tenant', tenantId);
}

/**
 * Reactivate a tenant. The "not before" instant is kept (old JWTs/refresh tokens stay invalid). POLICY PENDING (D4):
 * unless `opts.restoreKeys` is true, the dynamic keys minted up to the last deactivation stay refused.
 */
export function markTenantActive(tenantId: string, opts: { restoreKeys?: boolean } = {}): void {
  const wasInactive = _inactiveTenants.delete(tenantId);
  if (!wasInactive && !_unsynced.has(_key('tenant', tenantId))) return;
  if (!opts.restoreKeys) {
    const nb = _tenantNotBefore.get(tenantId) ?? Math.floor(Date.now() / 1000);
    _tenantKeysNotBefore.set(tenantId, Math.max(_tenantKeysNotBefore.get(tenantId) ?? 0, nb));
  }
  _persist('tenant', tenantId);
}

export function isTenantInactive(tenantId: string): boolean {
  _maybeRefresh();
  return _inactiveTenants.has(tenantId);
}

/** Mark a user deprovisioned (SCIM DELETE / active=false). */
export function markUserDeprovisioned(userId: string, atMs: number = Date.now()): void {
  const changed = !_deprovisionedUsers.has(userId) || _unsynced.has(_key('user', userId));
  _deprovisionedUsers.add(userId);
  if (_bumpNotBefore(_userNotBefore, userId, atMs) || changed) _persist('user', userId);
}

/** Re-provision a user. The "not before" instant is kept. */
export function markUserActive(userId: string): void {
  if (_deprovisionedUsers.delete(userId) || _unsynced.has(_key('user', userId))) _persist('user', userId);
}

export function isUserDeprovisioned(userId: string): boolean {
  _maybeRefresh();
  return _deprovisionedUsers.has(userId);
}

/** True when a token issued at `iatS` (epoch seconds) predates the last deactivation of the tenant. */
export function issuedBeforeTenantRevocation(tenantId: string, iatS: unknown): boolean {
  _maybeRefresh();
  const nb = _tenantNotBefore.get(tenantId);
  if (nb === undefined) return false;
  return typeof iatS !== 'number' || !Number.isFinite(iatS) || iatS <= nb;
}

/** True when a token issued at `iatS` (epoch seconds) predates the last deprovisioning of the user. */
export function issuedBeforeUserRevocation(userId: string, iatS: unknown): boolean {
  _maybeRefresh();
  const nb = _userNotBefore.get(userId);
  if (nb === undefined) return false;
  return typeof iatS !== 'number' || !Number.isFinite(iatS) || iatS <= nb;
}

/**
 * Reason an otherwise valid access JWT must be refused because of the status of its subject, or null.
 * `sub` is the tenant; `userId` (signup/login tokens) is the user.
 */
export function jwtSubjectDenial(p: { sub?: unknown; userId?: unknown; iat?: unknown }): string | null {
  if (typeof p.sub === 'string') {
    if (isTenantInactive(p.sub)) return 'tenant_inactive';
    if (issuedBeforeTenantRevocation(p.sub, p.iat)) return 'token_predates_tenant_deactivation';
  }
  if (typeof p.userId === 'string' && p.userId) {
    if (isUserDeprovisioned(p.userId)) return 'user_deprovisioned';
    if (issuedBeforeUserRevocation(p.userId, p.iat)) return 'token_predates_user_deprovisioning';
  }
  return null;
}

/**
 * H1 lane B: reason a dynamic API key must be refused because of when and by whom it was minted, or null.
 *   - S04 residual, POLICY PENDING (D4): the tenant was reactivated without restoreKeys and the key was minted at or
 *     before the deactivation;
 *   - S05 residual: the key was minted by a user (`createdBy`) that is deprovisioned, or that was deprovisioned after
 *     the key was minted (the key stays refused after re-provisioning, like the user's old JWTs). SCIM deprovisioning
 *     also revokes those keys durably; this check covers replicas whose hash registry still holds the key.
 * A key without creation instant is treated as minted before any revocation (conservative).
 */
export function dynamicKeyDenial(k: { tenantId: string; createdAt?: string; createdBy?: string | null }): string | null {
  _maybeRefresh();
  const createdS = k.createdAt ? Math.floor(Date.parse(k.createdAt) / 1000) : undefined;
  const knb = _tenantKeysNotBefore.get(k.tenantId);
  if (knb !== undefined && (createdS === undefined || !Number.isFinite(createdS) || createdS <= knb)) {
    return 'key_predates_tenant_reactivation';
  }
  if (typeof k.createdBy === 'string' && k.createdBy) {
    if (isUserDeprovisioned(k.createdBy)) return 'author_deprovisioned';
    if (issuedBeforeUserRevocation(k.createdBy, createdS)) return 'key_predates_author_deprovisioning';
  }
  return null;
}

/** Last deactivation instant of a tenant (epoch seconds), or undefined. */
export function tenantRevokedAtS(tenantId: string): number | undefined {
  return _tenantNotBefore.get(tenantId);
}

// ── durable store ──────────────────────────────────────────────────────────

/** Apply one store row to the cache. The store is authoritative for the inactive flag; instants only grow. */
function _apply(r: SubjectStatusRecord, seqAtStart: number): void {
  const k = _key(r.kind, r.id);
  // H1 R-04 (adversarial review): a local change whose write FAILED (_unsynced) is newer than any store row; before,
  // the next refresh applied the old row (e.g. inactive=false) and the deactivation was undone on this very replica
  const dirty = _dirty.has(k) || _unsynced.has(k) || (_localChangeSeq.get(k) ?? 0) > seqAtStart;
  if (r.kind === 'tenant') {
    if (!dirty) { if (r.inactive) _inactiveTenants.add(r.id); else _inactiveTenants.delete(r.id); }
    if (r.notBeforeS > 0) _tenantNotBefore.set(r.id, Math.max(_tenantNotBefore.get(r.id) ?? 0, r.notBeforeS));
    if (r.keysNotBeforeS > 0) _tenantKeysNotBefore.set(r.id, Math.max(_tenantKeysNotBefore.get(r.id) ?? 0, r.keysNotBeforeS));
  } else if (r.kind === 'user') {
    if (!dirty) { if (r.inactive) _deprovisionedUsers.add(r.id); else _deprovisionedUsers.delete(r.id); }
    if (r.notBeforeS > 0) _userNotBefore.set(r.id, Math.max(_userNotBefore.get(r.id) ?? 0, r.notBeforeS));
  }
}

/**
 * Refresh the cache from the store now. Resolves true on success, false on a store error (the last snapshot is kept;
 * see the module doc). Concurrent calls share one refresh.
 */
export function syncSubjectStatusNow(): Promise<boolean> {
  const store = _store;
  if (!store) return Promise.resolve(true);
  if (_syncInFlight) return _syncInFlight;
  _lastSyncStartMs = Date.now();
  // H1 R-04: changes whose write failed are written again on every refresh until the store confirms them
  for (const k of [..._unsynced]) {
    const [kind, id] = k.split('\u0000') as [SubjectKind, string];
    if (!_dirty.has(k)) _persist(kind, id);
  }
  const seqAtStart = _seq;
  // the in-flight marker is cleared inside the body, before the promise settles: a caller that awaited this refresh
  // and immediately asks for another one gets a NEW refresh (before, it got the settled promise back for one tick)
  let p!: Promise<boolean>;
  p = (async () => {
    try {
      const rows = await store.listAll();
      if (store !== _store) return false;
      for (const r of rows) _apply(r, seqAtStart);
      _lastSyncOkMs = Date.now();
      _lastSyncError = null;
      return true;
    } catch (err) {
      _lastSyncError = err instanceof Error ? err.message : String(err);
      return false;
    } finally {
      if (_syncInFlight === p) _syncInFlight = null;
    }
  })();
  _syncInFlight = p;
  return p;
}

/**
 * H1R2 A3 (N-D4): authoritative refresh of a few subjects, for one privileged or spending request. Reads their rows
 * from the store NOW (not the TTL snapshot) and applies them like a refresh (a local change not yet confirmed by the
 * store still wins). Resolves false when the store does not answer: the caller must then refuse the operation (fail
 * closed) instead of admitting a subject whose status is unknown. Without a store: true (the process is the authority).
 */
export async function refreshSubjectsNow(subjects: ReadonlyArray<{ kind: SubjectKind; id: string }>): Promise<boolean> {
  const store = _store;
  if (!store) return true;
  const wanted = subjects.filter((s) => typeof s.id === 'string' && s.id !== '');
  if (wanted.length === 0) return true;
  const seqAtStart = _seq;
  try {
    const rows = store.getMany
      ? await store.getMany(wanted)
      : (await store.listAll()).filter((r) => wanted.some((w) => w.kind === r.kind && w.id === r.id));
    if (store !== _store) return false;
    for (const r of rows) _apply(r, seqAtStart);
    // a subject still waiting for its own write to reach the store is not confirmed (it is enforced locally only)
    return true;
  } catch (err) {
    _lastSyncError = err instanceof Error ? err.message : String(err);
    return false;
  }
}

/**
 * Wait for the pending writes to the store. `ok` is false when some write since the previous flush failed (the local
 * cache already holds the change; other replicas do not see it until it is written again).
 */
export async function flushSubjectStatus(subject?: { kind: SubjectKind; id: string }): Promise<{ ok: boolean; errors: string[] }> {
  while (_pendingWrites.size > 0) await Promise.all([..._pendingWrites]);
  if (subject) {
    // H1 R-05 (adversarial review): the outcome of THIS subject's write; the global error list belongs to other callers
    const k = _key(subject.kind, subject.id);
    return _unsynced.has(k) ? { ok: false, errors: [`${subject.kind}:${subject.id}: not written to the store`] } : { ok: true, errors: [] };
  }
  const errors = _writeErrors.splice(0, _writeErrors.length);
  return { ok: errors.length === 0, errors };
}

/**
 * Configure the durable store (null = none). Subjects known only locally (e.g. restored from OTK_TENANT_LOG at module
 * load) are written to the store when it has no row for them; then the cache is hydrated from the store. Starts an
 * unref'd refresh timer (TTL). Resolves with the result of the first refresh.
 */
export async function setSubjectStatusStore(store: ISubjectStatusStore | null): Promise<boolean> {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _store = store;
  _lastSyncStartMs = 0;
  if (!store) return true;
  let known = new Set<string>();
  try { known = new Set((await store.listAll()).map((r) => _key(r.kind, r.id))); } catch { /* reported by the sync below */ }
  for (const id of _tenantNotBefore.keys()) if (!known.has(_key('tenant', id))) _persist('tenant', id);
  for (const id of _userNotBefore.keys()) if (!known.has(_key('user', id))) _persist('user', id);
  await flushSubjectStatus();
  const ok = await syncSubjectStatusNow();
  const ttl = _ttlMs();
  if (ttl > 0) {
    _timer = setInterval(() => { void syncSubjectStatusNow(); }, ttl);
    _timer.unref?.();
  }
  return ok;
}

export function getSubjectStatusStore(): ISubjectStatusStore | null { return _store; }

/** Observability: store configured, last successful refresh, last error. */
export function subjectStatusHealth(): { store: boolean; lastSyncOkMs: number; lastSyncError: string | null } {
  return { store: _store !== null, lastSyncOkMs: _lastSyncOkMs, lastSyncError: _lastSyncError };
}

/** @internal Test only. */
export function clearTenantStatusForTest(): void {
  _inactiveTenants.clear();
  _tenantNotBefore.clear();
  _tenantKeysNotBefore.clear();
}

/** @internal Test only. */
export function clearUserStatusForTest(): void {
  _deprovisionedUsers.clear();
  _userNotBefore.clear();
}

/** @internal Test only: drop the store (and its timer) without touching the cache. */
export function resetSubjectStatusStoreForTest(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
  _store = null;
  _syncInFlight = null;
  _dirty.clear();
  _localChangeSeq.clear();
  _unsynced.clear();
  _writeErrors.splice(0, _writeErrors.length);
  _lastSyncStartMs = 0; _lastSyncOkMs = 0; _lastSyncError = null;
}
