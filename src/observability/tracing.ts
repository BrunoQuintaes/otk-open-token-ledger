/**
 * H5.1/H5.2 — W3C-Compliant Tracing
 *
 * Replaces the stub otel.ts span IDs with W3C trace-context compliant IDs.
 * When OTK_OTEL_ENDPOINT is set, traces are exported via console (placeholder
 * for real OTLP exporter — wire @opentelemetry/sdk-node in Wave 4B, see E5 roadmap).
 *
 * Used by the request handling in `src/api/routes.ts`. Nothing is sent over the network: when enabled,
 * each ended span is written as one JSON line to stderr (see {@link endSpan}). Reads OTK_OTEL_ENDPOINT
 * only when {@link initTracing} is called without an argument; the endpoint value is never contacted.
 *
 * @module src/observability/tracing
 * @since Wave 2H (H5.1)
 */

import crypto from 'node:crypto';

/** A span with W3C trace-context ids; times are epoch milliseconds. */
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

/**
 * Enables tracing when an endpoint is given or OTK_OTEL_ENDPOINT is set; disables it otherwise.
 *
 * @param endpoint - Endpoint label; when omitted, the environment variable is read.
 */
export function initTracing(endpoint?: string): void {
  _endpoint = endpoint ?? process.env['OTK_OTEL_ENDPOINT'];
  _enabled = !!_endpoint;
}

/**
 * Reports whether ended spans are being emitted.
 *
 * @returns Whether the last {@link initTracing} call found an endpoint.
 */
export function isTracingEnabled(): boolean { return _enabled; }

/**
 * Generate W3C-compliant trace ID (32 hex chars).
 *
 * @returns 16 random bytes as lower-case hex.
 */
export function generateTraceId(): string {
  return crypto.randomBytes(16).toString('hex');
}

/**
 * Generate W3C-compliant span ID (16 hex chars).
 *
 * @returns 8 random bytes as lower-case hex.
 */
export function generateSpanId(): string {
  return crypto.randomBytes(8).toString('hex');
}

const _activeSpans = new Map<string, Span>();

/**
 * Starts a span and keeps it in the in-process active-span map until {@link endSpan}.
 *
 * Spans are created even when tracing is disabled; a span never ended stays in the map (memory grows).
 *
 * @param name - Span name.
 * @param opts - Optional trace id to join, parent span id, and attributes (stored by reference, not copied).
 * @returns The new open span.
 */
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

/**
 * Ends a span: sets `endTime`, removes it from the active map and, when tracing is enabled, writes it to stderr.
 *
 * @param span - The span to close (mutated).
 */
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

/** Test helper: disables tracing and forgets all active spans. */
export function resetTracingForTest(): void {
  _enabled = false;
  _endpoint = undefined;
  _activeSpans.clear();
}
