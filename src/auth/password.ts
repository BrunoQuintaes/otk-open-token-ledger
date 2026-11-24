/**
 * Password hashing and verification using Node.js crypto.scrypt (P3.1)
 *
 * Zero external dependencies — uses built-in crypto module.
 * Format: "scrypt:<salt_hex>:<derived_hex>"
 *
 * @module auth/password
 * @since Wave 3E (PACK 3E-01)
 */

import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_LEN = 16;
const SCRYPT_COST = 16384;
const SCRYPT_BLOCK_SIZE = 8;
const SCRYPT_PARALLELISM = 1;

/**
 * Hash a password using scrypt.
 * Returns "scrypt:<salt_hex>:<derived_hex>"
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(SCRYPT_SALT_LEN);
  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM,
    }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });
  return `scrypt:${salt.toString('hex')}:${derived.toString('hex')}`;
}

/**
 * Verify a password against a stored hash.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const parts = storedHash.split(':');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;

  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');

  const derived = await new Promise<Buffer>((resolve, reject) => {
    crypto.scrypt(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_COST, r: SCRYPT_BLOCK_SIZE, p: SCRYPT_PARALLELISM,
    }, (err, key) => {
      if (err) reject(err); else resolve(key);
    });
  });

  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

/**
 * F-H1-09 (H1 lane B): hash stored by no user. /login verifies the presented password against it when the e-mail is
 * unknown (or the user has no password), so that both "no such user" and "wrong password" cost one scrypt: answering an
 * unknown e-mail without hashing made the response time an oracle for account existence. Never matches (the derived
 * part is random and is not derived from any password).
 */
const DUMMY_HASH = `scrypt:${crypto.randomBytes(SCRYPT_SALT_LEN).toString('hex')}:${crypto.randomBytes(SCRYPT_KEYLEN).toString('hex')}`;

/** Run the same scrypt work as verifyPassword for a user that does not exist. Always false. */
export async function verifyPasswordForUnknownUser(password: string): Promise<false> {
  await verifyPassword(password, DUMMY_HASH);
  return false;
}
