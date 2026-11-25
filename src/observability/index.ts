/**
 * Observability public API (F1.1)
 *
 * Lateral telemetry layer — does not alter core CU/ZK/Registry semantics.
 * Import MetricsCollector and call record() after each NormalizedUsageEvent.
 *
 * Re-exports only; no logic. Tracing (`tracing.ts`, `otel.ts`) and the Prometheus registry
 * (`prometheusMetrics.ts`) are imported from their own files, not from here.
 *
 * @module src/observability/index
 */

export type { HealthStatus, ProviderMetricEntry, ObservabilitySnapshot } from './types.js';
export { MetricsCollector } from './MetricsCollector.js';
export { getCollector } from './runtime.js';
