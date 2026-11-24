import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { requireTenantId, ns } from '../../src/security/TenantIsolation.js';

describe('TenantIsolation', () => {
  it('requires tenantId', () => {
    assert.throws(() => requireTenantId({}), /tenantId is required/);
  });
  it('accepts tenantId', () => {
    const c = requireTenantId({ tenantId: 't1' });
    assert.equal(c.tenantId, 't1');
  });
  it('namespaces keys', () => {
    assert.equal(ns('t1', 'k'), 't1::k');
  });

  // --- QA1 edge cases ---
  it('rejects whitespace-only tenantId', () => {
    assert.throws(() => requireTenantId({ tenantId: '   ' }), /tenantId is required/);
  });
  it('preserves optional userId in TenantContext', () => {
    const c = requireTenantId({ tenantId: 'org-1', userId: 'u99' });
    assert.equal(c.tenantId, 'org-1');
    assert.equal(c.userId, 'u99');
  });
  it('ns() with special chars is stable', () => {
    assert.equal(ns('t::x', 'k::y'), 't::x::k::y');
  });
});
