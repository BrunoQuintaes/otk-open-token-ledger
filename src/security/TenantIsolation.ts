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

/**
 * Tenant identifier (non-empty string at enterprise boundaries).
 */
export type TenantId = string;

/**
 * Tenant (required) and optional user of a request.
 */
export type TenantContext = {
  tenantId: TenantId;
  userId?: string;
};

/**
 * Checks that a context names a tenant and returns a clean copy.
 *
 * @param ctx - Partial context.
 * @returns A new context with `tenantId` (and `userId` only when truthy).
 * @throws {Error} When `tenantId` is missing or blank.
 */
export function requireTenantId(ctx: Partial<TenantContext>): TenantContext {
  if (!ctx.tenantId || String(ctx.tenantId).trim().length === 0) {
    throw new Error('TenantIsolation: tenantId is required');
  }
  return { tenantId: String(ctx.tenantId), ...(ctx.userId ? { userId: ctx.userId } : {}) };
}

/**
 * Helper to build namespaced keys (e.g., cache keys, billing buckets)
 *
 * Note: the parts are joined with `::` without escaping, so a tenant ID that contains `::` can collide with
 * another tenant's namespace.
 *
 * @param tenantId - Tenant ID.
 * @param key - Key inside the tenant's namespace.
 * @returns `<tenantId>::<key>`.
 */
export function ns(tenantId: TenantId, key: string): string {
  return `${tenantId}::${key}`;
}
