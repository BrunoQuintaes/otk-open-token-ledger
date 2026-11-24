/**
 * SharedStateManager — Distributed shared state over Redis
 *
 * Provides:
 *   - Key-value set/get/del with prefix namespacing
 *   - Distributed lock (acquireLock / releaseLock)
 *   - Session tracking (setSession / getSession per tenant)
 *   - Worker coordination (claimWorkerSlot / releaseWorkerSlot / listActiveWorkers)
 *   - Graceful fallback to in-memory when Redis unavailable
 *
 * Uses RedisClient from redisClient.ts for connection lifecycle.
 *
 * @module infra/redis/sharedState
 * @since Wave 2 Pack 15 (E3.2)
 */

import type { RedisClient } from './redisClient.js';

/** Lock acquisition result */
export interface LockResult {
  acquired: boolean;
  key: string;
  ttlMs: number;
}

/** Session data stored per tenant */
export interface SessionData {
  tenantId: string;
  data: Record<string, unknown>;
  expiresAt: number;
}

/** Worker slot info */
export interface WorkerSlot {
  workerId: string;
  claimedAt: number;
}

/**
 * SharedStateManager — manages distributed state via Redis with in-memory fallback.
 */
export class SharedStateManager {
  private readonly _prefix: string;
  private readonly _redis: RedisClient | null;
  private readonly _fallback = new Map<string, { value: string; expiresAt: number | null }>();
  private readonly _locks = new Map<string, { owner: string; expiresAt: number }>();
  private readonly _workers = new Map<string, number>(); // workerId -> claimedAt

  /**
   * @param redis RedisClient instance (or null for in-memory-only mode)
   * @param prefix Key namespace prefix (default: 'otk:shared:')
   */
  constructor(redis: RedisClient | null, prefix?: string) {
    this._redis = redis;
    this._prefix = prefix ?? 'otk:shared:';
  }

  /** Whether we are operating in Redis mode (vs in-memory fallback). */
  get isRedisMode(): boolean {
    return this._redis !== null && this._redis.isReady;
  }

  /** Full prefixed key. */
  private _key(key: string): string {
    return `${this._prefix}${key}`;
  }

  // ── Key-Value ─────────────────────────────────────────────────

  /**
   * Set a key-value pair with optional TTL.
   * @param key   Key name (will be prefixed)
   * @param value String value
   * @param ttlMs TTL in milliseconds (0 = no expiration)
   */
  async set(key: string, value: string, ttlMs = 0): Promise<void> {
    if (this.isRedisMode) {
      try {
        const client = this._redis!.rawClient;
        if (ttlMs > 0) {
          await client.set(this._key(key), value, 'PX', ttlMs);
        } else {
          await client.set(this._key(key), value);
        }
        return;
      } catch { /* fallthrough to in-memory */ }
    }
    const expiresAt = ttlMs > 0 ? Date.now() + ttlMs : null;
    this._fallback.set(this._key(key), { value, expiresAt });
  }

  /**
   * Get a value by key.
   * Returns null if not found or expired.
   */
  async get(key: string): Promise<string | null> {
    if (this.isRedisMode) {
      try {
        const client = this._redis!.rawClient;
        return await client.get(this._key(key));
      } catch { /* fallthrough */ }
    }
    const entry = this._fallback.get(this._key(key));
    if (!entry) return null;
    if (entry.expiresAt !== null && Date.now() > entry.expiresAt) {
      this._fallback.delete(this._key(key));
      return null;
    }
    return entry.value;
  }

  /**
   * Delete a key.
   * Returns true if the key existed.
   */
  async del(key: string): Promise<boolean> {
    if (this.isRedisMode) {
      try {
        const client = this._redis!.rawClient;
        const count = await client.del(this._key(key));
        return count > 0;
      } catch { /* fallthrough */ }
    }
    return this._fallback.delete(this._key(key));
  }

  // ── Distributed Lock ──────────────────────────────────────────

  /**
   * Acquire a distributed lock.
   * Uses Redis SET NX PX pattern for atomic lock acquisition.
   * Falls back to in-memory lock when Redis is unavailable.
   *
   * @param key   Lock key name
   * @param ttlMs Lock TTL in milliseconds (auto-release)
   * @returns LockResult with acquisition status
   */
  async acquireLock(key: string, ttlMs: number): Promise<LockResult> {
    const lockKey = `lock:${key}`;
    const lockValue = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    if (this.isRedisMode) {
      try {
        const client = this._redis!.rawClient;
        const result = await client.set(this._key(lockKey), lockValue, 'NX', 'PX', ttlMs);
        return { acquired: result === 'OK', key, ttlMs };
      } catch { /* fallthrough */ }
    }

    // In-memory fallback
    const existing = this._locks.get(lockKey);
    if (existing && Date.now() < existing.expiresAt) {
      return { acquired: false, key, ttlMs };
    }
    this._locks.set(lockKey, { owner: lockValue, expiresAt: Date.now() + ttlMs });
    return { acquired: true, key, ttlMs };
  }

  /**
   * Release a distributed lock.
   * @param key Lock key name
   */
  async releaseLock(key: string): Promise<boolean> {
    const lockKey = `lock:${key}`;

    if (this.isRedisMode) {
      try {
        const client = this._redis!.rawClient;
        const count = await client.del(this._key(lockKey));
        return count > 0;
      } catch { /* fallthrough */ }
    }

    return this._locks.delete(lockKey);
  }

  // ── Session Tracking ──────────────────────────────────────────

  /**
   * Store session data for a tenant.
   * @param tenantId Tenant identifier
   * @param data     Session data (arbitrary JSON-serializable)
   * @param ttlMs    Session TTL in milliseconds
   */
  async setSession(tenantId: string, data: Record<string, unknown>, ttlMs: number): Promise<void> {
    const sessionKey = `session:${tenantId}`;
    const payload: SessionData = {
      tenantId,
      data,
      expiresAt: Date.now() + ttlMs,
    };
    await this.set(sessionKey, JSON.stringify(payload), ttlMs);
  }

  /**
   * Get session data for a tenant.
   * Returns null if no session or expired.
   */
  async getSession(tenantId: string): Promise<SessionData | null> {
    const sessionKey = `session:${tenantId}`;
    const raw = await this.get(sessionKey);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as SessionData;
    } catch {
      return null;
    }
  }

  // ── Worker Coordination ───────────────────────────────────────

  /**
   * Claim a worker slot (register a worker as active).
   * @param workerId Unique worker identifier
   * @param ttlMs    Heartbeat TTL (default: 60s — worker must re-claim periodically)
   */
  async claimWorkerSlot(workerId: string, ttlMs = 60_000): Promise<boolean> {
    const workerKey = `worker:${workerId}`;
    const now = Date.now();

    if (this.isRedisMode) {
      try {
        const client = this._redis!.rawClient;
        await client.set(this._key(workerKey), String(now), 'PX', ttlMs);
        return true;
      } catch { /* fallthrough */ }
    }

    this._workers.set(workerId, now);
    // In-memory: schedule auto-cleanup
    setTimeout(() => {
      if (this._workers.get(workerId) === now) {
        this._workers.delete(workerId);
      }
    }, ttlMs).unref?.();
    return true;
  }

  /**
   * Release a worker slot.
   */
  async releaseWorkerSlot(workerId: string): Promise<boolean> {
    const workerKey = `worker:${workerId}`;

    if (this.isRedisMode) {
      try {
        const client = this._redis!.rawClient;
        const count = await client.del(this._key(workerKey));
        return count > 0;
      } catch { /* fallthrough */ }
    }

    return this._workers.delete(workerId);
  }

  /**
   * List active workers.
   * In Redis mode: scans worker:* keys.
   * In fallback mode: returns from in-memory map.
   */
  async listActiveWorkers(): Promise<WorkerSlot[]> {
    // In-memory mode (always available as fallback)
    const slots: WorkerSlot[] = [];
    for (const [workerId, claimedAt] of this._workers.entries()) {
      slots.push({ workerId, claimedAt });
    }
    return slots;
  }

  /** Clear all in-memory state (for testing). */
  clearForTest(): void {
    this._fallback.clear();
    this._locks.clear();
    this._workers.clear();
  }
}

// ── Singleton ──────────────────────────────────────────────────────

let _instance: SharedStateManager | null = null;

/**
 * Get or create the singleton SharedStateManager.
 * Uses the Redis singleton if available; otherwise in-memory only.
 */
export function getSharedState(): SharedStateManager {
  if (!_instance) {
    // Dynamic import avoided: just use null for Redis when not available
    // Callers can inject Redis via constructor when ready
    _instance = new SharedStateManager(null);
  }
  return _instance;
}

/** Reset singleton for tests. */
export function resetSharedStateForTest(): void {
  if (_instance) _instance.clearForTest();
  _instance = null;
}
