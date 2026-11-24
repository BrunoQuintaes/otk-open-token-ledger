/**
 * H3.1 / H3.3 — JWT Token Management
 *
 * Signs, verifies, and blacklists JWT tokens.
 * Uses HMAC-SHA256 (HS256) with OTK_JWT_SECRET.
 * No external JWT library — uses native crypto for minimal dependencies.
 *
 * @module auth/jwt
 * @since Wave 2H (H3.1)
 * @since S0 SEC-01 — Redis-backed JWT blacklist (falls back to in-memory)
 */

import crypto from 'node:crypto';
import { getRedisClient } from '../infra/redis/redisClient.js';

export interface JWTPayload {
  sub: string;        // tenantId
  role: string;       // TenantRole
  iat: number;        // issued at (epoch seconds)
  exp: number;        // expiry (epoch seconds)
  jti: string;        // unique token ID
  teamId?: string;    // TEAM-04: optional team context for proxy routing
  tenantId?: string;  // set by SSO login (SAML nameId); already emitted, now typed
  userId?: string;    // set by signup/login; already emitted, now typed
}

// ── Base64url helpers ──
function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlEncode(str: string): string {
  return b64url(Buffer.from(str));
}

function b64urlDecode(str: string): string {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString();
}

// ── Signing ──
function hmacSign(data: string, secret: string): string {
  return b64url(crypto.createHmac('sha256', secret).update(data).digest());
}

/**
 * Sign a JWT token.
 */
export function signToken(payload: Omit<JWTPayload, 'iat' | 'exp' | 'jti'>, secret: string, expiresInS: number): string {
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JWTPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInS,
    jti: crypto.randomUUID(),
  };
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(JSON.stringify(fullPayload));
  const sig = hmacSign(`${header}.${body}`, secret);
  return `${header}.${body}.${sig}`;
}

/**
 * Verify and decode a JWT token. Returns null if invalid/expired/blacklisted.
 */
export function verifyToken(token: string, secret: string): JWTPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;
  const expected = hmacSign(`${header}.${body}`, secret);
  // SEC-11: timing-safe comparison to prevent HMAC oracle timing attacks
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  let payload: JWTPayload;
  try {
    payload = JSON.parse(b64urlDecode(body));
  } catch {
    return null;
  }

  // Check expiry
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;

  // Check blacklist
  if (isBlacklisted(payload.jti)) return null;

  return payload;
}

// ── Blacklist (SEC-01: Redis-backed write-through, in-memory for fast reads) ──
const _BLACKLIST_PREFIX = 'otk:jwt:blacklist:';
const _blacklist = new Map<string, number>(); // jti → expiresAt (ms), always in-memory

/**
 * Blacklist a JWT token by its jti.
 * Writes to Redis (durable, cross-replica) AND in-memory (fast reads).
 * Redis uses EXAT for automatic TTL expiry.
 * @param jti - JWT ID to blacklist
 * @param expiresAt - Token expiry (Unix epoch seconds)
 */
export async function blacklistToken(jti: string, expiresAt: number): Promise<void> {
  // Always update in-memory for fast synchronous reads by verifyToken
  _blacklist.set(jti, expiresAt * 1000);
  // Also write to Redis for persistence and cross-replica consistency (SEC-01)
  const redis = getRedisClient();
  if (redis?.isReady) {
    try {
      await redis.rawClient.set(`${_BLACKLIST_PREFIX}${jti}`, '1', 'EXAT', expiresAt);
    } catch { /* non-fatal: in-memory is source of truth for this replica */ }
  }
}

/**
 * Check if a JWT token is blacklisted (synchronous, in-memory).
 * In-memory is kept in sync by blacklistToken().
 * For cross-replica checks, tokens are verified against Redis at blacklist time.
 */
export function isBlacklisted(jti: string): boolean {
  const exp = _blacklist.get(jti);
  if (!exp) return false;
  if (Date.now() > exp) {
    _blacklist.delete(jti); // expired, clean up
    return false;
  }
  return true;
}

export function clearBlacklistForTest(): void {
  _blacklist.clear();
}

// ── Refresh Tokens (OPS-02) ─────────────────────────────────────────

const REFRESH_TOKEN_EXPIRY_S = 30 * 24 * 60 * 60; // 30 days

interface RefreshTokenPayload {
  tenantId: string;
  /** F-H1-10: the user the refresh token is bound to (absent on legacy, unbound tokens, which /auth/refresh refuses) */
  userId?: string;
  type: 'refresh';
  iat: number;
  exp: number;
  jti: string;
}

/**
 * OPS-02 — Sign a refresh token (30-day HMAC-SHA256 JWT, type='refresh').
 */
export function signRefreshToken(tenantId: string, secret: string, userId?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload: RefreshTokenPayload = {
    tenantId,
    ...(userId ? { userId } : {}),
    type: 'refresh',
    iat: now,
    exp: now + REFRESH_TOKEN_EXPIRY_S,
    jti: crypto.randomUUID(),
  };
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = hmacSign(`${header}.${body}`, secret);
  return `${header}.${body}.${sig}`;
}

/**
 * OPS-02 — Verify a refresh token.
 * Returns { tenantId } on success, null if invalid/expired/wrong type/blacklisted.
 */
export function verifyRefreshToken(token: string, secret: string): { tenantId: string; iat: number; userId?: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;
  const expected = hmacSign(`${header}.${body}`, secret);
  if (sig.length !== expected.length ||
      !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;

  let payload: RefreshTokenPayload;
  try {
    payload = JSON.parse(b64urlDecode(body)) as RefreshTokenPayload;
  } catch {
    return null;
  }

  if (payload.type !== 'refresh') return null;

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) return null;

  if (isBlacklisted(payload.jti)) return null;

  return {
    tenantId: payload.tenantId, iat: payload.iat,
    ...(typeof payload.userId === 'string' && payload.userId ? { userId: payload.userId } : {}),
  };
}

// ── Config ──
import { getCachedJwtSecret } from '../infra/secretsBootstrap.js';

export function getJwtSecret(): string | undefined {
  // Prefer cached secret (loaded at startup via bootstrapSecrets)
  // Falls back to process.env for backward compat in tests where bootstrap wasn't called
  return getCachedJwtSecret() ?? process.env['OTK_JWT_SECRET'];
}

export function getJwtExpiryS(): number {
  return Number(process.env['OTK_JWT_EXPIRY_S'] ?? 3600);
}
