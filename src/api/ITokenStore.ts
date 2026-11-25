/**
 * H2.7 — Token Store Interface
 *
 * Storage backend for bearer token → tenant context resolution.
 * TenantKeyRegistry delegates lookups to this store.
 * Future: Redis for cross-instance token resolution.
 *
 * Holds the storage contract, the in-memory default and the process-wide holder. `src/api/apiKeyManager.ts`
 * registers and revokes dynamic keys here; `src/infra/storeBootstrap.ts` installs the Redis store when Redis
 * is configured. Keys are looked up by their SHA-256 hash; the raw token is never stored.
 *
 * @module src/api/ITokenStore
 * @since Wave 2H (H2.7)
 */

/** Tenant context resolved from a token hash. */
export interface TokenEntry {
  /** Tenant the token belongs to. */
  tenantId: string;
  /** Role name granted to the token (a `TenantRole` value, stored as a plain string). */
  role: string;
  /** ISO-8601 registration timestamp (UTC). */
  registeredAt: string;
}

/** Storage contract mapping a token hash to its tenant context. */
export interface ITokenStore {
  /** Associates `tokenHash` with `entry`, replacing any previous entry. */
  register(tokenHash: string, entry: TokenEntry): Promise<void>;
  /** Returns the entry for `tokenHash`, or `null` when unknown or revoked. */
  resolve(tokenHash: string): Promise<TokenEntry | null>;
  /** Removes the entry for `tokenHash`; no-op when unknown. */
  revoke(tokenHash: string): Promise<void>;
  /** Removes every entry (tests and resets). */
  clear(): Promise<void>;
}

/** In-memory token store (default). */
/** In-memory token store (default). Lost on restart and not shared between replicas. */
export class MemoryTokenStore implements ITokenStore {
  private _map = new Map<string, TokenEntry>();

  /**
   * Stores the entry under the hash.
   *
   * @param tokenHash - SHA-256 hash of the raw token.
   * @param entry - Tenant context to associate.
   */
  async register(tokenHash: string, entry: TokenEntry): Promise<void> {
    this._map.set(tokenHash, entry);
  }

  /**
   * Looks up a token hash.
   *
   * @param tokenHash - SHA-256 hash of the raw token.
   * @returns The entry, or `null` when unknown.
   */
  async resolve(tokenHash: string): Promise<TokenEntry | null> {
    return this._map.get(tokenHash) ?? null;
  }

  /**
   * Deletes the entry for the hash.
   *
   * @param tokenHash - SHA-256 hash of the raw token; unknown hashes are ignored.
   */
  async revoke(tokenHash: string): Promise<void> {
    this._map.delete(tokenHash);
  }

  /** Removes every entry. */
  async clear(): Promise<void> {
    this._map.clear();
  }
}

let _store: ITokenStore = new MemoryTokenStore();
/**
 * Returns the process-wide token store.
 *
 * @returns The current store (in-memory unless `setTokenStore` replaced it).
 */
export function getTokenStore(): ITokenStore { return _store; }
/**
 * Replaces the process-wide token store (store bootstrap and tests).
 *
 * @param store - The store every later `getTokenStore` call returns.
 */
export function setTokenStore(store: ITokenStore): void { _store = store; }
/** Resets the process-wide store to a fresh in-memory one (tests only). */
export function resetTokenStoreForTest(): void { _store = new MemoryTokenStore(); }
