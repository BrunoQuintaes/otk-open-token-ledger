/**
 * Canonical Receipt Encoder V1 (OTK_RECEIPT_V1)
 *
 * Implements the normative encoding defined in:
 *   docs/architecture/U2_RECEIPT_CANON_SPEC.md
 *
 * Encoding: DOMAIN || 0x1f || field1 || 0x1f || ... || fieldN
 * Hashing:  keccak256(canonical_bytes)
 *
 * @module canonicalReceiptV1
 * @since U2.4
 */

import { ethers } from 'ethers';

/** Domain separator (ASCII). Frozen — increment version if format changes. */
export const RECEIPT_DOMAIN_V1 = 'OTK_RECEIPT_V1';

/** Unit separator byte (ASCII 0x1f) used between fields. */
export const FIELD_SEPARATOR = 0x1f;

/** Canonical receipt fields (all bigint for ZK-compat; order FROZEN per spec §1). */
export interface CanonicalReceiptV1 {
  provider: string;
  model: string;
  input_tokens: bigint;
  output_tokens: bigint;
  total_tokens: bigint;
  latency_ms: bigint;
  cost_unit: bigint;
  user_id: string;
  project_id: string;
  timestamp: bigint;  // unix ms
  nonce: bigint;
  epoch: bigint;      // derived: floor(timestamp_sec / EPOCH_WINDOW_SECONDS)
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function assertNonEmpty(name: string, v: string): void {
  if (!v || v.length === 0) {
    throw new Error(`CanonicalReceiptV1: '${name}' must be non-empty`);
  }
}

function bigintToDec(b: bigint): string {
  if (b < 0n) {
    throw new Error(`CanonicalReceiptV1: bigint must be non-negative, got ${b}`);
  }
  return b.toString(10); // base-10, no leading '+', no leading zeros (toString handles this)
}

function appendUtf8(arr: number[], s: string): void {
  const bytes = ethers.toUtf8Bytes(s);
  for (const byte of bytes) arr.push(byte);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode a CanonicalReceiptV1 to its canonical byte representation.
 *
 * Format: DOMAIN || 0x1f || f1 || 0x1f || f2 || ... || fN
 * (no trailing separator)
 *
 * @throws if validation fails (empty required fields, negative bigints,
 *         total_tokens mismatch)
 * @param r - Receipt fields (not modified); strings are written as UTF-8 without escaping, so a string that
 *   contains the 0x1f separator would make two encodings ambiguous (no check is made for it).
 * @returns The canonical bytes.
 */
export function encodeCanonicalReceiptV1Bytes(r: CanonicalReceiptV1): Uint8Array {
  // Validate required strings
  assertNonEmpty('provider', r.provider);
  assertNonEmpty('model', r.model);
  assertNonEmpty('user_id', r.user_id);
  assertNonEmpty('project_id', r.project_id);

  // Validate total_tokens invariant
  if (r.total_tokens !== r.input_tokens + r.output_tokens) {
    throw new Error(
      `CanonicalReceiptV1: total_tokens (${r.total_tokens}) must equal ` +
      `input_tokens (${r.input_tokens}) + output_tokens (${r.output_tokens})`
    );
  }

  // Build ordered field strings (spec §1, order frozen)
  const fields: string[] = [
    r.provider,
    r.model,
    bigintToDec(r.input_tokens),
    bigintToDec(r.output_tokens),
    bigintToDec(r.total_tokens),
    bigintToDec(r.latency_ms),
    bigintToDec(r.cost_unit),
    r.user_id,
    r.project_id,
    bigintToDec(r.timestamp),
    bigintToDec(r.nonce),
    bigintToDec(r.epoch),
  ];

  // Assemble: DOMAIN + sep + field[0] + sep + field[1] + ... + field[N-1]
  const out: number[] = [];
  appendUtf8(out, RECEIPT_DOMAIN_V1);
  for (let i = 0; i < fields.length; i++) {
    out.push(FIELD_SEPARATOR);
    appendUtf8(out, fields[i]);
  }

  return Uint8Array.from(out);
}

/**
 * Compute the canonical keccak256 hash of a CanonicalReceiptV1.
 *
 * This is the `raw_hash` that the runtime MUST sign (per spec §3).
 *
 * @returns 0x-prefixed hex string (66 chars)
 * @param r - Receipt fields.
 * @throws {Error} The validation errors of {@link encodeCanonicalReceiptV1Bytes}.
 */
export function hashCanonicalReceiptV1(r: CanonicalReceiptV1): string {
  const bytes = encodeCanonicalReceiptV1Bytes(r);
  return ethers.keccak256(bytes);
}
