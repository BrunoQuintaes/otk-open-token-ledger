/**
 * H5.1/H5.2 — W3C-Compliant Tracing
 *
 * Replaces the stub otel.ts span IDs with W3C trace-context compliant IDs.
 * When OTK_OTEL_ENDPOINT is set, traces are exported via console (placeholder
 * for real OTLP exporter — wire @opentelemetry/sdk-node in Wave 4B, see E5 roadmap).
 *
 * @module observability/tracing
 * @since Wave 2H (H5.1)
 */

import crypto from 'node:crypto';

export interface Span {
  traceId: string;    // 32-char hex (W3C)
  spanId: string;     // 16-char hex (W3C)
  name: string;
  startTime: number;  // ms
  endTime?: number;   // ms
  attributes: Record<string, string | number | boolean>;
  parentSpanId?: string;
}

let _enabled = false;
let _endpoint: string | undefined;

export function initTracing(endpoint?: string): void {
  _endpoint = endpoint ?? process.env['OTK_OTEL_ENDPOINT'];
  _enabled = !!_endpoint;
}

export function isTracingEnabled(): boolean { return _enabled; }

/** Generate W3C-compliant trace ID (32 hex chars). */
export function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Generate W3C-compliant span ID (16 hex chars). */
export function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

const _activeSpans = new Map<string, Span>();

export function startSpan(name: string, opts?: { traceId?: string; parentSpanId?: string; attributes?: Record<string, string | number | boolean> }): Span {
  const span: Span = {
    traceId: opts?.traceId ?? generateTraceId(),
    spanId: generateSpanId(),
    name,
    startTime: Date.now(),
    attributes: opts?.attributes ?? {},
    parentSpanId: opts?.parentSpanId,
  };
  _activeSpans.set(span.spanId, span);
  return span;
}

export function endSpan(span: Span): void {
  span.endTime = Date.now();
  _activeSpans.delete(span.spanId);

  if (_enabled && _endpoint) {
    // Placeholder: log to stderr as structured JSON (real OTLP export in Wave 3)
    const duration = span.endTime - span.startTime;
    process.stderr.write(JSON.stringify({
      _otel: true,
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      durationMs: duration,
      attributes: span.attributes,
    }) + '\n');
  }
}

export function resetTracingForTest(): void {
  _enabled = false;
  _endpoint = undefined;
  _activeSpans.clear();
}
