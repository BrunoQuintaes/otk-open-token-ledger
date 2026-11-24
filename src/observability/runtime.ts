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
 * @since F1.2
 */

import { MetricsCollector } from './MetricsCollector.js';

const _collector = new MetricsCollector();

/**
 * Returns the process-level MetricsCollector singleton.
 * Same instance on every call — guaranteed by module scope.
 */
export function getCollector(): MetricsCollector {
  return _collector;
}
