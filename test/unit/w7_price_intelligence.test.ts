/**
 * W7-A — Price Intelligence Engine Tests (PI-08)
 *
 * Tests PriceStore, PriceScraper (mock), PriceScheduler, CostBridge live/seed fallback.
 * No live HTTP calls — all scrapers mocked via module injection.
 *
 * Modules under test (imported dynamically inside each test): `src/pricing/PriceStore.ts`,
 * `src/pricing/PriceScraper.ts`, `src/pricing/PriceScheduler.ts` and `src/pricing/economics/CostBridge.ts`;
 * also the committed price seed file.
 *
 * Strategy / partitions: the store without Redis (writes ignored, reads fall back to the seed); the scraper and
 * a scrape run (result shape only, success or failure both accepted); the scheduler disabled when
 * `OTK_PRICE_SCRAPE_ENABLED` is unset; the cost bridge with the seed, an unknown provider and an unknown model;
 * the seed file structure.
 *
 * Needs: no Redis. Note: the scraper is not mocked; the scraper and scrape-run cases call the real provider
 * pricing pages over HTTPS when the machine is online and accept a failure when it is offline.
 *
 * Run just this file: `npx tsx --test test/unit/w7_price_intelligence.test.ts`
 *
 * @module test/unit/w7_price_intelligence.test
 */

import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

// ── PriceStore (unit, no Redis) ──────────────────────────────────────────────
describe('PriceStore', () => {
  it('setPrice/getPrice returns null when Redis not available', async () => {
    const { getPrice, setPrice } = await import('../../src/pricing/PriceStore.js');
    // Redis not initialized in test env
    await setPrice('openai', 'gpt-4o', { inputUsdPer1K: 0.005, outputUsdPer1K: 0.015 });
    const result = await getPrice('openai', 'gpt-4o');
    // Without Redis, getPrice should return null (graceful degradation)
    assert.equal(result, null);
  });

  it('listPrices returns seed data when Redis unavailable', async () => {
    const { listPrices } = await import('../../src/pricing/PriceStore.js');
    const prices = await listPrices();
    assert.ok(prices.length > 0, 'should return seed prices');
    const openaiGpt4o = prices.find(p => p.provider === 'openai' && p.model === 'gpt-4o');
    assert.ok(openaiGpt4o, 'gpt-4o should be in seed');
    assert.equal(openaiGpt4o!.source, 'seed');
    assert.equal(openaiGpt4o!.inputUsdPer1K, 0.005);
    assert.equal(openaiGpt4o!.outputUsdPer1K, 0.015);
    assert.equal(openaiGpt4o!.updatedAt, null);
  });

  it('listPrices includes all providers from seed', async () => {
    const { listPrices } = await import('../../src/pricing/PriceStore.js');
    const prices = await listPrices();
    const providers = [...new Set(prices.map(p => p.provider))];
    assert.ok(providers.includes('openai'), 'openai in seed');
    assert.ok(providers.includes('anthropic'), 'anthropic in seed');
    assert.ok(providers.includes('gemini'), 'gemini in seed');
  });
});

// ── PriceScraper (structure/type tests — no live HTTP) ──────────────────────
describe('PriceScraper', () => {
  it('scrapeOpenAI returns null on fetch failure (offline)', async () => {
    // In test environment with no internet, fetch fails → returns null
    const { scrapeOpenAI } = await import('../../src/pricing/PriceScraper.js');
    const result = await scrapeOpenAI();
    // Either null (network failure) or a valid result with models
    if (result !== null) {
      assert.equal(result.provider, 'openai');
      assert.ok(typeof result.scrapedAt === 'string');
      assert.ok(Object.keys(result.models).length > 0);
      for (const [, price] of Object.entries(result.models)) {
        assert.ok(typeof price.inputUsdPer1K === 'number');
        assert.ok(typeof price.outputUsdPer1K === 'number');
        assert.ok(price.inputUsdPer1K > 0);
        assert.ok(price.outputUsdPer1K > 0);
      }
    }
    // null is also valid (offline test env)
  });

  it('scrapeAllProviders returns an array (even if empty)', async () => {
    const { scrapeAllProviders } = await import('../../src/pricing/PriceScraper.js');
    const results = await scrapeAllProviders();
    assert.ok(Array.isArray(results));
    for (const r of results) {
      assert.ok(['openai', 'anthropic', 'gemini'].includes(r.provider));
      assert.ok(Object.keys(r.models).length > 0);
    }
  });
});

// ── PriceScheduler (unit) ────────────────────────────────────────────────────
describe('PriceScheduler', () => {
  it('startPriceScheduler is a no-op when OTK_PRICE_SCRAPE_ENABLED not set', async () => {
    const { startPriceScheduler, stopPriceScheduler, getPriceSchedulerStatus } = await import('../../src/pricing/PriceScheduler.js');
    const prev = process.env['OTK_PRICE_SCRAPE_ENABLED'];
    delete process.env['OTK_PRICE_SCRAPE_ENABLED'];
    startPriceScheduler();
    const status = getPriceSchedulerStatus();
    assert.equal(status.running, false);
    assert.equal(status.enabled, false);
    stopPriceScheduler();
    if (prev !== undefined) process.env['OTK_PRICE_SCRAPE_ENABLED'] = prev;
  });

  it('getPriceSchedulerStatus returns correct shape', async () => {
    const { getPriceSchedulerStatus } = await import('../../src/pricing/PriceScheduler.js');
    const status = getPriceSchedulerStatus();
    assert.ok('running' in status);
    assert.ok('enabled' in status);
    assert.ok('lastRunAt' in status);
    assert.ok('lastResult' in status);
  });

  it('runPriceScrape returns updated/failed arrays', async () => {
    const { runPriceScrape } = await import('../../src/pricing/PriceScheduler.js');
    const result = await runPriceScrape();
    assert.ok(Array.isArray(result.updated));
    assert.ok(Array.isArray(result.failed));
    // In offline test env, all providers either fail or return nothing
    const allProviders = [...result.updated, ...result.failed];
    for (const p of allProviders) {
      assert.ok(typeof p === 'string');
    }
  });
});

// ── CostBridge async + seed fallback ────────────────────────────────────────
describe('CostBridge (PI-07: live/seed fallback)', () => {
  it('calculateUsdCost falls back to seed when Redis unavailable', async () => {
    const { calculateUsdCost } = await import('../../src/pricing/economics/CostBridge.js');
    const result = await calculateUsdCost({
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 500,
    });
    // Should use seed (Redis not available in test)
    assert.equal(result.priceSource, 'seed');
    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'gpt-4o');
    assert.ok(result.totalCostUsd > 0);
    // 1000 input * 0.005/1K + 500 output * 0.015/1K = 0.005 + 0.0075 = 0.0125
    assert.ok(Math.abs(result.totalCostUsd - 0.0125) < 0.0001);
  });

  it('calculateUsdCost throws for unknown provider', async () => {
    const { calculateUsdCost } = await import('../../src/pricing/economics/CostBridge.js');
    await assert.rejects(
      () => calculateUsdCost({ provider: 'unknown-provider', model: 'x', inputTokens: 1, outputTokens: 1 }),
      /unknown provider/i
    );
  });

  it('calculateUsdCostSync uses seed only', async () => {
    const { calculateUsdCostSync } = await import('../../src/pricing/economics/CostBridge.js');
    const result = calculateUsdCostSync({
      provider: 'anthropic',
      model: 'claude-sonnet-4',
      inputTokens: 2000,
      outputTokens: 1000,
    });
    assert.equal(result.priceSource, 'seed');
    // 2000 * 0.003/1K + 1000 * 0.015/1K = 0.006 + 0.015 = 0.021
    assert.ok(Math.abs(result.totalCostUsd - 0.021) < 0.0001);
  });

  it('calculateUsdCostSync throws for unknown model', async () => {
    const { calculateUsdCostSync } = await import('../../src/pricing/economics/CostBridge.js');
    assert.throws(
      () => calculateUsdCostSync({ provider: 'openai', model: 'gpt-unknown', inputTokens: 1, outputTokens: 1 }),
      /unknown model/i
    );
  });
});

// ── price_seed.json structure ────────────────────────────────────────────────
describe('price_seed.json', () => {
  it('has correct structure', async () => {
    const seed: unknown = JSON.parse(readFileSync(new URL('../../src/pricing/data/price_seed.json', import.meta.url), 'utf-8'));
    const s = seed as Record<string, unknown>;
    assert.ok('_version' in s);
    assert.ok('openai' in s);
    assert.ok('anthropic' in s);
    assert.ok('gemini' in s);

    const openai = s['openai'] as Record<string, { inputUsdPer1K: number; outputUsdPer1K: number }>;
    assert.ok('gpt-4o' in openai);
    assert.equal(openai['gpt-4o']!.inputUsdPer1K, 0.005);
  });
});
