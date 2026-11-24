/**
 * D1–D8 / C — deterministic identities: request digest, effect ids and payload digests.
 *
 * The request digest covers only metering-relevant fields of the admitted request, never the
 * prompt text (D2 §6: a deterministic hash of small-domain text leaks). Same operation id with a
 * different digest is a conflict, never an overwrite (D3-G06).
 *
 * @module operations/ids
 */
import { createHash } from 'node:crypto';
import type { Hex32, OperationKey, OutboxEffect } from '../types/d1d8/index.js';
import { encodeJson } from './codec.js';

export function sha256Hex(text: string): Hex32 {
  return `0x${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/** Canonical JSON: keys sorted at every level, bigint as decimal string. */
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

export const REQUEST_DIGEST_V1 = 'otk.request_digest.v1' as const;
export const REQUEST_DIGEST_V2 = 'otk.request_digest.v2' as const;
export type RequestDigestVersion = typeof REQUEST_DIGEST_V1 | typeof REQUEST_DIGEST_V2;

/**
 * v1: computed over the body the OTK FORWARDS (after its own injections: default output limit,
 * stream_options.include_usage, service_tier). An OTK release that changes an injection therefore
 * changes the digest of the same client request (OVERNIGHT 20261005 / P0 identity-across-versions).
 * Kept for recognizing operations admitted by earlier releases; new operations use v2.
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

export const requestDigestV2 = (f: ClientRequestFields): Hex32 =>
  sha256Hex(canonicalJson({ v: REQUEST_DIGEST_V2, ...f }));

/** `${kind}:${tenant}:${operation}` with both parts URI-encoded (':' cannot collide). */
export function effectId(kind: OutboxEffect['kind'] | 'debit', key: OperationKey): string {
  return `${kind}:${encodeURIComponent(key.tenantId)}:${encodeURIComponent(key.operationId)}`;
}

export const payloadDigest = (payload: unknown): Hex32 => sha256Hex(encodeJson(payload));
