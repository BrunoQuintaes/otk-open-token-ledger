/**
 * RedisIdempotencyStore — Redis-backed IIdempotencyStore (Wave 3A)
 *
 * Stores idempotency keys in Redis with TTL.
 * Cross-instance safe: all API pods share the same Redis store.
 *
 * Key pattern: otk:idemp:{key}
 *
 * Errors and a disconnected client are treated as "no cached response" (the request is then processed again).
 *
 * @module src/infra/redis/RedisIdempotencyStore
 * @since Wave 3A (PACK 3A-01)
 */

import type { IIdempotencyStore, CachedResponse } from '../../api/idempotency.js';
import type { RedisClient } from './redisClient.js';

const KEY_PREFIX = 'idemp:';

/** `IIdempotencyStore` stored in Redis with a TTL per key. */
export class RedisIdempotencyStore implements IIdempotencyStore {
  private readonly _redis: RedisClient;

  /**
   * Wraps the shared Redis client; nothing is read or written here.
   *
   * @param redis - Shared Redis client wrapper (prefix and raw client).
   */
  constructor(redis: RedisClient) {
    this._redis = redis;
  }

  /**
   * Reads the cached response of an idempotency key.
   *
   * @param key - Idempotency key as given by the caller's scope.
   * @returns The cached response, or null when absent, unavailable or unreadable.
   */
  async get(key: string): Promise<CachedResponse | null> {
    const raw = this._redis.rawClient;
    if (!raw) return null;
    try {
      const data = await raw.get(`${this._redis.prefix}${KEY_PREFIX}${key}`);
      if (!data) return null;
      return JSON.parse(data) as CachedResponse;
    } catch {
      return null; // graceful degradation
    }
  }

  /**
   * Stores the response of an idempotency key with an expiry.
   *
   * @param key - Idempotency key.
   * @param response - Response to replay later.
   * @param ttlS - Time to live in seconds.
   */
  async set(key: string, response: CachedResponse, ttlS: number): Promise<void> {
    const raw = this._redis.rawClient;
    if (!raw) return;
    try {
      const fullKey = `${this._redis.prefix}${KEY_PREFIX}${key}`;
      await raw.set(fullKey, JSON.stringify(response), 'EX', ttlS);
    } catch {
      // non-fatal: next request will just proceed as new
    }
  }
}
