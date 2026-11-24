/**
 * G3 — Oracle Runtime (process-level singleton accessor)
 *
 * Provides process-level access to the active ReferenceOracleConfig.
 * Mirrors the singleton pattern used in F1 (getCollector), F4 (getLimiter).
 *
 * Default: DEFAULT_ORACLE_CONFIG (fixed, dissertation-safe).
 * Override: setOracleConfig() for operator injection or test isolation.
 *
 * @module oracle/oracleRuntime
 * @since G3
 */

import {
  DEFAULT_ORACLE_CONFIG,
  type ReferenceOracleConfig,
  type ReferenceOracleOutput,
  evaluateReferenceRate,
} from './referenceOracle.js';

let _config: ReferenceOracleConfig = DEFAULT_ORACLE_CONFIG;

/** Get the current oracle configuration (process-level singleton). */
export function getOracleConfig(): ReferenceOracleConfig {
  return _config;
}

/**
 * Override oracle configuration.
 * Use for operator injection or test isolation.
 */
export function setOracleConfig(config: ReferenceOracleConfig): void {
  _config = config;
}

/** Reset to DEFAULT_ORACLE_CONFIG (for test isolation). */
export function resetOracleConfig(): void {
  _config = DEFAULT_ORACLE_CONFIG;
}

/**
 * Evaluate the current oracle config for freshness.
 * Convenience wrapper: getOracleConfig() + evaluateReferenceRate().
 *
 * @param nowSecs - Injectable timestamp for deterministic testing
 */
export function evaluateCurrentRate(nowSecs?: number): ReferenceOracleOutput {
  return evaluateReferenceRate(_config, nowSecs);
}
