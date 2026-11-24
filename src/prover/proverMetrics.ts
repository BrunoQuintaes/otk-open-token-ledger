/**
 * PA-06 — Prover Metrics (prom-client)
 *
 * Exposes Prometheus-format counters/gauges for the ProverDaemon.
 * Uses an isolated Registry (NOT the default global register) so tests
 * can create fresh instances via createProverMetrics() without conflicts.
 *
 * @since PA-06 (2026-03-13)
 */

import { Counter, Gauge, Registry } from 'prom-client';

export interface ProverMetrics {
  registry: Registry;
  queueDepthGauge: Gauge;
  recordProof: (status: 'done' | 'failed' | 'dead_letter', ms?: number) => void;
}

/**
 * Create a fresh isolated metrics set.
 * Production code uses the module-level singleton `proverMetrics`.
 * Tests create their own instance to avoid cross-test counter accumulation.
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
