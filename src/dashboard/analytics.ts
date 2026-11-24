/**
 * P4.3 — Analytics Dashboard (W5-5C01)
 *
 * CU trend data endpoint and analytics HTML page.
 * Uses the ReceiptIndexer (in-memory) to compute per-day CU totals.
 *
 * Routes (wired into routes.ts):
 *   GET /analytics              — Analytics HTML page (Chart.js via CDN)
 *   GET /v1/analytics/cu-trend  — JSON: daily CU trend data
 *
 * @module dashboard/analytics
 * @since Wave 5 (W5-5C01 / P4.3)
 */

import { getIndexer } from './indexer.js';

export interface CuTrendPoint {
  date: string;   // ISO date "YYYY-MM-DD"
  totalCU: number;
  totalUsd: number;  // USD-06: daily USD spend
  receiptCount: number;
}

/**
 * Compute CU/USD trend: totalCU + totalUsd + receiptCount per calendar day for last N days.
 * Uses the in-memory ReceiptIndexer (pull model).
 *
 * @param tenantId  Optional: filter to specific tenant
 * @param days      Number of days to include (default 7)
 */
export function getCuTrendData(tenantId?: string, days = 7): CuTrendPoint[] {
  const indexer = getIndexer();
  const receipts = tenantId
    ? indexer.getReceiptsByTenant(tenantId, 10_000)
    : indexer.getRecentReceipts(10_000);

  // Build map: "YYYY-MM-DD" → { totalCU, totalUsd, receiptCount }
  const map = new Map<string, { totalCU: number; totalUsd: number; receiptCount: number }>();

  // Pre-fill all days in the window with zeros (ensures gaps show as 0 not missing)
  const now = Date.now();
  for (let d = days - 1; d >= 0; d--) {
    const dayMs = now - d * 86_400_000;
    const key = new Date(dayMs).toISOString().slice(0, 10);
    map.set(key, { totalCU: 0, totalUsd: 0, receiptCount: 0 });
  }

  const cutoffMs = now - days * 86_400_000;
  for (const r of receipts) {
    if (r.timestamp < cutoffMs) continue;
    const key = new Date(r.timestamp).toISOString().slice(0, 10);
    const agg = map.get(key) ?? { totalCU: 0, totalUsd: 0, receiptCount: 0 };
    agg.totalCU += r.costUnits;
    agg.totalUsd += r.costUsd ?? 0;
    agg.receiptCount += 1;
    map.set(key, agg);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, v]) => ({ date, ...v }));
}

// ---------------------------------------------------------------------------
// Analytics HTML page — self-contained, no CDN dependencies
// ---------------------------------------------------------------------------

export function getAnalyticsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>OTK — Analytics</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0f14;color:#e8eef6;min-height:100vh}
  header{padding:16px 24px;border-bottom:1px solid #1c2430;display:flex;align-items:center;justify-content:space-between}
  header h1{font-size:1.1rem;font-weight:600}
  .nav-links{display:flex;gap:16px;align-items:center}
  .nav-links a{color:#7db7ff;text-decoration:none;font-size:0.85rem;padding:6px 12px;background:#111826;border:1px solid #1c2430;border-radius:6px}
  .nav-links a:hover{background:#1a2540}
  main{padding:24px;max-width:1000px;margin:0 auto}
  .filter-bar{display:flex;gap:12px;align-items:center;margin-bottom:20px;flex-wrap:wrap}
  .filter-bar label{font-size:0.82rem;color:#7b8fa8}
  .filter-bar input,.filter-bar select{background:#111826;border:1px solid #1c2430;color:#e8eef6;padding:6px 12px;border-radius:6px;font-size:0.82rem}
  .btn{background:#1a2540;color:#7db7ff;border:1px solid #1c2430;padding:6px 16px;border-radius:6px;cursor:pointer;font-size:0.82rem}
  .btn:hover{background:#243050}
  .grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
  .grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:20px}
  @media(max-width:700px){.grid-4,.grid-2{grid-template-columns:1fr 1fr}}
  @media(max-width:450px){.grid-4,.grid-2{grid-template-columns:1fr}}
  .card{background:#111826;border:1px solid #1c2430;border-radius:12px;padding:20px;margin-bottom:20px}
  .card h2{font-size:0.78rem;color:#7b8fa8;margin-bottom:12px;text-transform:uppercase;letter-spacing:0.08em}
  .kpi{font-size:1.8rem;font-weight:700;color:#fff;line-height:1}
  .kpi-sub{font-size:0.78rem;color:#7b8fa8;margin-top:4px}
  .accent-green{color:#4ade80}
  .accent-blue{color:#7db7ff}
  .accent-yellow{color:#fbbf24}
  .accent-red{color:#f87171}
  .chart-wrap{position:relative;width:100%;height:240px}
  canvas{display:block;width:100%!important}
  .err{color:#f87171;font-size:0.82rem;padding:12px;background:#1a0a0a;border-radius:8px}
  table{width:100%;border-collapse:collapse;font-size:0.82rem;margin-top:12px}
  th{text-align:left;padding:8px 10px;color:#7b8fa8;border-bottom:1px solid #1c2430;font-weight:500}
  td{padding:8px 10px;border-bottom:1px solid #1c2430}
  tr:last-child td{border-bottom:none}
  .bar-cell{padding:4px 10px}
  .bar-bg{background:#1c2430;border-radius:4px;height:16px;overflow:hidden}
  .bar-fill{height:16px;border-radius:4px;transition:width 0.3s}
  .bar-cu{background:#2563eb}
  .bar-rc{background:#16a34a}
</style>
</head>
<body>

<header>
  <h1>OTK Analytics</h1>
  <div class="nav-links">
    <a href="/app">← Dashboard</a>
    <a href="/demo">Demo Sandbox</a>
  </div>
</header>

<main>
  <div class="filter-bar">
    <label>Tenant:</label>
    <input type="text" id="tenant-input" placeholder="all tenants" style="width:180px"/>
    <label>Days:</label>
    <select id="days-select">
      <option value="7" selected>7 days</option>
      <option value="14">14 days</option>
      <option value="30">30 days</option>
    </select>
    <button class="btn" onclick="loadData()">Refresh</button>
  </div>

  <div id="err-box" class="err" style="display:none;margin-bottom:16px"></div>

  <div class="grid-4">
    <div class="card">
      <h2>Total CU</h2>
      <div class="kpi accent-yellow" id="kpi-cu">--</div>
      <div class="kpi-sub">cost units</div>
    </div>
    <div class="card">
      <h2>Total USD</h2>
      <div class="kpi accent-green" id="kpi-usd">--</div>
      <div class="kpi-sub">provider cost</div>
    </div>
    <div class="card">
      <h2>Receipts</h2>
      <div class="kpi accent-blue" id="kpi-rc">--</div>
      <div class="kpi-sub">total indexed</div>
    </div>
    <div class="card">
      <h2>Avg/Day</h2>
      <div class="kpi" id="kpi-avg">--</div>
      <div class="kpi-sub">receipts per day</div>
    </div>
  </div>

  <div class="card">
    <h2>CU Consumption — Daily Trend</h2>
    <div class="chart-wrap">
      <canvas id="cu-chart"></canvas>
    </div>
  </div>

  <div class="card">
    <h2>Receipt Count — Daily</h2>
    <div class="chart-wrap">
      <canvas id="count-chart"></canvas>
    </div>
  </div>

  <div class="card">
    <h2>Daily Breakdown</h2>
    <div id="table-wrap"></div>
  </div>
</main>

<script>
function fmtNum(n) {
  if (n >= 1e6) return (n/1e6).toFixed(1)+'M';
  if (n >= 1e3) return (n/1e3).toFixed(1)+'k';
  return String(Math.round(n));
}

function fmtUsd(n) {
  if (n >= 1) return '$'+n.toFixed(2);
  if (n >= 0.01) return '$'+n.toFixed(4);
  return '$'+n.toFixed(6);
}

// ── Inline bar chart (no CDN) ──────────────────────────────────────────
function drawBars(canvasId, points, accessor, color, labelFn) {
  var canvas = document.getElementById(canvasId);
  if (!canvas || !canvas.getContext) return;
  var dpr = window.devicePixelRatio || 1;
  var w = canvas.parentElement.clientWidth || 600;
  var h = 220;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  var ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  var vals = points.map(accessor);
  var maxVal = Math.max.apply(null, vals) || 1;
  var padL = 48, padR = 12, padT = 16, padB = 36;
  var chartW = w - padL - padR;
  var chartH = h - padT - padB;
  var barW = Math.max(4, Math.floor(chartW / points.length) - 4);
  var gap = Math.floor((chartW - barW * points.length) / (points.length + 1));

  // Background
  ctx.fillStyle = '#111826';
  ctx.fillRect(0, 0, w, h);

  // Grid lines (4)
  ctx.strokeStyle = '#1c2430';
  ctx.lineWidth = 1;
  for (var i = 0; i <= 4; i++) {
    var y = padT + chartH - (i / 4) * chartH;
    ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke();
    var label = fmtNum((maxVal * i / 4));
    ctx.fillStyle = '#7b8fa8'; ctx.font = '10px system-ui'; ctx.textAlign = 'right';
    ctx.fillText(label, padL - 4, y + 4);
  }

  // Bars
  for (var j = 0; j < points.length; j++) {
    var x = padL + gap + j * (barW + gap);
    var barH = Math.max(2, (vals[j] / maxVal) * chartH);
    var y0 = padT + chartH - barH;

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, y0, barW, barH, 3) : ctx.rect(x, y0, barW, barH);
    ctx.fill();

    // X-axis label
    var d = points[j].date.slice(5); // MM-DD
    ctx.fillStyle = '#7b8fa8'; ctx.font = '9px system-ui'; ctx.textAlign = 'center';
    ctx.fillText(d, x + barW/2, h - padB + 14);

    // Value on hover stored in title via tooltip div is not trivial; skip for now
  }
}

function renderTable(points) {
  var maxCU = Math.max.apply(null, points.map(function(p){ return p.totalCU; })) || 1;
  var maxRC = Math.max.apply(null, points.map(function(p){ return p.receiptCount; })) || 1;
  var html = '<table><thead><tr><th>Date</th><th>CU</th><th></th><th>USD</th><th>Receipts</th><th></th></tr></thead><tbody>';
  for (var i = points.length - 1; i >= 0; i--) {
    var p = points[i];
    var cuPct = Math.round((p.totalCU / maxCU) * 100);
    var rcPct = Math.round((p.receiptCount / maxRC) * 100);
    html += '<tr>';
    html += '<td>' + p.date + '</td>';
    html += '<td style="font-weight:600;color:#fbbf24">' + fmtNum(p.totalCU) + '</td>';
    html += '<td class="bar-cell" style="width:120px"><div class="bar-bg"><div class="bar-fill bar-cu" style="width:'+cuPct+'%"></div></div></td>';
    html += '<td style="color:#4ade80">' + fmtUsd(p.totalUsd) + '</td>';
    html += '<td style="color:#7db7ff">' + p.receiptCount + '</td>';
    html += '<td class="bar-cell" style="width:80px"><div class="bar-bg"><div class="bar-fill bar-rc" style="width:'+rcPct+'%"></div></div></td>';
    html += '</tr>';
  }
  html += '</tbody></table>';
  document.getElementById('table-wrap').innerHTML = html;
}

async function loadData() {
  var tenantId = document.getElementById('tenant-input').value.trim();
  var days = document.getElementById('days-select').value;
  var params = new URLSearchParams({ days: days });
  if (tenantId) params.set('tenantId', tenantId);

  document.getElementById('err-box').style.display = 'none';

  var points;
  try {
    var res = await fetch('/v1/analytics/cu-trend?' + params.toString());
    if (!res.ok) throw new Error('HTTP ' + res.status);
    points = await res.json();
  } catch(e) {
    document.getElementById('err-box').textContent = 'Failed to load: ' + e.message;
    document.getElementById('err-box').style.display = 'block';
    return;
  }

  if (!points || points.length === 0) {
    document.getElementById('err-box').textContent = 'No data yet — run the seed script to populate.';
    document.getElementById('err-box').style.display = 'block';
    return;
  }

  var totalCU = points.reduce(function(s,p){ return s+p.totalCU; }, 0);
  var totalUsd = points.reduce(function(s,p){ return s+p.totalUsd; }, 0);
  var totalRC = points.reduce(function(s,p){ return s+p.receiptCount; }, 0);
  var avgRC = Math.round(totalRC / points.length);

  document.getElementById('kpi-cu').textContent = fmtNum(totalCU);
  document.getElementById('kpi-usd').textContent = fmtUsd(totalUsd);
  document.getElementById('kpi-rc').textContent = fmtNum(totalRC);
  document.getElementById('kpi-avg').textContent = String(avgRC);

  drawBars('cu-chart', points, function(p){ return p.totalCU; }, '#2563eb');
  drawBars('count-chart', points, function(p){ return p.receiptCount; }, '#16a34a');
  renderTable(points);
}

loadData();
</script>
</body>
</html>`;
}
