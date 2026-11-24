/**
 * RBAC permission model — E1.3 (ADR-0206)
 *
 * Defines the canonical permission matrix for all OTK roles.
 * Consumed by routes.ts to enforce per-endpoint authorization.
 *
 * @module security/rbac
 * @since E1.3 (2026-03-14)
 */

import type { TenantRole } from '../api/tenantKeyRegistry.js';

export type Permission =
  | 'receipts:write'
  | 'receipts:read'
  | 'accounting:read'
  | 'admin:flush'
  | 'admin:chain-head'
  | 'admin:tal-summary'
  | 'admin:keys'
  | 'admin:tenants'
  | 'admin:flags'
  | 'admin:dead-letters'
  | 'admin:gdpr'
  | 'admin:billing';  // BILL-05: billing cycle access

/** Canonical permission matrix (ADR-0206 + S1.5/S1.6 + NEW-6.01 + W7-C extensions). */
const ROLE_PERMISSIONS: Record<TenantRole, ReadonlySet<Permission>> = {
  OWNER: new Set([
    'receipts:write', 'receipts:read', 'accounting:read',
    'admin:flush', 'admin:chain-head', 'admin:tal-summary', 'admin:keys',
    'admin:tenants', 'admin:flags', 'admin:dead-letters', 'admin:gdpr',
    'admin:billing',
  ]),
  ADMIN: new Set([
    'receipts:write', 'receipts:read', 'accounting:read',
    'admin:flush', 'admin:chain-head', 'admin:tal-summary',
    'admin:tenants', 'admin:flags', 'admin:dead-letters',
    'admin:billing',
  ]),
  OPERATOR: new Set([
    'receipts:write', 'receipts:read', 'accounting:read',
    'admin:flush', 'admin:chain-head', 'admin:tal-summary',
    'admin:dead-letters',
  ]),
  MEMBER: new Set([
    'receipts:write', 'receipts:read', 'accounting:read',
  ]),
  VIEWER: new Set([
    'receipts:read', 'accounting:read',
  ]),
};

/**
 * Returns true if the given role has the requested permission.
 * Unknown roles always return false.
 */
export function hasPermission(role: TenantRole, permission: Permission): boolean {
  return (ROLE_PERMISSIONS[role] as Set<Permission> | undefined)?.has(permission) ?? false;
}
