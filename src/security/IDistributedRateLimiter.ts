/**
 * H4.1 — Distributed Rate Limiter Interface
 *
 * Sliding window rate limiter that works across multiple instances.
 * Memory impl for single-instance, Redis impl for multi-instance.
 *
 * @module security/IDistributedRateLimiter
 * @since Wave 2H (H4.1)
 */

/**
 * Result of one rate-limit check.
 */
export interface RateLimitDecision {
  allowed: boolean;
  /** Requests still allowed in the current window (0 when refused). */
  remaining: number;
  /** Milliseconds until a request may be allowed again; present only when refused. */
  retryAfterMs?: number;
}

/**
 * Sliding-window limit: at most `maxRequests` requests in any `windowSeconds`-second window.
 */
export interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
}

/**
 * Rate limiter backend shared by all instances (memory for one instance, Redis for several).
 */
export interface IDistributedRateLimiter {
  check(key: string, config: RateLimitConfig): Promise<RateLimitDecision>;
  reset(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory sliding window (single-instance, default). */
export class MemoryDistributedRateLimiter implements IDistributedRateLimiter {
  private _windows = new Map<string, number[]>();

  /**
   * Checks a key and, when allowed, records the request now.
   *
   * @param key - Limiter key (e.g. tenant or source).
   * @param config - Window and limit.
   * @returns The decision; a refused request is not recorded.
   */
  async check(key: string, config: RateLimitConfig): Promise<RateLimitDecision> {
    const now = Date.now();
    const windowMs = config.windowSeconds * 1000;
    const cutoff = now - windowMs;

    let timestamps = this._windows.get(key) ?? [];
    timestamps = timestamps.filter(t => t > cutoff);

    if (timestamps.length >= config.maxRequests) {
      const oldestInWindow = timestamps[0];
      const retryAfterMs = oldestInWindow + windowMs - now;
      this._windows.set(key, timestamps);
      return { allowed: false, remaining: 0, retryAfterMs: Math.max(0, retryAfterMs) };
    }

    timestamps.push(now);
    this._windows.set(key, timestamps);
    return { allowed: true, remaining: config.maxRequests - timestamps.length };
  }

  /**
   * Forgets the history of one key.
   *
   * @param key - Limiter key.
   */
  async reset(key: string): Promise<void> {
    this._windows.delete(key);
  }

  /**
   * Forgets the history of every key.
   */
  async clear(): Promise<void> {
    this._windows.clear();
  }
}

let _limiter: IDistributedRateLimiter = new MemoryDistributedRateLimiter();
/**
 * Returns the process-wide rate limiter.
 *
 * @returns The current limiter (in-memory unless replaced).
 */
export function getDistributedRateLimiter(): IDistributedRateLimiter { return _limiter; }
/**
 * Replaces the process-wide rate limiter.
 *
 * @param l - New backend.
 */
export function setDistributedRateLimiter(l: IDistributedRateLimiter): void { _limiter = l; }
/**
 * Restores an empty in-memory limiter (tests only).
 */
export function resetDistributedRateLimiterForTest(): void { _limiter = new MemoryDistributedRateLimiter(); }
