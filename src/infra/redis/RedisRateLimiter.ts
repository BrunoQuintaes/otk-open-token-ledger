/**
 * RedisRateLimiter — Redis-backed IDistributedRateLimiter (Wave 3A)
 *
 * Sliding window rate limiter using Redis sorted sets.
 * Cross-instance safe: all API pods share the same counters.
 *
 * Key pattern: otk:rl:{key}
 *
 * Algorithm:
 * 1. ZREMRANGEBYSCORE to prune expired entries
 * 2. ZADD to record current request
 * 3. ZCARD to count active entries
 * 4. EXPIRE to auto-cleanup abandoned keys
 *
 * @module infra/redis/RedisRateLimiter
 * @since Wave 3A (PACK 3A-01)
 */

import type { IDistributedRateLimiter, RateLimitConfig, RateLimitDecision } from '../../security/IDistributedRateLimiter.js';
import type { RedisClient } from './redisClient.js';

const KEY_PREFIX = 'rl:';

export class RedisRateLimiter implements IDistributedRateLimiter {
  private readonly _redis: RedisClient;

  constructor(redis: RedisClient) {
    this._redis = redis;
  }

  async check(key: string, config: RateLimitConfig): Promise<RateLimitDecision> {
    const raw = this._redis.rawClient;
    if (!raw) {
      // Graceful degradation: allow all if Redis unavailable
      return { allowed: true, remaining: config.maxRequests };
    }

    const fullKey = `${this._redis.prefix}${KEY_PREFIX}${key}`;
    const now = Date.now();
    const windowMs = config.windowSeconds * 1000;
    const cutoff = now - windowMs;
    // Unique member: timestamp + random suffix to avoid collisions
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

    try {
      const pipeline = raw.pipeline();
      pipeline.zremrangebyscore(fullKey, '-inf', cutoff);
      pipeline.zadd(fullKey, now, member);
      pipeline.zcard(fullKey);
      pipeline.expire(fullKey, config.windowSeconds + 1);
      const results = await pipeline.exec();

      // results[2] is ZCARD result: [err, count]
      const count = (results?.[2]?.[1] as number) ?? 0;

      if (count > config.maxRequests) {
        // Over limit — remove the entry we just added
        await raw.zrem(fullKey, member).catch(() => {});
        // Estimate retry-after from oldest entry
        const oldest = await raw.zrangebyscore(fullKey, cutoff, '+inf', 'LIMIT', 0, 1).catch(() => []);
        const oldestTs = oldest?.length ? parseFloat(oldest[0].split(':')[0]) : now;
        const retryAfterMs = Math.max(0, oldestTs + windowMs - now);
        return { allowed: false, remaining: 0, retryAfterMs };
      }

      return { allowed: true, remaining: config.maxRequests - count };
    } catch {
      // Graceful degradation: allow on Redis error
      return { allowed: true, remaining: config.maxRequests };
    }
  }

  async reset(key: string): Promise<void> {
    const raw = this._redis.rawClient;
    if (!raw) return;
    try {
      await raw.del(`${this._redis.prefix}${KEY_PREFIX}${key}`);
    } catch { /* non-fatal */ }
  }

  async clear(): Promise<void> {
    // No-op for Redis: keys auto-expire. Full clear would require SCAN which is expensive.
  }
}
