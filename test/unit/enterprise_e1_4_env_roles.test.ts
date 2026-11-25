/**
 * E1.4 — Role Bootstrap via OTK_TENANTS env
 *
 * Tests the extended parsing of loadTenantsFromString():
 * - "tenantId:token"      → role=OPERATOR (backward-compatible)
 * - "tenantId/ROLE:token" → explicit role
 * - Invalid role          → entry silently skipped
 * - Token with ":"        → still works
 * - All roles: OWNER, ADMIN, OPERATOR, MEMBER, VIEWER
 *
 * Module under test: `loadTenantsFromString` and the lookups of `src/api/tenantKeyRegistry.ts`.
 * The tenant list is passed as a string argument; the test never reads or sets `OTK_TENANTS`.
 *
 * Strategy / partitions: the legacy format (one and several entries, a token with colons, the
 * loaded count, auth switched on); the explicit format for each of the five roles, with tokens
 * containing colons; an unknown or empty role (entry skipped, neighbours kept); mixed formats
 * and several tenants in one string; empty and whitespace-only input, a pair without a colon,
 * and a reload that clears the previous state.
 *
 * Needs: nothing external (the registry is cleared before each test).
 *
 * Run just this file: `npx tsx --test test/unit/enterprise_e1_4_env_roles.test.ts`
 *
 * @since E1.4 (2026-03-14)
 * @module test/unit/enterprise_e1_4_env_roles.test
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadTenantsFromString,
  resolveTokenContext,
  clearRegistry,
  isAuthEnabled,
} from '../../src/api/tenantKeyRegistry.js';

// ---------------------------------------------------------------------------
// Reset registry before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  clearRegistry();
});

// ---------------------------------------------------------------------------
// 1. Backward compat — legacy format unchanged
// ---------------------------------------------------------------------------

describe('E1.4 — legacy format backward compat', () => {
  it('tenantId:token → role=OPERATOR', () => {
    loadTenantsFromString('acme:tok-123');
    const ctx = resolveTokenContext('tok-123');
    assert.ok(ctx, 'token must resolve');
    assert.equal(ctx!.tenantId, 'acme');
    assert.equal(ctx!.role, 'OPERATOR');
  });

  it('multiple legacy entries parsed correctly', () => {
    loadTenantsFromString('acme:tok-a,partner:tok-b');
    assert.equal(resolveTokenContext('tok-a')?.role, 'OPERATOR');
    assert.equal(resolveTokenContext('tok-b')?.role, 'OPERATOR');
    assert.equal(resolveTokenContext('tok-a')?.tenantId, 'acme');
    assert.equal(resolveTokenContext('tok-b')?.tenantId, 'partner');
  });

  it('token containing ":" still parsed correctly', () => {
    loadTenantsFromString('acme:my:token:with:colons');
    const ctx = resolveTokenContext('my:token:with:colons');
    assert.ok(ctx, 'token must resolve');
    assert.equal(ctx!.tenantId, 'acme');
    assert.equal(ctx!.role, 'OPERATOR');
  });

  it('loaded=1 for single entry', () => {
    const { loaded } = loadTenantsFromString('acme:tok-123');
    assert.equal(loaded, 1);
  });

  it('auth is enabled after load', () => {
    loadTenantsFromString('acme:tok-123');
    assert.equal(isAuthEnabled(), true);
  });
});

// ---------------------------------------------------------------------------
// 2. Explicit role format (E1.4)
// ---------------------------------------------------------------------------

describe('E1.4 — explicit role format: OWNER', () => {
  it('tenantId/OWNER:token → role=OWNER', () => {
    loadTenantsFromString('acme/OWNER:tok-owner');
    const ctx = resolveTokenContext('tok-owner');
    assert.ok(ctx, 'token must resolve');
    assert.equal(ctx!.tenantId, 'acme');
    assert.equal(ctx!.role, 'OWNER');
  });
});

describe('E1.4 — explicit role format: ADMIN', () => {
  it('tenantId/ADMIN:token → role=ADMIN', () => {
    loadTenantsFromString('acme/ADMIN:tok-admin');
    const ctx = resolveTokenContext('tok-admin');
    assert.ok(ctx);
    assert.equal(ctx!.role, 'ADMIN');
    assert.equal(ctx!.tenantId, 'acme');
  });
});

describe('E1.4 — explicit role format: OPERATOR', () => {
  it('tenantId/OPERATOR:token → role=OPERATOR (explicit)', () => {
    loadTenantsFromString('acme/OPERATOR:tok-op');
    const ctx = resolveTokenContext('tok-op');
    assert.ok(ctx);
    assert.equal(ctx!.role, 'OPERATOR');
  });
});

describe('E1.4 — explicit role format: MEMBER', () => {
  it('tenantId/MEMBER:token → role=MEMBER', () => {
    loadTenantsFromString('acme/MEMBER:tok-member');
    const ctx = resolveTokenContext('tok-member');
    assert.ok(ctx);
    assert.equal(ctx!.role, 'MEMBER');
    assert.equal(ctx!.tenantId, 'acme');
  });
});

describe('E1.4 — explicit role format: VIEWER', () => {
  it('tenantId/VIEWER:token → role=VIEWER', () => {
    loadTenantsFromString('acme/VIEWER:tok-view');
    const ctx = resolveTokenContext('tok-view');
    assert.ok(ctx);
    assert.equal(ctx!.role, 'VIEWER');
    assert.equal(ctx!.tenantId, 'acme');
  });
});

// ---------------------------------------------------------------------------
// 3. Explicit role + token containing ":"
// ---------------------------------------------------------------------------

describe('E1.4 — role format with colon in token', () => {
  it('tenantId/ADMIN:tok:with:colon → role=ADMIN, token preserved', () => {
    loadTenantsFromString('acme/ADMIN:tok:with:colon');
    const ctx = resolveTokenContext('tok:with:colon');
    assert.ok(ctx, 'token with colons must resolve');
    assert.equal(ctx!.tenantId, 'acme');
    assert.equal(ctx!.role, 'ADMIN');
  });

  it('tenantId/OWNER:tok:a:b:c → role=OWNER', () => {
    loadTenantsFromString('partner/OWNER:tok:a:b:c');
    const ctx = resolveTokenContext('tok:a:b:c');
    assert.ok(ctx);
    assert.equal(ctx!.role, 'OWNER');
    assert.equal(ctx!.tenantId, 'partner');
  });
});

// ---------------------------------------------------------------------------
// 4. Invalid role — skipped, not corrupting registry
// ---------------------------------------------------------------------------

describe('E1.4 — invalid role silently skipped', () => {
  it('tenantId/SUPERADMIN:token → skipped, auth disabled (open mode)', () => {
    // When all entries are invalid, loaded=0 and auth remains disabled.
    // resolveTokenContext() in auth-disabled mode returns the default context (not null),
    // because without auth enforcement all callers get open access.
    const { loaded } = loadTenantsFromString('acme/SUPERADMIN:tok-bad');
    assert.equal(loaded, 0);
    assert.equal(isAuthEnabled(), false);
    // Auth disabled: resolveTokenContext returns the default (not null)
    const ctx = resolveTokenContext('tok-bad');
    assert.equal(ctx?.tenantId, 'default');
    assert.equal(ctx?.role, 'OPERATOR');
  });

  it('invalid role does not affect valid adjacent entries', () => {
    const { loaded } = loadTenantsFromString('acme/INVALID:tok-bad,partner/OWNER:tok-ok');
    assert.equal(loaded, 1);
    assert.equal(resolveTokenContext('tok-bad'), null);
    const ctx = resolveTokenContext('tok-ok');
    assert.ok(ctx);
    assert.equal(ctx!.role, 'OWNER');
    assert.equal(ctx!.tenantId, 'partner');
  });

  it('empty role string is skipped', () => {
    const { loaded } = loadTenantsFromString('acme/:tok-bad');
    assert.equal(loaded, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. Mixed format (legacy + explicit role)
// ---------------------------------------------------------------------------

describe('E1.4 — mixed format in single OTK_TENANTS string', () => {
  it('parses legacy + owner + viewer in one string', () => {
    const { loaded } = loadTenantsFromString(
      'acme:tok-op,acme/OWNER:tok-owner,acme/VIEWER:tok-view',
    );
    assert.equal(loaded, 3);
    assert.equal(resolveTokenContext('tok-op')?.role, 'OPERATOR');
    assert.equal(resolveTokenContext('tok-owner')?.role, 'OWNER');
    assert.equal(resolveTokenContext('tok-view')?.role, 'VIEWER');
  });

  it('all three map to same tenantId correctly', () => {
    loadTenantsFromString('acme:tok-op,acme/OWNER:tok-owner,acme/VIEWER:tok-view');
    assert.equal(resolveTokenContext('tok-op')?.tenantId, 'acme');
    assert.equal(resolveTokenContext('tok-owner')?.tenantId, 'acme');
    assert.equal(resolveTokenContext('tok-view')?.tenantId, 'acme');
  });

  it('different tenants with different roles', () => {
    loadTenantsFromString('acme/OWNER:tok-a,partner/MEMBER:tok-b,trial:tok-c');
    assert.equal(resolveTokenContext('tok-a')?.role, 'OWNER');
    assert.equal(resolveTokenContext('tok-b')?.role, 'MEMBER');
    assert.equal(resolveTokenContext('tok-c')?.role, 'OPERATOR');
  });
});

// ---------------------------------------------------------------------------
// 6. Edge cases
// ---------------------------------------------------------------------------

describe('E1.4 — edge cases', () => {
  it('empty string → auth disabled, loaded=0', () => {
    const { loaded } = loadTenantsFromString('');
    assert.equal(loaded, 0);
    assert.equal(isAuthEnabled(), false);
  });

  it('whitespace-only → auth disabled', () => {
    const { loaded } = loadTenantsFromString('   ');
    assert.equal(loaded, 0);
    assert.equal(isAuthEnabled(), false);
  });

  it('pair without ":" → skipped', () => {
    const { loaded } = loadTenantsFromString('acmetoken');
    assert.equal(loaded, 0);
    assert.equal(isAuthEnabled(), false);
  });

  it('reload clears previous state', () => {
    loadTenantsFromString('acme/OWNER:tok-a');
    assert.equal(resolveTokenContext('tok-a')?.role, 'OWNER');
    loadTenantsFromString('partner/VIEWER:tok-b');
    assert.equal(resolveTokenContext('tok-a'), null); // cleared
    assert.equal(resolveTokenContext('tok-b')?.role, 'VIEWER');
  });
});
