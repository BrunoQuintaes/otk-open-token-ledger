/**
 * H4.1 — Distributed Rate Limiter Interface
 *
 * Sliding window rate limiter that works across multiple instances.
 * Memory impl for single-instance, Redis impl for multi-instance.
 *
 * @module security/IDistributedRateLimiter
 * @since Wave 2H (H4.1)
 */

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
}

export interface RateLimitConfig {
  windowSeconds: number;
  maxRequests: number;
}

export interface IDistributedRateLimiter {
  check(key: string, config: RateLimitConfig): Promise<RateLimitDecision>;
  reset(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** In-memory sliding window (single-instance, default). */
export class MemoryDistributedRateLimiter implements IDistributedRateLimiter {
  private _windows = new Map<string, number[]>();

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

  async reset(key: string): Promise<void> {
    this._windows.delete(key);
  }

  async clear(): Promise<void> {
    this._windows.clear();
  }
}

let _limiter: IDistributedRateLimiter = new MemoryDistributedRateLimiter();
export function getDistributedRateLimiter(): IDistributedRateLimiter { return _limiter; }
export function setDistributedRateLimiter(l: IDistributedRateLimiter): void { _limiter = l; }
export function resetDistributedRateLimiterForTest(): void { _limiter = new MemoryDistributedRateLimiter(); }
