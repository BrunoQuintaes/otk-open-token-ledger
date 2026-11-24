/**
 * OpenTelemetry trace wrapper — minimal no-op / stub (E1.2)
 *
 * When OTK_OTEL_ENDPOINT is set, traces are exported (placeholder for real OTel SDK).
 * When not set, all operations are no-ops with zero overhead.
 *
 * This file provides a seam for future OTel SDK integration without changing
 * call sites across the codebase.
 *
 * @module observability/otel
 * @since Wave 1 Pack 8 (E1.2)
 */

export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

export interface Span {
  name: string;
  attributes: SpanAttributes;
  startTime: number;
  endTime?: number;
  status: 'ok' | 'error' | 'unset';
  traceId: string;
  spanId: string;
}

/** Callback to receive completed spans (for testing or custom export). */
export type SpanExporter = (span: Span) => void;

let _enabled = false;
let _endpoint: string | undefined;
let _exporter: SpanExporter | undefined;

/**
 * Initialize OTel tracing.
 * Called once at startup; reads OTK_OTEL_ENDPOINT from env.
 * If endpoint is set, tracing is enabled.
 */
export function initTracing(options?: { endpoint?: string; exporter?: SpanExporter }): void {
  _endpoint = options?.endpoint ?? process.env['OTK_OTEL_ENDPOINT'];
  _enabled = !!_endpoint;
  _exporter = options?.exporter;
}

/**
 * Returns true if tracing is currently enabled.
 */
export function isTracingEnabled(): boolean {
  return _enabled;
}

/**
 * Returns the configured endpoint (or undefined if disabled).
 */
export function getTracingEndpoint(): string | undefined {
  return _endpoint;
}

let _idCounter = 0;

function generateId(): string {
  _idCounter++;
  return Date.now().toString(36) + '-' + _idCounter.toString(36);
}

/**
 * Create and start a new span.
 * When tracing is disabled, returns a lightweight no-op span.
 */
export function createSpan(name: string, attributes: SpanAttributes = {}): Span {
  return {
    name,
    attributes: { ...attributes },
    startTime: Date.now(),
    status: 'unset',
    traceId: _enabled ? generateId() : 'noop',
    spanId: _enabled ? generateId() : 'noop',
  };
}

/**
 * End a span and optionally mark its status.
 * When tracing is enabled, the span is forwarded to the exporter.
 */
export function endSpan(span: Span, status?: 'ok' | 'error'): void {
  span.endTime = Date.now();
  span.status = status ?? 'ok';

  if (_enabled && _exporter) {
    _exporter(span);
  }
}

/**
 * Convenience: wrap an async function in a span.
 * The span is ended automatically when the function completes.
 */
export async function withSpan<T>(
  name: string,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const span = createSpan(name, attributes);
  try {
    const result = await fn(span);
    endSpan(span, 'ok');
    return result;
  } catch (err) {
    endSpan(span, 'error');
    throw err;
  }
}

/**
 * Reset OTel state (for testing only).
 */
export function resetOtelForTest(): void {
  _enabled = false;
  _endpoint = undefined;
  _exporter = undefined;
  _idCounter = 0;
}
