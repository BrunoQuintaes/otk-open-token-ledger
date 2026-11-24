/**
 * RB-057 — Multi-tenant isolation (minimum)
 *
 * Defines canonical TenantContext and helpers to ensure tenantId is always present
 * at enterprise boundaries (router/gateway/policy/pricing).
 *
 * Pure helpers only — no I/O.
 *
 * @module security/TenantIsolation
 * @since RB-057
 */

export type TenantId = string;

export type TenantContext = {
  tenantId: TenantId;
  userId?: string;
};

export function requireTenantId(ctx: Partial<TenantContext>): TenantContext {
  if (!ctx.tenantId || String(ctx.tenantId).trim().length === 0) {
    throw new Error('TenantIsolation: tenantId is required');
  }
  return { tenantId: String(ctx.tenantId), ...(ctx.userId ? { userId: ctx.userId } : {}) };
}

/** Helper to build namespaced keys (e.g., cache keys, billing buckets) */
export function ns(tenantId: TenantId, key: string): string {
  return `${tenantId}::${key}`;
}
