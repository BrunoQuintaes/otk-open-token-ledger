/**
 * Tenant CRUD — Runtime tenant lifecycle management with JSONL persistence
 *
 * Provides create/read/update/delete for tenants without requiring restart.
 * Env bootstrap (OTK_TENANTS) acts as initial seed; runtime changes persist
 * to JSONL and survive restart.
 *
 * @module api/tenantCrud
 * @since S1.6 (Wave 1 Pack 1)
 */

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import {
  type TenantRole,
  registerToken,
  revokeToken,
  isTokenRegistered,
} from './tenantKeyRegistry.js';
import { type AuditRecord, chainHash } from '../security/AuditLogChain.js';
import { markTenantInactive, markTenantActive, clearTenantStatusForTest, isTenantInactive, tenantRevokedAtS } from '../auth/subjectStatus.js';
// STOPGATE-01 R-13b: every registry change is queued for the shared registry (no-op without one); the API route flushes
import { queueRegistryTokenChange } from '../auth/registryTokenAuthority.js';

/** Tenant record stored in the CRUD layer */
export interface TenantRecord {
  tenantId: string;
  role: TenantRole;
  /** Token is stored but never exposed in list/get responses */
  token: string;
  createdAt: string;
  updatedAt: string;
  /** Whether the tenant is active (soft-delete support) */
  active: boolean;
  /** H1-S04: ISO instant of the last deactivation (JWTs/refresh tokens issued until then stay invalid) */
  deactivatedAt?: string;
  /**
   * H1 lane B, POLICY PENDING (D4): set when the tenant was reactivated WITHOUT restoreKeys — dynamic keys minted up to
   * this ISO instant (the deactivation) stay refused. Absent = keys restored (or never deactivated).
   */
  keysRevokedThrough?: string;
}

/** Safe view of a tenant (token masked) */
export interface TenantView {
  tenantId: string;
  role: TenantRole;
  createdAt: string;
  updatedAt: string;
  active: boolean;
  tokenPrefix: string; // first 8 chars + "..."
}

// In-memory tenant records indexed by tenantId
const _tenants = new Map<string, TenantRecord>();
// Reverse map: token → tenantId (for revoke cleanup)
const _tokenIndex = new Map<string, string>();

// JSONL persistence (OTK_TENANT_LOG env)
const TENANT_LOG = process.env['OTK_TENANT_LOG'] ?? '';

// Audit chain integration
let _auditHead = '0000000000000000000000000000000000000000000000000000000000000000';
let _auditCount = 0;

function _appendAudit(action: string, tenantId: string, actor: string, meta?: Record<string, unknown>): void {
  const record: AuditRecord = {
    ts: new Date().toISOString(),
    tenantId,
    actor,
    action,
    meta,
  };
  _auditHead = chainHash(_auditHead, record);
  _auditCount++;
}

/** Persist full tenant state to JSONL (rewrite). Non-critical. */
function _persistAll(): void {
  if (!TENANT_LOG) return;
  try {
    const lines = Array.from(_tenants.values())
      .map(t => JSON.stringify(t))
      .join('\n');
    writeFileSync(TENANT_LOG, lines ? lines + '\n' : '', 'utf-8');
  } catch { /* non-critical */ }
}

/** Append a single tenant record to JSONL. */
function _appendTenant(record: TenantRecord): void {
  if (!TENANT_LOG) return;
  try {
    appendFileSync(TENANT_LOG, JSON.stringify(record) + '\n', 'utf-8');
  } catch { /* non-critical */ }
}

function _mask(token: string): string {
  return token.length > 8 ? token.slice(0, 8) + '...' : token.slice(0, 4) + '...';
}

function _toView(r: TenantRecord): TenantView {
  return {
    tenantId: r.tenantId,
    role: r.role,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    active: r.active,
    tokenPrefix: _mask(r.token),
  };
}

/**
 * STOPGATE-01 cycle 2 (review LOW-6): registry tokens must not look like dynamic keys (`otk_k_…`): the credential
 * authority routes that prefix to the key store only, so such a registry token would never be shared between replicas.
 */
const DYNAMIC_KEY_PREFIX = 'otk_k_';
export const RESERVED_PREFIX_ERROR = 'token prefix otk_k_ is reserved for dynamic keys';

const VALID_ROLES: ReadonlySet<string> = new Set<TenantRole>([
  'OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER',
]);

// Restore from JSONL on startup (overlay on top of env bootstrap)
if (TENANT_LOG) {
  try {
    const lines = readFileSync(TENANT_LOG, 'utf-8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as TenantRecord;
        if (rec.tenantId && rec.token) {
          _tenants.set(rec.tenantId, rec);
          _tokenIndex.set(rec.token, rec.tenantId);
          if (rec.active) {
            registerToken(rec.token, rec.tenantId, rec.role);
            // H1 lane B: a reactivated tenant keeps its "not before" instants across a restart (old JWTs, and old
            // dynamic keys unless they were restored)
            if (rec.deactivatedAt) {
              markTenantInactive(rec.tenantId, Date.parse(rec.deactivatedAt) || Date.now());
              markTenantActive(rec.tenantId, { restoreKeys: !rec.keysRevokedThrough });
            }
          } else {
            // H1-S04 (INF05-F01): the deactivation survives a restart for every credential of the tenant
            markTenantInactive(rec.tenantId, Date.parse(rec.deactivatedAt ?? rec.updatedAt) || Date.now());
          }
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* file not found */ }
}

/**
 * H1-S06 (INF05-F02): a token already bound to a tenant (registry entry from OTK_TENANTS/registerToken, or the token of
 * any CRUD record, active or deactivated) cannot be bound to another one. registerToken overwrites the binding, so
 * before this check POST /admin/tenants silently moved another tenant's token (and its charges) to the new tenant.
 */
function _tokenInUse(token: string, exceptTenantId?: string): boolean {
  if (isTokenRegistered(token)) {
    const owner = _tokenIndex.get(token);
    if (!(owner !== undefined && owner === exceptTenantId)) return true;
  }
  for (const r of _tenants.values()) if (r.token === token && r.tenantId !== exceptTenantId) return true;
  return false;
}

/**
 * Create a new tenant.
 * Returns the created tenant view or an error string.
 */
export function createTenant(params: {
  tenantId: string;
  token: string;
  role?: TenantRole;
  actor?: string;
}): { ok: true; tenant: TenantView } | { ok: false; error: string } {
  const { tenantId, token, role = 'OPERATOR', actor = 'system' } = params;

  if (!tenantId || !tenantId.trim()) return { ok: false, error: 'tenantId is required' };
  if (!token || !token.trim()) return { ok: false, error: 'token is required' };
  if (!VALID_ROLES.has(role)) return { ok: false, error: `invalid role: ${role}` };
  if (tenantId.includes(':') || tenantId.includes('/')) return { ok: false, error: 'tenantId must not contain : or /' };
  if (token.trim().startsWith(DYNAMIC_KEY_PREFIX)) return { ok: false, error: RESERVED_PREFIX_ERROR };
  if (_tenants.has(tenantId)) return { ok: false, error: 'tenant already exists' };
  if (_tokenInUse(token.trim())) return { ok: false, error: 'token already in use' };

  const now = new Date().toISOString();
  const record: TenantRecord = {
    tenantId: tenantId.trim(),
    role,
    token: token.trim(),
    createdAt: now,
    updatedAt: now,
    active: true,
  };

  _tenants.set(record.tenantId, record);
  _tokenIndex.set(record.token, record.tenantId);
  registerToken(record.token, record.tenantId, record.role);
  queueRegistryTokenChange({ op: 'put', token: record.token, tenantId: record.tenantId, role: record.role, suspended: false });
  _appendTenant(record);
  _appendAudit('tenant_created', record.tenantId, actor, { role });

  return { ok: true, tenant: _toView(record) };
}

/**
 * Get a tenant by tenantId. Returns the safe view or undefined.
 */
export function getTenant(tenantId: string): TenantView | undefined {
  const rec = _tenants.get(tenantId);
  return rec ? _toView(rec) : undefined;
}

/**
 * List all tenants (safe view — tokens masked).
 */
export function listTenants(filter?: {
  active?: boolean;
  role?: TenantRole;
}): TenantView[] {
  let entries = Array.from(_tenants.values());
  if (filter?.active !== undefined) entries = entries.filter(e => e.active === filter.active);
  if (filter?.role) entries = entries.filter(e => e.role === filter.role);
  return entries.map(_toView);
}

/**
 * Update a tenant (role or token).
 * Returns the updated view or an error string.
 */
export function updateTenant(params: {
  tenantId: string;
  token?: string;
  role?: TenantRole;
  /** H1-S04: true reactivates a deactivated tenant (credentials issued before the deactivation stay invalid) */
  active?: boolean;
  /**
   * H1 lane B, POLICY PENDING (D4): with active=true, also restore the dynamic keys minted before the deactivation.
   * Default false: those keys stay refused (and the API route revokes them in the metadata store).
   */
  restoreKeys?: boolean;
  actor?: string;
}): { ok: true; tenant: TenantView; reactivated?: { keysRevokedThrough: string | null } } | { ok: false; error: string } {
  const { tenantId, token, role, active, restoreKeys = false, actor = 'system' } = params;
  const rec = _tenants.get(tenantId);
  if (!rec) return { ok: false, error: 'tenant not found' };

  if (role && !VALID_ROLES.has(role)) return { ok: false, error: `invalid role: ${role}` };
  if (token && token.trim().startsWith(DYNAMIC_KEY_PREFIX)) return { ok: false, error: RESERVED_PREFIX_ERROR };
  if (token && token.trim() !== rec.token && _tokenInUse(token.trim(), tenantId)) return { ok: false, error: 'token already in use' };

  // Revoke old token from registry
  revokeToken(rec.token);
  _tokenIndex.delete(rec.token);
  const oldToken = rec.token;
  const wasActive = rec.active;

  if (token) rec.token = token.trim();
  if (role) rec.role = role;
  rec.updatedAt = new Date().toISOString();
  let reactivated: { keysRevokedThrough: string | null } | undefined;
  if (active === true && !rec.active) {
    rec.active = true;
    markTenantActive(rec.tenantId, { restoreKeys });
    if (restoreKeys) delete rec.keysRevokedThrough;
    else rec.keysRevokedThrough = rec.deactivatedAt ?? rec.updatedAt;
    reactivated = { keysRevokedThrough: rec.keysRevokedThrough ?? null };
  } else if (active === false && rec.active) {
    rec.active = false;
    rec.deactivatedAt = rec.updatedAt;
    markTenantInactive(rec.tenantId, Date.parse(rec.updatedAt));
  }

  // Re-register with new/updated token + role
  _tokenIndex.set(rec.token, rec.tenantId);
  if (rec.active) {
    registerToken(rec.token, rec.tenantId, rec.role);
  }
  // R-13b: rotation revokes the old token everywhere; (de)activation suspends/resumes every token row of the tenant
  if (oldToken !== rec.token) queueRegistryTokenChange({ op: 'revoke', token: oldToken, tenantId: rec.tenantId });
  if (wasActive !== rec.active) queueRegistryTokenChange({ op: rec.active ? 'resume' : 'suspend', tenantId: rec.tenantId });
  queueRegistryTokenChange({ op: 'put', token: rec.token, tenantId: rec.tenantId, role: rec.role, suspended: !rec.active });

  _tenants.set(tenantId, rec);
  _persistAll();
  _appendAudit('tenant_updated', tenantId, actor, { role: rec.role, ...(reactivated ? { reactivated: true, restoreKeys } : {}) });

  return { ok: true, tenant: _toView(rec), ...(reactivated ? { reactivated } : {}) };
}

/**
 * Delete (soft-deactivate) a tenant.
 * The tenant record is preserved but marked inactive. Token is revoked.
 */
export function deleteTenant(params: {
  tenantId: string;
  actor?: string;
}): { ok: true } | { ok: false; error: string } {
  const { tenantId, actor = 'system' } = params;
  const rec = _tenants.get(tenantId);
  if (!rec) return { ok: false, error: 'tenant not found' };

  rec.active = false;
  rec.updatedAt = new Date().toISOString();
  rec.deactivatedAt = rec.updatedAt;
  revokeToken(rec.token);
  _tokenIndex.delete(rec.token);
  // H1-S04 (INF05-F01): deactivation used to revoke only the registry token; dynamic keys, JWTs and refresh tokens of
  // the tenant kept working. They are now refused at authentication time (auth/subjectStatus).
  markTenantInactive(rec.tenantId, Date.parse(rec.updatedAt));
  queueRegistryTokenChange({ op: 'suspend', tenantId: rec.tenantId }); // R-13b: soft delete, the token row is kept

  _tenants.set(tenantId, rec);
  _persistAll();
  _appendAudit('tenant_deleted', tenantId, actor);

  return { ok: true };
}

/**
 * H1R2 R-14 (F-LB-02): deactivate a tenant that exists OUTSIDE the tenant registry — a /signup organization (its JWTs
 * carry the org id as tenant) or a tenant known only by its dynamic keys. Before, DELETE /admin/tenants/:id answered
 * 404 for them and their credentials could not be cut. The subject status (shared through PostgreSQL) is the only
 * state written: no registry record and no token are created, so the identity of the organization is unchanged. The
 * caller (API route) checks that the tenant exists. Idempotent.
 */
export function deactivateExternalTenant(params: { tenantId: string; actor?: string }): { ok: true; alreadyInactive: boolean } {
  const { tenantId, actor = 'system' } = params;
  const alreadyInactive = isTenantInactive(tenantId);
  markTenantInactive(tenantId, Date.now());
  queueRegistryTokenChange({ op: 'suspend', tenantId }); // R-13b: a tenant registered on another replica
  _appendAudit('tenant_deactivated_external', tenantId, actor, { alreadyInactive });
  return { ok: true, alreadyInactive };
}

/**
 * H1R2 R-14: reactivate a tenant outside the registry (see deactivateExternalTenant). Same rules as updateTenant:
 * credentials issued before the deactivation stay invalid; POLICY PENDING (D4): unless restoreKeys, dynamic keys minted
 * up to the deactivation stay refused and are revoked by the route. keysRevokedThrough is the deactivation instant.
 */
export function reactivateExternalTenant(params: { tenantId: string; restoreKeys?: boolean; actor?: string }):
  { ok: true; reactivated: { keysRevokedThrough: string | null } | null } {
  const { tenantId, restoreKeys = false, actor = 'system' } = params;
  if (!isTenantInactive(tenantId)) return { ok: true, reactivated: null };
  const revokedS = tenantRevokedAtS(tenantId);
  markTenantActive(tenantId, { restoreKeys });
  queueRegistryTokenChange({ op: 'resume', tenantId });
  _appendAudit('tenant_reactivated_external', tenantId, actor, { restoreKeys });
  const through = restoreKeys ? null : new Date((revokedS ?? Math.floor(Date.now() / 1000)) * 1000).toISOString();
  return { ok: true, reactivated: { keysRevokedThrough: through } };
}

/** Get tenant CRUD audit head and count (for governance trail). */
export function tenantAuditStatus(): { auditHead: string; auditCount: number } {
  return { auditHead: _auditHead, auditCount: _auditCount };
}

/** Total tenant count (all statuses). */
export function tenantCount(): number {
  return _tenants.size;
}

/**
 * Clear all tenant CRUD state.
 * @internal Test only.
 */
export function clearTenantsForTest(): void {
  for (const rec of _tenants.values()) {
    revokeToken(rec.token);
  }
  _tenants.clear();
  _tokenIndex.clear();
  clearTenantStatusForTest();
  _auditHead = '0000000000000000000000000000000000000000000000000000000000000000';
  _auditCount = 0;
}
