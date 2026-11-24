/**
 * Deterministic JSON used by front B for digests (raw usage, weights tables, price tables).
 * Object keys sorted at every depth, no whitespace, bigint as a decimal string, undefined
 * members dropped. Non-finite numbers are refused instead of collapsing to null.
 * This is not A's signing encoding; it only feeds B's own sha256 digests.
 */
import { createHash } from 'node:crypto';
import type { Hex32 } from '../../types/d1d8/index.js';

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

export function sha256Hex(data: string): Hex32 {
  return `0x${createHash('sha256').update(data, 'utf8').digest('hex')}`;
}

/** sha256 of canonicalJson(value); values that cannot be encoded hash their tagged String(). */
export function digestOf(value: unknown): Hex32 {
  try {
    return sha256Hex(canonicalJson(value));
  } catch {
    return sha256Hex(`otk.uncanonical:${String(value)}`);
  }
}
