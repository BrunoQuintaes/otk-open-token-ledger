/**
 * W7-B — USD Dashboard Tests (USD-01 through USD-07)
 *
 * Tests USD fields in ReceiptIndexer, InvoiceService, CuTrendData, and ReconciliationSystem.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ReceiptIndexer } from '../../src/dashboard/indexer.js';
import { reconcile } from '../../src/economics/ReconciliationSystem.js';

// ── USD-01: ReceiptIndexer.index() costUsd ──────────────────────────────────
describe('ReceiptIndexer USD-01', () => {
  it('index() computes costUsd for known provider/model', () => {
    const indexer = new ReceiptIndexer();
    indexer.index({
      requestId: 'r1',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
      costUnits: 1500,
      latencyMs: 100,
      timestamp: Date.now(),
      tenantId: 'tenant1',
    });
    const receipts = indexer.getRecentReceipts(10);
    assert.equal(receipts.length, 1);
    assert.ok(typeof receipts[0]!.costUsd === 'number');
    // 1000 input * 0.005/1K + 500 output * 0.015/1K = 0.005 + 0.0075 = 0.0125
    assert.ok(Math.abs(receipts[0]!.costUsd! - 0.0125) < 0.0001);
  });

  it('index() sets costUsd=0 for unknown provider/model', () => {
    const indexer = new ReceiptIndexer();
    indexer.index({
      requestId: 'r2',
      provider: 'unknown-provider',
      model: 'unknown-model',
      inputTokens: 1000,
      outputTokens: 500,
      costUnits: 0,
      latencyMs: 50,
      timestamp: Date.now(),
      tenantId: 'tenant1',
    });
    const receipts = indexer.getRecentReceipts(10);
    assert.equal(receipts[0]!.costUsd, 0);
  });
});

// ── USD-02: SystemOverview totalSpendUsd ────────────────────────────────────
describe('ReceiptIndexer USD-02', () => {
  it('getSystemOverview() includes totalSpendUsd', () => {
    const indexer = new ReceiptIndexer();
    indexer.index({
      requestId: 'r3',
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      inputTokens: 2000,
      outputTokens: 1000,
      costUnits: 3000,
      latencyMs: 200,
      timestamp: Date.now(),
      tenantId: 'tenant2',
    });
    const overview = indexer.getSystemOverview();
    assert.ok(typeof overview.totalSpendUsd === 'number');
    // 2000 * 0.003/1K + 1000 * 0.015/1K = 0.006 + 0.015 = 0.021
    assert.ok(Math.abs(overview.totalSpendUsd - 0.021) < 0.0001);
  });
});

// ── USD-04: ProviderUsage totalCostUsd ─────────────────────────────────────
describe('ReceiptIndexer USD-04', () => {
  it('getUsageByProvider() includes totalCostUsd', () => {
    const indexer = new ReceiptIndexer();
    indexer.index({
      requestId: 'r4',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 500,
      outputTokens: 200,
      costUnits: 700,
      latencyMs: 80,
      timestamp: Date.now(),
    });
    const usage = indexer.getUsageByProvider();
    const openaiUsage = usage.find(u => u.provider === 'openai');
    assert.ok(openaiUsage, 'openai usage should exist');
    assert.ok(typeof openaiUsage!.totalCostUsd === 'number');
    assert.ok(openaiUsage!.totalCostUsd > 0);
  });
});

// ── USD-07: ReconciliationSystem USD fields ─────────────────────────────────
describe('ReconciliationSystem USD-07', () => {
  it('reconcile() includes expectedUsd, deltaUsd, deltaPercent, discrepancyFlag', () => {
    const otkRecords = [{
      txHash: 'tx1',
      userId: 'user1',
      costUnits: 1000n,
      epoch: 1,
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
    }];
    const externalRecords = [{
      txHash: 'tx1',
      userId: 'user1',
      billedUsd: 0.015, // slightly over the expected 0.0125
    }];

    const report = reconcile(otkRecords, externalRecords);
    assert.equal(report.items.length, 1);
    const item = report.items[0]!;

    assert.ok(item.expectedUsd !== null, 'expectedUsd should be computed');
    assert.ok(Math.abs(item.expectedUsd! - 0.0125) < 0.0001);
    assert.ok(item.deltaUsd !== null);
    assert.ok(Math.abs(item.deltaUsd! - (0.015 - 0.0125)) < 0.0001);
    assert.ok(item.deltaPercent !== null);
    // discrepancyFlag: |delta%| > 5%: (0.0025/0.0125)*100 = 20% → true
    assert.equal(item.discrepancyFlag, true);
  });

  it('reconcile() sets expectedUsd=null when provider/model missing', () => {
    const otkRecords = [{
      txHash: 'tx2',
      userId: 'user2',
      costUnits: 1000n,
      epoch: 1,
      // no provider/model/tokens
    }];
    const externalRecords = [{
      txHash: 'tx2',
      userId: 'user2',
      billedUsd: 0.01,
    }];

    const report = reconcile(otkRecords, externalRecords);
    const item = report.items[0]!;
    assert.equal(item.expectedUsd, null);
    assert.equal(item.deltaUsd, null);
    assert.equal(item.deltaPercent, null);
    assert.equal(item.discrepancyFlag, false);
  });

  it('reconcile() no discrepancy when delta < 5%', () => {
    const otkRecords = [{
      txHash: 'tx3',
      userId: 'u3',
      costUnits: 1000n,
      epoch: 1,
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
    }];
    // Expected: 0.0125, billing: 0.013 → delta ~4% → no flag
    const externalRecords = [{ txHash: 'tx3', userId: 'u3', billedUsd: 0.013 }];
    const report = reconcile(otkRecords, externalRecords);
    assert.equal(report.items[0]!.discrepancyFlag, false);
  });
});

// ── USD-06: CuTrendData includes totalUsd ──────────────────────────────────
describe('Analytics USD-06', () => {
  it('getCuTrendData() returns totalUsd in each point', async () => {
    const { getCuTrendData } = await import('../../src/dashboard/analytics.js');
    const points = getCuTrendData(undefined, 3);
    assert.ok(Array.isArray(points));
    for (const p of points) {
      assert.ok('totalUsd' in p, 'should have totalUsd field');
      assert.ok(typeof p.totalUsd === 'number');
    }
  });
});
