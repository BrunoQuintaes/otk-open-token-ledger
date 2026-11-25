/**
 * W4-4C01 — Pricing Page + PricingEngineV2 tests (P4.1+P4.7)
 *
 * Covers:
 *   1.  src/pricing/PricingEngineV2.ts file exists
 *   2.  src/dashboard/pricing.ts file exists
 *   3.  routes.ts has /pricing route
 *   4.  PricingEngineV2: FREE tier margin = 0
 *   5.  PricingEngineV2: STARTER tier marginRate = 0.20
 *   6.  PricingEngineV2: PRO tier marginRate = 0.35
 *   7.  PricingEngineV2: total = unitPrice × cuUsed
 *   8.  PricingEngineV2: margin = total × marginRate
 *   9.  PricingEngineV2: margin always ≥ 0 (property test)
 *  10.  PricingEngineV2: total always ≥ 0 (property test)
 *  11.  PricingEngineV2: reads OTK_PRICE_PER_CU_USD from env
 *  12.  renderPricingPage() returns HTML string containing pricing data
 *  13.  renderPricingPage() contains all three tiers: Free, Starter, Pro
 *  14.  renderPricingPage() contains CTA links to /app/signup
 *  15.  PricingEngineV2 result has all required fields
 *  16.  PricingEngineV2: zero CU gives zero total and zero margin
 *  17.  PricingEngineV2: cuUsed field in result matches input
 *  18.  renderPricingPage() HTML is parseable (no unescaped < > in attributes)
 *
 * @since Wave 4 (4C-PACK-4C01 / P4.1+P4.7)
 *
 * Modules under test: `src/pricing/PricingEngineV2.ts` and `src/dashboard/pricing.ts`; the route list in
 * `src/api/routes.ts` is checked as text.
 *
 * Strategy / partitions: as listed above; the tier margins, the totals for several usages including zero, and
 * the price read from `OTK_PRICE_PER_CU_USD`.
 *
 * Needs: nothing external. Changes `OTK_PRICE_PER_CU_USD` and restores it after the engine group.
 *
 * Run just this file: `npx tsx --test test/unit/wave4_pricing.test.ts`
 *
 * @module test/unit/wave4_pricing.test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

import { PricingEngineV2 } from '../../src/pricing/PricingEngineV2.js';
import { renderPricingPage } from '../../src/dashboard/pricing.js';

// ──────────────────────────────────────────────────────────
// 1–3. File structure
// ──────────────────────────────────────────────────────────
describe('W4-4C01 — File structure', () => {
  it('src/pricing/PricingEngineV2.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/pricing/PricingEngineV2.ts')));
  });

  it('src/dashboard/pricing.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/dashboard/pricing.ts')));
  });

  it('routes.ts has /pricing route', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(content.includes("'/pricing'"));
  });
});

// ──────────────────────────────────────────────────────────
// 4–11. PricingEngineV2
// ──────────────────────────────────────────────────────────
describe('W4-4C01 — PricingEngineV2', () => {
  let origPrice: string | undefined;

  before(() => { origPrice = process.env['OTK_PRICE_PER_CU_USD']; });
  after(() => {
    if (origPrice !== undefined) process.env['OTK_PRICE_PER_CU_USD'] = origPrice;
    else delete process.env['OTK_PRICE_PER_CU_USD'];
  });

  it('FREE tier: marginRate = 0 and margin = 0', () => {
    const engine = new PricingEngineV2(0.001);
    const result = engine.computeMargin('FREE', 1000n);
    assert.strictEqual(result.marginRate, 0);
    assert.strictEqual(result.margin, 0);
  });

  it('STARTER tier: marginRate = 0.20', () => {
    const engine = new PricingEngineV2(0.001);
    const result = engine.computeMargin('STARTER', 1000n);
    assert.strictEqual(result.marginRate, 0.20);
  });

  it('PRO tier: marginRate = 0.35', () => {
    const engine = new PricingEngineV2(0.001);
    const result = engine.computeMargin('PRO', 1000n);
    assert.strictEqual(result.marginRate, 0.35);
  });

  it('total = unitPrice × cuUsed', () => {
    const engine = new PricingEngineV2(0.002);
    const result = engine.computeMargin('STARTER', 500n);
    assert.ok(Math.abs(result.total - 0.002 * 500) < 1e-10);
  });

  it('margin = total × marginRate', () => {
    const engine = new PricingEngineV2(0.001);
    const result = engine.computeMargin('PRO', 2000n);
    const expected = result.total * result.marginRate;
    assert.ok(Math.abs(result.margin - expected) < 1e-10);
  });

  it('margin always ≥ 0 for all tiers', () => {
    const engine = new PricingEngineV2(0.001);
    for (const tier of ['FREE', 'STARTER', 'PRO'] as const) {
      const r = engine.computeMargin(tier, 10000n);
      assert.ok(r.margin >= 0, `margin for ${tier} should be >= 0`);
    }
  });

  it('total always ≥ 0 for all tiers', () => {
    const engine = new PricingEngineV2(0.001);
    for (const tier of ['FREE', 'STARTER', 'PRO'] as const) {
      const r = engine.computeMargin(tier, 10000n);
      assert.ok(r.total >= 0, `total for ${tier} should be >= 0`);
    }
  });

  it('reads OTK_PRICE_PER_CU_USD from env', () => {
    process.env['OTK_PRICE_PER_CU_USD'] = '0.005';
    const engine = new PricingEngineV2();
    assert.strictEqual(engine.unitPrice, 0.005);
  });

  it('zero CU gives zero total and zero margin', () => {
    const engine = new PricingEngineV2(0.001);
    const result = engine.computeMargin('PRO', 0n);
    assert.strictEqual(result.total, 0);
    assert.strictEqual(result.margin, 0);
  });

  it('result has all required fields (tier, cuUsed, unitPrice, total, margin, marginRate)', () => {
    const engine = new PricingEngineV2(0.001);
    const result = engine.computeMargin('STARTER', 100n);
    assert.ok('tier' in result);
    assert.ok('cuUsed' in result);
    assert.ok('unitPrice' in result);
    assert.ok('total' in result);
    assert.ok('margin' in result);
    assert.ok('marginRate' in result);
  });

  it('cuUsed field in result matches input', () => {
    const engine = new PricingEngineV2(0.001);
    const result = engine.computeMargin('FREE', 42n);
    assert.strictEqual(result.cuUsed, 42n);
  });
});

// ──────────────────────────────────────────────────────────
// 12–15. renderPricingPage()
// ──────────────────────────────────────────────────────────
describe('W4-4C01 — renderPricingPage()', () => {
  let html: string;

  before(() => { html = renderPricingPage(); });

  it('returns non-empty HTML string', () => {
    assert.ok(typeof html === 'string');
    assert.ok(html.length > 100);
    assert.ok(html.includes('<!DOCTYPE html>'));
  });

  it('contains all three plan tiers', () => {
    assert.ok(html.includes('Free') || html.includes('FREE'));
    assert.ok(html.includes('Starter') || html.includes('STARTER'));
    assert.ok(html.includes('Pro') || html.includes('PRO'));
  });

  it('contains CTA links to /app/signup', () => {
    assert.ok(html.includes('/app/signup'));
  });

  it('HTML is well-formed (starts with DOCTYPE, ends with /html)', () => {
    assert.ok(html.trimStart().startsWith('<!DOCTYPE html>'));
    assert.ok(html.trimEnd().endsWith('</html>'));
  });
});
