/** Canonical JSON (sorted keys, no whitespace) and sha256, shared by journal, snapshot and ids. */
import { createHash } from 'node:crypto';

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

export const sha256Hex = (s: string | Uint8Array): string => createHash('sha256').update(s).digest('hex');
export const sha256Canon = (v: unknown): string => sha256Hex(canon(v));
