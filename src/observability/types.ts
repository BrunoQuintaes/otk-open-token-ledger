/**
 * Observability — canonical metric types (F1.1)
 *
 * These types define the contract for the in-memory collector.
 * They are intentionally decoupled from the CU/ZK/Registry core.
 * No external dependencies; pure value objects.
 *
 * @module src/observability/types
 */

/** `degraded` when at least half of the requests failed; `unknown` when no request was seen. */
export type HealthStatus = 'healthy' | 'degraded' | 'unknown';

/**
 * Aggregated metrics for one (provider, model) pair.
 * Updated by MetricsCollector.record() on each NormalizedUsageEvent.
 */
export type ProviderMetricEntry = {
  provider: string;
  model: string;
  requestCount: number;
  successCount: number;
  errorCount: number;
  /** Sum of request latencies, milliseconds. */
  totalLatencyMs: number;
  /** `totalLatencyMs / requestCount`, milliseconds. */
  avgLatencyMs: number;
  /** Sum of the events' cost, in cost units (CU). */
  totalCostUnits: number;
  lastSeenAt: number;        // unix seconds
  healthStatus: HealthStatus;
};

/**
 * Point-in-time snapshot of all tracked providers.
 * Produced by MetricsCollector.snapshot().
 */
export type ObservabilitySnapshot = {
  capturedAt: number;        // unix seconds (injectable for determinism)
  providers: ProviderMetricEntry[];
};
