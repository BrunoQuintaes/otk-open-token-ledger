/**
 * CE1 — canonical typed encoding for signed OTK payloads (receipt v3, conference v1, envelope).
 * Specification: docs/_ops/EXECUCAO_D1_D8_20260930/runs/20260930-1625/A/01_design.md §5.
 *
 *   null   00
 *   false  01            true 02
 *   bigint 03 ‖ sign(00 | 01) ‖ u32be(len) ‖ magnitude big-endian, minimal (0 → len 0)
 *   string 04 ‖ u32be(len) ‖ UTF-8 bytes
 *   array  05 ‖ u32be(count) ‖ items
 *   object 06 ‖ u32be(count) ‖ (string key, value)… with keys sorted by their UTF-8 bytes
 *
 * JS numbers, undefined, functions and symbols are refused: "absent" must be an explicit null and
 * integers must be bigint, so nothing is silently dropped, rounded or turned into 0.
 *
 * Used by `receiptCrypto.ts` (digests of receipt v3, conference report, statements and the signature
 * envelope). Pure functions; no I/O.
 *
 * @module src/receipt/v3/canonicalEncoding
 */
import { ethers } from 'ethers';

/**
 * Raised when a value cannot be encoded in CE1; `path` points to the offending member (empty for the root).
 */
export class CanonicalEncodingError extends Error {
  constructor(readonly path: string, message: string) {
    super(`CE1 ${path || '<root>'}: ${message}`);
    this.name = 'CanonicalEncodingError';
  }
}

const TAG = { null: 0x00, false: 0x01, true: 0x02, bigint: 0x03, string: 0x04, array: 0x05, object: 0x06 } as const;
const MAX_U32 = 0xffffffff;

function u32(n: number, path: string): number[] {
  if (!Number.isInteger(n) || n < 0 || n > MAX_U32) throw new CanonicalEncodingError(path, 'length out of u32 range');
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

function utf8(s: string, path: string): Uint8Array {
  // ethers.toUtf8Bytes throws on lone surrogates instead of replacing them.
  try {
    return ethers.toUtf8Bytes(s);
  } catch {
    throw new CanonicalEncodingError(path, 'string is not valid UTF-16 (lone surrogate)');
  }
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

function encodeInto(out: number[], v: unknown, path: string): void {
  if (v === null) { out.push(TAG.null); return; }
  switch (typeof v) {
    case 'boolean':
      out.push(v ? TAG.true : TAG.false);
      return;
    case 'bigint': {
      const neg = v < 0n;
      const mag = neg ? -v : v;
      const hex = mag === 0n ? '' : mag.toString(16);
      const bytes = hex === '' ? new Uint8Array(0) : ethers.getBytes('0x' + (hex.length % 2 ? '0' + hex : hex));
      out.push(TAG.bigint, neg ? 0x01 : 0x00, ...u32(bytes.length, path));
      for (const b of bytes) out.push(b);
      return;
    }
    case 'string': {
      const bytes = utf8(v, path);
      out.push(TAG.string, ...u32(bytes.length, path));
      for (const b of bytes) out.push(b);
      return;
    }
    case 'object': {
      if (Array.isArray(v)) {
        if (Object.keys(v).length !== v.length) throw new CanonicalEncodingError(path, 'array with holes or extra properties is not encodable');
        out.push(TAG.array, ...u32(v.length, path));
        // Index loop, not forEach: a hole in a sparse array reads as undefined and is refused,
        // so the declared count always equals the number of encoded items.
        for (let i = 0; i < v.length; i++) encodeInto(out, v[i], `${path}[${i}]`);
        return;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) {
        throw new CanonicalEncodingError(path, 'only plain objects, arrays and primitives are encodable');
      }
      const entries = Object.keys(v as object).map((k) => ({ k, kb: utf8(k, `${path}.${k}`) }));
      entries.sort((x, y) => compareBytes(x.kb, y.kb));
      out.push(TAG.object, ...u32(entries.length, path));
      for (const { k, kb } of entries) {
        out.push(TAG.string, ...u32(kb.length, path));
        for (const b of kb) out.push(b);
        encodeInto(out, (v as Record<string, unknown>)[k], path ? `${path}.${k}` : k);
      }
      return;
    }
    case 'number':
      throw new CanonicalEncodingError(path, 'JS number is not encodable; use bigint for integers');
    case 'undefined':
      throw new CanonicalEncodingError(path, 'undefined is not encodable; absent values must be null');
    default:
      throw new CanonicalEncodingError(path, `${typeof v} is not encodable`);
  }
}

/**
 * CE1 bytes of a value.
 *
 * @param v - Value made only of null, booleans, bigints, strings, dense arrays and plain objects.
 * @returns The CE1 bytes.
 * @throws {@link CanonicalEncodingError} When the value (or a nested member) is a JS number, `undefined`, a
 *   function, symbol, non-plain object, sparse array, a string with a lone surrogate, or a length above 2^32-1.
 */
export function encodeCE1(v: unknown): Uint8Array {
  const out: number[] = [];
  encodeInto(out, v, '');
  return Uint8Array.from(out);
}

/**
 * keccak256(utf8(domain) ‖ 0x00 ‖ CE1(payload)). Domain must be non-empty ASCII without NUL.
 *
 * @param domain - Domain label: printable ASCII (0x21-0x7e), non-empty, no spaces.
 * @param payload - Value to encode with {@link encodeCE1}.
 * @returns The keccak256 digest as `0x` plus 64 lowercase hex characters.
 * @throws {@link CanonicalEncodingError} When the domain is not printable ASCII or the payload is not encodable.
 */
export function domainDigest(domain: string, payload: unknown): `0x${string}` {
  if (!/^[\x21-\x7e]+$/.test(domain)) throw new CanonicalEncodingError('', 'domain must be printable ASCII');
  return ethers.keccak256(ethers.concat([ethers.toUtf8Bytes(domain), new Uint8Array([0x00]), encodeCE1(payload)])) as `0x${string}`;
}
