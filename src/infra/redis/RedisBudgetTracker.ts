/**
 * RedisBudgetTracker — Redis-backed IBudgetTracker (Wave 3A)
 *
 * Tracks spend per tenant per epoch in Redis for cross-instance budget enforcement.
 * Key patterns:
 *   otk:budget:spend:{tenantId}:{epochId} → bigint string
 *   otk:budget:policy:{tenantId}          → JSON (BudgetPolicy)
 *
 * Uses INCRBY for atomic spend accumulation.
 * BigInt values stored as decimal strings.
 *
 * Keys start with the client's configured prefix (`otk:` above). Errors are swallowed: when Redis is not connected
 * or a command fails, writes are lost silently and reads return 0n / null, so a budget check fails open.
 *
 * @module src/infra/redis/RedisBudgetTracker
 * @since Wave 3A (PACK 3A-03)
 */

import type { IBudgetTracker } from '../../economics/IBudgetTracker.js';
import type { BudgetPolicy } from '../../economics/CostAlertEngine.js';
import type { RedisClient } from './redisClient.js';

const SPEND_PREFIX = 'budget:spend:';
const POLICY_PREFIX = 'budget:policy:';

/** `IBudgetTracker` stored in Redis; see the module comment for the failure behaviour. */
export class RedisBudgetTracker implements IBudgetTracker {
  private readonly _redis: RedisClient;

  /**
   * Wraps the shared Redis client; nothing is read or written here.
   *
   * @param redis - Shared Redis client wrapper (prefix and raw client).
   */
  constructor(redis: RedisClient) {
    this._redis = redis;
  }

  private _spendKey(tenantId: string, epochId: string): string {
    return `${this._redis.prefix}${SPEND_PREFIX}${tenantId}:${epochId}`;
  }

  private _policyKey(tenantId: string): string {
    return `${this._redis.prefix}${POLICY_PREFIX}${tenantId}`;
  }

  /**
   * Adds CU to the tenant's spend (Redis INCRBY; no expiry is set on the key).
   *
   * @param tenantId - Tenant.
   * @param epochId - Accounting epoch.
   * @param cuAmount - CU to add.
   */
  async recordSpend(tenantId: string, epochId: string, cuAmount: bigint): Promise<void> {
    const raw = this._redis.rawClient;
    if (!raw) return;
    try {
      // INCRBY stores as integer string — safe for bigint semantics
      await raw.incrby(this._spendKey(tenantId, epochId), cuAmount.toString());
    } catch {
      // non-fatal
    }
  }

  /**
   * Reads the tenant's spend in one epoch.
   *
   * @param tenantId - Tenant.
   * @param epochId - Accounting epoch.
   * @returns CU spent; 0n when absent, when Redis is unavailable or on error.
   */
  async getCurrentSpend(tenantId: string, epochId: string): Promise<bigint> {
    const raw = this._redis.rawClient;
    if (!raw) return 0n;
    try {
      const val = await raw.get(this._spendKey(tenantId, epochId));
      if (!val) return 0n;
      return BigInt(val);
    } catch {
      return 0n;
    }
  }

  /**
   * Reads the tenant's budget policy.
   *
   * @param tenantId - Tenant.
   * @returns The policy, or null when absent, unavailable or unreadable.
   */
  async getBudget(tenantId: string): Promise<BudgetPolicy | null> {
    const raw = this._redis.rawClient;
    if (!raw) return null;
    try {
      const data = await raw.get(this._policyKey(tenantId));
      if (!data) return null;
      const parsed = JSON.parse(data) as { maxCU: string; warnPct: number; criticalPct: number };
      return {
        maxCU: BigInt(parsed.maxCU),
        warnPct: parsed.warnPct,
        criticalPct: parsed.criticalPct,
      };
    } catch {
      return null;
    }
  }

  /**
   * Stores the tenant's budget policy (`maxCU` as a decimal string).
   *
   * @param tenantId - Tenant.
   * @param policy - Policy to store.
   */
  async setBudget(tenantId: string, policy: BudgetPolicy): Promise<void> {
    const raw = this._redis.rawClient;
    if (!raw) return;
    try {
      // Serialize bigint as string for JSON
      const serializable = {
        maxCU: policy.maxCU.toString(),
        warnPct: policy.warnPct,
        criticalPct: policy.criticalPct,
      };
      await raw.set(this._policyKey(tenantId), JSON.stringify(serializable));
    } catch {
      // non-fatal
    }
  }

  /** Deletes every `budget:*` key under the client prefix, for all tenants (destructive; used by tests). */
  async clear(): Promise<void> {
    const raw = this._redis.rawClient;
    if (!raw) return;
    try {
      const pattern = `${this._redis.prefix}budget:*`;
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
