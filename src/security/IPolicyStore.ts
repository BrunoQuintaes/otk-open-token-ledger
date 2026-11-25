/**
 * H2.4 — Policy Store Interface
 *
 * Storage for per-tenant policy definitions.
 * PolicyEngine evaluator functions remain pure — this adds persistence.
 *
 * @module security/IPolicyStore
 * @since Wave 2H (H2.4)
 */

import type { QuotaPolicy, RateLimitPolicy, SLAPolicy } from './PolicyEngine.js';

/**
 * Any policy kind that can be stored per tenant.
 */
export type StoredPolicy = QuotaPolicy | RateLimitPolicy | SLAPolicy;

/**
 * Storage backend for per-tenant policies (one policy per tenant and policy type).
 */
export interface IPolicyStore {
  getPolicy(tenantId: string, type: string): Promise<StoredPolicy | null>;
  setPolicy(tenantId: string, policy: StoredPolicy): Promise<void>;
  listPolicies(tenantId: string): Promise<StoredPolicy[]>;
  deletePolicy(tenantId: string, type: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory policy store (default fallback). */
export class MemoryPolicyStore implements IPolicyStore {
  private _store = new Map<string, StoredPolicy>();

  private key(tenantId: string, type: string): string { return `${tenantId}::${type}`; }

  /**
   * Reads the tenant's policy of one type.
   *
   * @param tenantId - Tenant ID.
   * @param type - Policy type (`quota`, `rate_limit` or `sla`).
   * @returns The policy, or `null` when none is stored.
   */
  async getPolicy(tenantId: string, type: string): Promise<StoredPolicy | null> {
    return this._store.get(this.key(tenantId, type)) ?? null;
  }

  /**
   * Stores (or replaces) the tenant's policy of `policy.type`.
   *
   * @param tenantId - Tenant ID.
   * @param policy - Policy to store (by reference).
   */
  async setPolicy(tenantId: string, policy: StoredPolicy): Promise<void> {
    this._store.set(this.key(tenantId, policy.type), policy);
  }

  /**
   * Lists every policy of a tenant.
   *
   * @param tenantId - Tenant ID.
   * @returns The tenant's policies, in insertion order.
   */
  async listPolicies(tenantId: string): Promise<StoredPolicy[]> {
    const result: StoredPolicy[] = [];
    for (const [k, v] of this._store) {
      if (k.startsWith(`${tenantId}::`)) result.push(v);
    }
    return result;
  }

  /**
   * Deletes the tenant's policy of one type (no error when absent).
   *
   * @param tenantId - Tenant ID.
   * @param type - Policy type.
   */
  async deletePolicy(tenantId: string, type: string): Promise<void> {
    this._store.delete(this.key(tenantId, type));
  }

  /**
   * Deletes every stored policy.
   */
  async clear(): Promise<void> {
    this._store.clear();
  }
}

// Singleton
let _store: IPolicyStore = new MemoryPolicyStore();

/**
 * Returns the process-wide policy store.
 *
 * @returns The current store (in-memory unless replaced).
 */
export function getPolicyStore(): IPolicyStore { return _store; }
/**
 * Replaces the process-wide policy store.
 *
 * @param store - New backend; existing policies are not copied.
 */
export function setPolicyStore(store: IPolicyStore): void { _store = store; }
/**
 * Restores an empty in-memory policy store (tests only).
 */
export function resetPolicyStoreForTest(): void { _store = new MemoryPolicyStore(); }
