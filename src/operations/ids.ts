/**
 * D1–D8 / C — deterministic identities: request digest, effect ids and payload digests.
 *
 * The request digest covers only metering-relevant fields of the admitted request, never the
 * prompt text (D2 §6: a deterministic hash of small-domain text leaks). Same operation id with a
 * different digest is a conflict, never an overwrite (D3-G06).
 *
 * Pure functions; changing any of them changes stored identities and breaks matching with existing rows.
 *
 * @module src/operations/ids
 */
import { createHash } from 'node:crypto';
import type { Hex32, OperationKey, OutboxEffect } from '../types/d1d8/index.js';
import { encodeJson } from './codec.js';

/**
 * SHA-256 of a UTF-8 string.
 *
 * @param text - Input text.
 * @returns `0x` followed by 64 lower-case hex characters.
 */
export function sha256Hex(text: string): Hex32 {
  return `0x${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * Canonical JSON: keys sorted at every level, bigint as decimal string.
 *
 * Undefined properties are dropped. Keys are sorted by UTF-16 code unit order (`Array.prototype.sort`).
 *
 * @param value - Any JSON-like value; not mutated.
 * @returns Deterministic JSON text.
 */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (typeof v === 'bigint') return v.toString(10);
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(sort);
    return Object.fromEntries(Object.keys(v as object).sort()
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .map((k) => [k, sort((v as Record<string, unknown>)[k])]));
  };
  return JSON.stringify(sort(value));
}

/** Inputs of the v1 request digest: metering-relevant fields of the FORWARDED request (no prompt text). */
export interface MeteringRequestFields {
  provider: string;
  api: string;
  path: string;
  modelRequested: string;
  maxOutputTokens: bigint;
  stream: boolean;
  /** Byte length of the request body (not its content). */
  bodyBytes: number;
}

/** Version id of the digest over the forwarded request (earlier releases). */
export const REQUEST_DIGEST_V1 = 'otk.request_digest.v1' as const;
/** Version id of the digest over the request as the client sent it (current). */
export const REQUEST_DIGEST_V2 = 'otk.request_digest.v2' as const;
/** Either request digest version id. */
export type RequestDigestVersion = typeof REQUEST_DIGEST_V1 | typeof REQUEST_DIGEST_V2;

/**
 * v1: computed over the body the OTK FORWARDS (after its own injections: default output limit,
 * stream_options.include_usage, service_tier). An OTK release that changes an injection therefore
 * changes the digest of the same client request (OVERNIGHT 20261005 / P0 identity-across-versions).
 * Kept for recognizing operations admitted by earlier releases; new operations use v2.
 *
 * @param f - Fields of the forwarded request.
 * @returns SHA-256 of the canonical JSON of the fields plus the version id.
 */
export const requestDigest = (f: MeteringRequestFields): Hex32 =>
  sha256Hex(canonicalJson({ v: REQUEST_DIGEST_V1, ...f }));

/**
 * v2 — identity of the request AS THE CLIENT SENT IT, independent of what the OTK adds before
 * forwarding: the client's own output limit (null when absent, so a change of the OTK default
 * does not change the identity) and the byte length of the client's parsed body re-serialized
 * before any OTK injection. Still never the prompt text (D2 §6). The client remains responsible
 * for not reusing an operation id for a different request of identical shape.
 */
export interface ClientRequestFields {
  provider: string;
  api: string;
  path: string;
  modelRequested: string;
  /** Output limit written by the client; null when the OTK default applies. */
  clientMaxOutputTokens: bigint | null;
  stream: boolean;
  /** Byte length of JSON.stringify(client body) before any OTK change. */
  clientBodyBytes: number;
}

/**
 * v2 request digest (see {@link ClientRequestFields}).
 *
 * @param f - Fields of the request as the client sent it.
 * @returns SHA-256 of the canonical JSON of the fields plus the version id.
 */
export const requestDigestV2 = (f: ClientRequestFields): Hex32 =>
  sha256Hex(canonicalJson({ v: REQUEST_DIGEST_V2, ...f }));

/**
 * `${kind}:${tenant}:${operation}` with both parts URI-encoded (':' cannot collide).
 *
 * One id per (kind, operation): enqueuing the same effect twice is deduplicated by the outbox.
 *
 * @param kind - Effect kind, or `'debit'` for the ledger identity of a settlement.
 * @param key - Tenant and operation id.
 * @returns The effect id.
 */
export function effectId(kind: OutboxEffect['kind'] | 'debit', key: OperationKey): string {
  return `${kind}:${encodeURIComponent(key.tenantId)}:${encodeURIComponent(key.operationId)}`;
}

/**
 * Digest of an effect payload.
 *
 * Uses the codec's JSON (insertion key order), not {@link canonicalJson}: the same payload built with a
 * different key order gets a different digest.
 *
 * @param payload - The payload.
 * @returns SHA-256 of its JSON encoding.
 */
export const payloadDigest = (payload: unknown): Hex32 => sha256Hex(encodeJson(payload));
