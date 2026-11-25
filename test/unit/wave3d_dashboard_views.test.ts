/**
 * Wave 3D — Dashboard Views Tests (P2.3–P2.6)
 *
 * Tests:
 *   1. Tab navigation HTML structure
 *   2. Indexer: getUsageByProvider + getProviderHealth
 *   3. REST endpoints: /app/api/usage, /app/api/admin/summary, /app/api/providers/health, /app/api/dead-letters
 *   4. Dashboard HTML contains all 6 tabs (Overview, Receipts, Billing, Admin, Health, Onboarding)
 *
 * Modules under test: `src/dashboard/indexer.ts` (usage per provider and provider health),
 * `src/dashboard/app.ts` (the tabbed page) and the dashboard API routes of `src/api/routes.ts`.
 *
 * Strategy / partitions: usage aggregated per provider and model, filtered by tenant, average latency, unknown
 * tenant, ordering; health with p95 and maximum latency and ordering; each tab and its script and style in the
 * page; one call per dashboard API route; the exported types compile.
 *
 * Needs: nothing external; requests are in-memory mocks that send the value of `OTK_ADMIN_KEY` (or a test
 * default) as the platform key.
 *
 * Run just this file: `npx tsx --test test/unit/wave3d_dashboard_views.test.ts`
 *
 * @module test/unit/wave3d_dashboard_views.test
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ===========================================================================
// ReceiptIndexer — new aggregation methods
// ===========================================================================

import { ReceiptIndexer } from '../../src/dashboard/indexer.js';

describe('W3D — ReceiptIndexer.getUsageByProvider (P2.3)', () => {
  let indexer: ReceiptIndexer;

  beforeEach(() => {
    indexer = new ReceiptIndexer();
    indexer.index({ requestId: 'r1', provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50, costUnits: 200, latencyMs: 150, timestamp: 1000, tenantId: 't1' });
    indexer.index({ requestId: 'r2', provider: 'openai', model: 'gpt-4', inputTokens: 200, outputTokens: 100, costUnits: 400, latencyMs: 250, timestamp: 1001, tenantId: 't1' });
    indexer.index({ requestId: 'r3', provider: 'anthropic', model: 'claude-3', inputTokens: 300, outputTokens: 150, costUnits: 600, latencyMs: 100, timestamp: 1002, tenantId: 't2' });
  });

  it('aggregates CU by provider+model', () => {
    const usage = indexer.getUsageByProvider();
    assert.equal(usage.length, 2);
    const openai = usage.find(u => u.provider === 'openai');
    assert.ok(openai);
    assert.equal(openai.requests, 2);
    assert.equal(openai.totalCU, 600);
    assert.equal(openai.totalTokens, 450);
  });

  it('filters by tenantId', () => {
    const usage = indexer.getUsageByProvider('t2');
    assert.equal(usage.length, 1);
    assert.equal(usage[0].provider, 'anthropic');
    assert.equal(usage[0].totalCU, 600);
  });

  it('computes average latency', () => {
    const usage = indexer.getUsageByProvider();
    const openai = usage.find(u => u.provider === 'openai')!;
    assert.equal(openai.avgLatencyMs, 200); // (150+250)/2
  });

  it('returns empty for unknown tenant', () => {
    const usage = indexer.getUsageByProvider('unknown');
    assert.equal(usage.length, 0);
  });

  it('sorts by totalCU descending', () => {
    const usage = indexer.getUsageByProvider();
    assert.ok(usage[0].totalCU >= usage[1].totalCU);
  });
});

describe('W3D — ReceiptIndexer.getProviderHealth (P2.6)', () => {
  let indexer: ReceiptIndexer;

  beforeEach(() => {
    indexer = new ReceiptIndexer();
    for (let i = 0; i < 20; i++) {
      indexer.index({
        requestId: `r${i}`, provider: 'openai', model: 'gpt-4',
        inputTokens: 100, outputTokens: 50, costUnits: 200,
        latencyMs: 100 + i * 10, timestamp: 1000 + i, tenantId: 't1',
      });
    }
    indexer.index({ requestId: 'ra1', provider: 'anthropic', model: 'claude-3', inputTokens: 100, outputTokens: 50, costUnits: 300, latencyMs: 50, timestamp: 2000, tenantId: 't1' });
  });

  it('returns per-provider health metrics', () => {
    const health = indexer.getProviderHealth();
    assert.equal(health.length, 2);
  });

  it('computes p95 latency', () => {
    const health = indexer.getProviderHealth();
    const openai = health.find(h => h.provider === 'openai')!;
    assert.ok(openai.p95LatencyMs > 0);
    assert.ok(openai.p95LatencyMs <= openai.maxLatencyMs);
    assert.equal(openai.requests, 20);
  });

  it('computes max latency', () => {
    const health = indexer.getProviderHealth();
    const openai = health.find(h => h.provider === 'openai')!;
    assert.equal(openai.maxLatencyMs, 290); // 100 + 19*10
  });

  it('sorts by request count descending', () => {
    const health = indexer.getProviderHealth();
    assert.ok(health[0].requests >= health[1].requests);
  });
});

// ===========================================================================
// Dashboard HTML structure — tabs
// ===========================================================================

import { getDashboardHtml } from '../../src/dashboard/app.js';

describe('W3D — Dashboard HTML tab structure', () => {
  const html = getDashboardHtml();

  it('contains at least 6 tab buttons', () => {
    const tabMatches = html.match(/class="tab/g);
    assert.ok(tabMatches && tabMatches.length >= 6, `expected >= 6 tabs, got ${tabMatches?.length}`);
  });

  it('contains Overview tab (default active)', () => {
    assert.ok(html.includes('data-tab="overview"'));
    assert.ok(html.includes('id="tab-overview"'));
  });

  it('contains Receipts tab (P2.3)', () => {
    assert.ok(html.includes('data-tab="receipts"'));
    assert.ok(html.includes('id="tab-receipts"'));
    assert.ok(html.includes('filter-provider'));
  });

  it('contains Billing tab (P2.4)', () => {
    assert.ok(html.includes('data-tab="billing"'));
    assert.ok(html.includes('id="tab-billing"'));
    assert.ok(html.includes('plan-cards'));
  });

  it('contains Admin tab (P2.5)', () => {
    assert.ok(html.includes('data-tab="admin"'));
    assert.ok(html.includes('id="tab-admin"'));
    assert.ok(html.includes('admin-tenants-table'));
    assert.ok(html.includes('admin-dl-table'));
  });

  it('contains Health tab (P2.6)', () => {
    assert.ok(html.includes('data-tab="health"'));
    assert.ok(html.includes('id="tab-health"'));
    assert.ok(html.includes('provider-health-grid'));
    assert.ok(html.includes('system-status-cards'));
  });

  it('has tab-switching JavaScript', () => {
    assert.ok(html.includes("data-tab"));
    assert.ok(html.includes("classList.add('active')"));
  });

  it('has CSS for tabs', () => {
    assert.ok(html.includes('.tabs{'));
    assert.ok(html.includes('.tab-content{'));
  });
});

// ===========================================================================
// REST endpoint contracts
// ===========================================================================

function mockReq(method: string, url: string): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, {
    method,
    url,
    headers: { 'x-admin-key': process.env['OTK_ADMIN_KEY'] ?? 'test-admin-key' },
  }) as unknown as IncomingMessage;
  process.nextTick(() => em.emit('end'));
  return req;
}

type MockRes = ServerResponse & { body: string };

function mockRes(): MockRes {
  let body = '';
  return {
    statusCode: 200,
    setHeader: () => {},
    end: (data: string) => { body = data; },
    get body() { return body; },
  } as unknown as MockRes;
}

import { handleRequest } from '../../src/api/routes.js';

describe('W3D — /app/api/usage endpoint (P2.3)', () => {
  it('returns usage array', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/app/api/usage'), res);
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.ok);
    assert.ok(Array.isArray(json.usage));
  });
});

describe('W3D — /app/api/admin/summary endpoint (P2.5)', () => {
  it('returns admin summary with expected fields', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/app/api/admin/summary'), res);
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.ok);
    assert.equal(typeof json.tenantCount, 'number');
    assert.equal(typeof json.deadLetterPending, 'number');
    assert.equal(typeof json.auditCount, 'number');
    assert.equal(typeof json.governanceCount, 'number');
    assert.equal(typeof json.chainIntegrity, 'boolean');
  });
});

describe('W3D — /app/api/dead-letters endpoint (P2.5)', () => {
  it('returns dead-letter entries array', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/app/api/dead-letters?limit=5'), res);
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.ok);
    assert.ok(Array.isArray(json.entries));
  });
});

describe('W3D — /app/api/providers/health endpoint (P2.6)', () => {
  it('returns providers health array', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/app/api/providers/health'), res);
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.ok);
    assert.ok(Array.isArray(json.providers));
  });
});

// ===========================================================================
// Type exports
// ===========================================================================

import type { ProviderUsage, ProviderHealth } from '../../src/dashboard/indexer.js';

describe('W3D — Type exports', () => {
  it('ProviderUsage type compiles', () => {
    const u: ProviderUsage = { provider: 'openai', model: 'gpt-4', requests: 1, totalCU: 100, avgLatencyMs: 50, totalTokens: 200, totalCostUsd: 0 };
    assert.ok(u.provider);
  });

  it('ProviderHealth type compiles', () => {
    const h: ProviderHealth = { provider: 'openai', requests: 10, avgLatencyMs: 100, p95LatencyMs: 200, maxLatencyMs: 300, totalCU: 5000 };
    assert.ok(h.provider);
  });
});
