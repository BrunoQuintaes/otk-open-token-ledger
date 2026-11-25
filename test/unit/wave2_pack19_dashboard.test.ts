/**
 * Wave 2 Pack 19 — P2.1 Indexer + Dashboard Basic Tests
 *
 * Tests:
 *   - ReceiptIndexer: index, getRecentReceipts, getReceiptsByTenant, getTenantSummary, getSystemOverview
 *   - Empty state behavior
 *   - Dashboard HTML structure
 *   - Dashboard app route handler
 *
 * @since Wave 2 Pack 19 (2026-03-15)
 *
 * Modules under test: `src/dashboard/indexer.ts` (`ReceiptIndexer`) and `src/dashboard/app.ts` (the HTML page).
 *
 * Strategy / partitions: empty indexer; one receipt indexed and read back; recent receipts order; per-tenant
 * filter and summary; system overview; eviction past the maximum size; the default tenant; the page structure.
 *
 * Needs: nothing external (in-memory indexer).
 *
 * Run just this file: `npx tsx --test test/unit/wave2_pack19_dashboard.test.ts`
 *
 * @module test/unit/wave2_pack19_dashboard.test
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ReceiptIndexer } from '../../src/dashboard/indexer.js';
import { getDashboardHtml } from '../../src/dashboard/app.js';

describe('P2.1 — ReceiptIndexer', () => {

  let indexer: ReceiptIndexer;

  beforeEach(() => {
    indexer = new ReceiptIndexer({ maxSize: 100 });
  });

  it('starts empty with zero counts', () => {
    assert.equal(indexer.size, 0);
    assert.deepEqual(indexer.getRecentReceipts(), []);
    assert.deepEqual(indexer.getTenantSummary(), []);
    const overview = indexer.getSystemOverview();
    assert.equal(overview.totalReceipts, 0);
    assert.equal(overview.totalTenants, 0);
    assert.equal(overview.totalCU, 0);
    assert.ok(overview.uptimeMs >= 0, 'uptimeMs should be non-negative');
  });

  it('indexes a receipt and retrieves it', () => {
    indexer.index({
      requestId: 'req-001',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      costUnits: 150,
      latencyMs: 200,
      timestamp: 1710000000,
      tenantId: 'acme',
    });

    assert.equal(indexer.size, 1);
    const recent = indexer.getRecentReceipts(10);
    assert.equal(recent.length, 1);
    assert.equal(recent[0].requestId, 'req-001');
    assert.equal(recent[0].provider, 'openai');
    assert.equal(recent[0].tenantId, 'acme');
  });

  it('getRecentReceipts returns reverse-chronological order', () => {
    for (let i = 0; i < 5; i++) {
      indexer.index({
        requestId: `req-${i}`,
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 10,
        outputTokens: 5,
        costUnits: 15,
        latencyMs: 100,
        timestamp: 1710000000 + i,
      });
    }
    const recent = indexer.getRecentReceipts(3);
    assert.equal(recent.length, 3);
    assert.equal(recent[0].requestId, 'req-4');
    assert.equal(recent[1].requestId, 'req-3');
    assert.equal(recent[2].requestId, 'req-2');
  });

  it('getReceiptsByTenant filters correctly', () => {
    indexer.index({ requestId: 'r1', provider: 'a', model: 'm', inputTokens: 1, outputTokens: 1, costUnits: 2, latencyMs: 10, timestamp: 1, tenantId: 'alpha' });
    indexer.index({ requestId: 'r2', provider: 'b', model: 'm', inputTokens: 1, outputTokens: 1, costUnits: 3, latencyMs: 10, timestamp: 2, tenantId: 'beta' });
    indexer.index({ requestId: 'r3', provider: 'c', model: 'm', inputTokens: 1, outputTokens: 1, costUnits: 4, latencyMs: 10, timestamp: 3, tenantId: 'alpha' });

    const alpha = indexer.getReceiptsByTenant('alpha');
    assert.equal(alpha.length, 2);
    assert.equal(alpha[0].requestId, 'r3');
    assert.equal(alpha[1].requestId, 'r1');

    const beta = indexer.getReceiptsByTenant('beta');
    assert.equal(beta.length, 1);
    assert.equal(beta[0].requestId, 'r2');

    const none = indexer.getReceiptsByTenant('nonexistent');
    assert.equal(none.length, 0);
  });

  it('getTenantSummary aggregates per-tenant stats', () => {
    indexer.index({ requestId: 'r1', provider: 'a', model: 'm', inputTokens: 1, outputTokens: 1, costUnits: 100, latencyMs: 10, timestamp: 1, tenantId: 'acme' });
    indexer.index({ requestId: 'r2', provider: 'b', model: 'm', inputTokens: 1, outputTokens: 1, costUnits: 200, latencyMs: 10, timestamp: 2, tenantId: 'acme' });
    indexer.index({ requestId: 'r3', provider: 'c', model: 'm', inputTokens: 1, outputTokens: 1, costUnits: 50, latencyMs: 10, timestamp: 3, tenantId: 'beta' });

    const summary = indexer.getTenantSummary();
    assert.equal(summary.length, 2);
    // Sorted by lastActivityAt descending (beta was last)
    const acme = summary.find(s => s.tenantId === 'acme')!;
    const beta = summary.find(s => s.tenantId === 'beta')!;
    assert.equal(acme.totalReceipts, 2);
    assert.equal(acme.totalCU, 300);
    assert.equal(beta.totalReceipts, 1);
    assert.equal(beta.totalCU, 50);
  });

  it('getSystemOverview returns correct shape', () => {
    indexer.index({ requestId: 'r1', provider: 'a', model: 'm', inputTokens: 1, outputTokens: 1, costUnits: 100, latencyMs: 10, timestamp: 1, tenantId: 'x' });

    const overview = indexer.getSystemOverview();
    assert.equal(typeof overview.totalReceipts, 'number');
    assert.equal(typeof overview.totalTenants, 'number');
    assert.equal(typeof overview.totalCU, 'number');
    assert.equal(typeof overview.uptimeMs, 'number');
    assert.equal(typeof overview.queueDepth, 'number');
    assert.equal(typeof overview.chainHead, 'string');
    assert.equal(typeof overview.auditEntries, 'number');
    assert.equal(overview.totalReceipts, 1);
    assert.equal(overview.totalTenants, 1);
    assert.equal(overview.totalCU, 100);
  });

  it('evicts oldest when maxSize exceeded', () => {
    const small = new ReceiptIndexer({ maxSize: 3 });
    for (let i = 0; i < 5; i++) {
      small.index({ requestId: `r-${i}`, provider: 'a', model: 'm', inputTokens: 1, outputTokens: 1, costUnits: 10, latencyMs: 1, timestamp: i });
    }
    assert.equal(small.size, 3);
    const recent = small.getRecentReceipts(10);
    assert.equal(recent[0].requestId, 'r-4');
    assert.equal(recent[2].requestId, 'r-2');
  });

  it('defaults tenantId to "default" when not provided', () => {
    indexer.index({ requestId: 'r1', provider: 'a', model: 'm', inputTokens: 1, outputTokens: 1, costUnits: 10, latencyMs: 1, timestamp: 1 });
    const recent = indexer.getRecentReceipts();
    assert.equal(recent[0].tenantId, 'default');
  });
});

describe('P2.1 — Dashboard HTML', () => {

  it('generates valid HTML with expected structure', () => {
    const html = getDashboardHtml();
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'should start with DOCTYPE');
    assert.ok(html.includes('<title>OTK zk-Metering Dashboard</title>'), 'should have dashboard title');
    assert.ok(html.includes('kpi-receipts'), 'should have receipts KPI element');
    assert.ok(html.includes('kpi-tenants'), 'should have tenants KPI element');
    assert.ok(html.includes('kpi-cu'), 'should have CU KPI element');
    assert.ok(html.includes('kpi-uptime'), 'should have uptime KPI element');
    assert.ok(html.includes('/app/api/overview'), 'should fetch overview API');
    assert.ok(html.includes('/app/api/receipts'), 'should fetch receipts API');
    assert.ok(html.includes('/app/api/tenants'), 'should fetch tenants API');
    assert.ok(html.includes('setInterval'), 'should auto-refresh');
    assert.ok(html.includes('10000'), 'should refresh every 10 seconds');
  });
});
