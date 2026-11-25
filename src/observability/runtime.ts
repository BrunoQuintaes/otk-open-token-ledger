/**
 * Observability Runtime — process-level MetricsCollector singleton.
 *
 * Canonical access point for observability wiring across the process.
 * Callers (adapters, gateway, proxy call sites) invoke:
 *   getCollector().record(event)       after producing a NormalizedUsageEvent
 *   getCollector().record(event, true) to flag an error request
 *
 * The singleton is reset-safe: call getCollector().reset() in tests.
 *
 * In this version the snapshot is read by the metrics route in `src/api/routes.ts`; no server path in
 * `src/` calls `record()` (see `MetricsCollector.ts`).
 *
 * @module src/observability/runtime
 * @since F1.2
 */

import { MetricsCollector } from './MetricsCollector.js';

const _collector = new MetricsCollector();

/**
 * Returns the process-level MetricsCollector singleton.
 * Same instance on every call — guaranteed by module scope.
 *
 * @returns The shared collector (created when this module is first imported).
 */
export function getCollector(): MetricsCollector {
  return _collector;
}
