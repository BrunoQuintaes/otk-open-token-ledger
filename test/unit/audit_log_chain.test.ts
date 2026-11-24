import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, chainHash } from '../../src/security/AuditLogChain.js';

describe('AuditLogChain', () => {
  it('canonicalize is stable (sorted meta keys)', () => {
    const a = canonicalize({ ts: 't', tenantId: 'x', actor: 'a', action: 'z', meta: { b: 2, a: 1 } });
    const b = canonicalize({ ts: 't', tenantId: 'x', actor: 'a', action: 'z', meta: { a: 1, b: 2 } });
    assert.equal(a, b);
  });

  it('chainHash changes with record', () => {
    const prev = '00'.repeat(32);
    const h1 = chainHash(prev, { ts: 't1', tenantId: 't', actor: 'a', action: 'x' });
    const h2 = chainHash(prev, { ts: 't1', tenantId: 't', actor: 'a', action: 'y' });
    assert.notEqual(h1, h2);
  });

  it('chainHash depends on prev hash', () => {
    const r = { ts: 't1', tenantId: 't', actor: 'a', action: 'x' };
    const h1 = chainHash('11'.repeat(32), r);
    const h2 = chainHash('22'.repeat(32), r);
    assert.notEqual(h1, h2);
  });

  // --- QA1 edge cases ---
  it('canonicalize is stable with nested meta objects', () => {
    const a = canonicalize({ ts: 't', tenantId: 'x', actor: 'a', action: 'z', meta: { outer: { z: 3, a: 1 } } });
    const b = canonicalize({ ts: 't', tenantId: 'x', actor: 'a', action: 'z', meta: { outer: { a: 1, z: 3 } } });
    assert.equal(a, b);
  });

  it('canonicalize is stable with meta containing arrays', () => {
    const a = canonicalize({ ts: 't', tenantId: 'x', actor: 'a', action: 'z', meta: { arr: [1, 2, 3] } });
    const b = canonicalize({ ts: 't', tenantId: 'x', actor: 'a', action: 'z', meta: { arr: [1, 2, 3] } });
    assert.equal(a, b);
  });

  it('chainHash is deterministic (same input → same output)', () => {
    const prev = 'ab'.repeat(32);
    const r = { ts: '2026-01-01T00:00:00Z', tenantId: 'org', actor: 'svc', action: 'metered' };
    assert.equal(chainHash(prev, r), chainHash(prev, r));
  });
});
