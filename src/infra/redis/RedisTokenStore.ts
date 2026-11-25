/**
 * RedisTokenStore — Redis-backed ITokenStore (Wave 3A)
 *
 * Stores bearer token entries in Redis for cross-instance token resolution.
 * Key pattern: otk:token:{hash} → JSON (TokenEntry)
 *
 * Entries are keyed by the token's hash (the token itself is never stored here) and have no expiry. Errors and a
 * disconnected client are swallowed: a failed `revoke` leaves the entry in Redis without telling the caller.
 *
 * @module src/infra/redis/RedisTokenStore
 * @since Wave 3A (PACK 3A-03)
 */

import type { ITokenStore, TokenEntry } from '../../api/ITokenStore.js';
import type { RedisClient } from './redisClient.js';

const KEY_PREFIX = 'token:';
const SCAN_PATTERN_SUFFIX = 'token:*';

/** `ITokenStore` stored in Redis, one key per token hash. */
export class RedisTokenStore implements ITokenStore {
  private readonly _redis: RedisClient;

  /**
   * Wraps the shared Redis client; nothing is read or written here.
   *
   * @param redis - Shared Redis client wrapper (prefix and raw client).
   */
  constructor(redis: RedisClient) {
    this._redis = redis;
  }

  private _key(tokenHash: string): string {
    return `${this._redis.prefix}${KEY_PREFIX}${tokenHash}`;
  }

  /**
   * Stores (replaces) the entry of a token hash.
   *
   * @param tokenHash - Hash of the token.
   * @param entry - Tenant and metadata of the token.
   */
  async register(tokenHash: string, entry: TokenEntry): Promise<void> {
    const raw = this._redis.rawClient;
    if (!raw) return;
    try {
      await raw.set(this._key(tokenHash), JSON.stringify(entry));
    } catch {
      // non-fatal: memory store fallback active upstream
    }
  }

  /**
   * Looks up a token hash.
   *
   * @param tokenHash - Hash of the token.
   * @returns The entry, or null when absent, unavailable or unreadable.
   */
  async resolve(tokenHash: string): Promise<TokenEntry | null> {
    const raw = this._redis.rawClient;
    if (!raw) return null;
    try {
      const data = await raw.get(this._key(tokenHash));
      if (!data) return null;
      return JSON.parse(data) as TokenEntry;
    } catch {
      return null;
    }
  }

  /**
   * Deletes the entry of a token hash (errors are swallowed).
   *
   * @param tokenHash - Hash of the token.
   */
  async revoke(tokenHash: string): Promise<void> {
    const raw = this._redis.rawClient;
    if (!raw) return;
    try {
      await raw.del(this._key(tokenHash));
    } catch {
      // non-fatal
    }
  }

  /** Deletes every token key under the client prefix (destructive; used by tests). */
  async clear(): Promise<void> {
    const raw = this._redis.rawClient;
    if (!raw) return;
    try {
      // SCAN to avoid blocking large keysets
      const pattern = `${this._redis.prefix}${SCAN_PATTERN_SUFFIX}`;
      let cursor = '0';
      do {
        const [nextCursor, keys] = await raw.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          await raw.del(...keys);
        }
      } while (cursor !== '0');
    } catch {
      // non-fatal
    }
  }
}
