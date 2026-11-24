/**
 * G3 — Reference Oracle (pure, deterministic)
 *
 * Provides a snapshot-based reference rate for CU → fiat conversion.
 * NOT a live oracle — rate is injected at construction for reproducibility.
 *
 * Oracle limitation (ADR-0004):
 *   Provider-reported token counts are not independently verifiable at the
 *   API layer. This is a known limitation documented in dissertacao §5.2.
 *   TEE/TLSNotary attestation would address the execution-layer oracle problem
 *   but is out of scope for the current dissertation phase.
 *
 * Design principles:
 *   - All functions are pure (no I/O, no external calls)
 *   - Rate must be injected — no hidden defaults from process.env
 *   - Snapshot epoch injected for determinism
 *
 * @module oracle/referenceOracle
 * @since G3
 */

import type { ReferenceRate } from '../economics/tokenEconomicsTypes.js';

export type ReferenceOracleConfig = {
  /** Currency pair being quoted (e.g. 'USD_BRL') */
  pair: string;
  /** Rate value (e.g. 5.10 for 1 USD = 5.10 BRL) */
  rate: number;
  /** Snapshot epoch (unix seconds) — must be injected by caller */
  snapshotEpoch: number;
  /** Source tag */
  source: 'fixed' | 'injected';
  /** Version tag for audit trail */
  version: string;
};

export type ReferenceOracleOutput = {
  /** The derived ReferenceRate (compatible with tokenEconomicsTypes) */
  referenceRate: ReferenceRate;
  /** Whether the snapshot is within acceptable staleness window */
  isFresh: boolean;
  /** Age of snapshot in seconds at evaluation time */
  snapshotAgeSecs: number;
};

/** Default staleness threshold: 24 hours (86 400 seconds) */
export const DEFAULT_STALENESS_SECS = 86_400;

/**
 * Evaluate a reference oracle snapshot for freshness and extract ReferenceRate.
 * Pure function — no I/O, no side effects.
 *
 * @param config        - Oracle configuration (rate + epoch injected by caller)
 * @param nowSecs       - Current time in unix seconds (injectable for tests)
 * @param stalenessSecs - Max acceptable snapshot age (default 24h)
 */
export function evaluateReferenceRate(
  config: ReferenceOracleConfig,
  nowSecs?: number,
  stalenessSecs = DEFAULT_STALENESS_SECS,
): ReferenceOracleOutput {
  if (config.rate <= 0) {
    throw new Error(`ReferenceOracle: rate=${config.rate} must be > 0`);
  }
  const now = nowSecs ?? Math.floor(Date.now() / 1000);
  const snapshotAgeSecs = Math.max(0, now - config.snapshotEpoch);
  const isFresh = snapshotAgeSecs <= stalenessSecs;

  return {
    referenceRate: {
      pair: config.pair,
      rate: config.rate,
      snapshotEpoch: config.snapshotEpoch,
      source: config.source,
      version: config.version,
    },
    isFresh,
    snapshotAgeSecs,
  };
}

/**
 * Default oracle config — fixed, deterministic, dissertation snapshot (2026-02).
 *
 * USD/BRL = 5.10 (approximate 2026-02 rate, locked for reproducibility).
 * snapshotEpoch = 2026-03-02T00:00:00Z (1740873600).
 */
export const DEFAULT_ORACLE_CONFIG: ReferenceOracleConfig = {
  pair: 'USD_BRL',
  rate: 5.10,
  snapshotEpoch: 1_740_873_600,
  source: 'fixed',
  version: '2026-02',
} as const;
