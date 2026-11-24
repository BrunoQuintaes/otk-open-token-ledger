/**
 * RedisPolicyStore — Redis-backed IPolicyStore (Wave 3A)
 *
 * Stores per-tenant policy definitions in Redis for cross-instance sharing.
 * Key pattern: otk:policy:{tenantId}:{type} → JSON (StoredPolicy)
 *
 * @module infra/redis/RedisPolicyStore
 * @since Wave 3A (PACK 3A-03)
 */

import type { IPolicyStore, StoredPolicy } from '../../security/IPolicyStore.js';
import type { RedisClient } from './redisClient.js';

const KEY_PREFIX = 'policy:';

export class RedisPolicyStore implements IPolicyStore {
  private readonly _redis: RedisClient;

  constructor(redis: RedisClient) {
    this._redis = redis;
  }

  private _key(tenantId: string, type: string): string {
    return `${this._redis.prefix}${KEY_PREFIX}${tenantId}:${type}`;
  }

  private _tenantPattern(tenantId: string): string {
    return `${this._redis.prefix}${KEY_PREFIX}${tenantId}:*`;
  }

  async getPolicy(tenantId: string, type: string): Promise<StoredPolicy | null> {
    const raw = this._redis.rawClient;
    if (!raw) return null;
    try {
      const data = await raw.get(this._key(tenantId, type));
      if (!data) return null;
      return this._deserialize(data);
    } catch {
      return null;
    }
  }

  /** Deserialize policy, restoring bigint fields (stored as "<value>n"). */
  private _deserialize(json: string): StoredPolicy {
    return JSON.parse(json, (_key, value) => {
      if (typeof value === 'string' && /^\d+n$/.test(value)) {
        return BigInt(value.slice(0, -1));
      }
      return value;
    }) as StoredPolicy;
  }

  async setPolicy(tenantId: string, policy: StoredPolicy): Promise<void> {
    const raw = this._redis.rawClient;
    if (!raw) return;
    try {
      // Serialize with bigint support (bigint → string in JSON)
      const serialized = JSON.stringify(policy, (_key, value) =>
        typeof value === 'bigint' ? value.toString() + 'n' : value,
      );
      await raw.set(this._key(tenantId, policy.type), serialized);
    } catch {
      // non-fatal
    }
  }

  async listPolicies(tenantId: string): Promise<StoredPolicy[]> {
    const raw = this._redis.rawClient;
    if (!raw) return [];
    try {
      const pattern = this._tenantPattern(tenantId);
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [nextCursor, found] = await raw.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        keys.push(...found);
      } while (cursor !== '0');

      if (keys.length === 0) return [];

      const values = await raw.mget(...keys);
      const result: StoredPolicy[] = [];
      for (const v of values) {
        if (v) {
          try { result.push(this._deserialize(v)); } catch { /* skip corrupt */ }
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  async deletePolicy(tenantId: string, type: string): Promise<void> {
    const raw = this._redis.rawClient;
    if (!raw) return;
    try {
      await raw.del(this._key(tenantId, type));
    } catch {
      // non-fatal
    }
  }

  async clear(): Promise<void> {
    const raw = this._redis.rawClient;
    if (!raw) return;
    try {
      const pattern = `${this._redis.prefix}${KEY_PREFIX}*`;
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
