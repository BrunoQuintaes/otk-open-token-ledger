/**
 * RedisTAL — Redis-backed Token Accounting Layer for shared state
 *
 * Extends the in-memory TAL with Redis persistence for multi-instance deployments.
 * When Redis is available, debits are atomically written to both in-memory and Redis.
 * Balance queries check Redis for the distributed total.
 *
 * Fallback: when Redis is unavailable, degrades to in-memory-only (Phase 1 behavior).
 *
 * Key schema: otk:tal:{tenantId}:{epochId} → hash { totalCU, entryCount, m:<requestId> = CU }
 *
 * @module security/RedisTAL
 * @since S3.3 (Wave 1 Pack 4)
 */

import { TokenAccountingLayer, type TALEntry, type TALBalance, type ReconcileResult } from './TokenAccountingLayer.js';

/** Redis TAL configuration */
export interface RedisTALConfig {
  /** Key prefix (default: 'otk:tal:') */
  keyPrefix?: string;
  /** TTL for TAL keys in seconds (default: 604800 = 7 days) */
  ttlSeconds?: number;
  /** Fallback to in-memory on Redis error (default: true) */
  fallbackOnError?: boolean;
}

/**
 * KEYS[1] = tal hash, KEYS[2] = legacy idempotency marker (pre-RV30-04 layout, read only);
 * ARGV[1] = CU, ARGV[2] = TTL seconds, ARGV[3] = requestId.
 * Returns 1 when the debit was applied, 0 for a duplicate requestId.
 *
 * RV30-04: the deduplication marker is a field `m:<requestId>` of the SAME hash as the
 * aggregate, so it can never expire while the aggregate still includes its debit
 * (identity_retention_ge_aggregate_retention@1). Before, the marker was a separate key with its
 * own TTL while every later debit renewed the aggregate: a replay after the marker expired
 * added A again (100 + 200 + 100 = 400). A marker written by the old layout still counts as
 * "already applied" while it lives (it never outlives its aggregate in that layout).
 */
const DEBIT_SCRIPT = `
local f = 'm:' .. ARGV[3]
if redis.call('HEXISTS', KEYS[1], f) == 1 or redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
redis.call('HSET', KEYS[1], f, ARGV[1])
redis.call('HINCRBY', KEYS[1], 'totalCU', ARGV[1])
redis.call('HINCRBY', KEYS[1], 'entryCount', 1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2]))
return 1`;

/** Bound of the in-process pending projections (review LOW). */
const MAX_PENDING_PROJECTIONS = 10_000;

const DEFAULT_CONFIG = {
  keyPrefix: 'otk:tal:',
  ttlSeconds: 604800, // 7 days
  fallbackOnError: true,
};

/**
 * Redis-backed TAL that extends the in-memory TokenAccountingLayer.
 *
 * Usage:
 *   const tal = new RedisTAL(redisClient);
 *   await tal.debitAsync(entry);
 *   const balance = await tal.balanceAsync(tenantId, epochId);
 */
export class RedisTAL {
  private readonly _local: TokenAccountingLayer;
  private readonly _redis: any; // IORedis client or null
  private readonly _config: Required<RedisTALConfig>;
  private _available = false;

  constructor(redisClient: any | null, config?: RedisTALConfig) {
    this._local = new TokenAccountingLayer();
    this._redis = redisClient;
    this._config = { ...DEFAULT_CONFIG, ...config } as Required<RedisTALConfig>;
    this._available = !!redisClient;
  }

  /**
   * Whether Redis is being used for shared state.
   *
   * @returns `true` when a Redis client was given at construction.
   */
  get isDistributed(): boolean {
    return this._available;
  }

  /**
   * Redis key for a tenant+epoch pair.
   *
   * @param tenantId - Tenant ID.
   * @param epochId - Epoch ID.
   */
  private _key(tenantId: string, epochId: string): string {
    return `${this._config.keyPrefix}${tenantId}:${epochId}`;
  }

  /**
   * RV30-02: debits whose Redis write failed in this process, replayed (idempotently, by
   * requestId) before the next write and by flushPending(). This covers transient failures of
   * a live process only; a durable source is required across restarts: with PostgreSQL the
   * ledger + outbox effect `project_redis` (src/operations) re-project them from any instance.
   */
  private readonly _pending = new Map<string, TALEntry>();

  private _droppedProjections = 0;
  /**
   * Pending projections dropped by the in-process bound (durable source: the PG outbox).
   *
   * @returns Count since construction.
   */
  get droppedProjections(): number {
    return this._droppedProjections;
  }

  /**
   * Number of debits waiting to be re-projected into Redis by this process.
   *
   * @returns Pending debit count.
   */
  get pendingProjection(): number {
    return this._pending.size;
  }

  private async _evalDebit(entry: TALEntry): Promise<void> {
    const key = this._key(entry.tenantId, entry.epochId);
    await this._redis.eval(DEBIT_SCRIPT, 2, key, `${key}:req:${entry.requestId}`, String(entry.cu), String(this._config.ttlSeconds), entry.requestId);
  }

  /**
   * Replay pending projections in insertion order; stops at the first failure.
   *
   * @returns The number of debits still pending when Redis is not configured, otherwise 0 (on success).
   * @throws {Error} The first Redis error (the remaining debits stay pending).
   */
  async flushPending(): Promise<number> {
    if (!this._available || !this._redis) return this._pending.size;
    for (const [id, e] of [...this._pending]) {
      await this._evalDebit(e);
      this._pending.delete(id);
    }
    return 0;
  }

  /**
   * Record a CU debit. Writes to both local TAL and Redis (if available).
   * Idempotent by requestId within (tenantId, epochId). A Redis failure is logged and the
   * debit stays pending in this process (RV30-02) instead of being forgotten.
   *
   * @param entry - Debit to record (copied into the local ledger).
   * @throws {Error} A Redis error, only when `fallbackOnError` is `false`.
   */
  async debitAsync(entry: TALEntry): Promise<void> {
    // Always write to local TAL (fast, non-blocking)
    this._local.debit(entry);

    if (this._available && this._redis) {
      const id = `${entry.tenantId}|${entry.epochId}|${entry.requestId}`;
      this._pending.set(id, entry);
      if (this._pending.size > MAX_PENDING_PROJECTIONS) {
        // bounded memory while Redis stays down; with PostgreSQL the outbox still re-projects it
        const oldest = this._pending.keys().next().value;
        if (oldest !== undefined) this._pending.delete(oldest);
        this._droppedProjections++;
      }
      try {
        await this.flushPending();
      } catch (err) {
        if (!this._config.fallbackOnError) throw err;
        process.stderr.write(JSON.stringify({
          event: 'redis_tal_debit_error',
          error: err instanceof Error ? err.message : String(err),
          tenantId: entry.tenantId,
          pendingProjection: this._pending.size,
          ts: Date.now(),
        }) + '\n');
      }
    }
  }

  /**
   * Projection write for the durable outbox (effect `project_redis`): applies the debit to
   * Redis or throws, so the effect stays pending and is retried by any instance. Idempotent.
   *
   * @param entry - Debit to record.
   * @throws {Error} When Redis is not configured or the Redis write fails.
   */
  async debitStrict(entry: TALEntry): Promise<void> {
    this._local.debit(entry);
    if (!this._available || !this._redis) throw new Error('redis TAL not available');
    await this._evalDebit(entry);
    this._pending.delete(`${entry.tenantId}|${entry.epochId}|${entry.requestId}`);
  }

  /**
   * Local (process memory) debit only. In PostgreSQL mode the durable outbox effect
   * `project_redis` is the single writer of the Redis projection; a second, fire-and-forget
   * writer could re-add a debit after the aggregate was dropped (observed, D7-G08 test).
   *
   * @param entry - Debit to record in process memory.
   */
  debitLocal(entry: TALEntry): void {
    this._local.debit(entry);
  }

  /**
   * Synchronous debit (for backward compatibility with existing callers).
   * Only writes to local TAL — Redis write is fire-and-forget.
   *
   * @param entry - Debit to record.
   */
  debit(entry: TALEntry): void {
    this._local.debit(entry);
    if (this._available && this._redis) {
      this.debitAsync(entry).catch(() => { /* fire-and-forget */ });
    }
  }

  /**
   * Get balance from Redis (distributed total) or local TAL (fallback).
   *
   * @param tenantId - Tenant ID.
   * @param epochId - Epoch ID.
   * @returns The Redis aggregate when present, else the local one (also on a Redis error).
   */
  async balanceAsync(tenantId: string, epochId: string): Promise<TALBalance> {
    if (this._available && this._redis) {
      try {
        const key = this._key(tenantId, epochId);
        // HMGET: the hash also holds one marker field per debit (RV30-04)
        const [totalCU, entryCount]: Array<string | null> = await this._redis.hmget(key, 'totalCU', 'entryCount');
        if (totalCU !== null && totalCU !== undefined) {
          return {
            tenantId,
            epochId,
            totalCU: BigInt(totalCU || '0'),
            entryCount: parseInt(entryCount || '0', 10),
          };
        }
      } catch {
        // fallback to local
      }
    }
    return this._local.balance(tenantId, epochId);
  }

  /**
   * Synchronous balance (local TAL only — for backward compat).
   *
   * @param tenantId - Tenant ID.
   * @param epochId - Epoch ID.
   * @returns The local aggregate.
   */
  balance(tenantId: string, epochId: string): TALBalance {
    return this._local.balance(tenantId, epochId);
  }

  /**
   * Entries from local TAL (Redis doesn't store individual entries).
   *
   * @param tenantId - Tenant ID.
   * @param epochId - Epoch ID.
   * @returns The local entries of that tenant and epoch.
   */
  entries(tenantId: string, epochId: string): ReadonlyArray<TALEntry> {
    return this._local.entries(tenantId, epochId);
  }

  /**
   * Reconcile (local TAL).
   *
   * @param tenantId - Tenant ID.
   * @param epochId - Epoch ID.
   * @param onChainCU - CU total submitted on-chain.
   * @returns See `TokenAccountingLayer.reconcile`.
   */
  reconcile(tenantId: string, epochId: string, onChainCU: bigint): ReconcileResult {
    return this._local.reconcile(tenantId, epochId, onChainCU);
  }

  /**
   * Total entries in local ledger.
   *
   * @returns Number of local entries, all tenants.
   */
  size(): number {
    return this._local.size();
  }
}
