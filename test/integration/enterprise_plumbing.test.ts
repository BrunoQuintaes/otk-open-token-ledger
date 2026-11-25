/**
 * PACK-E4 — Enterprise Plumbing integration tests
 *
 * Tests the pure composite pipeline:
 *   requireTenantId → evaluateAll → debitToken → computePricingV2 → chainHash → evalBudget
 *
 * All inputs are deterministic (nowEpoch/nowIso/prevAuditHash injected).
 * No network, no filesystem, no wall-clock calls.
 *
 * Module under test: `src/enterprise/EnterpriseEvaluator.ts` (`evaluateEnterprise`), with billing tokens from
 * `src/economics/BillingToken.ts`.
 *
 * Strategy / scenarios (C1–C5): happy path (all gates pass, balance debited, no budget alert); quota policy denied
 * (no debit, denial audited); allowed but the usage crosses the budget warning threshold; determinism (same inputs,
 * identical outputs); policy allows but the billing token balance is insufficient.
 *
 * Run just this file: `npx tsx --test test/integration/enterprise_plumbing.test.ts`
 *
 * @module test/integration/enterprise_plumbing.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateEnterprise } from '../../src/enterprise/EnterpriseEvaluator.js';
import { createBillingToken } from '../../src/economics/BillingToken.js';
import type { EnterpriseRequest } from '../../src/enterprise/EnterpriseContext.js';

const GENESIS_HASH = '0'.repeat(64);
const NOW_ISO = '2026-01-01T00:00:00Z';
const NOW_EPOCH = 1_000_000;

/**
 * Build a base valid request for reuse across tests
 *
 * @param overrides - Fields that replace the defaults (shallow spread).
 * @returns A request that passes every gate: 1000-CU token and quota, 500 CU consumed, cost 100 CU.
 */
function baseRequest(overrides: Partial<EnterpriseRequest> = {}): EnterpriseRequest {
  const token = createBillingToken('tenant-1', 1000n, 0, {
    nowIso: NOW_ISO,
    idSeed: 'seed-base',
  });
  return {
    tenant: { tenantId: 'tenant-1', userId: 'user-1' },
    policies: [{ type: 'quota', maxCU: 1000n, period: 'daily' }],
    policyCtx: { consumedCU: 500n },
    token,
    costCU: 100n,
    consumedCU: 500n,
    pricing: { model: 'gpt-3.5-turbo', costUnits: 100, markupPercent: 20 },
    budgetPolicy: { maxCU: 1000n, warnPct: 80, criticalPct: 95 },
    prevAuditHash: GENESIS_HASH,
    nowEpoch: NOW_EPOCH,
    nowIso: NOW_ISO,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// C1 — Happy path: all gates pass, no budget alert
// ---------------------------------------------------------------------------
describe('EnterpriseEvaluator — C1: happy path', () => {
  const result = evaluateEnterprise(baseRequest());

  it('tenantCtx is populated', () => {
    assert.equal(result.tenantCtx.tenantId, 'tenant-1');
    assert.equal(result.tenantCtx.userId, 'user-1');
  });

  it('policy allowed', () => {
    assert.equal(result.policyDecision.allowed, true);
  });

  it('token debited: balance reduced by costCU', () => {
    assert.ok(result.tokenAfterDebit !== null);
    assert.equal(result.tokenAfterDebit!.balanceCU, 900n); // 1000 - 100
  });

  it('pricing computed: correct tier', () => {
    assert.ok(result.pricing !== null);
    assert.equal(result.pricing!.tier, 'STANDARD');
  });

  it('audit hash differs from genesis', () => {
    assert.notEqual(result.auditHash, GENESIS_HASH);
    assert.equal(result.auditHash.length, 64);
  });

  it('budget alert not triggered (60% usage)', () => {
    // consumedCU(500) + costCU(100) = 600 / maxCU(1000) = 60%
    assert.equal(result.budgetAlert.triggered, false);
    assert.equal(result.budgetAlert.level, null);
  });
});

// ---------------------------------------------------------------------------
// C2 — Policy denied: quota exceeded → no debit, denial audited
// ---------------------------------------------------------------------------
describe('EnterpriseEvaluator — C2: policy denied (quota)', () => {
  const result = evaluateEnterprise(baseRequest({
    policyCtx: { consumedCU: 1000n }, // consumed == maxCU → denied
  }));

  it('policy denied with quota reason', () => {
    assert.equal(result.policyDecision.allowed, false);
    if (!result.policyDecision.allowed) {
      assert.equal(result.policyDecision.policy, 'quota');
      assert.match(result.policyDecision.reason, /Quota exceeded/);
    }
  });

  it('token not debited (null)', () => {
    assert.equal(result.tokenAfterDebit, null);
  });

  it('pricing not computed (null)', () => {
    assert.equal(result.pricing, null);
  });

  it('audit hash still advances (denial is audited)', () => {
    assert.notEqual(result.auditHash, GENESIS_HASH);
    assert.equal(result.auditHash.length, 64);
  });
});

// ---------------------------------------------------------------------------
// C3 — Budget warn: allowed by policy, but usage crosses warn threshold
// ---------------------------------------------------------------------------
describe('EnterpriseEvaluator — C3: budget warn triggered', () => {
  const result = evaluateEnterprise(baseRequest({
    policyCtx: { consumedCU: 700n }, // 700 < 1000 → policy allows
    consumedCU: 790n,                // 790 + 100 = 890 / 1000 = 89% → warn (>80%)
    costCU: 100n,
  }));

  it('policy allowed', () => {
    assert.equal(result.policyDecision.allowed, true);
  });

  it('budget warn triggered at 89%', () => {
    assert.equal(result.budgetAlert.triggered, true);
    assert.equal(result.budgetAlert.level, 'warn');
    assert.ok(result.budgetAlert.pctUsed >= 89);
  });

  it('token still debited (alert does not block)', () => {
    assert.ok(result.tokenAfterDebit !== null);
    assert.equal(result.tokenAfterDebit!.balanceCU, 900n);
  });
});

// ---------------------------------------------------------------------------
// C4 — Determinism: same inputs → identical outputs
// ---------------------------------------------------------------------------
describe('EnterpriseEvaluator — C4: determinism', () => {
  const req = baseRequest();
  const r1 = evaluateEnterprise(req);
  const r2 = evaluateEnterprise(req);

  it('auditHash is identical', () => {
    assert.equal(r1.auditHash, r2.auditHash);
  });

  it('pricing finalPriceUsd is identical', () => {
    assert.equal(r1.pricing?.finalPriceUsd, r2.pricing?.finalPriceUsd);
  });

  it('budgetAlert pctUsed is identical', () => {
    assert.equal(r1.budgetAlert.pctUsed, r2.budgetAlert.pctUsed);
  });

  it('chained hash differs when prevAuditHash differs', () => {
    const r3 = evaluateEnterprise(baseRequest({ prevAuditHash: 'a'.repeat(64) }));
    assert.notEqual(r1.auditHash, r3.auditHash);
  });
});

// ---------------------------------------------------------------------------
// C5 — Billing failure: policy allows but token has insufficient balance
// ---------------------------------------------------------------------------
describe('EnterpriseEvaluator — C5: billing token insufficient', () => {
  const emptyToken = createBillingToken('tenant-1', 0n, 0, {
    nowIso: NOW_ISO,
    idSeed: 'seed-empty',
  });

  it('throws when policy allows but balance is 0', () => {
    assert.throws(
      () => evaluateEnterprise(baseRequest({ token: emptyToken })),
      /insufficient_balance/,
    );
  });
});
