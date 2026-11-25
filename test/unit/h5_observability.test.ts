/**
 * H-PACK-07 Tests — H5.1-H5.4 Observability
 *
 * Module under test: `src/observability/tracing.ts` (W3C trace context ids and spans).
 *
 * Strategy / partitions: id formats and uniqueness; a span's ids, end time, attributes and the
 * trace id of a child span; tracing off by default and on after `initTracing` with an endpoint;
 * one JSON line on stderr per finished span when tracing is on (stderr is captured during that
 * test).
 *
 * Needs: nothing external. The endpoint given to `initTracing` is only stored; no request is sent.
 *
 * Run just this file: `npx tsx --test test/unit/h5_observability.test.ts`
 *
 * @module test/unit/h5_observability.test
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startSpan, endSpan, generateTraceId, generateSpanId, isTracingEnabled, initTracing, resetTracingForTest } from '../../src/observability/tracing.js';

describe('H5.1 — W3C Tracing', () => {
  beforeEach(() => resetTracingForTest());

  it('generateTraceId produces 32-char hex', () => {
    const id = generateTraceId();
    assert.equal(id.length, 32);
    assert.match(id, /^[0-9a-f]{32}$/);
  });

  it('generateSpanId produces 16-char hex', () => {
    const id = generateSpanId();
    assert.equal(id.length, 16);
    assert.match(id, /^[0-9a-f]{16}$/);
  });

  it('generated IDs are unique', () => {
    const ids = new Set(Array.from({ length: 100 }, () => generateTraceId()));
    assert.equal(ids.size, 100);
  });

  it('startSpan creates span with W3C IDs', () => {
    const span = startSpan('test-op');
    assert.equal(span.traceId.length, 32);
    assert.equal(span.spanId.length, 16);
    assert.equal(span.name, 'test-op');
    assert.ok(span.startTime > 0);
  });

  it('endSpan sets endTime', () => {
    const span = startSpan('test-op');
    endSpan(span);
    assert.ok(span.endTime);
    assert.ok(span.endTime >= span.startTime);
  });

  it('child span inherits traceId', () => {
    const parent = startSpan('parent');
    const child = startSpan('child', { traceId: parent.traceId, parentSpanId: parent.spanId });
    assert.equal(child.traceId, parent.traceId);
    assert.equal(child.parentSpanId, parent.spanId);
    assert.notEqual(child.spanId, parent.spanId);
  });

  it('span carries attributes', () => {
    const span = startSpan('http-request', {
      attributes: { 'http.method': 'POST', 'http.route': '/receipts', 'http.status_code': 201 },
    });
    assert.equal(span.attributes['http.method'], 'POST');
    assert.equal(span.attributes['http.status_code'], 201);
  });

  it('isTracingEnabled returns false by default', () => {
    assert.equal(isTracingEnabled(), false);
  });

  it('initTracing enables when endpoint provided', () => {
    initTracing('http://localhost:4318');
    assert.equal(isTracingEnabled(), true);
  });

  it('endSpan with tracing enabled writes to stderr', () => {
    const lines: string[] = [];
    const originalWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => { lines.push(chunk); return true; }) as any;

    initTracing('http://localhost:4318');
    const span = startSpan('traced-op');
    endSpan(span);

    process.stderr.write = originalWrite;

    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]);
    assert.equal(parsed._otel, true);
    assert.equal(parsed.name, 'traced-op');
    assert.ok(parsed.durationMs >= 0);
  });
});
