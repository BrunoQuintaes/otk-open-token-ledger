/**
 * P2.1 — Dashboard Web App
 *
 * Self-contained single-page dashboard served from the API server.
 * No build tools, no external JS/CSS dependencies. Inline everything.
 *
 * Routes (wired into handleRequest in routes.ts):
 *   GET /app          — Dashboard HTML page
 *   GET /app/api/overview  — JSON system overview
 *   GET /app/api/receipts  — JSON recent receipts
 *   GET /app/api/tenants   — JSON tenant summary
 *
 * @module dashboard/app
 * @since Wave 2 Pack 19 (P2.1)
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { getIndexer } from './indexer.js';
import { URL } from 'node:url';
import { isAuthEnabled } from '../api/tenantKeyRegistry.js';
import { escapeHtml } from './sanitize.js';
import { generateCsrfToken } from '../auth/csrf.js';
import { tenantCount, tenantAuditStatus } from '../api/tenantCrud.js';
import { listDeadLetters, pendingCount } from '../api/deadLetterStore.js';
import { getGovernanceTrail } from '../security/GovernanceTrail.js';

// ── JSON helper ─────────────────────────────────────────────────────

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(data));
  res.end(data);
}

function sendHtml(res: ServerResponse, code: number, html: string): void {
  res.statusCode = code;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(html));
  res.end(html);
}

// ── Dashboard HTML (self-contained) ─────────────────────────────────

export function getDashboardHtml(opts?: { sessionId?: string }): string {
  // H6.3: CSRF token embedded for any dashboard form submissions (future-proof)
  const sessionId = opts?.sessionId ?? 'anonymous';
  const csrfToken = generateCsrfToken(sessionId);
  // H6.1: escapeHtml applied to any server-side dynamic content
  const safeSessionId = escapeHtml(sessionId);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="otk-csrf" content="${csrfToken}" data-session="${safeSessionId}"/>
<title>OTK zk-Metering Dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0b0f14;color:#e8eef6;min-height:100vh}
  header{padding:16px 24px;border-bottom:1px solid #1c2430;display:flex;align-items:center;justify-content:space-between}
  header h1{font-size:1.1rem;font-weight:600}
  .header-right{display:flex;align-items:center;gap:12px}
  .tag{background:#1a2540;color:#7db7ff;padding:3px 10px;border-radius:20px;font-size:0.75rem;font-family:monospace}
  .status-dot{width:8px;height:8px;border-radius:50%;background:#4ade80;display:inline-block}
  .status-dot.error{background:#f87171}
  main{padding:24px;max-width:1100px;margin:0 auto}
  .section-title{font-size:0.75rem;text-transform:uppercase;letter-spacing:0.1em;color:#7b8fa8;margin:24px 0 12px}
  .grid{display:grid;gap:12px}
  .grid-4{grid-template-columns:repeat(4,1fr)}
  .grid-2{grid-template-columns:repeat(2,1fr)}
  @media(max-width:800px){.grid-4,.grid-2{grid-template-columns:1fr}}
  .card{background:#111826;border:1px solid #1c2430;border-radius:12px;padding:16px}
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
  .mono{font-family:monospace;font-size:0.78rem;color:#7db7ff}
  .empty{color:#7b8fa8;font-style:italic;padding:20px;text-align:center}
  .refresh-info{font-size:0.72rem;color:#7b8fa8}
  .nav-links{display:flex;gap:12px;margin-top:16px}
  .nav-links a{color:#7db7ff;text-decoration:none;font-size:0.85rem}
  .nav-links a:hover{text-decoration:underline}
  #error-banner{display:none;background:#7f1d1d;color:#fca5a5;padding:8px 16px;border-radius:8px;margin-bottom:16px;font-size:0.85rem}
  .logout-btn{background:none;border:1px solid #7b8fa8;color:#7b8fa8;padding:4px 12px;border-radius:6px;cursor:pointer;font-size:0.75rem}
  .logout-btn:hover{border-color:#e8eef6;color:#e8eef6}
  .tabs{display:flex;gap:0;border-bottom:1px solid #1c2430;margin-bottom:20px}
  .tab{padding:10px 20px;cursor:pointer;color:#7b8fa8;font-size:0.85rem;border-bottom:2px solid transparent;transition:color 0.2s,border-color 0.2s}
  .tab:hover{color:#e8eef6}
  .tab.active{color:#7db7ff;border-bottom-color:#7db7ff}
  .tab-content{display:none}
  .tab-content.active{display:block}
  .filter-bar{display:flex;gap:12px;align-items:center;margin-bottom:16px}
  .filter-bar select,.filter-bar input{background:#111826;border:1px solid #1c2430;color:#e8eef6;padding:6px 12px;border-radius:6px;font-size:0.82rem}
  .usage-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:12px;margin-top:12px}
  .badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:0.7rem;font-weight:600}
  .badge-owner{background:#1a2540;color:#7db7ff}
  .badge-admin{background:#1a2540;color:#a78bfa}
  .badge-member{background:#1a2540;color:#4ade80}
  .badge-viewer{background:#1a2540;color:#fbbf24}
  .badge-operator{background:#1a2540;color:#fb923c}
  .status-pill{display:inline-block;padding:3px 10px;border-radius:12px;font-size:0.72rem;font-weight:600}
  .status-ok{background:#14532d;color:#4ade80}
  .status-warn{background:#713f12;color:#fbbf24}
  .status-err{background:#7f1d1d;color:#f87171}
  .progress-bar{background:#1c2430;border-radius:6px;height:8px;overflow:hidden;margin-top:6px}
  .progress-fill{height:100%;border-radius:6px;transition:width 0.3s}
  .plan-card{border-left:3px solid #7db7ff;padding-left:12px}
</style>
</head>
<body>

<header>
  <h1>OTK zk-Metering Dashboard</h1>
  <div class="header-right">
    <span class="status-dot" id="status-dot"></span>
    <span class="refresh-info">Auto-refresh: 10s</span>
    <button class="logout-btn" id="logout-btn" onclick="logout()">Logout</button>
  </div>
</header>

<main>
  <div id="error-banner"></div>

  <div class="tabs">
    <div class="tab active" data-tab="overview">Overview</div>
    <div class="tab" data-tab="receipts">Receipts</div>
    <div class="tab" data-tab="billing">Billing</div>
    <div class="tab" data-tab="finance">Finance</div>
    <div class="tab" data-tab="admin">Admin</div>
    <div class="tab" data-tab="health">Health</div>
    <div class="tab" data-tab="onboarding">Onboarding</div>
    <div class="tab" data-tab="ga">GA Status</div>
    <a class="tab" href="/analytics" style="text-decoration:none">Analytics ↗</a>
  </div>

  <div id="tab-overview" class="tab-content active">
  <p class="section-title">System Overview</p>
  <div class="grid grid-4">
    <div class="card">
      <h2>Total Receipts</h2>
      <div class="kpi accent-green" id="kpi-receipts">--</div>
      <div class="kpi-sub">indexed in session</div>
    </div>
    <div class="card">
      <h2>Tenants</h2>
      <div class="kpi accent-blue" id="kpi-tenants">--</div>
      <div class="kpi-sub">active</div>
    </div>
    <div class="card">
      <h2>Total CU</h2>
      <div class="kpi accent-yellow" id="kpi-cu">--</div>
      <div class="kpi-sub">cost units consumed</div>
    </div>
    <div class="card">
      <h2>Uptime</h2>
      <div class="kpi" id="kpi-uptime">--</div>
      <div class="kpi-sub">server uptime</div>
    </div>
  </div>

  <p class="section-title">Recent Receipts</p>
  <div class="card">
    <div id="receipts-table">
      <div class="empty">No receipts yet. Submit one via POST /receipts.</div>
    </div>
  </div>

  <p class="section-title">Tenant Summary</p>
  <div class="card">
    <div id="tenants-table">
      <div class="empty">No tenant data yet.</div>
    </div>
  </div>

  </div><!-- /tab-overview -->

  <div id="tab-receipts" class="tab-content">
    <p class="section-title">Receipts &amp; Usage (P2.3)</p>
    <div class="filter-bar">
      <select id="filter-provider"><option value="">All Providers</option></select>
      <select id="filter-tenant"><option value="">All Tenants</option></select>
    </div>
    <div class="card">
      <div id="filtered-receipts-table"><div class="empty">Loading receipts...</div></div>
    </div>
    <p class="section-title">Usage by Provider</p>
    <div class="usage-grid" id="usage-grid"><div class="empty">Loading usage data...</div></div>
  </div>

  <div id="tab-billing" class="tab-content">
    <p class="section-title">Plan Information (P2.4)</p>
    <div class="grid grid-3" id="plan-cards"><div class="empty">Loading plans...</div></div>
    <p class="section-title">Running Cycle — USD Totals (BILL-05)</p>
    <div class="grid grid-4">
      <div class="card">
        <h2>Spend This Cycle</h2>
        <div class="kpi accent-yellow" id="kpi-cycle-usd">--</div>
        <div class="kpi-sub">provider cost USD</div>
      </div>
      <div class="card">
        <h2>OTK Margin</h2>
        <div class="kpi accent-green" id="kpi-cycle-margin">--</div>
        <div class="kpi-sub">markup collected</div>
      </div>
      <div class="card">
        <h2>Active Tenants</h2>
        <div class="kpi accent-blue" id="kpi-cycle-tenants">--</div>
        <div class="kpi-sub">billed this cycle</div>
      </div>
      <div class="card">
        <h2>Cycle Status</h2>
        <div class="kpi" id="kpi-cycle-status">--</div>
        <div class="kpi-sub">open / submitted</div>
      </div>
    </div>
    <p class="section-title">Invoice</p>
    <div class="card">
      <div class="filter-bar">
        <select id="invoice-tenant"><option value="">Select tenant</option></select>
        <input id="invoice-epoch" placeholder="Epoch ID (e.g. 2026-04)" style="width:160px"/>
        <button onclick="loadInvoice()" style="background:#1a2540;color:#7db7ff;border:1px solid #1c2430;padding:6px 14px;border-radius:6px;cursor:pointer">Load</button>
      </div>
      <div id="invoice-table"><div class="empty">Select a tenant and epoch to view invoice.</div></div>
    </div>
    <p class="section-title">Billing Cycle History</p>
    <div class="card">
      <div id="billing-cycles-table"><div class="empty">Loading billing history...</div></div>
    </div>
  </div>

  <div id="tab-finance" class="tab-content">
    <p class="section-title">Provider P&amp;L Summary (W9-A PAY-03)</p>
    <div class="grid grid-4">
      <div class="card">
        <h2>Total Collected (USD)</h2>
        <div class="kpi accent-green" id="kpi-fin-collected">--</div>
        <div class="kpi-sub">from tenants this cycle</div>
      </div>
      <div class="card">
        <h2>Total Owed (USD)</h2>
        <div class="kpi accent-yellow" id="kpi-fin-owed">--</div>
        <div class="kpi-sub">to AI providers</div>
      </div>
      <div class="card">
        <h2>Net Margin (USD)</h2>
        <div class="kpi accent-blue" id="kpi-fin-margin">--</div>
        <div class="kpi-sub">collected minus owed</div>
      </div>
      <div class="card">
        <h2>Pending Payouts</h2>
        <div class="kpi" id="kpi-fin-pending">--</div>
        <div class="kpi-sub">awaiting payment</div>
      </div>
    </div>
    <div style="margin-top:12px">
      <button onclick="refreshFinance()" style="background:#1a2540;color:#7db7ff;border:1px solid #1c2430;padding:6px 14px;border-radius:6px;cursor:pointer">Refresh Finance Data</button>
    </div>
    <p class="section-title">Pending Provider Payouts</p>
    <div class="card">
      <div id="finance-payouts-table"><div class="empty">Click Refresh to load finance data.</div></div>
    </div>
  </div>

  <div id="tab-admin" class="tab-content">
    <p class="section-title">Admin Panel (P2.5)</p>
    <div class="grid grid-4" id="admin-kpis"><div class="empty">Loading...</div></div>
    <p class="section-title">Tenants</p>
    <div class="card"><div id="admin-tenants-table"><div class="empty">Loading tenants...</div></div></div>
    <p class="section-title">Dead-Letter Queue</p>
    <div class="card"><div id="admin-dl-table"><div class="empty">Loading dead-letters...</div></div></div>
    <p class="section-title">Audit Chain</p>
    <div class="card"><div id="admin-audit-info"><div class="empty">Loading audit status...</div></div></div>
  </div>

  <div id="tab-onboarding" class="tab-content">
    <p class="section-title">Getting Started (P3.2)</p>
    <div class="card" id="wizard-container">
      <div id="wizard-step-1" class="wizard-step">
        <h2 style="color:#e8eef6;margin-bottom:12px">Welcome to OTK zk-Metering</h2>
        <p style="color:#7b8fa8;margin-bottom:16px">Follow these steps to submit your first metered receipt.</p>
        <button class="login-btn" style="max-width:200px" onclick="wizardNext(2)">Get Started</button>
      </div>
      <div id="wizard-step-2" class="wizard-step" style="display:none">
        <h2 style="color:#e8eef6;margin-bottom:12px">Step 1: Create an API Key</h2>
        <p style="color:#7b8fa8;margin-bottom:12px">Generate a key to authenticate your requests.</p>
        <div class="filter-bar">
          <input id="wizard-key-label" placeholder="Key label (e.g. Production)" style="flex:1"/>
          <button class="login-btn" style="max-width:160px" onclick="wizardCreateKey()">Generate Key</button>
        </div>
        <div id="wizard-key-result" style="display:none;margin-top:12px;background:#0b0f14;padding:12px;border-radius:8px">
          <p style="color:#fbbf24;font-size:0.82rem;margin-bottom:6px">Save this key — it will only be shown once:</p>
          <code id="wizard-key-value" class="mono" style="word-break:break-all"></code>
        </div>
      </div>
      <div id="wizard-step-3" class="wizard-step" style="display:none">
        <h2 style="color:#e8eef6;margin-bottom:12px">Step 2: Submit Your First Receipt</h2>
        <p style="color:#7b8fa8;margin-bottom:12px">Run this command to submit a test receipt:</p>
        <div style="background:#0b0f14;padding:12px;border-radius:8px;overflow-x:auto">
          <pre id="wizard-curl" class="mono" style="white-space:pre-wrap;word-break:break-all"></pre>
        </div>
        <button class="login-btn" style="max-width:200px;margin-top:12px" onclick="wizardNext(4)">I submitted it</button>
      </div>
      <div id="wizard-step-4" class="wizard-step" style="display:none">
        <h2 style="color:#e8eef6;margin-bottom:12px">Step 3: Verify Your Receipt</h2>
        <p style="color:#7b8fa8;margin-bottom:12px">Check the Receipts tab to see your submitted receipt. If it appears, you're all set!</p>
        <button class="login-btn" style="max-width:200px" onclick="document.querySelector('[data-tab=receipts]').click()">Go to Receipts</button>
      </div>
    </div>
    <p class="section-title">API Keys Management (P3.3)</p>
    <div class="card">
      <div class="filter-bar">
        <input id="new-key-label" placeholder="New key label..." style="flex:1"/>
        <select id="new-key-role"><option value="MEMBER">MEMBER</option><option value="ADMIN">ADMIN</option><option value="VIEWER">VIEWER</option></select>
        <button class="login-btn" style="max-width:140px" onclick="createNewKey()">Create Key</button>
      </div>
      <div id="keys-table" style="margin-top:12px"><div class="empty">Loading keys...</div></div>
    </div>
  </div>

  <div id="tab-health" class="tab-content">
    <p class="section-title">Provider Health (P2.6)</p>
    <div class="usage-grid" id="provider-health-grid"><div class="empty">Loading provider health...</div></div>
    <p class="section-title">System Status</p>
    <div class="grid grid-4" id="system-status-cards"><div class="empty">Loading...</div></div>
  </div>

  <div id="tab-ga" class="tab-content">
    <p class="section-title">GA Readiness — 6 Sign-offs Required (2 / 6 Complete)</p>
    <div class="grid" style="grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:20px">
      <div class="card" style="border-left:3px solid #f87171">
        <h2>GA-1 — External Pentest</h2>
        <div style="margin-bottom:6px"><span class="status-pill status-warn">PENDING</span></div>
        <div class="kpi-sub">OWASP Top 10 · RBAC · ZK replay · auth flows</div>
        <div class="kpi-sub" style="margin-top:6px">Aguardando contratação de firma de segurança</div>
      </div>
      <div class="card" style="border-left:3px solid #4ade80">
        <h2>GA-2 — Disaster Recovery Drill</h2>
        <div style="margin-bottom:6px"><span class="status-pill status-ok">DONE</span></div>
        <div class="kpi accent-green" style="font-size:1.4rem">RTO 7m54s</div>
        <div class="kpi-sub">RPO = 0s · pg_restore · smoke test HTTP 201</div>
        <div class="kpi-sub" style="margin-top:4px">Drill: 2026-04-15 · Categorias A-D completas</div>
      </div>
      <div class="card" style="border-left:3px solid #4ade80">
        <h2>GA-3 — Load Test (p99 &lt; 200ms)</h2>
        <div style="margin-bottom:6px"><span class="status-pill status-ok">DONE</span></div>
        <div class="kpi accent-green" style="font-size:1.4rem">p99 193ms</div>
        <div class="kpi-sub">734 req/s · 0 erros · 500/500 HTTP 201</div>
        <div class="kpi-sub" style="margin-top:4px">EC2 loopback c=100 · us-east-2 · 2026-04-15</div>
      </div>
      <div class="card" style="border-left:3px solid #f87171">
        <h2>GA-4 — SLO Sign-off (99.9% / 30d)</h2>
        <div style="margin-bottom:6px"><span class="status-pill status-warn">PENDING</span></div>
        <div class="kpi-sub">Status page em <a href="/status" style="color:#7db7ff">/status</a></div>
        <div class="kpi-sub" style="margin-top:4px">Janela de 30 dias em produção ainda não decorrida</div>
      </div>
      <div class="card" style="border-left:3px solid #fbbf24">
        <h2>GA-5 — Legal Pages</h2>
        <div style="margin-bottom:6px"><span class="status-pill status-warn">INFRA READY</span></div>
        <div class="kpi-sub">Rotas: <a href="/terms" style="color:#7db7ff">/terms</a> · <a href="/privacy" style="color:#7db7ff">/privacy</a> · <a href="/dpa" style="color:#7db7ff">/dpa</a></div>
        <div class="kpi-sub" style="margin-top:4px">Conteúdo aguarda revisão jurídica</div>
      </div>
      <div class="card" style="border-left:3px solid #f87171">
        <h2>GA-6 — First Paying Customer</h2>
        <div style="margin-bottom:6px"><span class="status-pill status-warn">PENDING</span></div>
        <div class="kpi-sub">Contrato + API key ativa + receipt em prod</div>
        <div class="kpi-sub" style="margin-top:4px">Billing: Stripe webhooks wired</div>
      </div>
    </div>

    <p class="section-title">Performance Benchmarks — Resultados Validados</p>
    <div class="grid grid-4" style="margin-bottom:20px">
      <div class="card">
        <h2>Load Test p99</h2>
        <div class="kpi accent-green">193ms</div>
        <div class="kpi-sub">target: &lt;200ms · ✓ PASS</div>
      </div>
      <div class="card">
        <h2>Throughput</h2>
        <div class="kpi accent-blue">734 req/s</div>
        <div class="kpi-sub">c=100 · 0 erros · EC2 loopback</div>
      </div>
      <div class="card">
        <h2>p50 / p95</h2>
        <div class="kpi">90 / 187ms</div>
        <div class="kpi-sub">com 100 usuários concorrentes</div>
      </div>
      <div class="card">
        <h2>Ambiente</h2>
        <div class="kpi" style="font-size:1rem">t3.small</div>
        <div class="kpi-sub">EC2 · 2 vCPU · 2GB · Amazon Linux 2023</div>
      </div>
    </div>

    <p class="section-title">Disaster Recovery — Drill Completo (2026-04-15)</p>
    <div class="grid grid-4" style="margin-bottom:20px">
      <div class="card">
        <h2>RTO (Recovery Time)</h2>
        <div class="kpi accent-green">7m54s</div>
        <div class="kpi-sub">target: &lt;30 min · ✓ PASS</div>
      </div>
      <div class="card">
        <h2>RPO (Perda de Dados)</h2>
        <div class="kpi accent-green">0s</div>
        <div class="kpi-sub">zero perda · pg_dump completo</div>
      </div>
      <div class="card">
        <h2>Método de Restore</h2>
        <div class="kpi" style="font-size:1rem">pg_restore</div>
        <div class="kpi-sub">receipts 5=5 · users 2=2 · paridade ✓</div>
      </div>
      <div class="card">
        <h2>Smoke Test</h2>
        <div class="kpi accent-green">HTTP 201</div>
        <div class="kpi-sub">POST /receipts · 4 categorias A-D ✓</div>
      </div>
    </div>

    <p class="section-title">ZK Proof Pipeline — Benchmarks</p>
    <div class="grid grid-4" style="margin-bottom:20px">
      <div class="card">
        <h2>Groth16 fullProve</h2>
        <div class="kpi accent-yellow">410ms</div>
        <div class="kpi-sub">Docker Linux · metering_v2.circom</div>
      </div>
      <div class="card">
        <h2>Groth16 verify</h2>
        <div class="kpi accent-green">56ms</div>
        <div class="kpi-sub">snarkjs · vkey v2 (cerimônia histórica; independência não comprovada)</div>
      </div>
      <div class="card">
        <h2>Constraints do Circuito</h2>
        <div class="kpi accent-blue">874</div>
        <div class="kpi-sub">430 não-linear + 444 linear</div>
      </div>
      <div class="card">
        <h2>Segurança MPC</h2>
        <div class="kpi" style="font-size:1rem">1-of-181</div>
        <div class="kpi-sub">Hermez Phase 1 (176+) + fase 2 v2 sem evidência de independência</div>
      </div>
    </div>

    <p class="section-title">Acesso ao Projeto</p>
    <div class="card">
      <div style="display:flex;gap:12px;flex-wrap:wrap">
        <a href="https://github.com/BrunoQuintaes/otk-zk-metering" target="_blank" style="color:#7db7ff;text-decoration:none;font-size:0.85rem;background:#1a2540;padding:6px 14px;border-radius:6px;border:1px solid #1c2430">GitHub Repo ↗</a>
        <a href="/api-docs" style="color:#7db7ff;text-decoration:none;font-size:0.85rem;background:#1a2540;padding:6px 14px;border-radius:6px;border:1px solid #1c2430">API Docs ↗</a>
        <a href="/openapi.json" style="color:#7db7ff;text-decoration:none;font-size:0.85rem;background:#1a2540;padding:6px 14px;border-radius:6px;border:1px solid #1c2430">OpenAPI Spec ↗</a>
        <a href="/status" style="color:#7db7ff;text-decoration:none;font-size:0.85rem;background:#1a2540;padding:6px 14px;border-radius:6px;border:1px solid #1c2430">Status Page ↗</a>
      </div>
    </div>
  </div><!-- /tab-ga -->

  <div class="nav-links">
    <a href="/api-docs">API Docs</a>
    <a href="/openapi.json">OpenAPI Spec</a>
    <a href="/healthz">Health Check</a>
    <a href="/metrics">Metrics</a>
  </div>
</main>

<script>
(function() {
  var token = localStorage.getItem('otk_token') || '';

  function headers() {
    var h = { 'Accept': 'application/json' };
    if (token) h['Authorization'] = 'Bearer ' + token;
    return h;
  }

  function adminHeaders() {
    var h = Object.assign({}, headers());
    h['x-admin-key'] = 'demo-otk-2026';
    return h;
  }

  function formatUptime(ms) {
    var s = Math.floor(ms / 1000);
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s/60) + 'm ' + (s%60) + 's';
    var h = Math.floor(s/3600);
    var m = Math.floor((s%3600)/60);
    return h + 'h ' + m + 'm';
  }

  function numberWithCommas(x) {
    return x.toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ',');
  }

  // H6.1: XSS prevention — escape user-controlled data before innerHTML insertion
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#x27;');
  }

  function showError(msg) {
    var banner = document.getElementById('error-banner');
    banner.textContent = msg;
    banner.style.display = 'block';
    document.getElementById('status-dot').classList.add('error');
  }

  function hideError() {
    document.getElementById('error-banner').style.display = 'none';
    document.getElementById('status-dot').classList.remove('error');
  }

  function renderReceipts(receipts) {
    var container = document.getElementById('receipts-table');
    if (!receipts || receipts.length === 0) {
      container.innerHTML = '<div class="empty">No receipts yet. Submit one via POST /receipts.</div>';
      return;
    }
    var html = '<table><thead><tr><th>Request ID</th><th>Provider</th><th>Model</th><th>Tokens</th><th>CU</th><th>Tenant</th></tr></thead><tbody>';
    for (var i = 0; i < receipts.length; i++) {
      var r = receipts[i];
      html += '<tr>';
      html += '<td class="mono">' + esc(r.requestId) + '</td>';
      html += '<td>' + esc(r.provider) + '</td>';
      html += '<td>' + esc(r.model) + '</td>';
      html += '<td>' + numberWithCommas(r.inputTokens + r.outputTokens) + '</td>';
      html += '<td>' + numberWithCommas(r.costUnits) + '</td>';
      html += '<td>' + esc(r.tenantId) + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function renderTenants(tenants) {
    var container = document.getElementById('tenants-table');
    if (!tenants || tenants.length === 0) {
      container.innerHTML = '<div class="empty">No tenant data yet.</div>';
      return;
    }
    var html = '<table><thead><tr><th>Tenant</th><th>Receipts</th><th>Total CU</th><th>Last Activity</th></tr></thead><tbody>';
    for (var i = 0; i < tenants.length; i++) {
      var t = tenants[i];
      var lastAct = t.lastActivityAt ? new Date(t.lastActivityAt).toLocaleTimeString() : '--';
      html += '<tr>';
      html += '<td class="mono">' + esc(t.tenantId) + '</td>';
      html += '<td>' + numberWithCommas(t.totalReceipts) + '</td>';
      html += '<td>' + numberWithCommas(t.totalCU) + '</td>';
      html += '<td>' + lastAct + '</td>';
      html += '</tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  function refresh() {
    fetch('/app/api/overview', { headers: headers() })
      .then(function(r) {
        if (r.status === 401) { window.location.href = '/app/login'; return null; }
        return r.json();
      })
      .then(function(data) {
        if (!data) return;
        hideError();
        document.getElementById('kpi-receipts').textContent = numberWithCommas(data.totalReceipts);
        document.getElementById('kpi-tenants').textContent = data.totalTenants;
        document.getElementById('kpi-cu').textContent = numberWithCommas(data.totalCU);
        document.getElementById('kpi-uptime').textContent = formatUptime(data.uptimeMs);
      })
      .catch(function(e) { showError('Failed to fetch overview: ' + e.message); });

    fetch('/app/api/receipts', { headers: headers() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) { if (data) renderReceipts(data.receipts); })
      .catch(function() {});

    fetch('/app/api/tenants', { headers: headers() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) { if (data) renderTenants(data.tenants); })
      .catch(function() {});
  }

  window.logout = function() {
    localStorage.removeItem('otk_token');
    window.location.href = '/app/login';
  };

  // ── Tab switching ──
  document.querySelectorAll('.tab').forEach(function(tab) {
    tab.addEventListener('click', function() {
      document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelectorAll('.tab-content').forEach(function(c) { c.classList.remove('active'); });
      tab.classList.add('active');
      var target = tab.getAttribute('data-tab');
      document.getElementById('tab-' + target).classList.add('active');
      if (target === 'receipts') refreshReceipts();
      if (target === 'billing') refreshBilling();
      if (target === 'finance') refreshFinance();
      if (target === 'admin') refreshAdmin();
      if (target === 'health') refreshHealth();
      if (target === 'onboarding') refreshKeys();
    });
  });

  // ── P2.3: Receipts + Usage ──
  function refreshReceipts() {
    fetch('/app/api/receipts', { headers: headers() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        var receipts = data.receipts || [];
        // Populate filter dropdowns
        var providers = new Set(); var tenants = new Set();
        receipts.forEach(function(r) { providers.add(r.provider); tenants.add(r.tenantId); });
        var pSel = document.getElementById('filter-provider');
        var tSel = document.getElementById('filter-tenant');
        pSel.innerHTML = '<option value="">All Providers</option>';
        tSel.innerHTML = '<option value="">All Tenants</option>';
        providers.forEach(function(p) { pSel.innerHTML += '<option>' + esc(p) + '</option>'; });
        tenants.forEach(function(t) { tSel.innerHTML += '<option>' + esc(t) + '</option>'; });
        renderFilteredReceipts(receipts);
        pSel.onchange = tSel.onchange = function() { renderFilteredReceipts(receipts); };
      }).catch(function() {});

    fetch('/app/api/usage', { headers: headers() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || !data.usage) return;
        var grid = document.getElementById('usage-grid');
        if (data.usage.length === 0) { grid.innerHTML = '<div class="empty">No usage data yet.</div>'; return; }
        var html = '';
        data.usage.forEach(function(u) {
          html += '<div class="card"><h2>' + esc(u.provider) + ' / ' + esc(u.model) + '</h2>';
          html += '<div class="kpi accent-yellow">' + numberWithCommas(u.totalCU) + '</div>';
          html += '<div class="kpi-sub">' + numberWithCommas(u.requests) + ' requests &middot; ' + u.avgLatencyMs + 'ms avg</div></div>';
        });
        grid.innerHTML = html;
      }).catch(function() {});
  }

  function renderFilteredReceipts(receipts) {
    var pf = document.getElementById('filter-provider').value;
    var tf = document.getElementById('filter-tenant').value;
    var filtered = receipts.filter(function(r) {
      return (!pf || r.provider === pf) && (!tf || r.tenantId === tf);
    });
    var container = document.getElementById('filtered-receipts-table');
    if (filtered.length === 0) { container.innerHTML = '<div class="empty">No matching receipts.</div>'; return; }
    var html = '<table><thead><tr><th>Request ID</th><th>Provider</th><th>Model</th><th>Tokens</th><th>CU</th><th>Latency</th><th>Tenant</th></tr></thead><tbody>';
    for (var i = 0; i < Math.min(filtered.length, 100); i++) {
      var r = filtered[i];
      html += '<tr><td class="mono">' + esc(r.requestId) + '</td><td>' + esc(r.provider) + '</td><td>' + esc(r.model) + '</td>';
      html += '<td>' + numberWithCommas(r.inputTokens + r.outputTokens) + '</td><td>' + numberWithCommas(r.costUnits) + '</td>';
      html += '<td>' + r.latencyMs + 'ms</td><td>' + esc(r.tenantId) + '</td></tr>';
    }
    html += '</tbody></table>';
    container.innerHTML = html;
  }

  // ── P2.4: Billing ──
  function refreshBilling() {
    fetch('/plans', { headers: headers() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data || !data.plans) return;
        var grid = document.getElementById('plan-cards');
        var html = '';
        data.plans.forEach(function(p) {
          var quota = p.cuQuotaPerEpoch === '-1' ? 'Unlimited' : numberWithCommas(p.cuQuotaPerEpoch);
          html += '<div class="card plan-card"><h2>' + esc(p.name) + '</h2>';
          html += '<div class="kpi-sub">Quota: ' + quota + ' CU/epoch</div>';
          html += '<div class="kpi-sub">Rate: ' + p.rateLimitPerMinute + ' req/min</div>';
          html += '<div class="kpi-sub">ZK: ' + (p.zkProofsEnabled ? 'Yes' : 'No') + ' &middot; On-chain: ' + (p.onChainEnabled ? 'Yes' : 'No') + '</div></div>';
        });
        grid.innerHTML = html;
      }).catch(function() {});
    refreshBillingCycles();
  }

  window.loadInvoice = function() {
    var tid = document.getElementById('invoice-tenant').value;
    var eid = document.getElementById('invoice-epoch').value;
    if (!tid || !eid) return;
    fetch('/invoices?tenantId=' + encodeURIComponent(tid) + '&epochId=' + encodeURIComponent(eid), { headers: headers() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        var container = document.getElementById('invoice-table');
        if (!data || !data.invoice) { container.innerHTML = '<div class="empty">No invoice found.</div>'; return; }
        var inv = data.invoice;
        var html = '<div style="margin-bottom:12px"><strong>Plan:</strong> ' + esc(inv.planTier) + ' &middot; <strong>Total CU:</strong> ' + numberWithCommas(inv.totalCU) + ' &middot; <strong>Requests:</strong> ' + numberWithCommas(inv.totalRequests);
        if (inv.quotaUsedPct >= 0) html += ' &middot; <strong>Quota:</strong> ' + inv.quotaUsedPct + '%';
        html += '</div>';
        if (inv.lineItems && inv.lineItems.length > 0) {
          html += '<table><thead><tr><th>Provider</th><th>Model</th><th>Requests</th><th>CU</th></tr></thead><tbody>';
          inv.lineItems.forEach(function(li) {
            html += '<tr><td>' + esc(li.provider) + '</td><td>' + esc(li.model) + '</td><td>' + numberWithCommas(li.requestCount) + '</td><td>' + numberWithCommas(li.totalCU) + '</td></tr>';
          });
          html += '</tbody></table>';
        }
        container.innerHTML = html;
      }).catch(function(e) { document.getElementById('invoice-table').innerHTML = '<div class="empty">Error: ' + esc(e.message) + '</div>'; });
  };

  // ── BILL-05: Billing cycles ──
  function refreshBillingCycles() {
    fetch('/v1/billing/cycles', { headers: headers() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        var cycles = data.cycles || [];
        // KPI aggregates
        var totalUsd = 0, totalMargin = 0, submitted = 0;
        cycles.forEach(function(c) { totalUsd += (c.totalUsd||0); totalMargin += (c.marginUsd||0); if (c.status==='submitted') submitted++; });
        document.getElementById('kpi-cycle-usd').textContent = '$' + totalUsd.toFixed(4);
        document.getElementById('kpi-cycle-margin').textContent = '$' + totalMargin.toFixed(4);
        document.getElementById('kpi-cycle-tenants').textContent = cycles.length.toString();
        document.getElementById('kpi-cycle-status').textContent = submitted + '/' + cycles.length + ' submitted';

        var container = document.getElementById('billing-cycles-table');
        if (cycles.length === 0) { container.innerHTML = '<div class="empty">No billing cycles yet.</div>'; return; }
        var html = '<table><thead><tr><th>Tenant</th><th>Period</th><th>Plan</th><th>CU</th><th>USD</th><th>Margin</th><th>Status</th></tr></thead><tbody>';
        cycles.forEach(function(c) {
          var statusClass = c.status === 'submitted' || c.status === 'paid' ? 'status-ok' : c.status === 'failed' ? 'status-err' : 'status-warn';
          html += '<tr><td class="mono">' + esc(c.tenantId) + '</td>';
          html += '<td>' + esc(c.cycleStart) + ' → ' + esc(c.cycleEnd) + '</td>';
          html += '<td>' + esc(c.planTier) + '</td>';
          html += '<td>' + numberWithCommas(c.totalCU||0) + '</td>';
          html += '<td>$' + (c.totalUsd||0).toFixed(4) + '</td>';
          html += '<td>$' + (c.marginUsd||0).toFixed(4) + '</td>';
          html += '<td><span class="status-pill ' + statusClass + '">' + esc(c.status) + '</span></td></tr>';
        });
        html += '</tbody></table>';
        container.innerHTML = html;
      }).catch(function() {});
  }

  // ── P2.5: Admin ──
  function refreshAdmin() {
    fetch('/app/api/admin/summary', { headers: headers() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        var html = '<div class="card"><h2>Tenants</h2><div class="kpi accent-blue">' + (data.tenantCount || 0) + '</div></div>';
        html += '<div class="card"><h2>Dead-Letters</h2><div class="kpi accent-yellow">' + (data.deadLetterPending || 0) + '</div><div class="kpi-sub">pending</div></div>';
        html += '<div class="card"><h2>Audit Entries</h2><div class="kpi accent-green">' + (data.auditCount || 0) + '</div></div>';
        html += '<div class="card"><h2>Governance</h2><div class="kpi">' + (data.governanceCount || 0) + '</div><div class="kpi-sub">' + (data.chainIntegrity ? 'Chain OK' : 'INTEGRITY ISSUE') + '</div></div>';
        document.getElementById('admin-kpis').innerHTML = html;
      }).catch(function() {});

    fetch('/admin/tenants', { headers: adminHeaders() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        var container = document.getElementById('admin-tenants-table');
        if (!data || !data.tenants || data.tenants.length === 0) { container.innerHTML = '<div class="empty">No tenants.</div>'; return; }
        var html = '<table><thead><tr><th>Tenant ID</th><th>Role</th><th>Active</th><th>Created</th></tr></thead><tbody>';
        data.tenants.forEach(function(t) {
          var badge = '<span class="badge badge-' + t.role.toLowerCase() + '">' + esc(t.role) + '</span>';
          html += '<tr><td class="mono">' + esc(t.tenantId) + '</td><td>' + badge + '</td>';
          html += '<td>' + (t.active ? '<span class="status-pill status-ok">Active</span>' : '<span class="status-pill status-err">Inactive</span>') + '</td>';
          html += '<td>' + new Date(t.createdAt).toLocaleDateString() + '</td></tr>';
        });
        html += '</tbody></table>';
        container.innerHTML = html;
      }).catch(function() {});

    fetch('/app/api/dead-letters?limit=20', { headers: headers() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        var container = document.getElementById('admin-dl-table');
        if (!data || !data.entries || data.entries.length === 0) { container.innerHTML = '<div class="empty">No dead-letter entries.</div>'; return; }
        var html = '<table><thead><tr><th>ID</th><th>Reason</th><th>Status</th><th>Created</th></tr></thead><tbody>';
        data.entries.forEach(function(d) {
          var cls = d.status === 'pending' ? 'status-warn' : (d.status === 'retried' ? 'status-ok' : 'status-err');
          html += '<tr><td class="mono">' + esc(d.id) + '</td><td>' + esc(d.reason) + '</td>';
          html += '<td><span class="status-pill ' + cls + '">' + esc(d.status) + '</span></td>';
          html += '<td>' + new Date(d.createdAt).toLocaleDateString() + '</td></tr>';
        });
        html += '</tbody></table>';
        container.innerHTML = html;
      }).catch(function() {});
  }

  // ── P3.2: Onboarding wizard ──
  var _wizardKey = '';
  window.wizardNext = function(step) {
    for (var i = 1; i <= 4; i++) {
      var el = document.getElementById('wizard-step-' + i);
      if (el) el.style.display = (i === step) ? 'block' : 'none';
    }
  };

  window.wizardCreateKey = function() {
    var label = document.getElementById('wizard-key-label').value.trim() || 'Onboarding Key';
    fetch('/v1/keys', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, adminHeaders()),
      body: JSON.stringify({ label: label, role: 'MEMBER' })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok && data.key) {
        _wizardKey = data.key.rawKey;
        document.getElementById('wizard-key-value').textContent = _wizardKey;
        document.getElementById('wizard-key-result').style.display = 'block';
        // Pre-fill curl command
        var curl = 'curl -X POST http://localhost:8787/v1/receipts \\\n';
        curl += '  -H "Authorization: Bearer ' + _wizardKey + '" \\\n';
        curl += '  -H "Content-Type: application/json" \\\n';
        curl += '  -d \'{"requestId":"first-receipt-' + Date.now() + '","provider":"openai","model":"gpt-4","inputTokens":100,"outputTokens":50}\'';
        document.getElementById('wizard-curl').textContent = curl;
        setTimeout(function() { window.wizardNext(3); }, 1500);
      }
    }).catch(function() {});
  };

  // ── P3.3: Keys management ──
  function refreshKeys() {
    fetch('/v1/keys', { headers: adminHeaders() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        var container = document.getElementById('keys-table');
        if (!data || !data.keys || data.keys.length === 0) { container.innerHTML = '<div class="empty">No API keys yet. Create one above.</div>'; return; }
        var html = '<table><thead><tr><th>Key ID</th><th>Label</th><th>Prefix</th><th>Role</th><th>Created</th><th>Actions</th></tr></thead><tbody>';
        data.keys.forEach(function(k) {
          html += '<tr><td class="mono">' + esc(k.keyId) + '</td><td>' + esc(k.label) + '</td>';
          html += '<td class="mono">' + esc(k.prefix) + '...</td>';
          html += '<td><span class="badge badge-' + k.role.toLowerCase() + '">' + esc(k.role) + '</span></td>';
          html += '<td>' + new Date(k.createdAt).toLocaleDateString() + '</td>';
          html += '<td><button onclick="revokeKey(\'' + esc(k.keyId) + '\')" style="background:none;border:1px solid #f87171;color:#f87171;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:0.72rem;margin-right:4px">Revoke</button>';
          html += '<button onclick="rotateKey(\'' + esc(k.keyId) + '\')" style="background:none;border:1px solid #7db7ff;color:#7db7ff;padding:3px 8px;border-radius:4px;cursor:pointer;font-size:0.72rem">Rotate</button></td></tr>';
        });
        html += '</tbody></table>';
        container.innerHTML = html;
      }).catch(function() {});
  }

  window.createNewKey = function() {
    var label = document.getElementById('new-key-label').value.trim();
    var role = document.getElementById('new-key-role').value;
    if (!label) return;
    fetch('/v1/keys', {
      method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, adminHeaders()),
      body: JSON.stringify({ label: label, role: role })
    })
    .then(function(r) { return r.json(); })
    .then(function(data) {
      if (data.ok && data.key) {
        alert('Key created! Save this key — it will only be shown once:\\n\\n' + data.key.rawKey);
        document.getElementById('new-key-label').value = '';
        refreshKeys();
      }
    }).catch(function() {});
  };

  window.revokeKey = function(keyId) {
    if (!confirm('Revoke this key? This cannot be undone.')) return;
    fetch('/v1/keys/' + keyId, { method: 'DELETE', headers: adminHeaders() })
      .then(function() { refreshKeys(); }).catch(function() {});
  };

  window.rotateKey = function(keyId) {
    if (!confirm('Rotate this key? The old key will stop working immediately.')) return;
    fetch('/v1/keys/' + keyId + '/rotate', { method: 'POST', headers: adminHeaders() })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.ok && data.key) {
          alert('Key rotated! New key:\\n\\n' + data.key.rawKey);
          refreshKeys();
        }
      }).catch(function() {});
  };

  // ── P2.6: Health ──
  function refreshHealth() {
    fetch('/app/api/providers/health', { headers: headers() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        var grid = document.getElementById('provider-health-grid');
        if (!data || !data.providers || data.providers.length === 0) { grid.innerHTML = '<div class="empty">No provider data yet.</div>'; return; }
        var html = '';
        data.providers.forEach(function(p) {
          var color = p.avgLatencyMs < 500 ? 'accent-green' : (p.avgLatencyMs < 2000 ? 'accent-yellow' : 'accent-red');
          html += '<div class="card"><h2>' + esc(p.provider) + '</h2>';
          html += '<div class="kpi ' + color + '">' + p.avgLatencyMs + 'ms</div>';
          html += '<div class="kpi-sub">avg latency &middot; p95: ' + p.p95LatencyMs + 'ms &middot; max: ' + p.maxLatencyMs + 'ms</div>';
          html += '<div class="kpi-sub">' + numberWithCommas(p.requests) + ' requests &middot; ' + numberWithCommas(p.totalCU) + ' CU</div></div>';
        });
        grid.innerHTML = html;
      }).catch(function() {});

    fetch('/system/status', { headers: headers() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        var cb = data.circuitBreakerStatus || {};
        var cbCls = cb.open ? 'status-err' : 'status-ok';
        var cbLabel = cb.open ? 'OPEN (' + cb.consecutiveFails + ' fails)' : 'CLOSED';
        var html = '<div class="card"><h2>Circuit Breaker</h2><div><span class="status-pill ' + cbCls + '">' + cbLabel + '</span></div></div>';
        html += '<div class="card"><h2>Prover Daemon</h2><div><span class="status-pill ' + (data.daemonReachable ? 'status-ok' : 'status-err') + '">' + (data.daemonReachable ? 'Reachable' : 'Unreachable') + '</span></div></div>';
        html += '<div class="card"><h2>Redis</h2><div><span class="status-pill ' + (data.redisConnected ? 'status-ok' : 'status-warn') + '">' + (data.redisConnected ? 'Connected' : 'Not Connected') + '</span></div></div>';
        html += '<div class="card"><h2>PostgreSQL</h2><div><span class="status-pill ' + (data.pgConnected ? 'status-ok' : 'status-warn') + '">' + (data.pgConnected ? 'Connected' : 'Not Connected') + '</span></div></div>';
        document.getElementById('system-status-cards').innerHTML = html;
      }).catch(function() {});
  }

  // ── W9-A PAY-03: Finance ──
  window.refreshFinance = function() {
    fetch('/admin/finance', { headers: adminHeaders() })
      .then(function(r) { return r.ok ? r.json() : null; })
      .then(function(data) {
        if (!data) return;
        document.getElementById('kpi-fin-collected').textContent = '$' + (data.totalCollectedUsd || 0).toFixed(4);
        document.getElementById('kpi-fin-owed').textContent = '$' + (data.totalOwedUsd || 0).toFixed(4);
        document.getElementById('kpi-fin-margin').textContent = '$' + (data.netMarginUsd || 0).toFixed(4);
        document.getElementById('kpi-fin-pending').textContent = (data.pendingPayouts || []).length.toString();
        var container = document.getElementById('finance-payouts-table');
        var payouts = data.pendingPayouts || [];
        if (payouts.length === 0) { container.innerHTML = '<div class="empty">No pending payouts.</div>'; return; }
        var html = '<table><thead><tr><th>Provider</th><th>Cycle Start</th><th>Cycle End</th><th>Owed (USD)</th><th>Status</th></tr></thead><tbody>';
        payouts.forEach(function(p) {
          html += '<tr><td>' + esc(p.provider) + '</td><td>' + esc(p.cycleStart) + '</td><td>' + esc(p.cycleEnd) + '</td>';
          html += '<td>$' + (p.providerCostUsd || 0).toFixed(4) + '</td>';
          html += '<td><span class="status-pill status-warn">' + esc(p.status) + '</span></td></tr>';
        });
        html += '</tbody></table>';
        container.innerHTML = html;
      }).catch(function() {});
  };

  // Initial load + auto-refresh
  refresh();
  setInterval(refresh, 10000);
})();
</script>

</body>
</html>`;
}

// ── Route handler ───────────────────────────────────────────────────

/**
 * Handle dashboard-related requests.
 * Returns true if the request was handled, false otherwise.
 *
 * Called from handleRequest in routes.ts for paths starting with /app.
 */
export async function handleDashboardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  _resolveCallerContext: (req: IncomingMessage) => { tenantId: string; role: string } | null,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  if (method === 'GET' && pathname === '/app') {
    // If auth is enabled and no valid token, redirect to login
    let sessionId: string | undefined;
    if (isAuthEnabled()) {
      const ctx = _resolveCallerContext(req);
      if (!ctx) {
        res.statusCode = 302;
        res.setHeader('location', '/app/login');
        res.end();
        return true;
      }
      sessionId = ctx.tenantId;
    }
    // H6.3: Pass sessionId so CSRF token is tenant-bound
    sendHtml(res, 200, getDashboardHtml({ sessionId }));
    return true;
  }

  if (method === 'GET' && pathname === '/app/api/overview') {
    const indexer = getIndexer();
    sendJson(res, 200, indexer.getSystemOverview());
    return true;
  }

  if (method === 'GET' && pathname === '/app/api/receipts') {
    const indexer = getIndexer();
    const receipts = indexer.getRecentReceipts(100);
    sendJson(res, 200, { ok: true, receipts });
    return true;
  }

  if (method === 'GET' && pathname === '/app/api/tenants') {
    const indexer = getIndexer();
    const tenants = indexer.getTenantSummary();
    sendJson(res, 200, { ok: true, tenants });
    return true;
  }

  // P2.3: Usage by provider (Wave 3D)
  if (method === 'GET' && pathname === '/app/api/usage') {
    const indexer = getIndexer();
    const url = new URL(req.url ?? '/', 'http://localhost');
    const tenantId = url.searchParams.get('tenantId') || undefined;
    sendJson(res, 200, { ok: true, usage: indexer.getUsageByProvider(tenantId) });
    return true;
  }

  // P2.5: Admin summary (Wave 3D)
  if (method === 'GET' && pathname === '/app/api/admin/summary') {
    const gov = getGovernanceTrail();
    const dlPending = await pendingCount();
    sendJson(res, 200, {
      ok: true,
      tenantCount: tenantCount(),
      deadLetterPending: dlPending,
      auditCount: tenantAuditStatus().auditCount,
      governanceCount: gov.count(),
      chainIntegrity: gov.verifyIntegrity(),
    });
    return true;
  }

  // P2.5: Dead-letters proxy (Wave 3D)
  if (method === 'GET' && pathname === '/app/api/dead-letters') {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const limit = Number(url.searchParams.get('limit') ?? 20);
    const entries = await listDeadLetters({ limit });
    sendJson(res, 200, { ok: true, entries });
    return true;
  }

  // P2.6: Provider health (Wave 3D)
  if (method === 'GET' && pathname === '/app/api/providers/health') {
    const indexer = getIndexer();
    sendJson(res, 200, { ok: true, providers: indexer.getProviderHealth() });
    return true;
  }

  // NEW-4.06: Webhook management tab
  if (method === 'GET' && pathname === '/app/webhooks') {
    const { renderWebhooksPage } = await import('./webhooks.js');
    const { getWebhookStore } = await import('../webhooks/WebhookRegistry.js');
    const wStore = getWebhookStore();
    const endpoints = await wStore.listEndpoints();
    const deliveries: Record<string, import('../webhooks/WebhookRegistry.js').WebhookDeliveryLog[]> = {};
    for (const ep of endpoints) {
      deliveries[ep.id] = await wStore.listDeliveries(ep.id);
    }
    const deadLetters = await wStore.listDeadLetters();
    const html = renderWebhooksPage({ endpoints, deliveries, deadLetters });
    sendHtml(res, 200, html);
    return true;
  }

  return false;
}
