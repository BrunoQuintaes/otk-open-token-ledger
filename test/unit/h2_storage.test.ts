/**
 * H-PACK-03 Tests — H2.1-H2.5 Storage Migration
 *
 * Tests all store interfaces with their Memory implementations.
 * PG/Redis implementations tested separately when infrastructure is available.
 *
 * Modules under test: `src/billing/PlanRegistry.ts` with `src/billing/IPlanStore.ts`,
 * `src/security/ApiKeyRing.ts`, `src/security/IAuditStore.ts`, `src/security/IPolicyStore.ts` and
 * `src/economics/IBudgetTracker.ts`, each through its in-memory implementation.
 *
 * Strategy / partitions: per store, write then read, an unknown key (`null` or 0), listing (with
 * action filter, limit and offset for the audit chain), delete and clear; plan defaults, the three
 * tiers, quota unlimited vs exceeded and the per-plan rate limit; audit chain growth, head, count
 * and integrity check; budget check with no budget, under the thresholds, above the warning and
 * above the critical threshold.
 *
 * Needs: nothing external (in-memory stores, reset in the hooks of each block).
 *
 * Run just this file: `npx tsx --test test/unit/h2_storage.test.ts`
 *
 * @module test/unit/h2_storage.test
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// H2.1: PlanRegistry
import { assignPlan, getTenantPlan, getAllPlans, getPlan, checkQuota, getPlanRateLimit, resetPlanStoreForTest } from '../../src/billing/PlanRegistry.js';
import { MemoryPlanStore } from '../../src/billing/IPlanStore.js';

// H2.2: ApiKeyRing
import { InMemoryApiKeyStore, getApiKeyStore, resetApiKeyStoreForTest, type ApiKeyRef } from '../../src/security/ApiKeyRing.js';

// H2.3: AuditLogChain Store
import { MemoryAuditStore, resetAuditStoreForTest } from '../../src/security/IAuditStore.js';
import type { AuditRecord } from '../../src/security/AuditLogChain.js';

// H2.4: PolicyEngine Store
import { MemoryPolicyStore, resetPolicyStoreForTest } from '../../src/security/IPolicyStore.js';

// H2.5: BudgetTracker
import { MemoryBudgetTracker, checkBudget, resetBudgetTrackerForTest } from '../../src/economics/IBudgetTracker.js';

// ═══════════════════════════════════════════
// H2.1 — PlanRegistry Store
// ═══════════════════════════════════════════
describe('H2.1 — PlanRegistry Storage', () => {
  beforeEach(() => resetPlanStoreForTest());

  it('MemoryPlanStore: assign and get', async () => {
    const store = new MemoryPlanStore();
    await store.assign('t1', 'PRO');
    assert.equal(await store.get('t1'), 'PRO');
  });

  it('MemoryPlanStore: get returns null for unknown tenant', async () => {
    const store = new MemoryPlanStore();
    assert.equal(await store.get('unknown'), null);
  });

  it('MemoryPlanStore: list returns all assignments', async () => {
    const store = new MemoryPlanStore();
    await store.assign('t1', 'FREE');
    await store.assign('t2', 'PRO');
    const list = await store.list();
    assert.equal(list.length, 2);
  });

  it('MemoryPlanStore: clear removes all', async () => {
    const store = new MemoryPlanStore();
    await store.assign('t1', 'STARTER');
    await store.clear();
    assert.equal(await store.get('t1'), null);
  });

  it('PlanRegistry: getTenantPlan defaults to FREE', () => {
    assert.equal(getTenantPlan('new-tenant'), 'FREE');
  });

  it('PlanRegistry: getPlan returns correct definition', () => {
    const pro = getPlan('PRO');
    assert.equal(pro.tier, 'PRO');
    assert.equal(pro.cuQuotaPerEpoch, 0n);
    assert.equal(pro.onChainEnabled, true);
  });

  it('PlanRegistry: getAllPlans returns 3 tiers', () => {
    assert.equal(getAllPlans().length, 3);
  });

  it('PlanRegistry: checkQuota unlimited for PRO', async () => {
    await assignPlan('t-pro', 'PRO');
    const result = checkQuota('t-pro', 500_000n);
    assert.equal(result.exceeded, false);
  });

  it('PlanRegistry: checkQuota exceeded for FREE', () => {
    const result = checkQuota('t-free', 20_000n);
    assert.equal(result.exceeded, true);
  });

  it('PlanRegistry: getPlanRateLimit returns plan-specific limit', async () => {
    await assignPlan('t-starter', 'STARTER');
    const rl = getPlanRateLimit('t-starter');
    assert.equal(rl.maxRequests, 300);
  });
});

// ═══════════════════════════════════════════
// H2.2 — ApiKeyRing Store
// ═══════════════════════════════════════════
describe('H2.2 — ApiKeyRing Storage', () => {
  beforeEach(() => resetApiKeyStoreForTest());

  it('InMemoryApiKeyStore: put and get', () => {
    const store = new InMemoryApiKeyStore();
    const ref: ApiKeyRef = { tenantId: 't1', provider: 'openai', keyId: 'k1' };
    store.put(ref, 'secret-123');
    assert.equal(store.get(ref), 'secret-123');
  });

  it('InMemoryApiKeyStore: get returns null for unknown', () => {
    const store = new InMemoryApiKeyStore();
    assert.equal(store.get({ tenantId: 't1', provider: 'openai', keyId: 'missing' }), null);
  });

  it('InMemoryApiKeyStore: del removes key', () => {
    const store = new InMemoryApiKeyStore();
    const ref: ApiKeyRef = { tenantId: 't1', provider: 'openai', keyId: 'k1' };
    store.put(ref, 'secret');
    store.del(ref);
    assert.equal(store.get(ref), null);
  });

  it('singleton getApiKeyStore returns InMemoryApiKeyStore', () => {
    const store = getApiKeyStore();
    assert.ok(store instanceof InMemoryApiKeyStore);
  });
});

// ═══════════════════════════════════════════
// H2.3 — AuditLogChain Store
// ═══════════════════════════════════════════
describe('H2.3 — AuditLogChain Storage', () => {
  beforeEach(() => resetAuditStoreForTest());

  const record: AuditRecord = { ts: '2026-03-30T00:00:00Z', tenantId: 't1', actor: 'user1', action: 'metered' };

  it('MemoryAuditStore: append returns entry with hash', async () => {
    const store = new MemoryAuditStore();
    const entry = await store.append(record);
    assert.equal(entry.seq, 1);
    assert.ok(entry.hash.length > 0);
    assert.ok(entry.prevHash.length > 0);
  });

  it('MemoryAuditStore: chain grows sequentially', async () => {
    const store = new MemoryAuditStore();
    await store.append(record);
    const entry2 = await store.append({ ...record, action: 'policy_denied' });
    assert.equal(entry2.seq, 2);
  });

  it('MemoryAuditStore: head returns latest hash', async () => {
    const store = new MemoryAuditStore();
    const entry = await store.append(record);
    assert.equal(await store.head(), entry.hash);
  });

  it('MemoryAuditStore: count tracks entries', async () => {
    const store = new MemoryAuditStore();
    assert.equal(await store.count(), 0);
    await store.append(record);
    assert.equal(await store.count(), 1);
  });

  it('MemoryAuditStore: verifyIntegrity passes on valid chain', async () => {
    const store = new MemoryAuditStore();
    await store.append(record);
    await store.append({ ...record, action: 'audit' });
    const result = await store.verifyIntegrity();
    assert.equal(result.valid, true);
  });

  it('MemoryAuditStore: list with action filter', async () => {
    const store = new MemoryAuditStore();
    await store.append(record);
    await store.append({ ...record, action: 'denied' });
    const filtered = await store.list({ action: 'denied' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].record.action, 'denied');
  });

  it('MemoryAuditStore: list with limit+offset', async () => {
    const store = new MemoryAuditStore();
    for (let i = 0; i < 5; i++) await store.append({ ...record, action: `a${i}` });
    const page = await store.list({ limit: 2, offset: 2 });
    assert.equal(page.length, 2);
    assert.equal(page[0].record.action, 'a2');
  });

  it('MemoryAuditStore: clear resets everything', async () => {
    const store = new MemoryAuditStore();
    await store.append(record);
    await store.clear();
    assert.equal(await store.count(), 0);
  });
});

// ═══════════════════════════════════════════
// H2.4 — PolicyEngine Store
// ═══════════════════════════════════════════
describe('H2.4 — PolicyEngine Storage', () => {
  beforeEach(() => resetPolicyStoreForTest());

  it('MemoryPolicyStore: set and get policy', async () => {
    const store = new MemoryPolicyStore();
    await store.setPolicy('t1', { type: 'quota', maxCU: 100_000n, period: 'daily' });
    const p = await store.getPolicy('t1', 'quota');
    assert.ok(p);
    assert.equal(p!.type, 'quota');
  });

  it('MemoryPolicyStore: returns null for unknown', async () => {
    const store = new MemoryPolicyStore();
    assert.equal(await store.getPolicy('t1', 'quota'), null);
  });

  it('MemoryPolicyStore: list policies for tenant', async () => {
    const store = new MemoryPolicyStore();
    await store.setPolicy('t1', { type: 'quota', maxCU: 50_000n, period: 'hourly' });
    await store.setPolicy('t1', { type: 'rate_limit', maxRequests: 100, windowSeconds: 60 });
    const policies = await store.listPolicies('t1');
    assert.equal(policies.length, 2);
  });

  it('MemoryPolicyStore: delete removes specific policy', async () => {
    const store = new MemoryPolicyStore();
    await store.setPolicy('t1', { type: 'quota', maxCU: 50_000n, period: 'hourly' });
    await store.deletePolicy('t1', 'quota');
    assert.equal(await store.getPolicy('t1', 'quota'), null);
  });
});

// ═══════════════════════════════════════════
// H2.5 — CostAlertEngine Budget Tracker
// ═══════════════════════════════════════════
describe('H2.5 — Budget Tracker', () => {
  beforeEach(() => resetBudgetTrackerForTest());

  it('MemoryBudgetTracker: record and get spend', async () => {
    const tracker = new MemoryBudgetTracker();
    await tracker.recordSpend('t1', 'epoch-1', 500n);
    await tracker.recordSpend('t1', 'epoch-1', 300n);
    assert.equal(await tracker.getCurrentSpend('t1', 'epoch-1'), 800n);
  });

  it('MemoryBudgetTracker: returns 0 for unknown', async () => {
    const tracker = new MemoryBudgetTracker();
    assert.equal(await tracker.getCurrentSpend('t1', 'epoch-1'), 0n);
  });

  it('MemoryBudgetTracker: set and get budget', async () => {
    const tracker = new MemoryBudgetTracker();
    await tracker.setBudget('t1', { maxCU: 10_000n, warnPct: 80, criticalPct: 95 });
    const b = await tracker.getBudget('t1');
    assert.ok(b);
    assert.equal(b!.maxCU, 10_000n);
  });

  it('checkBudget: returns null when no budget set', async () => {
    const tracker = new MemoryBudgetTracker();
    const result = await checkBudget('t1', 'epoch-1', tracker);
    assert.equal(result, null);
  });

  it('checkBudget: returns warn when over warn threshold', async () => {
    const tracker = new MemoryBudgetTracker();
    await tracker.setBudget('t1', { maxCU: 10_000n, warnPct: 80, criticalPct: 95 });
    await tracker.recordSpend('t1', 'epoch-1', 8_500n);
    const result = await checkBudget('t1', 'epoch-1', tracker);
    assert.ok(result);
    assert.equal(result!.triggered, true);
    assert.equal(result!.level, 'warn');
  });

  it('checkBudget: returns critical when over critical threshold', async () => {
    const tracker = new MemoryBudgetTracker();
    await tracker.setBudget('t1', { maxCU: 10_000n, warnPct: 80, criticalPct: 95 });
    await tracker.recordSpend('t1', 'epoch-1', 9_600n);
    const result = await checkBudget('t1', 'epoch-1', tracker);
    assert.ok(result);
    assert.equal(result!.triggered, true);
    assert.equal(result!.level, 'critical');
  });

  it('checkBudget: returns not triggered when under thresholds', async () => {
    const tracker = new MemoryBudgetTracker();
    await tracker.setBudget('t1', { maxCU: 10_000n, warnPct: 80, criticalPct: 95 });
    await tracker.recordSpend('t1', 'epoch-1', 5_000n);
    const result = await checkBudget('t1', 'epoch-1', tracker);
    assert.ok(result);
    assert.equal(result!.triggered, false);
  });
});
