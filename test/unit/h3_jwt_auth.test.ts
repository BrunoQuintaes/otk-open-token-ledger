/**
 * H-PACK-05 Tests — H3.1-H3.4 JWT Auth
 *
 * Checks JSON Web Token issuing, verification and revocation, and how the request
 * authentication middleware chooses between no auth, a JWT and an API key.
 *
 * Modules under test: `src/auth/jwt.ts` and `authenticateRequest` from
 * `src/auth/authMiddleware.ts`.
 *
 * Strategy / partitions: a valid token, a wrong secret, an expired token and a malformed one; the
 * expiry default and the value from `OTK_JWT_EXPIRY_S`; revocation list for an unknown id, a
 * revoked id (also rejected by verification) and an already expired entry; the middleware with
 * auth off, with no tenants configured in production, with no credential header, with a valid
 * JWT, with invalid claims (blank subject, unknown role, refresh type), falling back to an API
 * key, and with a dynamic API key that is valid or expired.
 *
 * Needs: nothing external. Sets and deletes `OTK_JWT_EXPIRY_S`, `OTK_JWT_SECRET` and (in one test)
 * `NODE_ENV`, restoring them after use.
 *
 * Run just this file: `npx tsx --test test/unit/h3_jwt_auth.test.ts`
 *
 * @module test/unit/h3_jwt_auth.test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { signToken, verifyToken, blacklistToken, isBlacklisted, clearBlacklistForTest, getJwtExpiryS } from '../../src/auth/jwt.js';
import { authenticateRequest } from '../../src/auth/authMiddleware.js';
import { clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';
import type { IncomingMessage } from 'node:http';
import { EventEmitter } from 'node:events';

const TEST_SECRET = 'test-secret-key-for-jwt-tests-only';

function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter();
  return Object.assign(em, { method: 'GET', url: '/', headers }) as unknown as IncomingMessage;
}

// ═══════════════════════════════════════════
// H3.1 — JWT Token Issuance
// ═══════════════════════════════════════════
describe('H3.1 — JWT Token Issuance', () => {
  it('signToken produces a valid 3-part JWT', () => {
    const token = signToken({ sub: 't1', role: 'OPERATOR' }, TEST_SECRET, 3600);
    const parts = token.split('.');
    assert.equal(parts.length, 3);
  });

  it('verifyToken returns payload for valid token', () => {
    const token = signToken({ sub: 't1', role: 'ADMIN' }, TEST_SECRET, 3600);
    const payload = verifyToken(token, TEST_SECRET);
    assert.ok(payload);
    assert.equal(payload!.sub, 't1');
    assert.equal(payload!.role, 'ADMIN');
    assert.ok(payload!.jti);
    assert.ok(payload!.iat > 0);
    assert.ok(payload!.exp > payload!.iat);
  });

  it('verifyToken returns null for wrong secret', () => {
    const token = signToken({ sub: 't1', role: 'VIEWER' }, TEST_SECRET, 3600);
    assert.equal(verifyToken(token, 'wrong-secret'), null);
  });

  it('verifyToken returns null for expired token', () => {
    const token = signToken({ sub: 't1', role: 'OPERATOR' }, TEST_SECRET, -1); // already expired
    assert.equal(verifyToken(token, TEST_SECRET), null);
  });

  it('verifyToken returns null for malformed token', () => {
    assert.equal(verifyToken('not.a.jwt', TEST_SECRET), null);
    assert.equal(verifyToken('onlyonepart', TEST_SECRET), null);
    assert.equal(verifyToken('', TEST_SECRET), null);
  });

  it('getJwtExpiryS defaults to 3600', () => {
    delete process.env['OTK_JWT_EXPIRY_S'];
    assert.equal(getJwtExpiryS(), 3600);
  });

  it('getJwtExpiryS reads from env', () => {
    process.env['OTK_JWT_EXPIRY_S'] = '7200';
    assert.equal(getJwtExpiryS(), 7200);
    delete process.env['OTK_JWT_EXPIRY_S'];
  });
});

// ═══════════════════════════════════════════
// H3.3 — Token Refresh + Blacklist
// ═══════════════════════════════════════════
describe('H3.3 — JWT Blacklist', () => {
  beforeEach(() => clearBlacklistForTest());

  it('isBlacklisted returns false for unknown jti', () => {
    assert.equal(isBlacklisted('unknown-jti'), false);
  });

  it('blacklistToken + isBlacklisted returns true (SEC-01)', async () => {
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    await blacklistToken('jti-123', futureExp); // async: writes in-memory + Redis
    assert.equal(isBlacklisted('jti-123'), true);
  });

  it('verifyToken rejects blacklisted token (SEC-01)', async () => {
    const token = signToken({ sub: 't1', role: 'OPERATOR' }, TEST_SECRET, 3600);
    const payload = verifyToken(token, TEST_SECRET);
    assert.ok(payload);
    const futureExp = Math.floor(Date.now() / 1000) + 3600;
    await blacklistToken(payload!.jti, futureExp); // async: writes in-memory + Redis
    assert.equal(verifyToken(token, TEST_SECRET), null);
  });

  it('expired blacklist entries are cleaned up', async () => {
    const pastExp = Math.floor(Date.now() / 1000) - 10; // already expired
    await blacklistToken('old-jti', pastExp);
    assert.equal(isBlacklisted('old-jti'), false); // cleaned up on check
  });
});

// ═══════════════════════════════════════════
// H3.2 — Auth Middleware
// ═══════════════════════════════════════════
describe('H3.2 — Auth Middleware', () => {
  beforeEach(() => {
    process.env['OTK_JWT_SECRET'] = TEST_SECRET;
    // Enable auth by setting OTK_TENANTS (loadTenantsFromString would be called)
    // For these tests we test JWT path directly
  });

  afterEach(() => {
    delete process.env['OTK_JWT_SECRET'];
    clearHashRegistryForTest();
  });

  it('returns authenticated:true method:none when auth is disabled (dev/test mode)', () => {
    // Non-production: auth-disabled = OWNER context (backward compat for dev)
    const result = authenticateRequest(mockReq());
    assert.equal(result.authenticated, true);
    assert.equal(result.tenantId, 'default');
    assert.equal(result.role, 'OWNER');
    assert.equal(result.method, 'none');
  });

  it('returns authenticated:false when OTK_TENANTS not configured in production (SEC-10)', () => {
    const original = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const result = authenticateRequest(mockReq());
      assert.equal(result.authenticated, false, 'SEC-10: must reject in production when OTK_TENANTS unset');
      assert.equal(result.tenantId, '');
      assert.equal(result.role, '');
      assert.equal(result.method, 'none');
    } finally {
      if (original === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = original;
    }
  });

  it('returns authenticated:false when no Authorization header and auth enabled', async () => {
    const { loadTenantsFromString } = await import('../../src/api/tenantKeyRegistry.js');
    loadTenantsFromString('test-tenant:test-token');
    const result = authenticateRequest(mockReq());
    assert.equal(result.authenticated, false);
    loadTenantsFromString('');
  });

  it('authenticates JWT token when secret is configured', async () => {
    const { loadTenantsFromString } = await import('../../src/api/tenantKeyRegistry.js');
    loadTenantsFromString('test-tenant:test-token');
    const token = signToken({ sub: 'jwt-tenant', role: 'ADMIN' }, TEST_SECRET, 3600);
    const result = authenticateRequest(mockReq({ authorization: `Bearer ${token}` }));
    assert.equal(result.authenticated, true);
    assert.equal(result.tenantId, 'jwt-tenant');
    assert.equal(result.role, 'ADMIN');
    assert.equal(result.method, 'jwt');
    loadTenantsFromString('');
  });

  it('ADV-M24-15: blank sub, unknown role and refresh type in any case do not authenticate', async () => {
    const { loadTenantsFromString } = await import('../../src/api/tenantKeyRegistry.js');
    loadTenantsFromString('test-tenant:test-token');
    try {
      const refused: Array<Record<string, unknown>> = [
        { sub: '   ', role: 'ADMIN' },
        { sub: 'jwt-tenant', role: 'SUPERADMIN' },
        { sub: 'jwt-tenant', role: 'admin' },
        { sub: 'jwt-tenant', role: ' ' },
        { sub: 'jwt-tenant', role: 'ADMIN', type: 'REFRESH' },
        { sub: 'jwt-tenant', role: 'ADMIN', type: ' Refresh ' },
      ];
      for (const claims of refused) {
        const token = signToken(claims as never, TEST_SECRET, 3600);
        const result = authenticateRequest(mockReq({ authorization: `Bearer ${token}` }));
        assert.equal(result.authenticated, false, JSON.stringify(claims));
      }
      for (const role of ['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']) {
        const token = signToken({ sub: 'jwt-tenant', role }, TEST_SECRET, 3600);
        assert.equal(authenticateRequest(mockReq({ authorization: `Bearer ${token}` })).role, role);
      }
    } finally {
      loadTenantsFromString('');
    }
  });

  it('falls back to API key when JWT verification fails', async () => {
    const { loadTenantsFromString } = await import('../../src/api/tenantKeyRegistry.js');
    loadTenantsFromString('api-tenant:my-api-key');
    const result = authenticateRequest(mockReq({ authorization: 'Bearer my-api-key' }));
    assert.equal(result.authenticated, true);
    assert.equal(result.tenantId, 'api-tenant');
    assert.equal(result.method, 'api_key');
    loadTenantsFromString('');
  });

  it('authenticates dynamic Wave 3C API key via hash registry', async () => {
    const { registerTokenByHash } = await import('../../src/api/tenantKeyRegistry.js');
    const { hashKey } = await import('../../src/api/apiKeyManager.js');
    const rawKey = 'otk_k_deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const hash = hashKey(rawKey);
    registerTokenByHash(hash, { tenantId: 'dyn-tenant', role: 'MEMBER', expiresAt: null });
    const result = authenticateRequest(mockReq({ authorization: `Bearer ${rawKey}` }));
    assert.equal(result.authenticated, true);
    assert.equal(result.tenantId, 'dyn-tenant');
    assert.equal(result.role, 'MEMBER');
    assert.equal(result.method, 'api_key');
  });

  it('rejects expired dynamic API key', async () => {
    const { registerTokenByHash } = await import('../../src/api/tenantKeyRegistry.js');
    const { hashKey } = await import('../../src/api/apiKeyManager.js');
    const rawKey = 'otk_k_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const hash = hashKey(rawKey);
    registerTokenByHash(hash, { tenantId: 'exp-tenant', role: 'MEMBER', expiresAt: '2020-01-01T00:00:00Z' });
    const result = authenticateRequest(mockReq({ authorization: `Bearer ${rawKey}` }));
    assert.equal(result.authenticated, false);
  });
});
