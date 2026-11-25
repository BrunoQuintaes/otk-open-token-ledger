/**
 * IApiKeyMetadataStore — interface for API key metadata persistence (NEW-3.06)
 *
 * Stores key metadata (public info only — never the raw secret).
 * The raw key is returned only once at creation time.
 *
 * Defines the storage contract for the metadata of dynamic (tenant-created) API keys, plus the in-memory
 * default implementation and a process-wide holder (`getApiKeyMetadataStore` / `setApiKeyMetadataStore`).
 * Used by `src/api/apiKeyManager.ts`, `src/api/routes.ts` and `src/auth/authMiddleware.ts`; the store
 * bootstrap (`src/infra/storeBootstrap.ts`) swaps in a persistent implementation at startup.
 *
 * It does NOT hold raw keys or verify them: only the SHA-256 `tokenHash` is stored, and authentication
 * itself happens elsewhere.
 *
 * @module src/api/IApiKeyMetadataStore
 * @since Wave 3C (PACK 3C-01)
 */

import type { TenantRole } from './tenantKeyRegistry.js';

/** Public metadata of one dynamic API key; never contains the raw key. */
export interface ApiKeyMetadata {
  /** Unique key identifier (used in management routes; not secret). */
  keyId: string;
  /** Tenant that owns the key. */
  tenantId: string;
  /** Human-readable label chosen at creation. */
  label: string;
  prefix: string;          // first 8 chars of the key (for display)
  tokenHash: string;       // SHA-256 hash used for token store lookup
  /** Role granted to requests authenticated with this key. */
  role: TenantRole;
  /** ISO-8601 creation timestamp (UTC). */
  createdAt: string;
  /** ISO-8601 expiry timestamp; `null` means the key never expires. */
  expiresAt: string | null;
  /** ISO-8601 revocation timestamp; `null` means the key is active. */
  revokedAt: string | null;
  /** ISO-8601 timestamp of the last authenticated use; `null` means never used (or not recorded). */
  lastUsedAt: string | null;
  /**
   * H1 lane B (S05 residual): user id of the JWT that minted the key (signup/login users). null/absent = no user author
   * (registry token, dynamic key, JWT without userId, or a key minted before authorship was recorded). SCIM
   * deprovisioning revokes the keys whose author is the user; keys without author are never guessed.
   */
  createdBy?: string | null;
}

/**
 * Storage contract for API key metadata; implementations must never store the raw key.
 *
 * All methods are async so a database-backed implementation can be swapped in.
 */
export interface IApiKeyMetadataStore {
  /** Stores a new key's metadata (overwrites an entry with the same `keyId` in the in-memory store). */
  create(meta: ApiKeyMetadata): Promise<void>;
  /** Returns the metadata for `keyId` (revoked or not), or `null` when unknown. */
  get(keyId: string): Promise<ApiKeyMetadata | null>;
  /** Lists the tenant's active (not revoked) keys, newest first; `limit` defaults to 100 and `offset` to 0 in the in-memory store. */
  listByTenant(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<ApiKeyMetadata[]>;
  /** Active (not revoked) keys whose author is `userId` (H1 lane B, S05 residual). */
  listByCreator(userId: string): Promise<ApiKeyMetadata[]>;
  /** Marks the key revoked and returns the updated metadata; `null` when unknown or already revoked. */
  revoke(keyId: string): Promise<ApiKeyMetadata | null>;
  /**
   * H1R2 R-13: the key whose token hash is `tokenHash`, revoked or not (null when unknown). The authority consulted on
   * every request authenticated with a dynamic key (auth/credentialAuthority), so a revocation, rotation or creation
   * made on another replica is seen without a restart. Optional so that test doubles written before R-13 still compile.
   */
  getByHash?(tokenHash: string): Promise<ApiKeyMetadata | null>;
  /** Sets `lastUsedAt` to now for `keyId`; no-op when unknown. */
  updateLastUsed(keyId: string): Promise<void>;
  /** Sets `lastUsedAt` to now for the key whose hash is `tokenHash`; no-op when unknown. */
  updateLastUsedByHash(tokenHash: string): Promise<void>;
  /** Removes every entry (tests and resets). */
  clear(): Promise<void>;
}

/** In-memory implementation (default fallback). */
/**
 * In-memory implementation (default fallback).
 *
 * Lost on restart and not shared between replicas; used in tests and when no database is configured.
 */
export class MemoryApiKeyMetadataStore implements IApiKeyMetadataStore {
  private _map = new Map<string, ApiKeyMetadata>();

  /**
   * Stores the metadata under its `keyId`.
   *
   * @param meta - Metadata to store (kept by reference, not copied).
   */
  async create(meta: ApiKeyMetadata): Promise<void> {
    this._map.set(meta.keyId, meta);
  }

  /**
   * Looks up one key by id.
   *
   * @param keyId - Key identifier.
   * @returns The stored metadata, or `null` when unknown.
   */
  async get(keyId: string): Promise<ApiKeyMetadata | null> {
    return this._map.get(keyId) ?? null;
  }

  /**
   * Lists the tenant's active keys, newest first.
   *
   * @param tenantId - Tenant whose keys are listed.
   * @param opts - Paging: `limit` (default 100) and `offset` (default 0).
   * @returns Active (not revoked) keys of the tenant, sorted by `createdAt` descending.
   */
  async listByTenant(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<ApiKeyMetadata[]> {
    const all = [...this._map.values()]
      .filter(m => m.tenantId === tenantId && !m.revokedAt)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 100;
    return all.slice(offset, offset + limit);
  }

  /**
   * Lists the active keys minted by a user (used for SCIM deprovisioning).
   *
   * @param userId - User id recorded in `createdBy`.
   * @returns Active keys whose `createdBy` equals `userId`; keys without an author are never included.
   */
  async listByCreator(userId: string): Promise<ApiKeyMetadata[]> {
    return [...this._map.values()].filter(m => m.createdBy === userId && !m.revokedAt);
  }

  /**
   * Revokes a key by setting `revokedAt` to now.
   *
   * @param keyId - Key identifier.
   * @returns The updated metadata, or `null` when the key is unknown or already revoked.
   */
  async revoke(keyId: string): Promise<ApiKeyMetadata | null> {
    const meta = this._map.get(keyId);
    if (!meta || meta.revokedAt) return null;
    const updated = { ...meta, revokedAt: new Date().toISOString() };
    this._map.set(keyId, updated);
    return updated;
  }

  /**
   * Finds the key for a token hash, revoked or not.
   *
   * @param tokenHash - SHA-256 hash of the raw key.
   * @returns A copy of the matching metadata (a revoked match wins over an active one, then the newest), or `null`.
   */
  async getByHash(tokenHash: string): Promise<ApiKeyMetadata | null> {
    // same order as the PostgreSQL store: a revoked row for the hash wins (conservative), then the newest
    let found: ApiKeyMetadata | null = null;
    for (const m of this._map.values()) {
      if (m.tokenHash !== tokenHash) continue;
      if (!found || (!!m.revokedAt && !found.revokedAt) || (!!m.revokedAt === !!found.revokedAt && m.createdAt > found.createdAt)) found = m;
    }
    return found ? { ...found } : null;
  }

  /**
   * Records a use of the key now.
   *
   * @param keyId - Key identifier; unknown ids are ignored.
   */
  async updateLastUsed(keyId: string): Promise<void> {
    const meta = this._map.get(keyId);
    if (meta) {
      this._map.set(keyId, { ...meta, lastUsedAt: new Date().toISOString() });
    }
  }

  /**
   * Records a use of the key now, looked up by hash (first match only).
   *
   * @param tokenHash - SHA-256 hash of the raw key; unknown hashes are ignored.
   */
  async updateLastUsedByHash(tokenHash: string): Promise<void> {
    for (const [keyId, meta] of this._map) {
      if (meta.tokenHash === tokenHash) {
        this._map.set(keyId, { ...meta, lastUsedAt: new Date().toISOString() });
        return;
      }
    }
  }

  /** Removes every stored key. */
  async clear(): Promise<void> {
    this._map.clear();
  }
}

let _store: IApiKeyMetadataStore = new MemoryApiKeyMetadataStore();
/**
 * Returns the process-wide API key metadata store.
 *
 * @returns The current store (in-memory unless `setApiKeyMetadataStore` replaced it).
 */
export function getApiKeyMetadataStore(): IApiKeyMetadataStore { return _store; }
/**
 * Replaces the process-wide API key metadata store (called at startup by the store bootstrap and by tests).
 *
 * @param store - The store every later `getApiKeyMetadataStore` call returns.
 */
export function setApiKeyMetadataStore(store: IApiKeyMetadataStore): void { _store = store; }
/** Resets the process-wide store to a fresh in-memory one (tests only). */
export function resetApiKeyMetadataStoreForTest(): void { _store = new MemoryApiKeyMetadataStore(); }
