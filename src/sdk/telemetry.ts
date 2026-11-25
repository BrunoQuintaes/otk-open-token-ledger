/**
 * SDK Telemetry — Anonymous opt-in usage telemetry (NEW-5.03 / W5-5D)
 *
 * Collects anonymous, aggregated SDK performance metrics:
 *   - Latency percentiles (p50, p95) per operation type
 *   - Error rate per operation type
 *   - SDK version
 *
 * PRIVACY DESIGN:
 *   - No tenant IDs, user IDs, or payload content is recorded
 *   - All metrics are aggregated in-process before any flush
 *   - Opt-in by default: enabled only when OTK_TELEMETRY_ENABLED=1
 *   - Opt-out: set OTK_TELEMETRY_OPT_OUT=1 (takes precedence)
 *   - Data never leaves the process unless an explicit `flush()` target is set
 *
 * Usage:
 *   recordLatency('buildReceipt', 42);
 *   recordError('zkProve');
 *   const snapshot = getSnapshot();
 *
 * @module sdk/telemetry
 * @since Wave 5 (W5-5D / NEW-5.03)
 */

/** SDK version (matches package.json). */
export const SDK_VERSION = '0.1.0';

/**
 * Telemetry is opt-in — returns true only when explicitly enabled and not opted out.
 *
 * Reads `OTK_TELEMETRY_OPT_OUT` and `OTK_TELEMETRY_ENABLED` on every call.
 *
 * @returns `true` when `OTK_TELEMETRY_ENABLED=1` and `OTK_TELEMETRY_OPT_OUT` is not `1`.
 */
export function isTelemetryEnabled(): boolean {
  if (process.env['OTK_TELEMETRY_OPT_OUT'] === '1') return false;
  return process.env['OTK_TELEMETRY_ENABLED'] === '1';
}

// ---------------------------------------------------------------------------
// In-process metric store
// ---------------------------------------------------------------------------

interface MetricBucket {
  latencies: number[];
  errorCount: number;
  callCount: number;
}

const _buckets = new Map<string, MetricBucket>();

function getBucket(op: string): MetricBucket {
  let b = _buckets.get(op);
  if (!b) {
    b = { latencies: [], errorCount: 0, callCount: 0 };
    _buckets.set(op, b);
  }
  return b;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Record a latency measurement for an operation.
 * No-op when telemetry is disabled.
 *
 * @param op        Operation name (e.g. 'buildReceipt', 'zkProve')
 * @param latencyMs Wall-clock latency in milliseconds
 */
export function recordLatency(op: string, latencyMs: number): void {
  if (!isTelemetryEnabled()) return;
  const b = getBucket(op);
  b.latencies.push(latencyMs);
  b.callCount++;
}

/**
 * Record an error event for an operation.
 * No-op when telemetry is disabled.
 *
 * @param op  Operation name
 */
export function recordError(op: string): void {
  if (!isTelemetryEnabled()) return;
  const b = getBucket(op);
  b.errorCount++;
  b.callCount++;
}

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

/**
 * Aggregated metrics of one operation name.
 */
export interface OperationMetrics {
  op: string;
  callCount: number;
  errorCount: number;
  errorRate: number;    // 0–1
  /** Median latency in milliseconds (nearest-rank); null when no latency was recorded. */
  p50Ms: number | null;
  /** 95th percentile latency in milliseconds (nearest-rank); null when no latency was recorded. */
  p95Ms: number | null;
}

/**
 * Point-in-time view of the in-process telemetry.
 */
export interface TelemetrySnapshot {
  sdkVersion: string;
  enabled: boolean;
  operations: OperationMetrics[];
  /** When the snapshot was taken (ISO-8601 UTC). */
  capturedAt: string;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(Math.ceil(sorted.length * p) - 1, sorted.length - 1);
  return sorted[idx] ?? null;
}

/**
 * Return an immutable snapshot of current telemetry.
 * Always returns a valid object regardless of telemetry state.
 *
 * Note: this module has no `flush()`; metrics never leave the process through it.
 *
 * @returns A new snapshot object (not frozen); `enabled` reflects the environment at call time.
 */
export function getSnapshot(): TelemetrySnapshot {
  const operations: OperationMetrics[] = [];

  for (const [op, b] of _buckets) {
    const sorted = b.latencies.slice().sort((a, c) => a - c);
    operations.push({
      op,
      callCount: b.callCount,
      errorCount: b.errorCount,
      errorRate: b.callCount > 0 ? b.errorCount / b.callCount : 0,
      p50Ms: percentile(sorted, 0.5),
      p95Ms: percentile(sorted, 0.95),
    });
  }

  return {
    sdkVersion: SDK_VERSION,
    enabled: isTelemetryEnabled(),
    operations,
    capturedAt: new Date().toISOString(),
  };
}

/** Reset all collected telemetry (for tests / process restart). */
export function resetTelemetry(): void {
  _buckets.clear();
}
