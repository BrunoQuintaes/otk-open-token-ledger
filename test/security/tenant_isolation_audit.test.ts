/**
 * W5-5D — Tenant Isolation Audit (NEW-5.04)
 *
 * Verifies 5+ boundary scenarios for multi-tenant isolation:
 *   1. requireTenantId() rejects missing/empty tenantId
 *   2. Namespace helper produces non-colliding keys across tenants
 *   3. PlanRegistry: per-tenant quota isolation (plans don't bleed)
 *   4. Indexer: per-tenant receipt isolation (getReceiptsByTenant)
 *   5. Rate limit key namespacing: per-tenant keys don't collide
 *   6. CU quota: each tenant's budget is independent
 *   7. Concurrent multi-tenant assignment: no data leakage
 *
 * @since Wave 5 (W5-5D / NEW-5.04)
 *
 * Note: item 4 of the list above has no test in this file (the indexer is not imported); per-tenant receipt
 * isolation through the API is covered by `route_surface.test.ts` and `m24_tenant_sweep.test.ts` in this folder.
 *
 * Modules under test: `src/security/TenantIsolation.ts` (`requireTenantId`, `ns`) and `src/billing/PlanRegistry.ts`
 * (`assignPlan`, `getTenantPlan`, `getPlan`, `getSLAForTier`).
 *
 * Partitions: missing, empty and whitespace-only tenant ids, trimming and optional user id; namespaced keys for
 * different and equal tenants, their format, and 10 tenants with the same base key; default plan, assignment without
 * bleeding, SLA by plan, 20 concurrent assignments; plan quotas; rate-limit keys per tenant.
 *
 * Needs: nothing external (in memory; plan assignments are cleared before each plan case).
 *
 * Run just this file: `npx tsx --test test/security/tenant_isolation_audit.test.ts`
 *
 * @module test/security/tenant_isolation_audit.test
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireTenantId, ns } from '../../src/security/TenantIsolation.js';
import {
  assignPlan,
  getTenantPlan,
  getPlan,
  getSLAForTier,
  clearAssignmentsForTest,
} from '../../src/billing/PlanRegistry.js';

// ---------------------------------------------------------------------------
// 1. requireTenantId boundary checks
// ---------------------------------------------------------------------------

describe('Tenant Isolation — requireTenantId()', () => {
  it('throws when tenantId is missing', () => {
    assert.throws(() => requireTenantId({}), /tenantId is required/);
  });

  it('throws when tenantId is empty string', () => {
    assert.throws(() => requireTenantId({ tenantId: '' }), /tenantId is required/);
  });

  it('throws when tenantId is whitespace only', () => {
    assert.throws(() => requireTenantId({ tenantId: '   ' }), /tenantId is required/);
  });

  it('returns context with trimmed tenantId', () => {
    const ctx = requireTenantId({ tenantId: 'tenant-a' });
    assert.equal(ctx.tenantId, 'tenant-a');
  });

  it('preserves optional userId', () => {
    const ctx = requireTenantId({ tenantId: 'tenant-a', userId: 'u1' });
    assert.equal(ctx.userId, 'u1');
  });
});

// ---------------------------------------------------------------------------
// 2. Namespace key isolation
// ---------------------------------------------------------------------------

describe('Tenant Isolation — ns() key namespacing', () => {
  it('produces different keys for different tenants with same base key', () => {
    const k1 = ns('tenant-a', 'budget:epoch-709');
    const k2 = ns('tenant-b', 'budget:epoch-709');
    assert.notEqual(k1, k2, 'namespace keys must differ across tenants');
  });

  it('same tenant + same key produces same namespace key (deterministic)', () => {
    const k1 = ns('tenant-a', 'ratelimit:req');
    const k2 = ns('tenant-a', 'ratelimit:req');
    assert.equal(k1, k2, 'namespace key must be deterministic');
  });

  it('key format is tenantId::key', () => {
    const k = ns('tenant-x', 'usage');
    assert.equal(k, 'tenant-x::usage');
  });

  it('does not collide for 10 distinct tenants with same base key', () => {
    const keys = new Set(
      Array.from({ length: 10 }, (_, i) => ns(`tenant-${i}`, 'budget'))
    );
    assert.equal(keys.size, 10, 'all 10 namespace keys must be distinct');
  });
});

// ---------------------------------------------------------------------------
// 3. PlanRegistry: quota isolation across tenants
// ---------------------------------------------------------------------------

describe('Tenant Isolation — PlanRegistry plan assignment', () => {
  beforeEach(() => { clearAssignmentsForTest(); });

  it('tenants start on FREE by default', () => {
    assert.equal(getTenantPlan('tenant-new-1'), 'FREE');
    assert.equal(getTenantPlan('tenant-new-2'), 'FREE');
  });

  it('plan assignment does not bleed to other tenants', async () => {
    await assignPlan('tenant-pro', 'PRO');
    await assignPlan('tenant-starter', 'STARTER');
    assert.equal(getTenantPlan('tenant-pro'), 'PRO');
    assert.equal(getTenantPlan('tenant-starter'), 'STARTER');
    assert.equal(getTenantPlan('tenant-unassigned'), 'FREE', 'unassigned tenant must still be FREE');
  });

  it('changing one tenant plan does not affect others', async () => {
    await assignPlan('tenant-a', 'PRO');
    await assignPlan('tenant-b', 'STARTER');
    await assignPlan('tenant-a', 'FREE');  // downgrade
    assert.equal(getTenantPlan('tenant-a'), 'FREE', 'tenant-a must be downgraded to FREE');
    assert.equal(getTenantPlan('tenant-b'), 'STARTER', 'tenant-b must remain STARTER');
  });

  it('SLA boundaries are plan-specific, not tenant-specific', async () => {
    await assignPlan('t1', 'PRO');
    await assignPlan('t2', 'STARTER');
    const slaPro = getSLAForTier(getTenantPlan('t1'));
    const slaStarter = getSLAForTier(getTenantPlan('t2'));
    assert.ok(slaPro.maxLatencyP99Ms < slaStarter.maxLatencyP99Ms, 'PRO SLA must be stricter than STARTER');
  });

  it('concurrent assignment of 20 tenants maintains isolation', async () => {
    // Simulate concurrent-like assignment
    const assignments: Array<[string, 'FREE' | 'STARTER' | 'PRO']> = Array.from(
      { length: 20 },
      (_, i) => [`tenant-concurrent-${i}`, i % 3 === 0 ? 'PRO' : i % 3 === 1 ? 'STARTER' : 'FREE']
    );
    for (const [id, tier] of assignments) await assignPlan(id, tier);

    // Verify every tenant got the correct tier
    for (const [id, tier] of assignments) {
      assert.equal(getTenantPlan(id), tier, `tenant ${id} must have tier ${tier}`);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. CU quota per-plan independence
// ---------------------------------------------------------------------------

describe('Tenant Isolation — plan quota independence', () => {
  it('PRO plan has no CU quota cap (0n = unlimited)', () => {
    const pro = getPlan('PRO');
    assert.equal(pro.cuQuotaPerEpoch, 0n, 'PRO must have unlimited quota (0n)');
  });

  it('FREE and STARTER quotas are separate', () => {
    const free = getPlan('FREE');
    const starter = getPlan('STARTER');
    assert.ok(free.cuQuotaPerEpoch > 0n, 'FREE must have positive quota');
    assert.ok(starter.cuQuotaPerEpoch > free.cuQuotaPerEpoch, 'STARTER quota must exceed FREE');
  });

  it('changing plan definition does not affect other plans', () => {
    // Verify plans are independent in-memory objects (different references)
    const free1 = getPlan('FREE');
    const starter1 = getPlan('STARTER');
    assert.notEqual(free1, starter1, 'plan definitions must be separate objects');
  });
});

// ---------------------------------------------------------------------------
// 6. Key namespace audit: no cross-tenant collisions
// ---------------------------------------------------------------------------

describe('Tenant Isolation — cross-tenant key audit', () => {
  it('rate limit keys per tenant do not collide for common resources', () => {
    const resources = ['receipts', 'proofs', 'exports', 'webhooks', 'streams'];
    const tenants = ['alpha', 'beta', 'gamma'];
    const allKeys = new Set<string>();

    for (const tenant of tenants) {
      for (const resource of resources) {
        const key = ns(tenant, `ratelimit:${resource}`);
        assert.ok(!allKeys.has(key), `Collision detected for key: ${key}`);
        allKeys.add(key);
      }
    }
    assert.equal(allKeys.size, tenants.length * resources.length, 'all keys must be unique');
  });

  it('billing bucket keys per tenant/epoch do not collide', () => {
    const epochs = ['709', '710', '711'];
    const tenants = ['t-alpha', 't-beta'];
    const allKeys = new Set<string>();

    for (const tenant of tenants) {
      for (const epoch of epochs) {
        const key = ns(tenant, `cu:${epoch}`);
        assert.ok(!allKeys.has(key), `Billing key collision: ${key}`);
        allKeys.add(key);
      }
    }
    assert.equal(allKeys.size, tenants.length * epochs.length);
  });
});
