/**
 * Tests — PricingEngineV2 (RB-055)
 *
 * Module under test: `src/pricing/PricingEngineV2.ts` (`resolveModelTier`, `volumeDiscount`, `computePricingV2`,
 * `DEFAULT_VOLUME_BRACKETS`), which turns cost units into a price using a model tier, an SLA surcharge on the
 * markup, a volume discount and an optional currency conversion.
 *
 * Strategy / partitions: known models of each tier and an unknown model (falls back to the middle tier); small,
 * bracket-boundary and large volumes, and custom brackets; a basic price; tier ordering for the same CU; each SLA
 * surcharge; the discount effect; conversion to BRL with and without an exchange rate; and monotonicity of the
 * volume discount.
 *
 * Needs: nothing external (pure functions).
 *
 * Run just this file: `npx tsx --test test/pricing/PricingEngineV2.test.ts`
 *
 * @module test/pricing/PricingEngineV2.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveModelTier,
  volumeDiscount,
  computePricingV2,
  DEFAULT_VOLUME_BRACKETS,
} from '../../src/pricing/PricingEngineV2.js';

describe('PricingEngineV2 — resolveModelTier', () => {
  it('maps gpt-4o to ADVANCED', () => {
    assert.equal(resolveModelTier('gpt-4o'), 'ADVANCED');
  });
  it('maps claude-3-haiku to STANDARD', () => {
    assert.equal(resolveModelTier('claude-3-haiku'), 'STANDARD');
  });
  it('maps claude-3-opus to FRONTIER', () => {
    assert.equal(resolveModelTier('claude-3-opus'), 'FRONTIER');
  });
  it('falls back to ADVANCED for unknown model', () => {
    assert.equal(resolveModelTier('unknown-model-xyz'), 'ADVANCED');
  });
});

describe('PricingEngineV2 — volumeDiscount', () => {
  it('returns 0 for small volumes', () => {
    assert.equal(volumeDiscount(0), 0);
    assert.equal(volumeDiscount(500_000), 0);
  });
  it('returns 5% at 1M CU', () => {
    assert.equal(volumeDiscount(1_000_000), 5);
  });
  it('returns 10% at 10M CU', () => {
    assert.equal(volumeDiscount(10_000_000), 10);
  });
  it('returns 15% at 100M CU', () => {
    assert.equal(volumeDiscount(100_000_000), 15);
  });
  it('accepts custom brackets', () => {
    const custom = [{ minCU: 0, discountPct: 0 }, { minCU: 100, discountPct: 50 }];
    assert.equal(volumeDiscount(200, custom), 50);
  });
});

describe('PricingEngineV2 — computePricingV2', () => {
  it('computes basic price for gpt-4o (ADVANCED tier)', () => {
    const r = computePricingV2({ model: 'gpt-4o', costUnits: 1000, markupPercent: 20 });
    assert.equal(r.tier, 'ADVANCED');
    assert.equal(r.slaTier, 'BEST_EFFORT');
    assert.equal(r.slaPercent, 0);
    assert.ok(r.costUsd > 0);
    assert.ok(r.finalPriceUsd > r.costUsd);
    assert.ok(r.marginUsd > 0);
  });

  it('STANDARD tier costs less than FRONTIER for same CU', () => {
    const std = computePricingV2({ model: 'gpt-3.5-turbo', costUnits: 1000 });
    const frt = computePricingV2({ model: 'claude-3-opus', costUnits: 1000 });
    assert.ok(std.costUsd < frt.costUsd, `STANDARD ${std.costUsd} should < FRONTIER ${frt.costUsd}`);
  });

  it('PREMIUM_SLA adds 25% surcharge to markup', () => {
    const best = computePricingV2({ model: 'gpt-4o', costUnits: 1000, markupPercent: 20, slaTier: 'BEST_EFFORT' });
    const prem = computePricingV2({ model: 'gpt-4o', costUnits: 1000, markupPercent: 20, slaTier: 'PREMIUM_SLA' });
    assert.equal(prem.markupPercent, 45);
    assert.ok(prem.finalPriceUsd > best.finalPriceUsd);
  });

  it('volume discount reduces cost', () => {
    const small = computePricingV2({ model: 'gpt-4o', costUnits: 1000, monthlyTotalCU: 0 });
    const large = computePricingV2({ model: 'gpt-4o', costUnits: 1000, monthlyTotalCU: 100_000_000 });
    assert.ok(large.costUsd < small.costUsd, 'High volume should be cheaper');
    assert.equal(large.volumeDiscountPct, 15);
  });

  it('BRL conversion when fxRate provided', () => {
    const r = computePricingV2({ model: 'gpt-4o', costUnits: 1000, markupPercent: 20, fxRate: 5.0 });
    assert.ok(r.finalPriceBrl !== undefined);
    assert.ok(r.finalPriceBrl! > r.finalPriceUsd);
  });
});

// --- QA1 edge cases ---
describe('PricingEngineV2 — QA1 edge cases', () => {
  it('tier cost order: STANDARD < ADVANCED < FRONTIER', () => {
    const std = computePricingV2({ model: 'gpt-3.5-turbo', costUnits: 1000 });
    const adv = computePricingV2({ model: 'gpt-4o', costUnits: 1000 });
    const frt = computePricingV2({ model: 'claude-3-opus', costUnits: 1000 });
    assert.ok(std.costUsd < adv.costUsd, 'STANDARD < ADVANCED');
    assert.ok(adv.costUsd < frt.costUsd, 'ADVANCED < FRONTIER');
  });

  it('volumeDiscount is monotonically non-decreasing', () => {
    const volumes = [0, 500_000, 1_000_000, 5_000_000, 10_000_000, 50_000_000, 100_000_000];
    let prev = -1;
    for (const v of volumes) {
      const d = volumeDiscount(v, DEFAULT_VOLUME_BRACKETS);
      assert.ok(d >= prev, `discount at ${v} (${d}) should be >= prev (${prev})`);
      prev = d;
    }
  });

  it('STANDARD_SLA adds exactly 10% surcharge to markup', () => {
    const base = computePricingV2({ model: 'gpt-4o', costUnits: 1000, markupPercent: 20, slaTier: 'BEST_EFFORT' });
    const sla  = computePricingV2({ model: 'gpt-4o', costUnits: 1000, markupPercent: 20, slaTier: 'STANDARD_SLA' });
    assert.equal(sla.markupPercent, 30);
    assert.equal(sla.slaPercent, 10);
    assert.ok(sla.finalPriceUsd > base.finalPriceUsd);
  });

  it('no fxRate → finalPriceBrl undefined', () => {
    const r = computePricingV2({ model: 'gpt-4o', costUnits: 1000, markupPercent: 20 });
    assert.equal(r.finalPriceBrl, undefined);
  });
});
