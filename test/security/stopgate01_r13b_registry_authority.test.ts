/**
 * STOPGATE-01 P1.1 (R-13b): registry tokens changed through the API are decided by the shared registry on every request.
 *
 * "Replica A" writes straight to the shared registry (an in-memory RegistryTokenSource); this process plays replica B.
 * The same contract runs against two real server processes and PostgreSQL in
 * test/integration/stopgate01_r13b_tenant_tokens_two_replicas_pg.test.ts.
 *
 * Strategy / partitions: a token created on the other replica is learned at its first request; revoked and suspended
 * rows drop the token, while environment-configured tokens without a row keep working; store outage (503 on strict
 * requests, local snapshot on plain reads, unknown tokens never learned); lookups of unknown values throttled per
 * source; tenant CRUD queues ordered changes and a failed write keeps them for a retry; the shared registry stores
 * only a hash, never the token; a queued revocation is not undone by an older active row; a token bound to another
 * tenant is never moved; the dynamic-key prefix is refused for registry tokens and unknown roles are not admitted;
 * without an authority nothing is queued.
 *
 * Modules under test: `src/auth/registryTokenAuthority.ts`, `src/auth/credentialAuthority.ts`,
 * `src/auth/authMiddleware.ts`, `src/api/tenantKeyRegistry.ts` and `src/api/tenantCrud.ts`.
 *
 * Needs: nothing external (the shared registry is the in-memory `MemRegistry` below, with switchable read and write
 * failures).
 *
 * Run just this file: `npx tsx --test test/security/stopgate01_r13b_registry_authority.test.ts`
 *
 * @module test/security/stopgate01_r13b_registry_authority.test
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import { authenticateRequest } from '../../src/auth/authMiddleware.js';
import {
  refreshCredential, credentialAuthorityStats, resetCredentialAuthorityStatsForTest, resetKeyLookupLimiterForTest,
} from '../../src/auth/credentialAuthority.js';
import {
  setRegistryTokenAuthority, resetRegistryTokenAuthorityForTest, queueRegistryTokenChange, flushRegistryTokenChanges,
  pendingRegistryTokenChanges, registryTokenHash, takeRegistryTokenConflicts, RegistryTokenConflictError,
  type RegistryTokenRow, type RegistryTokenSource,
} from '../../src/auth/registryTokenAuthority.js';
import { registerToken, clearRegistry, clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';
import { createTenant, updateTenant, deleteTenant, clearTenantsForTest } from '../../src/api/tenantCrud.js';

const req = (token: string): IncomingMessage => ({ headers: { authorization: `Bearer ${token}` } }) as unknown as IncomingMessage;
const authed = (token: string) => authenticateRequest(req(token)).authenticated;
const STATIC = 'static-registry-token-sg01-r13b-0123456789abcdef';

class MemRegistry implements RegistryTokenSource {
  rows = new Map<string, RegistryTokenRow>();
  failReads = false;
  failWrites = false;
  writes: string[] = [];
  async getByHash(h: string) { if (this.failReads) throw new Error('down'); return this.rows.get(h) ?? null; }
  async put(h: string, tenantId: string, role: string, suspended: boolean) {
    if (this.failWrites) throw new Error('down');
    const cur = this.rows.get(h);
    if (cur && cur.tenantId !== tenantId) throw new RegistryTokenConflictError(); // same guard as PgTenantTokenStore.put
    this.writes.push(`put:${tenantId}`); this.rows.set(h, { tenantId, role, suspended, revoked: false });
  }
  async revoke(h: string, tenantId: string) {
    if (this.failWrites) throw new Error('down');
    this.writes.push(`revoke:${tenantId}`);
    const r = this.rows.get(h); this.rows.set(h, { tenantId, role: r?.role ?? '', suspended: r?.suspended ?? false, revoked: true });
  }
  async setTenantSuspended(tenantId: string, suspended: boolean) {
    if (this.failWrites) throw new Error('down');
    this.writes.push(`${suspended ? 'suspend' : 'resume'}:${tenantId}`);
    for (const r of this.rows.values()) if (r.tenantId === tenantId && !r.revoked) r.suspended = suspended;
  }
  async hasTenant(tenantId: string) { for (const r of this.rows.values()) if (r.tenantId === tenantId && !r.revoked) return true; return false; }
}

describe('STOPGATE-01 R-13b: registry tokens decided by the shared registry', () => {
  let reg: MemRegistry;
  beforeEach(() => {
    clearTenantsForTest(); clearRegistry(); clearHashRegistryForTest();
    resetRegistryTokenAuthorityForTest(); resetCredentialAuthorityStatsForTest(); resetKeyLookupLimiterForTest();
    registerToken(STATIC, 'acme', 'OWNER'); // auth enabled
    reg = new MemRegistry();
    setRegistryTokenAuthority(reg);
  });
  afterEach(() => { resetRegistryTokenAuthorityForTest(); clearTenantsForTest(); clearRegistry(); });

  it('a token created on another replica is learned at its first request (stale without the refresh)', async () => {
    const t = 'sg01-created-on-a-0123456789abcdef0123';
    reg.rows.set(registryTokenHash(t), { tenantId: 'beta', role: 'OPERATOR', suspended: false, revoked: false });
    assert.equal(authed(t), false, 'stale: this process never saw the token');
    assert.deepEqual(await refreshCredential(t, { strict: false }), { ok: true });
    const a = authenticateRequest(req(t));
    assert.equal(a.authenticated, true);
    assert.equal(a.tenantId, 'beta');
    assert.equal(a.role, 'OPERATOR');
    assert.equal(credentialAuthorityStats().registryTokensLearned, 1);
  });

  it('revoked and suspended rows drop the token locally, OTK_TENANTS tokens without a row keep working', async () => {
    const t = 'sg01-local-token-0123456789abcdef0123';
    registerToken(t, 'beta', 'OWNER');
    reg.rows.set(registryTokenHash(t), { tenantId: 'beta', role: 'OWNER', suspended: true, revoked: false });
    await refreshCredential(t, { strict: false });
    assert.equal(authed(t), false, 'suspended → refused');
    registerToken(t, 'beta', 'OWNER');
    reg.rows.set(registryTokenHash(t), { tenantId: 'beta', role: 'OWNER', suspended: false, revoked: true });
    await refreshCredential(t, { strict: true });
    assert.equal(authed(t), false, 'revoked → refused');
    await refreshCredential(STATIC, { strict: true });
    assert.equal(authed(STATIC), true, 'no row → the local registry decides');
  });

  it('store outage: known token → 503 on strict, snapshot on plain reads; unknown token is never learned', async () => {
    reg.failReads = true;
    const r = await refreshCredential(STATIC, { strict: true });
    assert.equal(r.ok, false);
    assert.equal((r as { status: number }).status, 503);
    assert.deepEqual(await refreshCredential(STATIC, { strict: false }), { ok: true });
    assert.equal(authed(STATIC), true);
    const u = 'sg01-unknown-0123456789abcdef0123456';
    assert.deepEqual(await refreshCredential(u, { strict: true }), { ok: true });
    assert.equal(authed(u), false);
  });

  it('lookups of unknown values are throttled per source; known tokens are not affected', async () => {
    for (let i = 0; i < 25; i++) await refreshCredential(`sg01-guess-${i}-0123456789abcdef`, { strict: false, source: 'ip:1' });
    assert.ok(credentialAuthorityStats().registryLookupsThrottled >= 5, JSON.stringify(credentialAuthorityStats()));
    const before = credentialAuthorityStats().registryLookups;
    await refreshCredential(STATIC, { strict: false, source: 'ip:1' });
    assert.equal(credentialAuthorityStats().registryLookups, before + 1, 'a known token is still looked up');
  });

  it('tenant CRUD queues ordered changes; a failed write keeps them queued and a retry writes them', async () => {
    const t1 = 'sg01-crud-first-token-0123456789abcd'; const t2 = 'sg01-crud-second-token-0123456789abc';
    assert.equal(createTenant({ tenantId: 'gamma', token: t1, role: 'OWNER' }).ok, true);
    assert.equal(await flushRegistryTokenChanges(), true);
    assert.equal(reg.rows.get(registryTokenHash(t1))?.revoked, false);
    reg.failWrites = true;
    assert.equal(updateTenant({ tenantId: 'gamma', token: t2 }).ok, true);
    assert.equal(await flushRegistryTokenChanges(), false, 'store down: not saved');
    assert.ok(pendingRegistryTokenChanges() >= 2, 'rotation stays queued');
    reg.failWrites = false;
    assert.equal(await flushRegistryTokenChanges(), true, 'retry writes it');
    assert.equal(reg.rows.get(registryTokenHash(t1))?.revoked, true, 'old token revoked');
    assert.equal(reg.rows.get(registryTokenHash(t2))?.revoked, false, 'new token active');
    assert.equal(deleteTenant({ tenantId: 'gamma' }).ok, true);
    assert.equal(await flushRegistryTokenChanges(), true);
    assert.equal(reg.rows.get(registryTokenHash(t2))?.suspended, true, 'soft delete suspends');
    assert.equal(updateTenant({ tenantId: 'gamma', active: true }).ok, true);
    assert.equal(await flushRegistryTokenChanges(), true);
    assert.equal(reg.rows.get(registryTokenHash(t2))?.suspended, false, 'reactivation resumes');
    assert.deepEqual(reg.writes, ['put:gamma', 'revoke:gamma', 'put:gamma', 'suspend:gamma', 'resume:gamma', 'put:gamma']);
  });

  it('the shared registry never receives the token itself', async () => {
    const t = 'sg01-secret-token-value-0123456789ab';
    createTenant({ tenantId: 'delta', token: t, role: 'OWNER' });
    await flushRegistryTokenChanges();
    for (const k of reg.rows.keys()) assert.notEqual(k, t);
    assert.ok(reg.rows.has(registryTokenHash(t)));
  });

  it('cycle 2 (review MED-2): a revocation queued but not yet written is not undone by the older active row', async () => {
    const t1 = 'sg01-pending-old-token-0123456789abcd'; const t2 = 'sg01-pending-new-token-0123456789abcd';
    assert.equal(createTenant({ tenantId: 'eps', token: t1, role: 'OWNER' }).ok, true);
    assert.equal(await flushRegistryTokenChanges(), true);
    reg.failWrites = true;
    assert.equal(updateTenant({ tenantId: 'eps', token: t2 }).ok, true); // rotation applied locally, not written
    assert.equal(await flushRegistryTokenChanges(), false);
    assert.equal(reg.rows.get(registryTokenHash(t1))?.revoked, false, 'the shared row still says active');
    await refreshCredential(t1, { strict: false });
    assert.equal(authed(t1), false, 'the old token is not learned again from the stale row');
    assert.equal(updateTenant({ tenantId: 'eps', active: false }).ok, true);
    reg.rows.set(registryTokenHash(t2), { tenantId: 'eps', role: 'OWNER', suspended: false, revoked: false });
    await refreshCredential(t2, { strict: false });
    assert.equal(authed(t2), false, 'a queued suspension of the tenant wins over the stale row');
    reg.failWrites = false;
    assert.equal(await flushRegistryTokenChanges(), true);
    assert.equal(reg.rows.get(registryTokenHash(t1))?.revoked, true);
  });

  it('cycle 2 (review MED-3): a token bound to another tenant in the shared registry is never moved', async () => {
    const t = 'sg01-conflict-token-0123456789abcdef0';
    reg.rows.set(registryTokenHash(t), { tenantId: 'zeta', role: 'OWNER', suspended: false, revoked: false });
    assert.equal(createTenant({ tenantId: 'eta', token: t, role: 'OWNER' }).ok, true, 'this replica does not know the token');
    assert.equal(await flushRegistryTokenChanges(), true, 'the conflicting change is dropped, not retried forever');
    assert.equal(takeRegistryTokenConflicts(), 1);
    assert.equal(reg.rows.get(registryTokenHash(t))?.tenantId, 'zeta', 'the row keeps its tenant');
    await refreshCredential(t, { strict: false });
    assert.equal(authenticateRequest(req(t)).tenantId, 'zeta', 'the authority decides the tenant of the token');
    assert.equal(pendingRegistryTokenChanges(), 0);
  });

  it('cycle 2 (review LOW-6/LOW-8): otk_k_ prefix refused for registry tokens; rows with an unknown role are not admitted', async () => {
    const r = createTenant({ tenantId: 'theta', token: 'otk_k_' + 'a'.repeat(64), role: 'OWNER' });
    assert.equal(r.ok, false);
    const t = 'sg01-bad-role-token-0123456789abcdef0';
    reg.rows.set(registryTokenHash(t), { tenantId: 'iota', role: 'SUPERUSER', suspended: false, revoked: false });
    await refreshCredential(t, { strict: false });
    assert.equal(authed(t), false);
  });

  it('without an authority nothing is queued (single process unchanged)', () => {
    setRegistryTokenAuthority(null);
    queueRegistryTokenChange({ op: 'put', token: 'x'.repeat(40), tenantId: 'z', role: 'OWNER', suspended: false });
    assert.equal(pendingRegistryTokenChanges(), 0);
  });
});
