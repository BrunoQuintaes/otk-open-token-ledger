/**
 * Observability public API (F1.1)
 *
 * Lateral telemetry layer — does not alter core CU/ZK/Registry semantics.
 * Import MetricsCollector and call record() after each NormalizedUsageEvent.
 */

export type { HealthStatus, ProviderMetricEntry, ObservabilitySnapshot } from './types.js';
export { MetricsCollector } from './MetricsCollector.js';
export { getCollector } from './runtime.js';
