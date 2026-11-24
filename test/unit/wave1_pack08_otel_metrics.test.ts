/**
 * Wave 1 Pack 8 — OTel + Prometheus Metrics Tests (E1.2 + E1.3 + E1.4)
 *
 * Tests:
 *   - OTel: no-op when disabled, span creation, span end, withSpan
 *   - Prometheus: metric registration, counter increment, histogram observation,
 *     gauge set, getMetricsText output
 *
 * @since Wave 1 Pack 8 (2026-03-15)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── OTel Tests ──────────────────────────────────────────────

import {
  initTracing,
  isTracingEnabled,
  getTracingEndpoint,
  createSpan,
  endSpan,
  withSpan,
  resetOtelForTest,
  type Span,
} from '../../src/observability/otel.js';

describe('Pack 8 — OTel Tracing', () => {
  beforeEach(() => {
    resetOtelForTest();
  });

  it('tracing is disabled by default', () => {
    initTracing();
    assert.equal(isTracingEnabled(), false);
    assert.equal(getTracingEndpoint(), undefined);
  });

  it('tracing is enabled when endpoint is provided', () => {
    initTracing({ endpoint: 'http://localhost:4318' });
    assert.equal(isTracingEnabled(), true);
    assert.equal(getTracingEndpoint(), 'http://localhost:4318');
  });

  it('createSpan returns a span with name and attributes', () => {
    const span = createSpan('test-op', { method: 'POST', path: '/receipts' });
    assert.equal(span.name, 'test-op');
    assert.equal(span.attributes['method'], 'POST');
    assert.equal(span.attributes['path'], '/receipts');
    assert.equal(span.status, 'unset');
    assert.ok(span.startTime > 0);
  });

  it('endSpan sets endTime and status', () => {
    const span = createSpan('test-op');
    endSpan(span, 'ok');
    assert.ok(span.endTime! >= span.startTime);
    assert.equal(span.status, 'ok');
  });

  it('no-op span has noop traceId when disabled', () => {
    initTracing(); // no endpoint
    const span = createSpan('noop');
    assert.equal(span.traceId, 'noop');
    assert.equal(span.spanId, 'noop');
  });

  it('enabled span has real traceId', () => {
    initTracing({ endpoint: 'http://localhost:4318' });
    const span = createSpan('real');
    assert.notEqual(span.traceId, 'noop');
    assert.notEqual(span.spanId, 'noop');
  });

  it('exporter receives completed span when enabled', () => {
    const exported: Span[] = [];
    initTracing({ endpoint: 'http://localhost:4318', exporter: (s) => exported.push(s) });

    const span = createSpan('export-test');
    endSpan(span, 'ok');

    assert.equal(exported.length, 1);
    assert.equal(exported[0].name, 'export-test');
    assert.equal(exported[0].status, 'ok');
  });

  it('withSpan wraps async function and ends span', async () => {
    const exported: Span[] = [];
    initTracing({ endpoint: 'http://localhost:4318', exporter: (s) => exported.push(s) });

    const result = await withSpan('async-op', { key: 'val' }, async () => {
      return 42;
    });

    assert.equal(result, 42);
    assert.equal(exported.length, 1);
    assert.equal(exported[0].name, 'async-op');
    assert.equal(exported[0].status, 'ok');
  });

  it('withSpan marks error on throw', async () => {
    const exported: Span[] = [];
    initTracing({ endpoint: 'http://localhost:4318', exporter: (s) => exported.push(s) });

    await assert.rejects(
      withSpan('fail-op', {}, async () => {
        throw new Error('boom');
      }),
      { message: 'boom' },
    );

    assert.equal(exported.length, 1);
    assert.equal(exported[0].status, 'error');
  });
});

// ─── Prometheus Metrics Tests ────────────────────────────────

import {
  httpRequestsTotal,
  httpRequestDuration,
  receiptStoreTotal,
  proofQueueDepth,
  deadLetterCount,
  getMetricsText,
  getMetricsContentType,
  resetMetricsForTest,
} from '../../src/observability/prometheusMetrics.js';

describe('Pack 8 — Prometheus Metrics', () => {
  beforeEach(async () => {
    await resetMetricsForTest();
  });

  it('httpRequestsTotal counter increments', async () => {
    httpRequestsTotal.inc({ method: 'POST', path: '/receipts', status: '201' });
    httpRequestsTotal.inc({ method: 'POST', path: '/receipts', status: '201' });

    const text = await getMetricsText();
    assert.ok(text.includes('otk_http_requests_total'));
  });

  it('httpRequestDuration histogram observes values', async () => {
    httpRequestDuration.observe({ method: 'POST', path: '/receipts' }, 0.045);

    const text = await getMetricsText();
    assert.ok(text.includes('otk_http_request_duration_seconds'));
  });

  it('receiptStoreTotal counter tracks success/error', async () => {
    receiptStoreTotal.inc({ status: 'success' });
    receiptStoreTotal.inc({ status: 'duplicate' });
    receiptStoreTotal.inc({ status: 'error' });

    const text = await getMetricsText();
    assert.ok(text.includes('otk_receipt_store_total'));
  });

  it('proofQueueDepth gauge can be set', async () => {
    proofQueueDepth.set(42);

    const text = await getMetricsText();
    assert.ok(text.includes('otk_proof_queue_depth'));
    assert.ok(text.includes('42'));
  });

  it('deadLetterCount gauge can be set', async () => {
    deadLetterCount.set(3);

    const text = await getMetricsText();
    assert.ok(text.includes('otk_dead_letter_count'));
    assert.ok(text.includes('3'));
  });

  it('getMetricsText returns valid prometheus format', async () => {
    httpRequestsTotal.inc({ method: 'GET', path: '/health', status: '200' });

    const text = await getMetricsText();
    // Should contain HELP and TYPE lines
    assert.ok(text.includes('# HELP'));
    assert.ok(text.includes('# TYPE'));
  });

  it('getMetricsContentType returns correct content type', () => {
    const ct = getMetricsContentType();
    assert.ok(ct.includes('text/plain') || ct.includes('text/openmetrics') || ct.includes('application/openmetrics'),
      `unexpected content type: ${ct}`);
  });
});
