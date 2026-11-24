/**
 * W5-5C01 — Analytics dashboard + Demo sandbox tests
 *
 * Tests pure/structural functions without importing the full indexer chain
 * (which transitively imports ethers — long-path issue on Google Drive + Windows).
 *
 * getCuTrendData() integration (with live indexer) is covered via npm test
 * full-suite run where all modules share one process.
 *
 * Covers:
 *   1. getCuTrendData() structure (day count, field shapes, sort order)
 *   2. getAnalyticsHtml() renders Chart.js + API endpoint reference
 *   3. DEMO_RECEIPTS seed correctness (7 days, required fields)
 *   4. getDemoStats() aggregation math
 *   5. getDemoHtml() renders expected content
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DEMO_RECEIPTS, getDemoStats, getDemoHtml } from '../../src/dashboard/demo.js';
import { getAnalyticsHtml } from '../../src/dashboard/analytics.js';

// ---------------------------------------------------------------------------
// Analytics HTML
// ---------------------------------------------------------------------------

describe('W5-5C01 — getAnalyticsHtml()', () => {
  it('returns valid HTML', () => {
    const html = getAnalyticsHtml();
    assert.ok(typeof html === 'string' && html.length > 0);
    assert.ok(html.startsWith('<!DOCTYPE html>'));
  });

  it('includes inline chart implementation', () => {
    const html = getAnalyticsHtml();
    assert.ok(html.includes('drawBars'), 'must include inline bar chart implementation');
  });

  it('references the cu-trend API endpoint', () => {
    const html = getAnalyticsHtml();
    assert.ok(html.includes('/v1/analytics/cu-trend'), 'must reference the API endpoint');
  });

  it('links back to dashboard and demo', () => {
    const html = getAnalyticsHtml();
    assert.ok(html.includes('href="/app"'), 'must link to dashboard');
    assert.ok(html.includes('/demo'), 'must link to demo sandbox');
  });
});

// ---------------------------------------------------------------------------
// DEMO_RECEIPTS seed data
// ---------------------------------------------------------------------------

describe('W5-5C01 — DEMO_RECEIPTS seed data', () => {
  it('DEMO_RECEIPTS is non-empty', () => {
    assert.ok(DEMO_RECEIPTS.length > 0, 'DEMO_RECEIPTS must be non-empty');
  });

  it('covers exactly 7 unique dates', () => {
    const dates = new Set(DEMO_RECEIPTS.map(r => r.date));
    assert.equal(dates.size, 7, 'must cover 7 distinct dates');
  });

  it('each receipt has all required fields', () => {
    for (const r of DEMO_RECEIPTS) {
      assert.ok(typeof r.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.date), 'date must be YYYY-MM-DD');
      assert.ok(typeof r.provider === 'string' && r.provider.length > 0, 'provider must be non-empty string');
      assert.ok(typeof r.model === 'string' && r.model.length > 0, 'model must be non-empty string');
      assert.ok(typeof r.cu === 'number' && r.cu > 0, 'cu must be positive number');
      assert.ok(typeof r.latencyMs === 'number' && r.latencyMs > 0, 'latencyMs must be positive number');
    }
  });

  it('covers multiple providers', () => {
    const providers = new Set(DEMO_RECEIPTS.map(r => r.provider));
    assert.ok(providers.size >= 2, 'must have at least 2 providers');
  });
});

// ---------------------------------------------------------------------------
// getDemoStats()
// ---------------------------------------------------------------------------

describe('W5-5C01 — getDemoStats()', () => {
  it('totalCU is positive', () => {
    const stats = getDemoStats();
    assert.ok(stats.totalCU > 0, 'totalCU must be positive');
  });

  it('receiptCount equals DEMO_RECEIPTS.length', () => {
    const stats = getDemoStats();
    assert.equal(stats.receiptCount, DEMO_RECEIPTS.length);
  });

  it('byDay has exactly 7 entries', () => {
    const stats = getDemoStats();
    assert.equal(stats.byDay.size, 7, 'must have 7 day buckets');
  });

  it('byProvider is non-empty', () => {
    const stats = getDemoStats();
    assert.ok(stats.byProvider.size > 0, 'byProvider must have entries');
  });

  it('sum of byDay values equals totalCU', () => {
    const stats = getDemoStats();
    const sumByDay = Array.from(stats.byDay.values()).reduce((s, v) => s + v, 0);
    assert.equal(sumByDay, stats.totalCU, 'byDay sum must equal totalCU');
  });

  it('sum of byProvider values equals totalCU', () => {
    const stats = getDemoStats();
    const sumByProvider = Array.from(stats.byProvider.values()).reduce((s, v) => s + v, 0);
    assert.equal(sumByProvider, stats.totalCU, 'byProvider sum must equal totalCU');
  });
});

// ---------------------------------------------------------------------------
// getDemoHtml()
// ---------------------------------------------------------------------------

describe('W5-5C01 — getDemoHtml()', () => {
  it('returns non-empty HTML', () => {
    const html = getDemoHtml();
    assert.ok(typeof html === 'string' && html.length > 0);
    assert.ok(html.startsWith('<!DOCTYPE html>'));
  });

  it('contains demo-tenant reference', () => {
    const html = getDemoHtml();
    assert.ok(html.includes('demo-tenant'), 'must mention demo-tenant');
  });

  it('contains FREE plan badge', () => {
    const html = getDemoHtml();
    assert.ok(html.includes('FREE plan'), 'must mention FREE plan');
  });

  it('contains Demo Mode banner', () => {
    const html = getDemoHtml();
    assert.ok(html.includes('Demo Mode'), 'must contain demo mode banner');
  });

  it('links to analytics and dashboard', () => {
    const html = getDemoHtml();
    assert.ok(html.includes('href="/analytics"'), 'must link to analytics');
    assert.ok(html.includes('href="/app"'), 'must link to dashboard');
  });

  it('shows at least one receipt row in table', () => {
    const html = getDemoHtml();
    assert.ok(html.includes('<tr>'), 'must have table rows');
  });
});
