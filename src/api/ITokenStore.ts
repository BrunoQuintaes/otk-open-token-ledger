/**
 * H2.7 — Token Store Interface
 *
 * Storage backend for bearer token → tenant context resolution.
 * TenantKeyRegistry delegates lookups to this store.
 * Future: Redis for cross-instance token resolution.
 *
 * @module api/ITokenStore
 * @since Wave 2H (H2.7)
 */

export interface TokenEntry {
  tenantId: string;
  role: string;
  registeredAt: string;
}

export interface ITokenStore {
  register(tokenHash: string, entry: TokenEntry): Promise<void>;
  resolve(tokenHash: string): Promise<TokenEntry | null>;
  revoke(tokenHash: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory token store (default). */
export class MemoryTokenStore implements ITokenStore {
  private _map = new Map<string, TokenEntry>();

  async register(tokenHash: string, entry: TokenEntry): Promise<void> {
    this._map.set(tokenHash, entry);
  }

  async resolve(tokenHash: string): Promise<TokenEntry | null> {
    return this._map.get(tokenHash) ?? null;
  }

  async revoke(tokenHash: string): Promise<void> {
    this._map.delete(tokenHash);
  }

  async clear(): Promise<void> {
    this._map.clear();
  }
}

let _store: ITokenStore = new MemoryTokenStore();
export function getTokenStore(): ITokenStore { return _store; }
export function setTokenStore(store: ITokenStore): void { _store = store; }
export function resetTokenStoreForTest(): void { _store = new MemoryTokenStore(); }
