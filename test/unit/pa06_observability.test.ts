/**
 * PA-06 — Observability Tests
 *
 * Covers:
 *   (a) proverMetrics — createProverMetrics() factory, recordProof(), Prometheus text output
 *   (b) API /metrics — backward-compat JSON shape + receipt counters
 *
 * ProverDaemon /metrics is tested via proverMetrics directly (no server spin-up needed).
 * API /metrics is tested via the same in-process mock pattern used in observability_smoke.test.ts.
 *
 * @since PA-06 (2026-03-13)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createProverMetrics } from '../../src/prover/proverMetrics.js';
import { handleRequest } from '../../src/api/routes.js';
import { getCollector } from '../../src/observability/runtime.js';

// ---------------------------------------------------------------------------
// Helpers (same mock pattern as observability_smoke.test.ts)
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url }) as unknown as IncomingMessage;
  process.nextTick(() => em.emit('end'));
  return req;
}

type MockRes = ServerResponse & { body: string; statusCode: number };

function mockRes(): MockRes {
  let body = '';
  let code = 200;
  return {
    get statusCode() { return code; },
    set statusCode(v: number) { code = v; },
    setHeader: () => {},
    end: (data: string) => { body = data; },
    get body() { return body; },
  } as unknown as MockRes;
}

// ---------------------------------------------------------------------------
// Suite A — proverMetrics (prom-client, isolated registry)
// ---------------------------------------------------------------------------

describe('PA-06 — proverMetrics', () => {

  it('recordProof("done", ms) increments otk_proofs_total{status="done"}', async () => {
    const pm = createProverMetrics();
    pm.recordProof('done', 250);

    const text = await pm.registry.metrics();
    assert.ok(text.includes('otk_proofs_total'), 'missing otk_proofs_total');
    // Prometheus text format: metric{label="value"} value
    assert.ok(text.includes('"done"'), 'done label missing');
  });

  it('recordProof("failed") increments otk_proofs_total{status="failed"}', async () => {
    const pm = createProverMetrics();
    pm.recordProof('failed');

    const text = await pm.registry.metrics();
    assert.ok(text.includes('"failed"'), 'failed label missing');
  });

  it('recordProof("dead_letter") increments otk_proofs_total{status="dead_letter"}', async () => {
    const pm = createProverMetrics();
    pm.recordProof('dead_letter');

    const text = await pm.registry.metrics();
    assert.ok(text.includes('"dead_letter"'), 'dead_letter label missing');
  });

  it('Prometheus text contains otk_queue_depth metric name', async () => {
    const pm = createProverMetrics();
    pm.queueDepthGauge.labels('pending').set(3);
    pm.queueDepthGauge.labels('done').set(10);

    const text = await pm.registry.metrics();
    assert.ok(text.includes('otk_queue_depth'), 'missing otk_queue_depth');
    assert.ok(text.includes('"pending"'), 'pending label missing');
    assert.ok(text.includes('"done"'), 'done label missing');
  });

  it('Prometheus text contains otk_proof_last_ms metric name', async () => {
    const pm = createProverMetrics();
    pm.recordProof('done', 420);

    const text = await pm.registry.metrics();
    assert.ok(text.includes('otk_proof_last_ms'), 'missing otk_proof_last_ms');
  });

  it('multiple calls accumulate counter correctly', async () => {
    const pm = createProverMetrics();
    pm.recordProof('done', 100);
    pm.recordProof('done', 200);
    pm.recordProof('failed');

    const text = await pm.registry.metrics();
    // The text should contain the counter lines — exact value format is:
    // otk_proofs_total{status="done"} 2
    // otk_proofs_total{status="failed"} 1
    assert.ok(text.includes('2'), 'expected count of 2 not found in metrics text');
    assert.ok(text.includes('1'), 'expected count of 1 not found in metrics text');
  });
});

// ---------------------------------------------------------------------------
// Suite B — API /metrics backward-compat + receipt counters
// ---------------------------------------------------------------------------

describe('PA-06 — API /metrics receipt counters', () => {
  beforeEach(() => { getCollector().reset(); });

  it('GET /metrics still returns capturedAt and providers (backward-compat)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/metrics?format=json'), res);
    assert.equal(res.statusCode, 200);
    const snap = JSON.parse(res.body) as Record<string, unknown>;
    assert.ok('capturedAt' in snap, 'capturedAt missing — backward-compat broken');
    assert.ok(Array.isArray(snap['providers']), 'providers not an array — backward-compat broken');
  });

  it('GET /metrics includes receipts counter field', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/metrics?format=json'), res);
    const snap = JSON.parse(res.body) as Record<string, unknown>;
    assert.ok('receipts' in snap, 'receipts counter field missing from /metrics');
    const receipts = snap['receipts'] as Record<string, number>;
    assert.ok(typeof receipts['total'] === 'number', 'receipts.total should be a number');
    assert.ok(typeof receipts['duplicates'] === 'number', 'receipts.duplicates should be a number');
  });
});
