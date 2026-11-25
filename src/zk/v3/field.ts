/**
 * BN254 scalar field helpers for metering_v3 (D2 §2–3).
 *
 * Every value that enters the circuit is validated here as a canonical decimal string of an
 * integer in range. The circuit's own Num2Bits(64) constraints stay the authority; these checks
 * reject bad external input early instead of relying on silent reduction modulo r.
 *
 * @module src/zk/v3/field
 */
import { randomBytes } from 'node:crypto';

/** BN254 (alt_bn128) scalar field order r. */
export const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Exclusive upper bound of usage/minUsage/maxUsage/epoch in metering_v3 (Num2Bits(64)). */
export const U64_LIMIT = 1n << 64n;

/** Canonical decimal: "0" or a non-empty run of digits without leading zero. */
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;

/**
 * Raised when a value that would enter the circuit is not canonical or out of range; `field` names it.
 */
export class FieldInputError extends Error {
  constructor(readonly field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'FieldInputError';
  }
}

/**
 * Parses a canonical decimal string; rejects signs, spaces, hex, leading zeros.
 *
 * @param field - Name used in the error message.
 * @param s - Decimal text.
 * @returns The value.
 * @throws {@link FieldInputError} When `s` is not a canonical non-negative decimal string.
 */
export function parseCanonicalDecimal(field: string, s: string): bigint {
  if (typeof s !== 'string' || !CANONICAL_DECIMAL.test(s)) {
    throw new FieldInputError(field, 'not a canonical non-negative decimal string');
  }
  return BigInt(s);
}

/**
 * Validates a field element given as decimal string (0 ≤ x < r) and returns it as bigint.
 *
 * @param field - Name used in the error message.
 * @param s - Decimal text.
 * @returns The value.
 * @throws {@link FieldInputError} When `s` is not canonical or not below the BN254 scalar field order.
 */
export function parseFieldElement(field: string, s: string): bigint {
  const v = parseCanonicalDecimal(field, s);
  if (v >= BN254_R) throw new FieldInputError(field, 'not below the BN254 scalar field order');
  return v;
}

/**
 * Validates an unsigned 64-bit value (0 ≤ x < 2^64).
 *
 * @param field - Name used in the error message.
 * @param v - Value to check.
 * @returns `v` unchanged.
 * @throws {@link FieldInputError} When `v` is not a bigint or is outside [0, 2^64).
 */
export function assertU64(field: string, v: bigint): bigint {
  if (typeof v !== 'bigint') throw new FieldInputError(field, 'must be a bigint');
  if (v < 0n || v >= U64_LIMIT) throw new FieldInputError(field, 'outside [0, 2^64)');
  return v;
}

/**
 * Uniform random element of F_r from the OS CSPRNG, by rejection sampling on 254-bit draws
 * (acceptance ≈ 0.76 per draw). No seed parameter exists on purpose: a blinding value must never
 * be derived from a nonce, date, request id or public seed (D2 §2).
 *
 * @returns A random value in [0, r).
 */
export function randomFieldElement(): bigint {
  for (;;) {
    const b = randomBytes(32);
    b[0] = b[0]! & 0x3f; // keep 254 bits
    const v = BigInt('0x' + b.toString('hex'));
    if (v < BN254_R) return v;
  }
}
