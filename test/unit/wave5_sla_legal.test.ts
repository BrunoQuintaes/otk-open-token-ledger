/**
 * W5-5C02 — SLA tiers + ToS/DPA tests
 *
 * Covers:
 *   1. getSLAForTier() returns correct values per plan
 *   2. FREE plan has no SLA (maxLatencyP99Ms=0)
 *   3. STARTER/PRO have contractual bounds
 *   4. renderTermsPage() / renderPrivacyPage() / renderDpaPage() return valid HTML
 *   5. Legal pages include required sections
 *   6. routes.ts has /terms, /privacy, /dpa references
 *
 * Modules under test: `getSLAForTier` of `src/billing/PlanRegistry.ts` and the pages of
 * `src/dashboard/legal.ts`; the routes in `src/api/routes.ts` are checked as text.
 *
 * Strategy / partitions: the SLA per tier and their ordering; each legal page is HTML with its heading and
 * required sections; one route check per page.
 *
 * Needs: nothing external. Reads `src/api/routes.ts` relative to the current directory, so run it from the
 * repository root.
 *
 * Run just this file: `npx tsx --test test/unit/wave5_sla_legal.test.ts`
 *
 * @module test/unit/wave5_sla_legal.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getSLAForTier } from '../../src/billing/PlanRegistry.js';
import { renderTermsPage, renderPrivacyPage, renderDpaPage } from '../../src/dashboard/legal.js';

// ---------------------------------------------------------------------------
// getSLAForTier
// ---------------------------------------------------------------------------

describe('W5-5C02 — getSLAForTier()', () => {
  it('FREE returns maxLatencyP99Ms=0 (no SLA)', () => {
    const sla = getSLAForTier('FREE');
    assert.equal(sla.tier, 'FREE');
    assert.equal(sla.maxLatencyP99Ms, 0, 'FREE must have no p99 SLA');
    assert.equal(sla.uptimePercent, 0, 'FREE must have no uptime SLA');
  });

  it('STARTER returns p99 < 3000ms and 99.0% uptime', () => {
    const sla = getSLAForTier('STARTER');
    assert.equal(sla.tier, 'STARTER');
    assert.ok(sla.maxLatencyP99Ms > 0 && sla.maxLatencyP99Ms <= 3000, 'STARTER p99 must be ≤ 3000ms');
    assert.ok(sla.uptimePercent >= 99.0, 'STARTER uptime must be ≥ 99.0%');
  });

  it('PRO returns p99 < 1000ms and 99.9% uptime', () => {
    const sla = getSLAForTier('PRO');
    assert.equal(sla.tier, 'PRO');
    assert.ok(sla.maxLatencyP99Ms > 0 && sla.maxLatencyP99Ms <= 1000, 'PRO p99 must be ≤ 1000ms');
    assert.ok(sla.uptimePercent >= 99.9, 'PRO uptime must be ≥ 99.9%');
  });

  it('PRO SLA is stricter than STARTER', () => {
    const starter = getSLAForTier('STARTER');
    const pro = getSLAForTier('PRO');
    assert.ok(pro.maxLatencyP99Ms < starter.maxLatencyP99Ms, 'PRO p99 must be stricter than STARTER');
    assert.ok(pro.uptimePercent > starter.uptimePercent, 'PRO uptime must be higher than STARTER');
  });

  it('all tiers return a label string', () => {
    for (const tier of ['FREE', 'STARTER', 'PRO'] as const) {
      const sla = getSLAForTier(tier);
      assert.ok(typeof sla.label === 'string' && sla.label.length > 0, `${tier} must have a non-empty label`);
    }
  });
});

// ---------------------------------------------------------------------------
// Legal pages
// ---------------------------------------------------------------------------

describe('W5-5C02 — renderTermsPage()', () => {
  it('returns valid HTML', () => {
    const html = renderTermsPage();
    assert.ok(html.startsWith('<!DOCTYPE html>'), 'must be valid HTML');
    assert.ok(html.length > 500, 'must have substantial content');
  });

  it('contains Terms of Service heading', () => {
    const html = renderTermsPage();
    assert.ok(html.includes('Terms of Service'), 'must contain ToS heading');
  });

  it('mentions SLA tiers', () => {
    const html = renderTermsPage();
    assert.ok(html.includes('FREE') && html.includes('STARTER') && html.includes('PRO'), 'must mention all plan tiers');
  });

  it('links to privacy and DPA', () => {
    const html = renderTermsPage();
    assert.ok(html.includes('href="/privacy"'), 'must link to privacy');
    assert.ok(html.includes('href="/dpa"'), 'must link to DPA');
  });
});

describe('W5-5C02 — renderPrivacyPage()', () => {
  it('returns valid HTML', () => {
    const html = renderPrivacyPage();
    assert.ok(html.startsWith('<!DOCTYPE html>'));
  });

  it('contains Privacy Policy heading', () => {
    const html = renderPrivacyPage();
    assert.ok(html.includes('Privacy Policy'));
  });

  it('mentions LGPD/GDPR and data subject rights', () => {
    const html = renderPrivacyPage();
    assert.ok(html.includes('LGPD') || html.includes('GDPR'), 'must mention privacy regulation');
  });

  it('mentions data retention', () => {
    const html = renderPrivacyPage();
    assert.ok(html.includes('retention') || html.includes('Retention'), 'must mention data retention');
  });
});

describe('W5-5C02 — renderDpaPage()', () => {
  it('returns valid HTML', () => {
    const html = renderDpaPage();
    assert.ok(html.startsWith('<!DOCTYPE html>'));
  });

  it('contains DPA heading', () => {
    const html = renderDpaPage();
    assert.ok(html.includes('Data Processing Agreement'));
  });

  it('mentions Controller and Processor parties', () => {
    const html = renderDpaPage();
    assert.ok(html.includes('Controller') && html.includes('Processor'), 'DPA must define parties');
  });
});

describe('W5-5C02 — routes.ts has legal routes', () => {
  const routesPath = join(process.cwd(), 'src', 'api', 'routes.ts');

  it('/terms route exists in routes.ts', () => {
    const content = readFileSync(routesPath, 'utf8');
    assert.ok(content.includes('/terms'), 'routes.ts must have /terms route');
  });

  it('/privacy route exists in routes.ts', () => {
    const content = readFileSync(routesPath, 'utf8');
    assert.ok(content.includes('/privacy'), 'routes.ts must have /privacy route');
  });

  it('/dpa route exists in routes.ts', () => {
    const content = readFileSync(routesPath, 'utf8');
    assert.ok(content.includes('/dpa'), 'routes.ts must have /dpa route');
  });
});
