/**
 * Email verification token generation + validation (P3.1)
 *
 * HMAC-SHA256 based tokens with embedded expiry.
 * Format: "<userId>.<expiryUnix>.<hmac_hex>"
 *
 * @module auth/emailVerification
 * @since Wave 3E (PACK 3E-01)
 */

import crypto from 'node:crypto';
import { getCachedJwtSecret } from '../infra/secretsBootstrap.js';

const DEFAULT_EXPIRY_HOURS = 24;

function getSecret(): string {
  const secret = getCachedJwtSecret();
  if (!secret) throw new Error('OTK_JWT_SECRET is required for email verification');
  return secret;
}

/**
 * Generate an email verification token.
 * Token is URL-safe and expires after `expiryHours`.
 */
export function generateVerificationToken(userId: string, expiryHours = DEFAULT_EXPIRY_HOURS): string {
  const expiry = Math.floor(Date.now() / 1000) + expiryHours * 3600;
  const payload = `${userId}.${expiry}`;
  const hmac = crypto.createHmac('sha256', getSecret())
    .update(payload)
    .digest('hex');
  return `${payload}.${hmac}`;
}

/**
 * Validate a verification token.
 * Returns the userId if valid and not expired, null otherwise.
 */
export function validateVerificationToken(token: string): string | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [userId, expiryStr, providedHmac] = parts;
  const expiry = Number(expiryStr);
  if (isNaN(expiry)) return null;

  // Check expiry
  if (Math.floor(Date.now() / 1000) > expiry) return null;

  // Verify HMAC
  const payload = `${userId}.${expiryStr}`;
  const expectedHmac = crypto.createHmac('sha256', getSecret())
    .update(payload)
    .digest('hex');

  // Validate hex format before conversion
  if (!/^[0-9a-f]{64}$/.test(providedHmac)) return null;

  // Timing-safe comparison
  const a = Buffer.from(providedHmac, 'hex');
  const b = Buffer.from(expectedHmac, 'hex');
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;

  return userId;
}
