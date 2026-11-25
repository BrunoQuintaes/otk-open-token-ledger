/**
 * AuthorityBoundary — Cross-Tenant Access Prevention (AUTHORITY_BOUNDARY_SPEC)
 *
 * Enforces that operations on tenant data cannot be performed by actors
 * belonging to a different tenant. This is the primary guard against
 * cross-tenant data leakage in the OTK enterprise deployment.
 *
 * Authority model (from AUTHORITY_BOUNDARY_SPEC.md):
 *   - Provider: declares token counts — trusted within oracle model
 *   - OTK Runtime: computes CU, signs receipts, generates proofs
 *   - Tenant boundary: enforced here — tenant A cannot read/modify tenant B
 *
 * All checks are pure functions (no I/O, no side effects).
 * The caller is responsible for passing the correct context.
 *
 * @module security/AuthorityBoundary
 * @since U12.POST-CLAIM-CLOSURE (AUTHORITY_BOUNDARY_SPEC)
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Who is acting, on which tenant's resource, and what operation is attempted.
 */
export type BoundaryContext = {
  /** The tenant performing the operation */
  actorTenantId: string;
  /** The tenant that owns the resource being accessed */
  resourceTenantId: string;
  /** The operation being attempted (for audit log) */
  operation: string;
};

/**
 * Result of {@link checkTenantBoundary}: allowed, or refused with a reason and the context.
 */
export type BoundaryResult =
  | { allowed: true }
  | { allowed: false; reason: string; context: BoundaryContext };

// ---------------------------------------------------------------------------
// Core checks
// ---------------------------------------------------------------------------

/**
 * Assert that the actor tenant matches the resource tenant.
 * This is the primary cross-tenant isolation check.
 *
 * @example
 * const result = checkTenantBoundary({
 *   actorTenantId: apiKey.tenantId,
 *   resourceTenantId: receipt.tenantId,
 *   operation: 'read_receipt',
 * });
 * if (!result.allowed) throw new Error(result.reason);
 * @param ctx - Actor tenant, resource tenant and operation (not modified).
 * @returns `allowed: true` only when both tenant IDs are non-blank and exactly equal.
 */
export function checkTenantBoundary(ctx: BoundaryContext): BoundaryResult {
  if (!ctx.actorTenantId || ctx.actorTenantId.trim() === '') {
    return { allowed: false, reason: 'actorTenantId is required', context: ctx };
  }
  if (!ctx.resourceTenantId || ctx.resourceTenantId.trim() === '') {
    return { allowed: false, reason: 'resourceTenantId is required', context: ctx };
  }
  if (ctx.actorTenantId !== ctx.resourceTenantId) {
    return {
      allowed: false,
      reason: `Cross-tenant access denied: actor "${ctx.actorTenantId}" cannot access resource of tenant "${ctx.resourceTenantId}" (operation: ${ctx.operation})`,
      context: ctx,
    };
  }
  return { allowed: true };
}

/**
 * Assert — throws if boundary check fails.
 * Use at entry points (API route handlers, service methods).
 *
 * @param ctx - Actor tenant, resource tenant and operation.
 * @throws {@link AuthorityBoundaryError} When {@link checkTenantBoundary} refuses the access.
 */
export function assertTenantBoundary(ctx: BoundaryContext): void {
  const result = checkTenantBoundary(ctx);
  if (!result.allowed) {
    throw new AuthorityBoundaryError(result.reason, result.context);
  }
}

// ---------------------------------------------------------------------------
// System actor bypass (for internal OTK runtime operations)
// ---------------------------------------------------------------------------

const SYSTEM_TENANT_ID = '__otk_system__';

/**
 * Create a context for system-level operations that bypass tenant checks.
 * Only for internal OTK runtime use (ProverDaemon, BatchAggregator).
 * Never expose this to external callers.
 *
 * @param _resourceTenantId - Ignored: both actor and resource are set to the system tenant, so the
 *   context always passes {@link checkTenantBoundary}.
 * @param operation - Operation label for logs.
 * @returns A context for the reserved system tenant.
 */
export function systemContext(_resourceTenantId: string, operation: string): BoundaryContext {
  return {
    actorTenantId: SYSTEM_TENANT_ID,
    resourceTenantId: SYSTEM_TENANT_ID,  // system acts on behalf of itself
    operation,
  };
}

/**
 * Tells whether a tenant ID is the reserved system tenant.
 *
 * @param actorTenantId - Tenant ID to test.
 * @returns `true` for the system tenant.
 */
export function isSystemActor(actorTenantId: string): boolean {
  return actorTenantId === SYSTEM_TENANT_ID;
}

// ---------------------------------------------------------------------------
// Error class
// ---------------------------------------------------------------------------

/**
 * Raised by {@link assertTenantBoundary}; `context` holds the refused access.
 */
export class AuthorityBoundaryError extends Error {
  public readonly context: BoundaryContext;

  constructor(message: string, context: BoundaryContext) {
    super(message);
    this.name = 'AuthorityBoundaryError';
    this.context = context;
  }
}
