/**
 * P4.2 — Demo / Trial Sandbox (W5-5C01)
 *
 * Serves a read-only demo dashboard pre-loaded with synthetic receipt data.
 * No authentication required — purpose-built for evaluators and onboarding.
 *
 * The demo data is static (embedded): 7 days of usage for a FREE plan tenant
 * named "demo-tenant", covering realistic CU distributions across providers.
 *
 * Route (wired into routes.ts):
 *   GET /demo — Demo sandbox HTML page (no auth)
 *
 * The rows are generated once, when the module is loaded, for the 7 days ending on that day (UTC dates), so the
 * dates move with the process start but the counts and CU values never change. Nothing is read from the
 * receipt store, the accounting layer or the network.
 *
 * @module src/dashboard/demo
 * @since Wave 5 (W5-5C01 / P4.2)
 */

/** One synthetic receipt of the demo dataset. */
export interface DemoReceipt {
  /** UTC day, `YYYY-MM-DD`. */
  date: string;
  provider: string;
  model: string;
  /** Compute units of the request. */
  cu: number;
  /** Latency in milliseconds. */
  latencyMs: number;
}

/** 7-day seeded demo dataset for the FREE plan demo tenant. */
export const DEMO_RECEIPTS: DemoReceipt[] = (() => {
  const now = Date.now();
  const rows: DemoReceipt[] = [];
  const providers = [
    { provider: 'openai',    model: 'gpt-4o',            cuPerReq: 120, lat: 820 },
    { provider: 'openai',    model: 'gpt-4o-mini',       cuPerReq: 18,  lat: 310 },
    { provider: 'anthropic', model: 'claude-sonnet-4-6', cuPerReq: 95,  lat: 740 },
    { provider: 'anthropic', model: 'claude-haiku-4-5',  cuPerReq: 12,  lat: 190 },
  ];
  const dailyCounts = [14, 22, 18, 31, 27, 19, 25]; // last 7 days, oldest first
  for (let d = 6; d >= 0; d--) {
    const dayMs = now - d * 86_400_000;
    const date = new Date(dayMs).toISOString().slice(0, 10);
    const count = dailyCounts[6 - d];
    for (let i = 0; i < count; i++) {
      const p = providers[i % providers.length];
      rows.push({ date, provider: p.provider, model: p.model, cu: p.cuPerReq, latencyMs: p.lat });
    }
  }
  return rows;
})();

/**
 * Aggregate demo stats from DEMO_RECEIPTS.
 *
 * @returns Total CU, receipt count, CU per day (`YYYY-MM-DD` key) and CU per `"provider / model"`.
 */
export function getDemoStats() {
  let totalCU = 0;
  const byDay = new Map<string, number>();
  const byProvider = new Map<string, number>();
  for (const r of DEMO_RECEIPTS) {
    totalCU += r.cu;
    byDay.set(r.date, (byDay.get(r.date) ?? 0) + r.cu);
    const key = `${r.provider} / ${r.model}`;
    byProvider.set(key, (byProvider.get(key) ?? 0) + r.cu);
  }
  return { totalCU, receiptCount: DEMO_RECEIPTS.length, byDay, byProvider };
}

// ---------------------------------------------------------------------------
// Demo HTML
// ---------------------------------------------------------------------------

/**
 * Renders the public demo dashboard as a complete HTML document.
 *
 * @returns The HTML text built from `getDemoStats()`.
 */
export function getDemoHtml(): string {
  const stats = getDemoStats();
  const days = Array.from(stats.byDay.entries()).sort(([a], [b]) => a.localeCompare(b));
  const providers = Array.from(stats.byProvider.entries()).sort(([, a], [, b]) => b - a);

  const dayRows = days.map(([date, cu]) =>
    `<tr><td>${date}</td><td class="mono">${cu.toLocaleString()} CU</td></tr>`
  ).join('');

  const provRows = providers.map(([name, cu]) =>
    `<tr><td>${name}</td><td class="mono">${cu.toLocaleString()} CU</td></tr>`
  ).join('');

  const recentRows = DEMO_RECEIPTS.slice(-10).reverse().map(r =>
    `<tr><td>${r.date}</td><td>${r.provider}</td><td class="mono">${r.model}</td><td class="mono accent-yellow">${r.cu}</td><td class="mono">${r.latencyMs}ms</td></tr>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OTK — Demo Sandbox</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0f14;color:#e8eef6;min-height:100vh}
  header{padding:16px 24px;border-bottom:1px solid #1c2430;display:flex;align-items:center;justify-content:space-between}
  header h1{font-size:1.1rem;font-weight:600}
  .demo-banner{background:#14532d;color:#4ade80;padding:10px 24px;font-size:0.82rem;display:flex;align-items:center;gap:8px}
  .demo-banner strong{font-weight:600}
  .nav-links{display:flex;gap:16px;align-items:center}
  .nav-links a{color:#7db7ff;text-decoration:none;font-size:0.85rem}
  .nav-links a:hover{text-decoration:underline}
  main{padding:24px;max-width:1000px;margin:0 auto}
  .grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px}
  @media(max-width:700px){.grid-3{grid-template-columns:1fr}}
  .card{background:#111826;border:1px solid #1c2430;border-radius:12px;padding:20px;margin-bottom:20px}
  .card h2{font-size:0.78rem;color:#7b8fa8;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:8px}
  .kpi{font-size:1.8rem;font-weight:700;color:#fff;line-height:1}
  .kpi-sub{font-size:0.78rem;color:#7b8fa8;margin-top:4px}
  .accent-green{color:#4ade80}
  .accent-blue{color:#7db7ff}
  .accent-yellow{color:#fbbf24}
  table{width:100%;border-collapse:collapse;font-size:0.82rem}
  th{text-align:left;padding:8px 10px;color:#7b8fa8;border-bottom:1px solid #1c2430;font-weight:500}
  td{padding:8px 10px;border-bottom:1px solid #1c2430}
  tr:last-child td{border-bottom:none}
  .mono{font-family:monospace;font-size:0.78rem}
  .plan-tag{display:inline-block;background:#1a2540;color:#7db7ff;padding:3px 10px;border-radius:20px;font-size:0.72rem;font-family:monospace;margin-left:8px}
  .section-title{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;color:#7b8fa8;margin:24px 0 12px}
</style>
</head>
<body>

<header>
  <h1>OTK Demo Sandbox <span class="plan-tag">FREE plan</span></h1>
  <div class="nav-links">
    <a href="/analytics">Analytics</a>
    <a href="/app">Dashboard</a>
  </div>
</header>

<div class="demo-banner">
  <strong>Demo Mode</strong> — Pre-loaded synthetic data for tenant <code>demo-tenant</code>. No authentication required.
</div>

<main>
  <p class="section-title">Last 7 Days — Demo Tenant</p>
  <div class="grid-3">
    <div class="card">
      <h2>Total CU</h2>
      <div class="kpi accent-yellow">${stats.totalCU.toLocaleString()}</div>
      <div class="kpi-sub">cost units consumed</div>
    </div>
    <div class="card">
      <h2>Receipts</h2>
      <div class="kpi accent-green">${stats.receiptCount}</div>
      <div class="kpi-sub">API calls metered</div>
    </div>
    <div class="card">
      <h2>Avg CU/request</h2>
      <div class="kpi accent-blue">${Math.round(stats.totalCU / stats.receiptCount)}</div>
      <div class="kpi-sub">per metered call</div>
    </div>
  </div>

  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px">
    <div class="card">
      <h2>CU by Day</h2>
      <table>
        <thead><tr><th>Date</th><th>CU</th></tr></thead>
        <tbody>${dayRows}</tbody>
      </table>
    </div>
    <div class="card">
      <h2>CU by Provider</h2>
      <table>
        <thead><tr><th>Provider / Model</th><th>CU</th></tr></thead>
        <tbody>${provRows}</tbody>
      </table>
    </div>
  </div>

  <div class="card">
    <h2>Recent Receipts (last 10)</h2>
    <table>
      <thead>
        <tr><th>Date</th><th>Provider</th><th>Model</th><th>CU</th><th>Latency</th></tr>
      </thead>
      <tbody>${recentRows}</tbody>
    </table>
  </div>
</main>
</body>
</html>`;
}
