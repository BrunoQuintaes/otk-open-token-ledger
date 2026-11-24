/**
 * Redis Client — Hardened connection lifecycle for OTK
 *
 * Provides a centralized, reusable Redis connection with:
 * - Health checks (PING-based)
 * - Reconnect with exponential backoff
 * - Startup readiness gate
 * - No secret leakage in logs
 * - Graceful shutdown
 * - Circuit breaker for unavailability
 *
 * @module infra/redis/redisClient
 * @since S3.1 (Wave 1 Pack 2)
 */

import { EventEmitter } from 'node:events';

/**
 * Redis client configuration.
 * Designed for IORedis-compatible clients, but abstracted for testability.
 */
export interface RedisConfig {
  /** Redis URL (e.g. redis://localhost:6379). Required. */
  url: string;
  /** Connection timeout in ms (default: 5000) */
  connectTimeoutMs?: number;
  /** Command timeout in ms (default: 3000) */
  commandTimeoutMs?: number;
  /** Max reconnect attempts before giving up (default: 20) */
  maxReconnectAttempts?: number;
  /** Initial backoff delay in ms for reconnect (default: 500) */
  reconnectBackoffMs?: number;
  /** Maximum backoff delay in ms (default: 30000) */
  maxBackoffMs?: number;
  /** Health check interval in ms (default: 15000) */
  healthCheckIntervalMs?: number;
  /** Key prefix for all keys (default: 'otk:') */
  keyPrefix?: string;
  /** Max memory policy hint (for documentation / validation only) */
  maxMemoryPolicy?: string;
}

export interface RedisHealthStatus {
  connected: boolean;
  lastPingMs: number | null;
  lastPingAt: string | null;
  reconnectAttempts: number;
  circuitOpen: boolean;
  uptimeMs: number;
}

const DEFAULT_CONFIG: Required<Omit<RedisConfig, 'url'>> = {
  connectTimeoutMs: 5000,
  commandTimeoutMs: 3000,
  maxReconnectAttempts: 20,
  reconnectBackoffMs: 500,
  maxBackoffMs: 30000,
  healthCheckIntervalMs: 15000,
  keyPrefix: 'otk:',
  maxMemoryPolicy: 'noeviction',
};

/**
 * Hardened Redis client wrapper.
 * Manages connection lifecycle, health monitoring, and reconnection.
 */
export class RedisClient extends EventEmitter {
  private readonly config: Required<RedisConfig>;
  private _connected = false;
  private _circuitOpen = false;
  private _reconnectAttempts = 0;
  private _lastPingMs: number | null = null;
  private _lastPingAt: string | null = null;
  private _startTime = Date.now();
  private _healthTimer: ReturnType<typeof setInterval> | null = null;
  private _client: any = null; // IORedis instance (lazy)
  private _closing = false;

  constructor(config: RedisConfig) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<RedisConfig>;
  }

  /** Masked URL for logging (hides password if present). */
  get maskedUrl(): string {
    try {
      const u = new URL(this.config.url);
      if (u.password) u.password = '***';
      return u.toString();
    } catch {
      return '<invalid-url>';
    }
  }

  /** Current health status (safe to expose in admin endpoints). */
  health(): RedisHealthStatus {
    return {
      connected: this._connected,
      lastPingMs: this._lastPingMs,
      lastPingAt: this._lastPingAt,
      reconnectAttempts: this._reconnectAttempts,
      circuitOpen: this._circuitOpen,
      uptimeMs: Date.now() - this._startTime,
    };
  }

  /** Whether the client is connected and healthy. */
  get isReady(): boolean {
    return this._connected && !this._circuitOpen;
  }

  /**
   * Connect to Redis.
   * Returns true on success. On failure, logs (no secret leakage) and returns false.
   * Does NOT throw — callers can proceed without Redis in Phase 1 fallback mode.
   */
  async connect(): Promise<boolean> {
    if (this._client && this._connected) return true;

    try {
      // Dynamic import of ioredis — fails gracefully if not installed
      const { default: IORedis } = await import('ioredis');

      this._client = new IORedis(this.config.url, {
        connectTimeout: this.config.connectTimeoutMs,
        commandTimeout: this.config.commandTimeoutMs,
        maxRetriesPerRequest: null, // BullMQ v5 requirement
        retryStrategy: (times: number) => {
          if (times > this.config.maxReconnectAttempts) {
            this._circuitOpen = true;
            this._connected = false;
            this._log('error', 'max reconnect attempts reached — circuit open');
            return null; // stop retrying
          }
          this._reconnectAttempts = times;
          const delay = Math.min(
            this.config.reconnectBackoffMs * Math.pow(2, times - 1),
            this.config.maxBackoffMs,
          );
          this._log('warn', `reconnecting attempt ${times}/${this.config.maxReconnectAttempts} in ${delay}ms`);
          return delay;
        },
        lazyConnect: true,
      });

      // Wire events
      this._client.on('connect', () => {
        this._connected = true;
        this._circuitOpen = false;
        this._reconnectAttempts = 0;
        this._log('info', 'connected');
        this.emit('connected');
      });

      this._client.on('close', () => {
        if (!this._closing) {
          this._connected = false;
          this._log('warn', 'connection closed');
          this.emit('disconnected');
        }
      });

      this._client.on('error', (err: Error) => {
        // Log but don't expose connection details
        this._log('error', `client error: ${err.message}`);
        // C-F02 (D1–D8 run 20260930-1625): an 'error' event without a listener is thrown by
        // Node and terminated the whole API when Redis dropped a connection (same class as N12
        // for the PG pool). It is logged above; re-emit only to code that subscribed.
        if (this.listenerCount('error') > 0) this.emit('error', err);
      });

      await this._client.connect();
      this._connected = true;
      this._circuitOpen = false;

      // Start health check loop
      this._startHealthCheck();

      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._log('error', `connection failed: ${msg}`);
      this._connected = false;
      return false;
    }
  }

  /**
   * Execute a PING health check.
   * Returns latency in ms or null on failure.
   */
  async ping(): Promise<number | null> {
    if (!this._client || !this._connected) return null;
    try {
      const start = Date.now();
      const result = await this._client.ping();
      const latency = Date.now() - start;
      if (result === 'PONG') {
        this._lastPingMs = latency;
        this._lastPingAt = new Date().toISOString();
        return latency;
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Get the raw IORedis client (for BullMQ or direct use). Null if not connected. */
  get rawClient(): any {
    return this._client;
  }

  /** Get the Redis URL (for BullMQ connection config). */
  get url(): string {
    return this.config.url;
  }

  /** Key prefix for namespacing. */
  get prefix(): string {
    return this.config.keyPrefix;
  }

  /** Graceful shutdown. */
  async close(): Promise<void> {
    this._closing = true;
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    if (this._client) {
      try {
        await this._client.quit();
      } catch {
        try { this._client.disconnect(); } catch { /* force close */ }
      }
    }
    this._connected = false;
    this._log('info', 'closed');
  }

  private _startHealthCheck(): void {
    if (this._healthTimer) clearInterval(this._healthTimer);
    this._healthTimer = setInterval(async () => {
      const latency = await this.ping();
      if (latency === null && this._connected) {
        this._log('warn', 'health check failed');
      }
    }, this.config.healthCheckIntervalMs);
    // Don't keep process alive just for health checks
    if (this._healthTimer && typeof this._healthTimer === 'object' && 'unref' in this._healthTimer) {
      (this._healthTimer as NodeJS.Timeout).unref();
    }
  }

  private _log(level: string, message: string): void {
    const entry = {
      event: 'redis',
      level,
      message,
      url: this.maskedUrl,
      ts: Date.now(),
    };
    process.stderr.write(JSON.stringify(entry) + '\n');
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let _instance: RedisClient | null = null;

/**
 * Get or create the singleton Redis client.
 * Uses OTK_REDIS_URL env var. Returns null if URL is not configured.
 */
export function getRedisClient(): RedisClient | null {
  const url = process.env['OTK_REDIS_URL'];
  if (!url) return null;
  if (!_instance) {
    _instance = new RedisClient({
      url,
      connectTimeoutMs: Number(process.env['OTK_REDIS_CONNECT_TIMEOUT'] ?? 5000),
      commandTimeoutMs: Number(process.env['OTK_REDIS_COMMAND_TIMEOUT'] ?? 3000),
      maxReconnectAttempts: Number(process.env['OTK_REDIS_MAX_RECONNECT'] ?? 20),
      healthCheckIntervalMs: Number(process.env['OTK_REDIS_HEALTH_INTERVAL'] ?? 15000),
    });
  }
  return _instance;
}

/**
 * Initialize Redis connection (call at server startup).
 * Returns true if connected, false if Redis is unavailable or not configured.
 * Non-fatal: the system can run in Phase 1 mode without Redis.
 */
export async function initRedis(): Promise<boolean> {
  const client = getRedisClient();
  if (!client) return false;
  return client.connect();
}

/**
 * Gracefully close Redis connection (call at server shutdown).
 */
export async function closeRedis(): Promise<void> {
  if (_instance) {
    await _instance.close();
    _instance = null;
  }
}

/** Reset singleton for tests. */
export function resetRedisForTest(): void {
  _instance = null;
}
