/**
 * AuthorityBoundary — Unit Tests
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  checkTenantBoundary,
  assertTenantBoundary,
  AuthorityBoundaryError,
  systemContext,
  isSystemActor,
} from '../../src/security/AuthorityBoundary.js';

describe('AuthorityBoundary', () => {
  describe('checkTenantBoundary', () => {
    it('allows same tenant', () => {
      const r = checkTenantBoundary({ actorTenantId: 'acme', resourceTenantId: 'acme', operation: 'read' });
      assert.equal(r.allowed, true);
    });

    it('denies cross-tenant access', () => {
      const r = checkTenantBoundary({ actorTenantId: 'acme', resourceTenantId: 'globex', operation: 'read' });
      assert.equal(r.allowed, false);
      assert.ok((r as { reason: string }).reason.includes('Cross-tenant'));
    });

    it('denies empty actorTenantId', () => {
      const r = checkTenantBoundary({ actorTenantId: '', resourceTenantId: 'globex', operation: 'read' });
      assert.equal(r.allowed, false);
    });

    it('denies empty resourceTenantId', () => {
      const r = checkTenantBoundary({ actorTenantId: 'acme', resourceTenantId: '', operation: 'read' });
      assert.equal(r.allowed, false);
    });
  });

  describe('assertTenantBoundary', () => {
    it('does not throw for same tenant', () => {
      assert.doesNotThrow(() =>
        assertTenantBoundary({ actorTenantId: 'acme', resourceTenantId: 'acme', operation: 'write' })
      );
    });

    it('throws AuthorityBoundaryError for cross-tenant', () => {
      assert.throws(
        () => assertTenantBoundary({ actorTenantId: 'acme', resourceTenantId: 'globex', operation: 'write' }),
        AuthorityBoundaryError
      );
    });

    it('thrown error includes context', () => {
      try {
        assertTenantBoundary({ actorTenantId: 'acme', resourceTenantId: 'globex', operation: 'write' });
        assert.fail('should have thrown');
      } catch (e) {
        assert.ok(e instanceof AuthorityBoundaryError);
        assert.equal(e.context.actorTenantId, 'acme');
        assert.equal(e.context.resourceTenantId, 'globex');
        assert.equal(e.context.operation, 'write');
      }
    });
  });

  describe('systemContext', () => {
    it('systemContext creates a bypass context', () => {
      const ctx = systemContext('any-tenant', 'batch_flush');
      assert.equal(ctx.operation, 'batch_flush');
      assert.ok(isSystemActor(ctx.actorTenantId));
    });

    it('system context passes boundary check (same-tenant logic)', () => {
      const ctx = systemContext('any-tenant', 'internal_op');
      const r = checkTenantBoundary(ctx);
      assert.equal(r.allowed, true);
    });
  });
});
