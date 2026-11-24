/**
 * Webhook management dashboard tab (NEW-4.06)
 *
 * Renders:
 *   - Registered endpoint list with active/inactive badge
 *   - Register new endpoint form (URL + event filter)
 *   - Per-endpoint delivery log table
 *   - Dead-letter queue replay button
 *
 * @module dashboard/webhooks
 * @since Wave 4 (4E-PACK-4E02 / NEW-4.06)
 */

import { escapeHtml } from './sanitize.js';
import type { WebhookEndpoint, WebhookDeliveryLog, WebhookDeadLetter } from '../webhooks/WebhookRegistry.js';

// ──────────────────────────────────────────────────────────
// Types
// ──────────────────────────────────────────────────────────

export interface WebhookDashboardData {
  endpoints: WebhookEndpoint[];
  deliveries: Record<string, WebhookDeliveryLog[]>;  // endpointId → logs
  deadLetters: WebhookDeadLetter[];
}

// ──────────────────────────────────────────────────────────
// HTML renderer
// ──────────────────────────────────────────────────────────

export function renderWebhooksPage(data: WebhookDashboardData): string {
  const { endpoints, deliveries, deadLetters } = data;

  const endpointRows = endpoints.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:#888">No endpoints registered</td></tr>'
    : endpoints.map(ep => {
        const badge = ep.active
          ? '<span style="color:#22c55e;font-weight:bold">active</span>'
          : '<span style="color:#ef4444;font-weight:bold">inactive</span>';
        const events = escapeHtml(ep.events.join(', '));
        const url = escapeHtml(ep.url);
        const id = escapeHtml(ep.id);
        return `<tr>
          <td><code>${id.slice(0, 8)}…</code></td>
          <td><a href="${url}" target="_blank">${url}</a></td>
          <td>${events}</td>
          <td>${badge} &nbsp;
            <button onclick="deleteEndpoint('${id}')" style="color:#ef4444;background:none;border:1px solid #ef4444;cursor:pointer;padding:2px 6px">Delete</button>
          </td>
        </tr>`;
      }).join('\n');

  const allDeliveries = Object.values(deliveries).flat();
  const deliveryRows = allDeliveries.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:#888">No deliveries yet</td></tr>'
    : allDeliveries.slice(-20).reverse().map(d => {
        const statusColor = d.status === 'success' ? '#22c55e' : '#ef4444';
        return `<tr>
          <td><code>${escapeHtml(d.endpointId.slice(0, 8))}…</code></td>
          <td>${escapeHtml(d.eventKind)}</td>
          <td>${d.attempt}</td>
          <td style="color:${statusColor}">${d.status}</td>
          <td>${d.statusCode ?? '—'}</td>
        </tr>`;
      }).join('\n');

  const dlqRows = deadLetters.length === 0
    ? '<tr><td colspan="4" style="text-align:center;color:#888">Dead-letter queue is empty</td></tr>'
    : deadLetters.map(dl => {
        const replayed = dl.replayedAt
          ? `<span style="color:#888">replayed</span>`
          : `<button onclick="replayDlq('${escapeHtml(dl.endpointId)}','${escapeHtml(dl.id)}')" style="cursor:pointer;padding:2px 6px">Replay</button>`;
        return `<tr>
          <td><code>${escapeHtml(dl.id.slice(0, 8))}…</code></td>
          <td>${escapeHtml(dl.eventKind)}</td>
          <td>${dl.attempts}</td>
          <td>${replayed}</td>
        </tr>`;
      }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>OTK — Webhook Management</title>
<style>
  body { font-family: sans-serif; max-width: 1100px; margin: 0 auto; padding: 1rem 2rem; background:#f9fafb; }
  h1 { color: #1e293b; }
  h2 { color: #334155; margin-top: 2rem; }
  table { width:100%; border-collapse:collapse; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,.1); margin-bottom:1rem; }
  th { background:#1e293b; color:#fff; padding:8px 12px; text-align:left; }
  td { padding:8px 12px; border-bottom:1px solid #e2e8f0; }
  tr:last-child td { border-bottom:none; }
  .form-row { display:flex; gap:0.5rem; margin-bottom:1rem; flex-wrap:wrap; }
  input[type=text] { flex:1; padding:6px 10px; border:1px solid #cbd5e1; border-radius:4px; min-width:200px; }
  button.primary { background:#3b82f6; color:#fff; border:none; padding:7px 14px; border-radius:4px; cursor:pointer; }
  button.primary:hover { background:#2563eb; }
  .back { margin-bottom:1rem; }
  a { color:#3b82f6; }
</style>
</head>
<body>
<div class="back"><a href="/app">← Dashboard</a></div>
<h1>Webhook Management</h1>

<h2>Register Endpoint</h2>
<div class="form-row">
  <input type="text" id="ep-url" placeholder="https://your-server.example.com/webhook"/>
  <input type="text" id="ep-events" placeholder="Events (e.g. receipt_submitted,proof_ready or * for all)"/>
  <button class="primary" onclick="registerEndpoint()">Register</button>
</div>

<h2>Endpoints (${endpoints.length})</h2>
<table>
  <thead><tr><th>ID</th><th>URL</th><th>Events</th><th>Status</th></tr></thead>
  <tbody>${endpointRows}</tbody>
</table>

<h2>Recent Deliveries</h2>
<table>
  <thead><tr><th>Endpoint</th><th>Event</th><th>Attempt</th><th>Status</th><th>HTTP</th></tr></thead>
  <tbody>${deliveryRows}</tbody>
</table>

<h2>Dead-Letter Queue (${deadLetters.length})</h2>
<table>
  <thead><tr><th>ID</th><th>Event</th><th>Attempts</th><th>Action</th></tr></thead>
  <tbody>${dlqRows}</tbody>
</table>

<script>
async function registerEndpoint() {
  const url = document.getElementById('ep-url').value.trim();
  const eventsRaw = document.getElementById('ep-events').value.trim();
  if (!url) { alert('URL required'); return; }
  const events = eventsRaw ? eventsRaw.split(',').map(s => s.trim()).filter(Boolean) : ['*'];
  const r = await fetch('/v1/webhooks', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url, events }) });
  if (r.ok) { location.reload(); } else { alert('Error registering endpoint'); }
}
async function deleteEndpoint(id) {
  if (!confirm('Delete endpoint?')) return;
  await fetch('/v1/webhooks/' + id, { method:'DELETE' });
  location.reload();
}
async function replayDlq(endpointId, dlId) {
  const r = await fetch('/v1/webhooks/' + endpointId + '/deliveries/' + dlId + '/replay', { method:'POST' });
  if (r.ok) { location.reload(); } else { alert('Replay failed'); }
}
</script>
</body>
</html>`;
}
