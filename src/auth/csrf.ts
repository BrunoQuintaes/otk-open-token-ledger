/**
 * H6.3 — CSRF Protection
 *
 * HMAC-SHA256 CSRF tokens tied to session ID.
 * Validates on state-changing dashboard form submissions.
 *
 * @module auth/csrf
 * @since Wave 2H (H6.3)
 */

import crypto from 'node:crypto';
import { isDeployedEnv } from '../infra/deployEnv.js'; // RV2-RUNS-02 (RUN-S): same rule as the auth guard

// SEC-03: In production, OTK_CSRF_SECRET must be explicitly set.
// Per-process random fallback breaks CSRF validation across replicas and restarts.
const _envCsrfSecret = process.env['OTK_CSRF_SECRET'];
if (!_envCsrfSecret && isDeployedEnv()) {
  throw new Error('[SEC-03] OTK_CSRF_SECRET is required in production. Set it to a stable shared secret.');
}
let _csrfSecret = _envCsrfSecret ?? crypto.randomBytes(32).toString('hex');

/**
 * Generate a CSRF token for a given session ID.
 * Token = HMAC-SHA256(sessionId, secret) — not predictable without the secret.
 */
export function generateCsrfToken(sessionId: string): string {
  return crypto.createHmac('sha256', _csrfSecret).update(sessionId).digest('hex');
}

/**
 * Validate a CSRF token against a session ID.
 * Uses timing-safe comparison to prevent timing attacks.
 */
/** Reset CSRF secret (for tests). */
export function resetCsrfForTest(secret?: string): void {
  _csrfSecret = secret ?? crypto.randomBytes(32).toString('hex');
}

export function validateCsrfToken(token: string, sessionId: string): boolean {
  const expected = generateCsrfToken(sessionId);
  if (token.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}
