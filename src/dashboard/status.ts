/**
 * status.ts — Public system status page HTML generator (NEW-4.02)
 *
 * Renders component health table (API, PG, Redis, ProverDaemon).
 * No authentication required — publicly visible at GET /status.
 *
 * @module dashboard/status
 * @since Wave 4 (4C-PACK-4C03 / NEW-4.02)
 */

import { escapeHtml as esc } from './sanitize.js';

export interface ComponentStatus {
  name: string;
  status: 'up' | 'down' | 'degraded' | 'unknown';
  detail?: string;
}

export interface StatusPageData {
  components: ComponentStatus[];
  timestamp: string;
  version?: string;
}

// ──────────────────────────────────────────────────────────
// HTML renderer
// ──────────────────────────────────────────────────────────

function statusBadge(status: ComponentStatus['status']): string {
  const colors: Record<string, string> = {
    up: '#198754',
    down: '#dc3545',
    degraded: '#ffc107',
    unknown: '#6c757d',
  };
  const labels: Record<string, string> = { up: 'Operational', down: 'Outage', degraded: 'Degraded', unknown: 'Unknown' };
  const color = colors[status] ?? '#6c757d';
  return `<span style="background:${color};color:#fff;padding:2px 8px;border-radius:4px;font-size:.85rem">${esc(labels[status] ?? status)}</span>`;
}

export function renderStatusPage(data: StatusPageData): string {
  const rows = data.components.map(c => `
    <tr>
      <td style="padding:.6rem 1rem">${esc(c.name)}</td>
      <td style="padding:.6rem 1rem">${statusBadge(c.status)}</td>
      <td style="padding:.6rem 1rem;color:#6c757d;font-size:.9rem">${esc(c.detail ?? '')}</td>
    </tr>`).join('');

  const allUp = data.components.every(c => c.status === 'up');
  const anyDown = data.components.some(c => c.status === 'down');
  const overallStatus = anyDown ? 'Partial Outage' : allUp ? 'All Systems Operational' : 'Degraded Performance';
  const overallColor = anyDown ? '#dc3545' : allUp ? '#198754' : '#ffc107';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>OTK Status</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f8f9fa; color: #212529; }
    .header { background: #1a1a2e; color: #fff; padding: 2rem; text-align: center; }
    .header h1 { margin: 0; font-size: 1.8rem; }
    .overall { text-align: center; padding: 1.5rem; font-size: 1.3rem; font-weight: 600; color: ${overallColor}; }
    .container { max-width: 760px; margin: 0 auto; padding: 1rem; }
    table { width: 100%; background: #fff; border-radius: 8px; border-collapse: collapse; box-shadow: 0 1px 4px rgba(0,0,0,.08); }
    th { background: #f1f3f5; padding: .6rem 1rem; text-align: left; font-size: .875rem; color: #495057; }
    tr:not(:last-child) td { border-bottom: 1px solid #e9ecef; }
    footer { text-align: center; padding: 1.5rem; color: #6c757d; font-size: .8rem; }
  </style>
</head>
<body>
  <div class="header"><h1>OTK System Status</h1></div>
  <div class="overall">${esc(overallStatus)}</div>
  <div class="container">
    <table>
      <thead><tr><th>Component</th><th>Status</th><th>Details</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <footer>Last updated: ${esc(data.timestamp)}${data.version ? ` &bull; Version ${esc(data.version)}` : ''}</footer>
</body>
</html>`;
}

// ──────────────────────────────────────────────────────────
// Default status resolver (reads from runtime state)
// ──────────────────────────────────────────────────────────

export function resolveDefaultStatus(): StatusPageData {
  const components: ComponentStatus[] = [
    { name: 'API Server', status: 'up', detail: 'Responding normally' },
    { name: 'PostgreSQL', status: process.env['OTK_DB_URL'] ? 'unknown' : 'unknown', detail: process.env['OTK_DB_URL'] ? 'Configured' : 'Not configured' },
    { name: 'Redis', status: process.env['OTK_REDIS_URL'] ? 'unknown' : 'unknown', detail: process.env['OTK_REDIS_URL'] ? 'Configured' : 'Not configured' },
    { name: 'ProverDaemon', status: 'unknown', detail: 'Check /admin/prover/status' },
  ];
  return {
    components,
    timestamp: new Date().toISOString(),
    version: process.env['npm_package_version'],
  };
}
