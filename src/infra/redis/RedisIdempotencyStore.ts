/**
 * RedisIdempotencyStore — Redis-backed IIdempotencyStore (Wave 3A)
 *
 * Stores idempotency keys in Redis with TTL.
 * Cross-instance safe: all API pods share the same Redis store.
 *
 * Key pattern: otk:idemp:{key}
 *
 * @module infra/redis/RedisIdempotencyStore
 * @since Wave 3A (PACK 3A-01)
 */

import type { IIdempotencyStore, CachedResponse } from '../../api/idempotency.js';
import type { RedisClient } from './redisClient.js';

const KEY_PREFIX = 'idemp:';

export class RedisIdempotencyStore implements IIdempotencyStore {
  private readonly _redis: RedisClient;

  constructor(redis: RedisClient) {
    this._redis = redis;
  }

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
