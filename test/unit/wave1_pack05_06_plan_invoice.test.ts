/**
 * Wave 1 Pack 5+6 — Plan+RateLimit + Invoice+Tests (S2.1-S2.4)
 *
 * @since Wave 1 Packs 5-6 (2026-03-15)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── S2.1 — PlanRegistry Tests ────────────────────────────────────

import {
  getPlan,
  getAllPlans,
  assignPlan,
  getTenantPlan,
  getTenantPlanDefinition,
  checkQuota,
  getPlanRateLimit,
  listAssignments,
  clearAssignmentsForTest,
} from '../../src/billing/PlanRegistry.js';

describe('S2.1 — PlanRegistry Model', () => {
  beforeEach(() => {
    clearAssignmentsForTest();
  });

  it('getPlan returns FREE tier', () => {
    const plan = getPlan('FREE');
    assert.equal(plan.tier, 'FREE');
    assert.equal(plan.cuQuotaPerEpoch, 10_000n);
    assert.equal(plan.rateLimitPerMinute, 60);
    assert.equal(plan.zkProofsEnabled, false);
  });

  it('getPlan returns STARTER tier', () => {
    const plan = getPlan('STARTER');
    assert.equal(plan.tier, 'STARTER');
    assert.equal(plan.cuQuotaPerEpoch, 1_000_000n);
    assert.equal(plan.zkProofsEnabled, true);
    assert.equal(plan.onChainEnabled, false);
  });

  it('getPlan returns PRO tier', () => {
    const plan = getPlan('PRO');
    assert.equal(plan.tier, 'PRO');
    assert.equal(plan.cuQuotaPerEpoch, 0n); // unlimited
    assert.equal(plan.onChainEnabled, true);
    assert.equal(plan.queuePriority, 10);
  });

  it('getAllPlans returns 3 tiers', () => {
    const plans = getAllPlans();
    assert.equal(plans.length, 3);
    const tiers = plans.map(p => p.tier);
    assert.ok(tiers.includes('FREE'));
    assert.ok(tiers.includes('STARTER'));
    assert.ok(tiers.includes('PRO'));
  });

  it('default tenant plan is FREE', () => {
    assert.equal(getTenantPlan('unknown'), 'FREE');
  });

  it('assignPlan changes tenant tier', async () => {
    await assignPlan('acme', 'PRO');
    assert.equal(getTenantPlan('acme'), 'PRO');
  });

  it('getTenantPlanDefinition returns full plan', async () => {
    await assignPlan('acme', 'STARTER');
    const plan = getTenantPlanDefinition('acme');
    assert.equal(plan.tier, 'STARTER');
    assert.equal(plan.rateLimitPerMinute, 300);
  });

  it('listAssignments shows all assignments', async () => {
    await assignPlan('acme', 'PRO');
    await assignPlan('beta', 'STARTER');
    const assignments = listAssignments();
    assert.equal(assignments.length, 2);
  });
});

describe('S2.1 — checkQuota', () => {
  beforeEach(() => {
    clearAssignmentsForTest();
  });

  it('FREE tier within quota', () => {
    const result = checkQuota('free-tenant', 5_000n);
    assert.equal(result.exceeded, false);
    assert.equal(result.remaining, 5_000n);
  });

  it('FREE tier exceeded', () => {
    const result = checkQuota('free-tenant', 15_000n);
    assert.equal(result.exceeded, true);
    assert.equal(result.remaining, 0n);
  });

  it('PRO tier unlimited', async () => {
    await assignPlan('pro-tenant', 'PRO');
    const result = checkQuota('pro-tenant', 999_999_999n);
    assert.equal(result.exceeded, false);
    assert.equal(result.quota, 0n); // unlimited marker
  });
});

describe('S2.3 — Rate Limit per Plan', () => {
  beforeEach(() => {
    clearAssignmentsForTest();
  });

  it('FREE tier rate limit', () => {
    const rl = getPlanRateLimit('free-tenant');
    assert.equal(rl.windowSeconds, 60);
    assert.equal(rl.maxRequests, 60);
  });

  it('STARTER tier rate limit', async () => {
    await assignPlan('starter-tenant', 'STARTER');
    const rl = getPlanRateLimit('starter-tenant');
    assert.equal(rl.maxRequests, 300);
  });

  it('PRO tier rate limit', async () => {
    await assignPlan('pro-tenant', 'PRO');
    const rl = getPlanRateLimit('pro-tenant');
    assert.equal(rl.maxRequests, 1000);
  });
});

// ─── S2.2 — Invoice Tests ─────────────────────────────────────────

import { generateInvoice, serializeInvoice } from '../../src/billing/InvoiceService.js';
import { getAccountingLayer } from '../../src/security/talRuntime.js';

describe('S2.2 — Invoice Endpoint', () => {
  beforeEach(() => {
    clearAssignmentsForTest();
  });

  it('generates empty invoice for unknown tenant', () => {
    const invoice = generateInvoice('empty-tenant', '999');
    assert.equal(invoice.tenantId, 'empty-tenant');
    assert.equal(invoice.epochId, '999');
    assert.equal(invoice.totalCU, 0n);
    assert.equal(invoice.totalRequests, 0);
    assert.equal(invoice.lineItems.length, 0);
    assert.equal(invoice.planTier, 'FREE');
  });

  it('generates invoice with line items from TAL', () => {
    const tal = getAccountingLayer();
    // Add some entries
    tal.debit({ tenantId: 'inv-test', epochId: '100', requestId: 'r1', provider: 'openai', model: 'gpt-4', cu: 100n, ts: 1 });
    tal.debit({ tenantId: 'inv-test', epochId: '100', requestId: 'r2', provider: 'openai', model: 'gpt-4', cu: 200n, ts: 2 });
    tal.debit({ tenantId: 'inv-test', epochId: '100', requestId: 'r3', provider: 'anthropic', model: 'claude-3', cu: 50n, ts: 3 });

    const invoice = generateInvoice('inv-test', '100');
    assert.equal(invoice.totalCU, 350n);
    assert.equal(invoice.totalRequests, 3);
    assert.equal(invoice.lineItems.length, 2); // 2 provider:model groups
  });

  it('aggregates by provider+model', () => {
    const tal = getAccountingLayer();
    tal.debit({ tenantId: 'agg-test', epochId: '200', requestId: 'a1', provider: 'openai', model: 'gpt-4', cu: 100n, ts: 1 });
    tal.debit({ tenantId: 'agg-test', epochId: '200', requestId: 'a2', provider: 'openai', model: 'gpt-4', cu: 150n, ts: 2 });

    const invoice = generateInvoice('agg-test', '200');
    assert.equal(invoice.lineItems.length, 1);
    assert.equal(invoice.lineItems[0].provider, 'openai');
    assert.equal(invoice.lineItems[0].model, 'gpt-4');
    assert.equal(invoice.lineItems[0].requestCount, 2);
    assert.equal(invoice.lineItems[0].totalCU, 250n);
  });

  it('quotaUsedPct calculated for FREE tier', () => {
    const tal = getAccountingLayer();
    tal.debit({ tenantId: 'pct-test', epochId: '300', requestId: 'p1', provider: 'o', model: 'm', cu: 5000n, ts: 1 });

    const invoice = generateInvoice('pct-test', '300');
    assert.equal(invoice.quotaUsedPct, 50); // 5000/10000 = 50%
  });

  it('quotaUsedPct is -1 for PRO (unlimited)', async () => {
    await assignPlan('pro-inv', 'PRO');
    const invoice = generateInvoice('pro-inv', '400');
    assert.equal(invoice.quotaUsedPct, -1);
  });

  it('serializeInvoice converts bigints to strings', () => {
    const tal = getAccountingLayer();
    tal.debit({ tenantId: 'ser-test', epochId: '500', requestId: 's1', provider: 'o', model: 'm', cu: 100n, ts: 1 });

    const invoice = generateInvoice('ser-test', '500');
    const serialized = serializeInvoice(invoice);
    assert.equal(typeof serialized['totalCU'], 'string');
    assert.equal(serialized['totalCU'], '100');
    const items = serialized['lineItems'] as Array<Record<string, unknown>>;
    assert.equal(typeof items[0]['totalCU'], 'string');
  });
});
