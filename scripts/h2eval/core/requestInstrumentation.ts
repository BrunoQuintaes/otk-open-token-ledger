/**
 * E1‴ (C160, R-INST prospectivo no executor científico). Pure core (imports node:crypto only; desenho de referência: Bot B8 `requestInstrumentation.js`).
 * For every NEW operation sent it yields two forensic facts, never anything else:
 *   1. wireBodySha256: sha256 of the EXACT bytes of the request body handed to the transport (UTF-8 of `wireBody(req)`, the same string `egress.send` passes to fetch/double);
 *   2. providerRequestId: the provider's request id read from ONE allow-listed RESPONSE header (Anthropic: `request-id`), or 'NOT_AVAILABLE' with a reason.
 * Rules: no personal data, no secret. Request headers are never touched; response headers are read only through `get(<allow-listed name>)` (never iterated),
 * so the authorization/credential header is never read. Every function here NEVER throws: a failure yields 'NOT_AVAILABLE' + a fixed reason code.
 * It never changes what is sent nor the result: the transport receives the same string, and the response object is returned unchanged.
 */
import { createHash } from 'node:crypto';
import type { BuiltRequest, Provider } from '../types.js';

export const NOT_AVAILABLE = 'NOT_AVAILABLE' as const;
export type InstrumentedValue = { value: string; reason: null } | { value: typeof NOT_AVAILABLE; reason: string };

/** The exact body string handed to the transport. `egress.send` uses THIS function, so the hash below is the hash of the bytes sent. */
export const wireBody = (req: Pick<BuiltRequest, 'body'>): string => JSON.stringify(req.body);

/** Response header that carries the provider's request id. Only providers with a documented header are listed; any other ⇒ NOT_AVAILABLE (never invented). */
export const REQUEST_ID_HEADER: Readonly<Partial<Record<Provider, string>>> = Object.freeze({ anthropic: 'request-id' });
/**
 * E3G (C160 BRACO-GO): response headers of the request id for the arm providers, read in this order (first non-empty wins), same names as the Bot clients
 * (providers3p/openai.js REQ_ID_HEADERS ['x-request-id']; providers3p/google.js ['x-goog-request-id', 'x-request-id']). Anthropic keeps REQUEST_ID_HEADER unchanged.
 */
export const ARM_REQUEST_ID_HEADERS: Readonly<Partial<Record<Provider, readonly string[]>>> = Object.freeze({ openai: Object.freeze(['x-request-id']), google: Object.freeze(['x-goog-request-id', 'x-request-id']) });

/** Accepted shape of a request id (opaque provider token). Anything else ⇒ NOT_AVAILABLE (FORMAT_INVALID); the raw value is never recorded. */
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_\-.:]{0,127}$/;

/** sha256 (hex) of the UTF-8 bytes of the wire body. Never throws. */
export function wireBodySha256(bytes: unknown): InstrumentedValue {
  try {
    if (typeof bytes !== 'string') return { value: NOT_AVAILABLE, reason: 'BODY_NOT_STRING' };
    return { value: createHash('sha256').update(Buffer.from(bytes, 'utf8')).digest('hex'), reason: null };
  } catch { return { value: NOT_AVAILABLE, reason: 'HASH_FAILED' }; }
}

/** sha256 of `wireBody(req)`, computed without throwing (a body that cannot be serialised ⇒ NOT_AVAILABLE). */
export function wireBodySha256Of(req: Pick<BuiltRequest, 'body'>): InstrumentedValue {
  let s: string;
  try { s = wireBody(req); } catch { return { value: NOT_AVAILABLE, reason: 'BODY_SERIALISE_FAILED' }; }
  return wireBodySha256(s);
}

/** Reads the provider's request id from the RESPONSE headers. Only `headers.get(<allow-listed name>)` is called. Never throws. */
export function providerRequestId(provider: Provider, headers: unknown): InstrumentedValue {
  try {
    const one = REQUEST_ID_HEADER[provider];
    const names: readonly string[] = one ? [one] : (ARM_REQUEST_ID_HEADERS[provider] ?? []);
    if (!names.length) return { value: NOT_AVAILABLE, reason: 'NO_HEADER_FOR_PROVIDER' };
    if (headers === null || headers === undefined) return { value: NOT_AVAILABLE, reason: 'NO_HEADERS' };
    const get = (headers as { get?: unknown }).get;
    if (typeof get !== 'function') return { value: NOT_AVAILABLE, reason: 'NO_HEADERS' };
    let v: unknown = null;
    for (const name of names) { v = (get as (n: string) => unknown).call(headers, name); if (v !== null && v !== undefined && v !== '') break; }
    if (v === null || v === undefined || v === '') return { value: NOT_AVAILABLE, reason: 'HEADER_ABSENT' };
    if (typeof v !== 'string' || !REQUEST_ID_RE.test(v)) return { value: NOT_AVAILABLE, reason: 'FORMAT_INVALID' };
    return { value: v, reason: null };
  } catch { return { value: NOT_AVAILABLE, reason: 'HEADER_READ_FAILED' }; }
}

/** Request id of an egress response: the value egress already derived (REAL: `providerRequestId`, re-validated) or else `headers` of the object (OFFLINE double). Never throws. */
export function providerRequestIdFromResponse(provider: Provider, res: unknown): InstrumentedValue {
  try {
    if (res === null || res === undefined || typeof res !== 'object') return { value: NOT_AVAILABLE, reason: 'NO_HEADERS' };
    const pre: unknown = (res as { providerRequestId?: unknown }).providerRequestId;
    if (pre !== undefined) {
      const q = pre as { value?: unknown; reason?: unknown } | null;
      if (q && q.reason === null && typeof q.value === 'string' && REQUEST_ID_RE.test(q.value)) return { value: q.value, reason: null };
      if (q && q.value === NOT_AVAILABLE && typeof q.reason === 'string' && /^[A-Z_]{1,40}$/.test(q.reason)) return { value: NOT_AVAILABLE, reason: q.reason };
      return { value: NOT_AVAILABLE, reason: 'FORMAT_INVALID' };
    }
    return providerRequestId(provider, (res as { headers?: unknown }).headers);
  } catch { return { value: NOT_AVAILABLE, reason: 'HEADER_READ_FAILED' }; }
}

/** Journal fields (flat; the reason only when NOT_AVAILABLE). */
export const wireFields = (w: InstrumentedValue): Record<string, string> => (w.reason === null ? { wireBodySha256: w.value } : { wireBodySha256: w.value, wireBodySha256Reason: w.reason });
export const requestIdFields = (r: InstrumentedValue): Record<string, string> => (r.reason === null ? { providerRequestId: r.value } : { providerRequestId: r.value, providerRequestIdReason: r.reason });
