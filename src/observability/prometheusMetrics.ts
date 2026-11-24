/**
 * Prometheus-compatible metrics registry (E1.3)
 *
 * Uses prom-client to register standard OTK metrics.
 * Provides getMetricsText() for the /metrics endpoint.
 *
 * Registered metrics:
 * - otk_http_requests_total (counter)
 * - otk_http_request_duration_seconds (histogram)
 * - otk_receipt_store_total (counter)
 * - otk_proof_queue_depth (gauge)
 * - otk_dead_letter_count (gauge)
 *
 * @module observability/prometheusMetrics
 * @since Wave 1 Pack 8 (E1.3)
 */

import client from 'prom-client';

// ── Registry ────────────────────────────────────────────────

const registry = new client.Registry();

// ── Metrics ─────────────────────────────────────────────────

export const httpRequestsTotal = new client.Counter({
  name: 'otk_http_requests_total',
  help: 'Total HTTP requests received',
  labelNames: ['method', 'path', 'status'] as const,
  registers: [registry],
});

export const httpRequestDuration = new client.Histogram({
  name: 'otk_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'path'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [registry],
});

export const receiptStoreTotal = new client.Counter({
  name: 'otk_receipt_store_total',
  help: 'Total receipts stored',
  labelNames: ['status'] as const,  // 'success' | 'duplicate' | 'error'
  registers: [registry],
});

export const proofQueueDepth = new client.Gauge({
  name: 'otk_proof_queue_depth',
  help: 'Current depth of the proof generation queue',
  registers: [registry],
});

export const deadLetterCount = new client.Gauge({
  name: 'otk_dead_letter_count',
  help: 'Current count of dead-letter entries',
  registers: [registry],
});

// H1-S22 (2026-10-13): money and plan failure signals. Labels never carry tenant ids, tokens or amounts.
export const planStoreOpsTotal = new client.Counter({
  name: 'otk_plan_store_ops_total',
  help: 'Plan store writes by outcome (applied, conflict, unavailable = outcome unknown, skipped_duplicate, skipped_stale, skipped_superseded_by_admin, skipped_other_subscription)',
  labelNames: ['source', 'outcome'] as const,
  registers: [registry],
});

export const stripeWebhookEventsTotal = new client.Counter({
  name: 'otk_stripe_webhook_events_total',
  help: 'Verified Stripe webhook events by handler action (retryable failures included)',
  labelNames: ['type', 'action'] as const,
  registers: [registry],
});

export const admissionRefusalsTotal = new client.Counter({
  name: 'otk_admission_refusals_total',
  help: 'Durable proxy admissions refused before the provider, by reason',
  labelNames: ['reason'] as const,
  registers: [registry],
});

// H1R2 C5 (H1 final closure run): revocation, denied attempts, recovery and ZK signals. Labels are fixed vocabularies
// (event names, HTTP status, error codes): never a tenant, user, key, hash or amount. Gauges are read at scrape time
// from the in-process state of each module (dynamic imports: no import cycle, no cost between scrapes).

export const authDenialsTotal = new client.Counter({
  name: 'otk_auth_denials_total',
  help: 'Requests refused by authentication/authorization (RBAC path), by HTTP status and error code',
  labelNames: ['status', 'error'] as const,
  registers: [registry],
});

new client.Gauge({
  name: 'otk_credential_authority_events',
  help: 'Cumulative per-request credential authority events since start (R-13/A3): key lookups and refusals, subject checks, fail-closed answers',
  labelNames: ['event'] as const,
  registers: [registry],
  async collect() {
    try {
      const { credentialAuthorityStats } = await import('../auth/credentialAuthority.js');
      // H1R2 review LOW-4: /metrics is public; revoked/unknown/expired are merged so the counters are no oracle on keys
      const st: Record<string, number> = { ...credentialAuthorityStats() };
      const refused = (st['keysRefusedRevoked'] ?? 0) + (st['keysRefusedUnknown'] ?? 0) + (st['keysRefusedExpired'] ?? 0);
      delete st['keysRefusedRevoked']; delete st['keysRefusedUnknown']; delete st['keysRefusedExpired'];
      st['keysRefused'] = refused;
      for (const [event, v] of Object.entries(st)) this.set({ event }, v);
    } catch { /* module unavailable: no sample */ }
  },
});

new client.Gauge({
  name: 'otk_subject_status_store_up',
  help: 'Revocation status store: 1 = configured and last refresh succeeded, 0 = configured and failing, -1 = not configured (single process)',
  registers: [registry],
  async collect() {
    try {
      const { subjectStatusHealth } = await import('../auth/subjectStatus.js');
      const h = subjectStatusHealth();
      this.set(!h.store ? -1 : h.lastSyncError === null && h.lastSyncOkMs > 0 ? 1 : 0);
    } catch { /* no sample */ }
  },
});

new client.Gauge({
  name: 'otk_subject_status_sync_age_seconds',
  help: 'Seconds since the last successful refresh of the revocation status snapshot (-1 = never / no store)',
  registers: [registry],
  async collect() {
    try {
      const { subjectStatusHealth } = await import('../auth/subjectStatus.js');
      const h = subjectStatusHealth();
      this.set(h.store && h.lastSyncOkMs > 0 ? (Date.now() - h.lastSyncOkMs) / 1000 : -1);
    } catch { /* no sample */ }
  },
});

new client.Gauge({
  name: 'otk_proof_recovery',
  help: 'ZK proof pipeline state (recovery): pending proofs, in flight, uncertain dispatches, possible duplicate jobs, prover circuit open (1/0)',
  labelNames: ['state'] as const,
  registers: [registry],
  async collect() {
    try {
      const { circuitBreakerStatus } = await import('../api/receiptStore.js');
      const c = circuitBreakerStatus();
      this.set({ state: 'pending' }, c.pendingProofs);
      this.set({ state: 'in_flight' }, c.inFlight);
      this.set({ state: 'uncertain_dispatches' }, c.uncertainDispatches);
      this.set({ state: 'possible_duplicate_jobs' }, c.possibleDuplicateJobs);
      this.set({ state: 'circuit_open' }, c.open ? 1 : 0);
      this.set({ state: 'consecutive_failures' }, c.consecutiveFails);
    } catch { /* no sample */ }
  },
});

// ── API ─────────────────────────────────────────────────────

/**
 * Returns Prometheus text exposition format.
 */
export async function getMetricsText(): Promise<string> {
  return registry.metrics();
}

/**
 * Returns the content type header for Prometheus scraping.
 */
export function getMetricsContentType(): string {
  return registry.contentType;
}

/**
 * Returns the underlying prom-client registry (for advanced usage).
 */
export function getRegistry(): client.Registry {
  return registry;
}

/**
 * Reset all metrics (for testing only).
 */
export async function resetMetricsForTest(): Promise<void> {
  registry.resetMetrics();
}
