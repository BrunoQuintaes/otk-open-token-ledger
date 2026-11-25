/**
 * Deterministic JSON used by front B for digests (raw usage, weights tables, price tables).
 * Object keys sorted at every depth, no whitespace, bigint as a decimal string, undefined
 * members dropped. Non-finite numbers are refused instead of collapsing to null.
 * This is not A's signing encoding; it only feeds B's own sha256 digests.
 *
 * Imported by `src/economics/cuWeightsV2.ts` and `src/pricing/priceUsage.ts` (weights and price table digests)
 * and by the usage normalizer in this folder. Pure functions; no I/O.
 *
 * @module src/providers/usage/canonicalJson
 */
import { createHash } from 'node:crypto';
import type { Hex32 } from '../../types/d1d8/index.js';

/**
 * Encodes a value as deterministic JSON (sorted keys, no whitespace).
 *
 * @param value - Value to encode: null, boolean, finite number, bigint, string, array or plain object.
 *   `undefined` object members are dropped; `undefined` inside an array is not supported.
 * @returns The canonical JSON text.
 * @throws {Error} When a number is not finite or a value has an unsupported type (function, symbol, undefined).
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'bigint') return JSON.stringify(value.toString());
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('canonicalJson: non-finite number');
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

/**
 * Hashes a string as UTF-8 with SHA-256.
 *
 * @param data - Text to hash.
 * @returns The digest as `0x` followed by 64 lowercase hex characters.
 */
export function sha256Hex(data: string): Hex32 {
  return `0x${createHash('sha256').update(data, 'utf8').digest('hex')}`;
}

/**
 * sha256 of canonicalJson(value); values that cannot be encoded hash their tagged String().
 *
 * @param value - Any value.
 * @returns The `0x`-prefixed SHA-256 hex digest; never throws.
 */
export function digestOf(value: unknown): Hex32 {
  try {
    return sha256Hex(canonicalJson(value));
  } catch {
    return sha256Hex(`otk.uncanonical:${String(value)}`);
  }
}
