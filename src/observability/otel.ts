/**
 * OpenTelemetry trace wrapper — minimal no-op / stub (E1.2)
 *
 * When OTK_OTEL_ENDPOINT is set, traces are exported (placeholder for real OTel SDK).
 * When not set, all operations are no-ops with zero overhead.
 *
 * This file provides a seam for future OTel SDK integration without changing
 * call sites across the codebase.
 *
 * Despite the wording above, nothing is sent over the network: an enabled span is only handed to the
 * optional exporter callback given to {@link initTracing}. Reads OTK_OTEL_ENDPOINT when no endpoint is
 * passed. The request path uses the newer `src/observability/tracing.ts`; in this version this file is
 * imported only by its unit test.
 *
 * @module src/observability/otel
 * @since Wave 1 Pack 8 (E1.2)
 */

/** Free-form span attributes; `undefined` values are kept as given. */
export interface SpanAttributes {
  [key: string]: string | number | boolean | undefined;
}

/** A span of the stub tracer (not W3C trace-context ids; see `tracing.ts` for those). */
export interface Span {
  name: string;
  /** Copy of the attributes passed at creation. */
  attributes: SpanAttributes;
  /** Start time, epoch milliseconds. */
  startTime: number;
  /** End time, epoch milliseconds; `undefined` while the span is open. */
  endTime?: number;
  status: 'ok' | 'error' | 'unset';
  /** Process-local id (base-36 time plus counter), or `'noop'` when tracing is disabled. */
  traceId: string;
  /** Same format as `traceId`; `'noop'` when tracing is disabled. */
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
 *
 * Calling it again replaces the previous settings (the exporter is cleared when not given).
 *
 * @param options - Optional endpoint (overrides OTK_OTEL_ENDPOINT) and exporter callback for ended spans.
 */
export function initTracing(options?: { endpoint?: string; exporter?: SpanExporter }): void {
  _endpoint = options?.endpoint ?? process.env['OTK_OTEL_ENDPOINT'];
  _enabled = !!_endpoint;
  _exporter = options?.exporter;
}

/**
 * Returns true if tracing is currently enabled.
 *
 * @returns Whether the last {@link initTracing} call found an endpoint.
 */
export function isTracingEnabled(): boolean {
  return _enabled;
}

/**
 * Returns the configured endpoint (or undefined if disabled).
 *
 * @returns The endpoint string, or `undefined`.
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
 *
 * @param name - Span name.
 * @param attributes - Initial attributes (shallow-copied).
 * @returns A new open span with status `'unset'`.
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
 *
 * Mutates `span` (sets `endTime` and `status`). An exception thrown by the exporter propagates.
 *
 * @param span - The span to close.
 * @param status - Final status; defaults to `'ok'`.
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
 *
 * @param name - Span name.
 * @param attributes - Initial attributes.
 * @param fn - Work to run; receives the open span.
 * @returns Whatever `fn` resolves to.
 * @throws {Error} Re-throws any error from `fn` after ending the span with status `'error'`.
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
