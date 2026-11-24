/**
 * IApiKeyMetadataStore — interface for API key metadata persistence (NEW-3.06)
 *
 * Stores key metadata (public info only — never the raw secret).
 * The raw key is returned only once at creation time.
 *
 * @module api/IApiKeyMetadataStore
 * @since Wave 3C (PACK 3C-01)
 */

import type { TenantRole } from './tenantKeyRegistry.js';

export interface ApiKeyMetadata {
  keyId: string;
  tenantId: string;
  label: string;
  prefix: string;          // first 8 chars of the key (for display)
  tokenHash: string;       // SHA-256 hash used for token store lookup
  role: TenantRole;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  /**
   * H1 lane B (S05 residual): user id of the JWT that minted the key (signup/login users). null/absent = no user author
   * (registry token, dynamic key, JWT without userId, or a key minted before authorship was recorded). SCIM
   * deprovisioning revokes the keys whose author is the user; keys without author are never guessed.
   */
  createdBy?: string | null;
}

export interface IApiKeyMetadataStore {
  create(meta: ApiKeyMetadata): Promise<void>;
  get(keyId: string): Promise<ApiKeyMetadata | null>;
  listByTenant(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<ApiKeyMetadata[]>;
  /** Active (not revoked) keys whose author is `userId` (H1 lane B, S05 residual). */
  listByCreator(userId: string): Promise<ApiKeyMetadata[]>;
  revoke(keyId: string): Promise<ApiKeyMetadata | null>;
  /**
   * H1R2 R-13: the key whose token hash is `tokenHash`, revoked or not (null when unknown). The authority consulted on
   * every request authenticated with a dynamic key (auth/credentialAuthority), so a revocation, rotation or creation
   * made on another replica is seen without a restart. Optional so that test doubles written before R-13 still compile.
   */
  getByHash?(tokenHash: string): Promise<ApiKeyMetadata | null>;
  updateLastUsed(keyId: string): Promise<void>;
  updateLastUsedByHash(tokenHash: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory implementation (default fallback). */
export class MemoryApiKeyMetadataStore implements IApiKeyMetadataStore {
  private _map = new Map<string, ApiKeyMetadata>();

  async create(meta: ApiKeyMetadata): Promise<void> {
    this._map.set(meta.keyId, meta);
  }

  async get(keyId: string): Promise<ApiKeyMetadata | null> {
    return this._map.get(keyId) ?? null;
  }

  async listByTenant(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<ApiKeyMetadata[]> {
    const all = [...this._map.values()]
      .filter(m => m.tenantId === tenantId && !m.revokedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 100;
    return all.slice(offset, offset + limit);
  }

  async listByCreator(userId: string): Promise<ApiKeyMetadata[]> {
    return [...this._map.values()].filter(m => m.createdBy === userId && !m.revokedAt);
  }

  async revoke(keyId: string): Promise<ApiKeyMetadata | null> {
    const meta = this._map.get(keyId);
    if (!meta || meta.revokedAt) return null;
    const updated = { ...meta, revokedAt: new Date().toISOString() };
    this._map.set(keyId, updated);
    return updated;
  }

  async getByHash(tokenHash: string): Promise<ApiKeyMetadata | null> {
    // same order as the PostgreSQL store: a revoked row for the hash wins (conservative), then the newest
    let found: ApiKeyMetadata | null = null;
    for (const m of this._map.values()) {
      if (m.tokenHash !== tokenHash) continue;
      if (!found || (!!m.revokedAt && !found.revokedAt) || (!!m.revokedAt === !!found.revokedAt && m.createdAt > found.createdAt)) found = m;
    }
    return found ? { ...found } : null;
  }

  async updateLastUsed(keyId: string): Promise<void> {
    const meta = this._map.get(keyId);
    if (meta) {
      this._map.set(keyId, { ...meta, lastUsedAt: new Date().toISOString() });
    }
  }

  async updateLastUsedByHash(tokenHash: string): Promise<void> {
    for (const [keyId, meta] of this._map) {
      if (meta.tokenHash === tokenHash) {
        this._map.set(keyId, { ...meta, lastUsedAt: new Date().toISOString() });
        return;
      }
    }
  }

  async clear(): Promise<void> {
    this._map.clear();
  }
}

let _store: IApiKeyMetadataStore = new MemoryApiKeyMetadataStore();
export function getApiKeyMetadataStore(): IApiKeyMetadataStore { return _store; }
export function setApiKeyMetadataStore(store: IApiKeyMetadataStore): void { _store = store; }
export function resetApiKeyMetadataStoreForTest(): void { _store = new MemoryApiKeyMetadataStore(); }
