/**
 * pricing.ts — Public pricing page HTML generator (P4.1)
 *
 * Reads FREE/STARTER/PRO plans from PlanRegistry and renders a tier
 * comparison table with CTA links to /app/signup.
 *
 * Called by the public pricing route in `src/api/routes.ts`. Environment variable read:
 * `OTK_PRICE_PER_CU_USD` (USD per CU, default 0.001). The STARTER price shown is computed here as
 * quota x price per CU x 0.8; it is NOT the plan's `priceUsd` field, and PRO is shown as "Custom".
 *
 * @module src/dashboard/pricing
 * @since Wave 4 (4C-PACK-4C01 / P4.1)
 */

import { getPlan } from '../billing/PlanRegistry.js';
import { escapeHtml as escape } from './sanitize.js';

// ──────────────────────────────────────────────────────────
// Pricing page generator
// ──────────────────────────────────────────────────────────

/**
 * Renders the public pricing page as a complete HTML document (no network or store access).
 *
 * @returns The HTML text; plan names and numbers are HTML-escaped.
 */
export function renderPricingPage(): string {
  const free = getPlan('FREE');
  const starter = getPlan('STARTER');
  const pro = getPlan('PRO');

  const pricePerCu = Number(process.env['OTK_PRICE_PER_CU_USD'] ?? 0.001);
  const starterPrice = (Number(starter.cuQuotaPerEpoch) * pricePerCu * 0.8).toFixed(2); // 20% margin
  const proPrice = 'Custom';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OTK zk-Metering — Pricing</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f8f9fa; color: #212529; }
    .header { background: #1a1a2e; color: #fff; padding: 2rem; text-align: center; }
    .header h1 { margin: 0; font-size: 2rem; }
    .header p { margin: 0.5rem 0 0; color: #adb5bd; }
    .plans { display: flex; gap: 1.5rem; justify-content: center; padding: 3rem 1rem; flex-wrap: wrap; }
    .plan { background: #fff; border-radius: 12px; padding: 2rem; width: 280px; box-shadow: 0 2px 8px rgba(0,0,0,.08); }
    .plan.featured { border: 2px solid #0d6efd; }
    .plan h2 { margin: 0 0 0.5rem; font-size: 1.4rem; }
    .plan .price { font-size: 2rem; font-weight: 700; color: #0d6efd; margin: 1rem 0; }
    .plan .price span { font-size: 1rem; font-weight: 400; color: #6c757d; }
    .plan ul { list-style: none; padding: 0; margin: 0 0 1.5rem; }
    .plan ul li { padding: 0.35rem 0; color: #495057; }
    .plan ul li::before { content: "✓ "; color: #198754; font-weight: bold; }
    .cta { display: block; text-align: center; background: #0d6efd; color: #fff; padding: 0.75rem; border-radius: 6px; text-decoration: none; font-weight: 600; }
    .cta:hover { background: #0b5ed7; }
    .cta.outline { background: #fff; color: #0d6efd; border: 2px solid #0d6efd; }
    .cta.outline:hover { background: #f0f5ff; }
    footer { text-align: center; padding: 2rem; color: #6c757d; font-size: 0.875rem; }
  </style>
</head>
<body>
  <div class="header">
    <h1>Simple, Transparent Pricing</h1>
    <p>Pay only for what you use. No surprises.</p>
  </div>

  <div class="plans">
    <!-- FREE -->
    <div class="plan">
      <h2>${escape(free.name)}</h2>
      <div class="price">$0 <span>/ month</span></div>
      <ul>
        <li>${escape(free.cuQuotaPerEpoch.toLocaleString())} CU / epoch</li>
        <li>${escape(String(free.rateLimitPerMinute))} req / min</li>
        <li>No ZK proofs</li>
        <li>No on-chain anchoring</li>
        <li>Community support</li>
      </ul>
      <a href="/app/signup?plan=FREE" class="cta outline">Get Started Free</a>
    </div>

    <!-- STARTER -->
    <div class="plan featured">
      <h2>${escape(starter.name)}</h2>
      <div class="price">$${escape(starterPrice)} <span>/ epoch</span></div>
      <ul>
        <li>${escape(starter.cuQuotaPerEpoch.toLocaleString())} CU / epoch</li>
        <li>${escape(String(starter.rateLimitPerMinute))} req / min</li>
        <li>ZK proofs included</li>
        <li>No on-chain anchoring</li>
        <li>Email support</li>
      </ul>
      <a href="/app/signup?plan=STARTER" class="cta">Start Free Trial</a>
    </div>

    <!-- PRO -->
    <div class="plan">
      <h2>${escape(pro.name)}</h2>
      <div class="price">${escape(proPrice)}</div>
      <ul>
        <li>Unlimited CU / epoch</li>
        <li>${escape(String(pro.rateLimitPerMinute))} req / min</li>
        <li>ZK proofs + on-chain anchoring</li>
        <li>Dedicated SLA</li>
        <li>Priority support</li>
      </ul>
      <a href="/app/signup?plan=PRO" class="cta">Contact Sales</a>
    </div>
  </div>

  <footer>
    <p>Prices are per billing epoch. CU = Cost Unit (normalized AI token usage metric).</p>
    <p>All plans include API access, metering receipts, and audit trail.</p>
  </footer>
</body>
</html>`;
}
