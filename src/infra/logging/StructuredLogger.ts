/**
 * StructuredLogger — JSON structured logging with secret masking (E1.1)
 *
 * Replaces ad-hoc console.log with structured JSON output on stderr.
 * Shape: { level, message, timestamp, service, correlationId?, tenantId?, ...extra }
 *
 * Design constraints:
 * - NEVER leaks secrets (sensitive fields are masked)
 * - Injectable output sink (for testing / custom transports)
 * - Zero external deps — only node builtins
 * - Levels: debug, info, warn, error
 *
 * @module infra/logging/StructuredLogger
 * @since Wave 1 Pack 7 (E1.1)
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

/** Numeric priority (higher = more severe). */
const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

/** Fields whose values will be masked in output. */
const SENSITIVE_FIELDS: ReadonlySet<string> = new Set([
  'password',
  'secret',
  'token',
  'apiKey',
  'api_key',
  'authorization',
  'mnemonic',
  'privateKey',
  'private_key',
  'credential',
  'credentials',
]);

const MASK = '***REDACTED***';

export interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  service: string;
  requestId?: string;
  correlationId?: string;
  tenantId?: string;
  [key: string]: unknown;
}

/**
 * Output sink — receives the serialized JSON line.
 * Default: process.stderr.write.
 */
export type LogSink = (line: string) => void;

export interface StructuredLoggerOptions {
  /** Service name included in every entry */
  service: string;
  /** Minimum level to emit (default: 'debug') */
  minLevel?: LogLevel;
  /** Custom output sink (default: stderr) */
  sink?: LogSink;
  /** Request ID from X-Request-Id header */
  requestId?: string;
  /** Correlation ID attached to every entry */
  correlationId?: string;
  /** Tenant ID attached to every entry */
  tenantId?: string;
}

/**
 * Structured JSON logger.
 *
 * Usage:
 *   const log = createLogger('api-server');
 *   log.info('request received', { method: 'POST', path: '/receipts' });
 */
export class StructuredLogger {
  private readonly service: string;
  private readonly minLevel: LogLevel;
  private readonly sink: LogSink;
  private requestId?: string;
  private correlationId?: string;
  private tenantId?: string;

  constructor(options: StructuredLoggerOptions) {
    this.service = options.service;
    this.minLevel = options.minLevel ?? 'debug';
    this.sink = options.sink ?? defaultStderrSink;
    this.requestId = options.requestId;
    this.correlationId = options.correlationId;
    this.tenantId = options.tenantId;
  }

  debug(message: string, extra?: Record<string, unknown>): void {
    this._log('debug', message, extra);
  }

  info(message: string, extra?: Record<string, unknown>): void {
    this._log('info', message, extra);
  }

  warn(message: string, extra?: Record<string, unknown>): void {
    this._log('warn', message, extra);
  }

  error(message: string, extra?: Record<string, unknown>): void {
    this._log('error', message, extra);
  }

  /** Update request ID (e.g., from X-Request-Id header). */
  setRequestId(id: string | undefined): void {
    this.requestId = id;
  }

  /** Update correlation ID (e.g., per-request). */
  setCorrelationId(id: string | undefined): void {
    this.correlationId = id;
  }

  /** Update tenant ID (e.g., after auth resolution). */
  setTenantId(id: string | undefined): void {
    this.tenantId = id;
  }

  /**
   * Create a child logger that inherits service/sink/level but may override
   * correlationId and tenantId.
   */
  child(overrides: { requestId?: string; correlationId?: string; tenantId?: string }): StructuredLogger {
    return new StructuredLogger({
      service: this.service,
      minLevel: this.minLevel,
      sink: this.sink,
      requestId: overrides.requestId ?? this.requestId,
      correlationId: overrides.correlationId ?? this.correlationId,
      tenantId: overrides.tenantId ?? this.tenantId,
    });
  }

  // ── Internal ────────────────────────────────────────────────

  private _log(level: LogLevel, message: string, extra?: Record<string, unknown>): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[this.minLevel]) return;

    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      service: this.service,
    };

    if (this.requestId) entry.requestId = this.requestId;
    if (this.correlationId) entry.correlationId = this.correlationId;
    if (this.tenantId) entry.tenantId = this.tenantId;

    if (extra) {
      const masked = maskSensitiveFields(extra);
      Object.assign(entry, masked);
    }

    this.sink(JSON.stringify(entry) + '\n');
  }
}

// ── Masking ─────────────────────────────────────────────────

/**
 * Deep-clone an object, replacing values of sensitive keys with MASK.
 */
export function maskSensitiveFields(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (SENSITIVE_FIELDS.has(key)) {
      result[key] = MASK;
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      result[key] = maskSensitiveFields(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

// ── Default sink ────────────────────────────────────────────

function defaultStderrSink(line: string): void {
  process.stderr.write(line);
}

// ── Factory & Singleton ─────────────────────────────────────

let _singleton: StructuredLogger | undefined;

/**
 * Create a new StructuredLogger instance.
 */
export function createLogger(service: string, options?: Omit<StructuredLoggerOptions, 'service'>): StructuredLogger {
  return new StructuredLogger({ service, ...options });
}

/**
 * Get or create the process-level singleton logger.
 * Service defaults to 'otk-metering'.
 */
export function getLogger(): StructuredLogger {
  if (!_singleton) {
    _singleton = createLogger('otk-metering');
  }
  return _singleton;
}

/**
 * Reset the singleton (for testing only).
 */
export function resetLoggerForTest(): void {
  _singleton = undefined;
}
