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

export type StoredPolicy = QuotaPolicy | RateLimitPolicy | SLAPolicy;

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

  async getPolicy(tenantId: string, type: string): Promise<StoredPolicy | null> {
    return this._store.get(this.key(tenantId, type)) ?? null;
  }

  async setPolicy(tenantId: string, policy: StoredPolicy): Promise<void> {
    this._store.set(this.key(tenantId, policy.type), policy);
  }

  async listPolicies(tenantId: string): Promise<StoredPolicy[]> {
    const result: StoredPolicy[] = [];
    for (const [k, v] of this._store) {
      if (k.startsWith(`${tenantId}::`)) result.push(v);
    }
    return result;
  }

  async deletePolicy(tenantId: string, type: string): Promise<void> {
    this._store.delete(this.key(tenantId, type));
  }

  async clear(): Promise<void> {
    this._store.clear();
  }
}

// Singleton
let _store: IPolicyStore = new MemoryPolicyStore();

export function getPolicyStore(): IPolicyStore { return _store; }
export function setPolicyStore(store: IPolicyStore): void { _store = store; }
export function resetPolicyStoreForTest(): void { _store = new MemoryPolicyStore(); }
