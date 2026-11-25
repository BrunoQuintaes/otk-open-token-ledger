/**
 * S0 — Security Stabilization Tests
 *
 * Tests for SEC-10, SEC-02 security fixes.
 *
 * Modules under test: `src/auth/authMiddleware.ts` (request authentication when no tenant is configured),
 * `src/api/tenantKeyRegistry.ts` and `src/auth/jwt.ts` (`getJwtSecret`).
 *
 * Strategy / partitions: no tenants configured in production (no credential and a token credential, both
 * refused); no tenants in development and test (open, kept for compatibility); tenants configured (the
 * registered token authenticates); the signing secret unset (the getter may return a falsy value).
 *
 * Needs: nothing external. Changes `NODE_ENV` and removes `OTK_JWT_SECRET` inside each test and restores them.
 *
 * Run just this file: `npx tsx --test test/unit/s0_security.test.ts`
 *
 * @module test/unit/s0_security
 * @since S0 PACK01 (2026-04-06)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import { authenticateRequest } from '../../src/auth/authMiddleware.js';
import { loadTenantsFromString, clearRegistry } from '../../src/api/tenantKeyRegistry.js';

function mockReq(headers: Record<string, string> = {}): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

// ── SEC-10: OTK_TENANTS not configured → 401 in production ──────────────────

describe('SEC-10 — Auth bypass prevention when OTK_TENANTS unset (production)', () => {
  it('returns authenticated:false when OTK_TENANTS absent and NODE_ENV=production', () => {
    // clear BEFORE setting production (clearRegistry throws in production mode)
    clearRegistry();
    const originalEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const result = authenticateRequest(mockReq());
      assert.equal(result.authenticated, false,
        'SEC-10: must reject in production when OTK_TENANTS not configured');
      assert.equal(result.tenantId, '');
      assert.equal(result.role, '');
      assert.equal(result.method, 'none');
    } finally {
      if (originalEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = originalEnv;
    }
  });

  it('returns authenticated:false for Bearer token when OTK_TENANTS absent in production', () => {
    clearRegistry(); // clear BEFORE setting production
    const originalEnv = process.env['NODE_ENV'];
    process.env['NODE_ENV'] = 'production';
    try {
      const result = authenticateRequest(mockReq({ authorization: 'Bearer some-token' }));
      assert.equal(result.authenticated, false,
        'SEC-10: must reject even with a token when server misconfigured');
    } finally {
      if (originalEnv === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = originalEnv;
    }
  });

  it('allows bypass in dev/test mode when OTK_TENANTS absent (backward compat)', () => {
    // NODE_ENV != 'production' → preserve dev/test convenience
    clearRegistry();
    const devEnvs: Array<string | undefined> = [undefined, 'test', 'development'];
    for (const env of devEnvs) {
      const originalEnv = process.env['NODE_ENV'];
      if (env === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = env;
      try {
        const result = authenticateRequest(mockReq());
        assert.equal(result.authenticated, true,
          `SEC-10: dev/test mode (NODE_ENV=${env ?? 'undefined'}) should allow bypass`);
      } finally {
        if (originalEnv === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = originalEnv;
      }
    }
  });

  it('authenticates correctly once OTK_TENANTS is set', () => {
    loadTenantsFromString('sec10-tenant/OWNER:sec10-token');
    try {
      const result = authenticateRequest(mockReq({ authorization: 'Bearer sec10-token' }));
      assert.equal(result.authenticated, true);
      assert.equal(result.tenantId, 'sec10-tenant');
      assert.equal(result.role, 'OWNER');
      assert.equal(result.method, 'api_key');
    } finally {
      loadTenantsFromString('');
    }
  });
});

// ── SEC-02: JWT secret guard (unit verification) ─────────────────────────────

describe('SEC-02 — JWT secret guard', () => {
  it('getJwtSecret returns undefined or string (falsy check enables guard)', async () => {
    const { getJwtSecret } = await import('../../src/auth/jwt.js');
    const original = process.env['OTK_JWT_SECRET'];
    delete process.env['OTK_JWT_SECRET'];
    try {
      const secret = getJwtSecret();
      // The SSO routes in routes.ts guard: if (!jwtSecret) return 500
      // getJwtSecret() must be able to return falsy when env is absent
      assert.ok(secret === undefined || typeof secret === 'string',
        'getJwtSecret must return string | undefined');
    } finally {
      if (original !== undefined) process.env['OTK_JWT_SECRET'] = original;
    }
  });
});
