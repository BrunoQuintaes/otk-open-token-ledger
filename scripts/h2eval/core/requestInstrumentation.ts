/**
 * E1‴ (C160, R-INST prospectivo no executor científico). Pure core (imports node:crypto only; desenho de referência: Bot B8 `requestInstrumentation.js`).
 * For every NEW operation sent it yields two forensic facts, never anything else:
 *   1. wireBodySha256: sha256 of the EXACT bytes of the request body handed to the transport (UTF-8 of `wireBody(req)`, the same string `egress.send` passes to fetch/double);
 *   2. providerRequestId: the provider's request id read from ONE allow-listed RESPONSE header (Anthropic: `request-id`), or 'NOT_AVAILABLE' with a reason.
 * Rules: no personal data, no secret. Request headers are never touched; response headers are read only through `get(<allow-listed name>)` (never iterated),
 * so the authorization/credential header is never read. Every function here NEVER throws: a failure yields 'NOT_AVAILABLE' + a fixed reason code.
 * It never changes what is sent nor the result: the transport receives the same string, and the response object is returned unchanged.
 *
 * In short: records, for each sent request, the SHA-256 of the exact body bytes and the provider's request id taken
 * from one allow-listed response header, so a call can later be matched with the provider's records. Used by the
 * egress (`./egress.ts`) and the runner (`./runner.ts`).
 *
 * @module scripts/h2eval/core/requestInstrumentation
 */
import { createHash } from 'node:crypto';
import type { BuiltRequest, Provider } from '../types.js';

/** Placeholder value recorded when a fact could not be obtained. */
export const NOT_AVAILABLE = 'NOT_AVAILABLE' as const;
/** A recorded fact: a value with `reason: null`, or `NOT_AVAILABLE` with a fixed upper-case reason code. */
export type InstrumentedValue = { value: string; reason: null } | { value: typeof NOT_AVAILABLE; reason: string };

/**
 * The exact body string handed to the transport. `egress.send` uses THIS function, so the hash below is the hash of the bytes sent.
 *
 * @param req - The built request (only its body is read).
 * @returns `JSON.stringify` of the body.
 */
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

/**
 * sha256 (hex) of the UTF-8 bytes of the wire body. Never throws.
 *
 * @param bytes - The wire body string.
 * @returns The digest, or `NOT_AVAILABLE` with `BODY_NOT_STRING` or `HASH_FAILED`.
 */
export function wireBodySha256(bytes: unknown): InstrumentedValue {
  try {
    if (typeof bytes !== 'string') return { value: NOT_AVAILABLE, reason: 'BODY_NOT_STRING' };
    return { value: createHash('sha256').update(Buffer.from(bytes, 'utf8')).digest('hex'), reason: null };
  } catch { return { value: NOT_AVAILABLE, reason: 'HASH_FAILED' }; }
}

/**
 * sha256 of `wireBody(req)`, computed without throwing (a body that cannot be serialised ⇒ NOT_AVAILABLE).
 *
 * @param req - The built request.
 * @returns The digest, or `NOT_AVAILABLE` with a reason code.
 */
export function wireBodySha256Of(req: Pick<BuiltRequest, 'body'>): InstrumentedValue {
  let s: string;
  try { s = wireBody(req); } catch { return { value: NOT_AVAILABLE, reason: 'BODY_SERIALISE_FAILED' }; }
  return wireBodySha256(s);
}

/**
 * Reads the provider's request id from the RESPONSE headers. Only `headers.get(<allow-listed name>)` is called. Never throws.
 *
 * @param provider - Provider of the call (selects the allow-listed header names).
 * @param headers - A `Headers`-like object with a `get` method.
 * @returns The request id (up to 128 characters of a safe alphabet), or `NOT_AVAILABLE` with `NO_HEADER_FOR_PROVIDER`,
 *   `NO_HEADERS`, `HEADER_ABSENT`, `FORMAT_INVALID` or `HEADER_READ_FAILED`.
 */
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

/**
 * Request id of an egress response: the value egress already derived (REAL: `providerRequestId`, re-validated) or else `headers` of the object (OFFLINE double). Never throws.
 *
 * @param provider - Provider of the call.
 * @param res - The egress response object.
 * @returns The request id, or `NOT_AVAILABLE` with a reason code.
 */
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

/**
 * Journal fields (flat; the reason only when NOT_AVAILABLE).
 *
 * @param w - The body-hash fact.
 * @returns `{ wireBodySha256 }`, plus `wireBodySha256Reason` when not available.
 */
export const wireFields = (w: InstrumentedValue): Record<string, string> => (w.reason === null ? { wireBodySha256: w.value } : { wireBodySha256: w.value, wireBodySha256Reason: w.reason });
/**
 * Journal fields of the request id (flat; the reason only when NOT_AVAILABLE).
 *
 * @param r - The request-id fact.
 * @returns `{ providerRequestId }`, plus `providerRequestIdReason` when not available.
 */
export const requestIdFields = (r: InstrumentedValue): Record<string, string> => (r.reason === null ? { providerRequestId: r.value } : { providerRequestId: r.value, providerRequestIdReason: r.reason });
