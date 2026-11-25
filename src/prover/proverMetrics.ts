/**
 * PA-06 — Prover Metrics (prom-client)
 *
 * Exposes Prometheus-format counters/gauges for the ProverDaemon.
 * Uses an isolated Registry (NOT the default global register) so tests
 * can create fresh instances via createProverMetrics() without conflicts.
 *
 * Served by the daemon's metrics route. Values are per process. Not to be confused with the
 * `ProverMetrics` interface of `ProverDaemonManager.ts` (a different, supervisor-side shape).
 *
 * @module src/prover/proverMetrics
 * @since PA-06 (2026-03-13)
 */

import { Counter, Gauge, Registry } from 'prom-client';

/** The daemon's metric set. */
export interface ProverMetrics {
  /** Isolated registry holding the metrics below. */
  registry: Registry;
  /** Queue depth gauge, labelled by job status (set by the daemon). */
  queueDepthGauge: Gauge;
  /** Counts one finished job by status; for `done` with a duration, also sets the last-proof gauge (ms). */
  recordProof: (status: 'done' | 'failed' | 'dead_letter', ms?: number) => void;
}

/**
 * Create a fresh isolated metrics set.
 * Production code uses the module-level singleton `proverMetrics`.
 * Tests create their own instance to avoid cross-test counter accumulation.
 *
 * @returns A new metric set in its own registry.
 */
export function createProverMetrics(): ProverMetrics {
  const registry = new Registry();

  const proofCounter = new Counter({
    name: 'otk_proofs_total',
    help: 'Total proof jobs processed, labeled by outcome status',
    labelNames: ['status'],
    registers: [registry],
  });

  const queueDepthGauge = new Gauge({
    name: 'otk_queue_depth',
    help: 'Current proof queue depth by status',
    labelNames: ['status'],
    registers: [registry],
  });

  const lastProofMsGauge = new Gauge({
    name: 'otk_proof_last_ms',
    help: 'Duration in ms of the last successful proof generation',
    registers: [registry],
  });

  function recordProof(status: 'done' | 'failed' | 'dead_letter', ms?: number): void {
    proofCounter.labels(status).inc();
    if (status === 'done' && ms !== undefined) {
      lastProofMsGauge.set(ms);
    }
  }

  return { registry, queueDepthGauge, recordProof };
}

/** Process-level singleton used by ProverDaemon. */
export const proverMetrics = createProverMetrics();
