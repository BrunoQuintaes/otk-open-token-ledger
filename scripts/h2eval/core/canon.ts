/**
 * Canonical JSON (sorted keys, no whitespace) and sha256, shared by journal, snapshot and ids.
 *
 * The canonical form makes hashes reproducible across processes: object keys are sorted, `undefined` fields are
 * dropped, BigInt values become decimal strings and non-finite numbers are refused. Pure; no I/O.
 *
 * @module scripts/h2eval/core/canon
 */
import { createHash } from 'node:crypto';

/**
 * Serializes a value to canonical JSON.
 *
 * @param v - Any JSON-like value; BigInt is written as a quoted decimal string. Not mutated.
 * @returns The canonical JSON text.
 * @throws {TypeError} When the value contains NaN or an infinite number.
 * @example
 * canon({ b: 1, a: [2n, null] }); // '{"a":["2",null],"b":1}'
 */
export function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'bigint') return JSON.stringify(v.toString());
    if (typeof v === 'number' && !Number.isFinite(v)) throw new TypeError('canon: non-finite number');
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(',')}}`;
}

/**
 * SHA-256 of a string (UTF-8) or bytes.
 *
 * @param s - Text or bytes.
 * @returns Lowercase hex digest.
 */
export const sha256Hex = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');
/**
 * SHA-256 of the canonical JSON of a value.
 *
 * @param v - Any JSON-like value.
 * @returns Lowercase hex digest.
 * @throws {TypeError} When the value contains a non-finite number.
 */
export const sha256Canon = (v: unknown): string => sha256Hex(canon(v));
