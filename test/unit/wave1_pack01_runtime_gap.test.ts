/**
 * Wave 1 Pack 1 — Runtime Gap Tests (S1.5 + S1.6 + S1.7)
 *
 * Tests:
 *   - Dead-letter store: add, list, get, retry, discard, persistence
 *   - Tenant CRUD: create, read, update, delete, list, validation, auth
 *   - RBAC extensions: admin:tenants, admin:dead-letters permissions
 *   - Integration: dead-letter capture at validation boundary
 *
 * @since Wave 1 Pack 1 (2026-03-15)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── Dead-Letter Store Tests ──────────────────────────────────────

import {
  addDeadLetter,
  getDeadLetter,
  listDeadLetters,
  markRetried,
  markDiscarded,
  deadLetterCount,
  pendingCount,
  clearDeadLettersForTest,
} from '../../src/api/deadLetterStore.js';

describe('S1.5 — Dead-Letter Store', () => {
  beforeEach(async () => {
    await clearDeadLettersForTest();
  });

  it('addDeadLetter creates an entry with correct structure', async () => {
    const entry = await addDeadLetter({
      originalPayload: '{"bad":"data"}',
      error: 'missing_required_fields',
      reason: 'validation_error',
      source: 'POST /receipts',
      tenantId: 'acme',
    });
    assert.ok(entry.id.startsWith('dl-'));
    assert.equal(entry.error, 'missing_required_fields');
    assert.equal(entry.reason, 'validation_error');
    assert.equal(entry.source, 'POST /receipts');
    assert.equal(entry.tenantId, 'acme');
    assert.equal(entry.status, 'pending');
    assert.ok(entry.createdAt);
  });

  it('getDeadLetter retrieves by id', async () => {
    const entry = await addDeadLetter({
      originalPayload: '{}',
      error: 'test',
      reason: 'store_error',
      source: 'test',
    });
    const found = await getDeadLetter(entry.id);
    assert.deepEqual(found, entry);
  });

  it('getDeadLetter returns null for unknown id', async () => {
    assert.equal(await getDeadLetter('dl-nonexistent'), null);
  });

  it('listDeadLetters returns all entries', async () => {
    await addDeadLetter({ originalPayload: 'a', error: 'e1', reason: 'validation_error', source: 's' });
    await addDeadLetter({ originalPayload: 'b', error: 'e2', reason: 'store_error', source: 's' });
    await addDeadLetter({ originalPayload: 'c', error: 'e3', reason: 'dispatch_error', source: 's' });
    const all = await listDeadLetters();
    assert.equal(all.length, 3);
  });

  it('listDeadLetters filters by status', async () => {
    const e1 = await addDeadLetter({ originalPayload: '', error: '', reason: 'validation_error', source: '' });
    await addDeadLetter({ originalPayload: '', error: '', reason: 'store_error', source: '' });
    await markRetried(e1.id);
    const pending = await listDeadLetters({ status: 'pending' });
    assert.equal(pending.length, 1);
    const retried = await listDeadLetters({ status: 'retried' });
    assert.equal(retried.length, 1);
  });

  it('listDeadLetters filters by reason', async () => {
    await addDeadLetter({ originalPayload: '', error: '', reason: 'validation_error', source: '' });
    await addDeadLetter({ originalPayload: '', error: '', reason: 'dispatch_error', source: '' });
    const filtered = await listDeadLetters({ reason: 'validation_error' });
    assert.equal(filtered.length, 1);
  });

  it('listDeadLetters filters by tenantId', async () => {
    await addDeadLetter({ originalPayload: '', error: '', reason: 'validation_error', source: '', tenantId: 'acme' });
    await addDeadLetter({ originalPayload: '', error: '', reason: 'store_error', source: '', tenantId: 'beta' });
    const filtered = await listDeadLetters({ tenantId: 'acme' });
    assert.equal(filtered.length, 1);
  });

  it('listDeadLetters respects limit', async () => {
    for (let i = 0; i < 10; i++) {
      await addDeadLetter({ originalPayload: `${i}`, error: '', reason: 'validation_error', source: '' });
    }
    const limited = await listDeadLetters({ limit: 3 });
    assert.equal(limited.length, 3);
  });

  it('markRetried changes status', async () => {
    const entry = await addDeadLetter({ originalPayload: '', error: '', reason: 'validation_error', source: '' });
    const updated = await markRetried(entry.id);
    assert.ok(updated);
    assert.equal(updated!.status, 'retried');
  });

  it('markRetried returns null for unknown id', async () => {
    assert.equal(await markRetried('dl-unknown'), null);
  });

  it('markDiscarded changes status', async () => {
    const entry = await addDeadLetter({ originalPayload: '', error: '', reason: 'validation_error', source: '' });
    const updated = await markDiscarded(entry.id);
    assert.ok(updated);
    assert.equal(updated!.status, 'discarded');
  });

  it('markDiscarded returns null for unknown id', async () => {
    assert.equal(await markDiscarded('dl-unknown'), null);
  });

  it('deadLetterCount and pendingCount track correctly', async () => {
    await addDeadLetter({ originalPayload: '', error: '', reason: 'validation_error', source: '' });
    await addDeadLetter({ originalPayload: '', error: '', reason: 'store_error', source: '' });
    assert.equal(await deadLetterCount(), 2);
    assert.equal(await pendingCount(), 2);

    const entries = await listDeadLetters();
    await markRetried(entries[0].id);
    assert.equal(await deadLetterCount(), 2);
    assert.equal(await pendingCount(), 1);

    await markDiscarded(entries[1].id);
    assert.equal(await pendingCount(), 0);
  });

  it('clearDeadLettersForTest resets all state', async () => {
    await addDeadLetter({ originalPayload: '', error: '', reason: 'validation_error', source: '' });
    await clearDeadLettersForTest();
    assert.equal(await deadLetterCount(), 0);
    assert.equal(await pendingCount(), 0);
  });
});

// ─── Tenant CRUD Tests ────────────────────────────────────────────

import {
  createTenant,
  getTenant,
  listTenants,
  updateTenant,
  deleteTenant,
  tenantAuditStatus,
  clearTenantsForTest,
} from '../../src/api/tenantCrud.js';

describe('S1.6 — Tenant CRUD Runtime', () => {
  beforeEach(() => {
    clearTenantsForTest();
  });

  it('createTenant succeeds with valid params', () => {
    const result = createTenant({ tenantId: 'acme', token: 'tok-123', role: 'ADMIN' });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.tenant.tenantId, 'acme');
    assert.equal(result.tenant.role, 'ADMIN');
    assert.equal(result.tenant.active, true);
    assert.ok(result.tenant.tokenPrefix.includes('...'));
    assert.ok(result.tenant.createdAt);
  });

  it('createTenant defaults role to OPERATOR', () => {
    const result = createTenant({ tenantId: 'beta', token: 'tok-456' });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.tenant.role, 'OPERATOR');
  });

  it('createTenant rejects empty tenantId', () => {
    const result = createTenant({ tenantId: '', token: 'tok' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'tenantId is required');
  });

  it('createTenant rejects empty token', () => {
    const result = createTenant({ tenantId: 'acme', token: '' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'token is required');
  });

  it('createTenant rejects invalid role', () => {
    const result = createTenant({ tenantId: 'acme', token: 'tok', role: 'SUPERADMIN' as any });
    assert.equal(result.ok, false);
  });

  it('createTenant rejects tenantId with : or /', () => {
    assert.equal(createTenant({ tenantId: 'a:b', token: 'tok' }).ok, false);
    assert.equal(createTenant({ tenantId: 'a/b', token: 'tok' }).ok, false);
  });

  it('createTenant rejects duplicate tenantId', () => {
    createTenant({ tenantId: 'acme', token: 'tok-1' });
    const result = createTenant({ tenantId: 'acme', token: 'tok-2' });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error, 'tenant already exists');
  });

  it('getTenant returns created tenant view', () => {
    createTenant({ tenantId: 'acme', token: 'tok-123' });
    const view = getTenant('acme');
    assert.ok(view);
    assert.equal(view!.tenantId, 'acme');
    assert.equal(view!.active, true);
  });

  it('getTenant returns undefined for unknown', () => {
    assert.equal(getTenant('unknown'), undefined);
  });

  it('listTenants returns all tenants', () => {
    createTenant({ tenantId: 'a', token: 't1' });
    createTenant({ tenantId: 'b', token: 't2' });
    const list = listTenants();
    assert.equal(list.length, 2);
  });

  it('listTenants filters by active status', () => {
    createTenant({ tenantId: 'a', token: 't1' });
    createTenant({ tenantId: 'b', token: 't2' });
    deleteTenant({ tenantId: 'b' });
    assert.equal(listTenants({ active: true }).length, 1);
    assert.equal(listTenants({ active: false }).length, 1);
  });

  it('listTenants filters by role', () => {
    createTenant({ tenantId: 'a', token: 't1', role: 'ADMIN' });
    createTenant({ tenantId: 'b', token: 't2', role: 'VIEWER' });
    assert.equal(listTenants({ role: 'ADMIN' }).length, 1);
    assert.equal(listTenants({ role: 'VIEWER' }).length, 1);
    assert.equal(listTenants({ role: 'OWNER' }).length, 0);
  });

  it('updateTenant changes role', () => {
    createTenant({ tenantId: 'acme', token: 'tok-1' });
    const result = updateTenant({ tenantId: 'acme', role: 'ADMIN' });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.equal(result.tenant.role, 'ADMIN');
  });

  it('updateTenant changes token', () => {
    createTenant({ tenantId: 'acme', token: 'old-token-abcdef' });
    const result = updateTenant({ tenantId: 'acme', token: 'new-token-ghijkl' });
    assert.ok(result.ok);
    if (!result.ok) return;
    assert.ok(result.tenant.tokenPrefix.startsWith('new-toke'));
  });

  it('updateTenant rejects invalid role', () => {
    createTenant({ tenantId: 'acme', token: 'tok' });
    const result = updateTenant({ tenantId: 'acme', role: 'INVALID' as any });
    assert.equal(result.ok, false);
  });

  it('updateTenant returns error for unknown tenant', () => {
    const result = updateTenant({ tenantId: 'unknown', role: 'ADMIN' });
    assert.equal(result.ok, false);
  });

  it('deleteTenant soft-deactivates tenant', () => {
    createTenant({ tenantId: 'acme', token: 'tok-1' });
    const result = deleteTenant({ tenantId: 'acme' });
    assert.ok(result.ok);
    const view = getTenant('acme');
    assert.ok(view);
    assert.equal(view!.active, false);
  });

  it('deleteTenant returns error for unknown tenant', () => {
    const result = deleteTenant({ tenantId: 'unknown' });
    assert.equal(result.ok, false);
  });

  it('tenantAuditStatus tracks operations', () => {
    const before = tenantAuditStatus();
    assert.equal(before.auditCount, 0);

    createTenant({ tenantId: 'acme', token: 'tok' });
    const after = tenantAuditStatus();
    assert.equal(after.auditCount, 1);
    assert.notEqual(after.auditHead, before.auditHead);
  });

  it('deleted tenant token is no longer resolvable', async () => {
    // Verify that token resolution works, then stops after delete
    const { resolveTokenContext } = await import('../../src/api/tenantKeyRegistry.js');
    createTenant({ tenantId: 'ephemeral', token: 'eph-tok-123' });
    // Token should resolve
    const ctx = resolveTokenContext('eph-tok-123');
    assert.ok(ctx);
    assert.equal(ctx!.tenantId, 'ephemeral');

    // Delete and verify token is revoked
    deleteTenant({ tenantId: 'ephemeral' });
    const ctx2 = resolveTokenContext('eph-tok-123');
    // When auth is enabled, revoked token returns null
    // When auth is disabled, returns default context (always)
    // Since createTenant calls registerToken which enables auth, this should be null
    assert.equal(ctx2, null);
  });
});

// ─── RBAC Extension Tests ─────────────────────────────────────────

import { hasPermission } from '../../src/security/rbac.js';

describe('S1.5/S1.6 — RBAC Extensions', () => {
  it('OWNER has admin:tenants permission', () => {
    assert.equal(hasPermission('OWNER', 'admin:tenants'), true);
  });

  it('ADMIN has admin:tenants permission', () => {
    assert.equal(hasPermission('ADMIN', 'admin:tenants'), true);
  });

  it('OPERATOR does not have admin:tenants permission', () => {
    assert.equal(hasPermission('OPERATOR', 'admin:tenants'), false);
  });

  it('MEMBER does not have admin:tenants permission', () => {
    assert.equal(hasPermission('MEMBER', 'admin:tenants'), false);
  });

  it('VIEWER does not have admin:tenants permission', () => {
    assert.equal(hasPermission('VIEWER', 'admin:tenants'), false);
  });

  it('OWNER has admin:dead-letters permission', () => {
    assert.equal(hasPermission('OWNER', 'admin:dead-letters'), true);
  });

  it('ADMIN has admin:dead-letters permission', () => {
    assert.equal(hasPermission('ADMIN', 'admin:dead-letters'), true);
  });

  it('OPERATOR has admin:dead-letters permission', () => {
    assert.equal(hasPermission('OPERATOR', 'admin:dead-letters'), true);
  });

  it('MEMBER does not have admin:dead-letters permission', () => {
    assert.equal(hasPermission('MEMBER', 'admin:dead-letters'), false);
  });

  it('VIEWER does not have admin:dead-letters permission', () => {
    assert.equal(hasPermission('VIEWER', 'admin:dead-letters'), false);
  });

  // Existing permissions still work (non-regression)
  it('existing permissions are preserved (non-regression)', () => {
    assert.equal(hasPermission('OWNER', 'admin:keys'), true);
    assert.equal(hasPermission('ADMIN', 'admin:keys'), false);
    assert.equal(hasPermission('VIEWER', 'receipts:read'), true);
    assert.equal(hasPermission('VIEWER', 'receipts:write'), false);
    assert.equal(hasPermission('MEMBER', 'receipts:write'), true);
  });
});
