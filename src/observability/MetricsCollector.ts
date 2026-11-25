/**
 * MetricsCollector — in-memory provider metrics aggregator (F1.1)
 *
 * Design constraints:
 * - NEVER throws: record() is called in telemetry paths; errors must not break the core flow.
 * - Pure in-memory: no I/O, no external deps, fully deterministic for testing.
 * - Lateral to core: callers pass a NormalizedUsageEvent after the adapter produces it.
 *   Nothing inside CU/ZK/Registry is modified.
 * - Health is derived from counters, not from heuristics.
 *
 * Key = "provider::model" — each pair tracked independently.
 *
 * The process-wide instance lives in `src/observability/runtime.ts`; its snapshot is served by the metrics
 * route in `src/api/routes.ts`. In this version no server path inside `src/` calls `record()`; the SDK
 * example `examples/typescript/basic_metering.ts` does. Counters live only in memory and reset on restart.
 *
 * @module src/observability/MetricsCollector
 */

import type { NormalizedUsageEvent } from '../providers/types.js';
import type { HealthStatus, ObservabilitySnapshot, ProviderMetricEntry } from './types.js';

/** Error rate at or above this threshold → 'degraded' */
const DEGRADED_ERROR_RATE_THRESHOLD = 0.5;

/** In-memory per-(provider, model) counters with a derived health status. */
export class MetricsCollector {
  private readonly data = new Map<string, ProviderMetricEntry>();

  /**
   * Record a completed request.
   *
   * Latency and cost are summed as given (`latencyMs` in ms, `costUnits` in CU); `lastSeenAt` takes the
   * event timestamp even when it is older than the stored one. The event is not mutated.
   *
   * @param event - NormalizedUsageEvent produced by an adapter
   * @param isError - Whether this request ended in an error (default: false)
   */
  record(event: NormalizedUsageEvent, isError = false): void {
    const key = `${event.provider}::${event.model}`;
    const existing = this.data.get(key);

    if (!existing) {
      const requestCount = 1;
      const successCount = isError ? 0 : 1;
      const errorCount = isError ? 1 : 0;
      this.data.set(key, {
        provider: event.provider,
        model: event.model,
        requestCount,
        successCount,
        errorCount,
        totalLatencyMs: event.latencyMs,
        avgLatencyMs: event.latencyMs,
        totalCostUnits: event.costUnits,
        lastSeenAt: event.timestamp,
        healthStatus: this._deriveHealth(requestCount, errorCount),
      });
      return;
    }

    const requestCount = existing.requestCount + 1;
    const successCount = existing.successCount + (isError ? 0 : 1);
    const errorCount = existing.errorCount + (isError ? 1 : 0);
    const totalLatencyMs = existing.totalLatencyMs + event.latencyMs;
    const totalCostUnits = existing.totalCostUnits + event.costUnits;

    this.data.set(key, {
      provider: event.provider,
      model: event.model,
      requestCount,
      successCount,
      errorCount,
      totalLatencyMs,
      avgLatencyMs: totalLatencyMs / requestCount,
      totalCostUnits,
      lastSeenAt: event.timestamp,
      healthStatus: this._deriveHealth(requestCount, errorCount),
    });
  }

  /**
   * Return a point-in-time snapshot of all tracked providers.
   *
   * The entries are the stored objects, not copies; treat them as read-only.
   *
   * @param nowSeconds - Injectable unix timestamp (defaults to Date.now()/1000)
   * @returns The capture time in unix seconds and one entry per (provider, model) pair seen so far.
   */
  snapshot(nowSeconds?: number): ObservabilitySnapshot {
    return {
      capturedAt: nowSeconds ?? Math.floor(Date.now() / 1000),
      providers: Array.from(this.data.values()),
    };
  }

  /** Reset all accumulated data (useful between test runs). */
  reset(): void {
    this.data.clear();
  }

  private _deriveHealth(requestCount: number, errorCount: number): HealthStatus {
    if (requestCount === 0) return 'unknown';
    return errorCount / requestCount >= DEGRADED_ERROR_RATE_THRESHOLD ? 'degraded' : 'healthy';
  }
}
