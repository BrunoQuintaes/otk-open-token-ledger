/**
 * W4-4C03 — Tenant data export + status page tests (NEW-4.01+NEW-4.02)
 *
 * Covers:
 *   1.  src/api/dataExport.ts file exists
 *   2.  src/dashboard/status.ts file exists
 *   3.  routes.ts has /v1/data/export route
 *   4.  routes.ts has /v1/data/export/status/:jobId route
 *   5.  routes.ts has /status route
 *   6.  handleCreateExportJob() returns 202 with jobId and status=pending
 *   7.  handleCreateExportJob() jobId is a hex string
 *   8.  handleExportJobStatus() returns 404 for unknown jobId
 *   9.  handleExportJobStatus() returns job status for known jobId
 *  10.  renderStatusPage() returns valid HTML
 *  11.  renderStatusPage() contains component table
 *  12.  renderStatusPage() shows all up → 'All Systems Operational'
 *  13.  renderStatusPage() shows any down → 'Partial Outage'
 *  14.  resolveDefaultStatus() returns components array
 *
 * @since Wave 4 (4C-PACK-4C03 / NEW-4.01+NEW-4.02)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

import {
  handleCreateExportJob,
  handleExportJobStatus,
} from '../../src/api/dataExport.js';
import { renderStatusPage, resolveDefaultStatus } from '../../src/dashboard/status.js';

// ──────────────────────────────────────────────────────────
// Mock HTTP helpers
// ──────────────────────────────────────────────────────────
function mockReq(url: string, method = 'GET'): http.IncomingMessage {
  return Object.assign(Object.create(http.IncomingMessage.prototype), { url, method, headers: {} }) as http.IncomingMessage;
}
interface MockRes { statusCode: number; body: string; writeHead(c: number, h?: Record<string, string>): void; end(b?: string): void; setHeader(n: string, v: string): void; }
function mockRes(): MockRes & http.ServerResponse {
  const r: MockRes = { statusCode: 200, body: '', writeHead(c) { this.statusCode = c; }, end(b) { this.body += b ?? ''; }, setHeader() {} };
  return r as unknown as MockRes & http.ServerResponse;
}

// ──────────────────────────────────────────────────────────
// 1–5. File structure
// ──────────────────────────────────────────────────────────
describe('W4-4C03 — File structure', () => {
  it('src/api/dataExport.ts exists', () => assert.ok(fs.existsSync(path.join(ROOT, 'src/api/dataExport.ts'))));
  it('src/dashboard/status.ts exists', () => assert.ok(fs.existsSync(path.join(ROOT, 'src/dashboard/status.ts'))));

  it('routes.ts has /v1/data/export route', () => {
    const c = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(c.includes('/data/export'));
  });

  it('routes.ts has /v1/data/export/status/ route', () => {
    const c = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(c.includes('/data/export/status/'));
  });

  it('routes.ts has /status route', () => {
    const c = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(c.includes("'/status'"));
  });
});

// ──────────────────────────────────────────────────────────
// 6–9. dataExport handlers
// ──────────────────────────────────────────────────────────
describe('W4-4C03 — dataExport handlers', () => {
  it('handleCreateExportJob returns 202 with jobId', async () => {
    const req = mockReq('/v1/data/export', 'POST');
    const res = mockRes();
    await handleCreateExportJob(req, res as unknown as http.ServerResponse, 'tenant-export-test');
    assert.strictEqual(res.statusCode, 202);
    const parsed = JSON.parse(res.body);
    assert.ok(typeof parsed.jobId === 'string');
    assert.strictEqual(parsed.status, 'pending');
    assert.strictEqual(parsed.tenantId, 'tenant-export-test');
  });

  it('handleCreateExportJob jobId is a hex string', async () => {
    const req = mockReq('/v1/data/export', 'POST');
    const res = mockRes();
    await handleCreateExportJob(req, res as unknown as http.ServerResponse, 'tenant-hex-test');
    const parsed = JSON.parse(res.body);
    assert.ok(/^[0-9a-f]+$/.test(parsed.jobId));
  });

  it('handleExportJobStatus returns 404 for unknown jobId', () => {
    const req = mockReq('/v1/data/export/status/nonexistent');
    const res = mockRes();
    handleExportJobStatus(req, res as unknown as http.ServerResponse, 'nonexistent-job-id');
    assert.strictEqual(res.statusCode, 404);
  });

  it('handleExportJobStatus returns status for known jobId', async () => {
    const req1 = mockReq('/v1/data/export', 'POST');
    const res1 = mockRes();
    await handleCreateExportJob(req1, res1 as unknown as http.ServerResponse, 'tenant-poll-test');
    const { jobId } = JSON.parse(res1.body) as { jobId: string };

    const req2 = mockReq(`/v1/data/export/status/${jobId}`);
    const res2 = mockRes();
    handleExportJobStatus(req2, res2 as unknown as http.ServerResponse, jobId);
    const parsed = JSON.parse(res2.body);
    assert.ok(parsed.jobId === jobId);
    assert.ok(['pending', 'processing', 'done'].includes(parsed.status));
  });
});

// ──────────────────────────────────────────────────────────
// 10–14. Status page
// ──────────────────────────────────────────────────────────
describe('W4-4C03 — Status page', () => {
  it('renderStatusPage() returns valid HTML', () => {
    const data = resolveDefaultStatus();
    const html = renderStatusPage(data);
    assert.ok(html.includes('<!DOCTYPE html>'));
    assert.ok(html.includes('</html>'));
  });

  it('renderStatusPage() contains component table', () => {
    const data = resolveDefaultStatus();
    const html = renderStatusPage(data);
    assert.ok(html.includes('<table>') || html.includes('<table '));
    assert.ok(html.includes('Component'));
  });

  it('all up → shows "All Systems Operational"', () => {
    const data = {
      components: [{ name: 'API', status: 'up' as const }, { name: 'DB', status: 'up' as const }],
      timestamp: new Date().toISOString(),
    };
    const html = renderStatusPage(data);
    assert.ok(html.includes('All Systems Operational'));
  });

  it('any down → shows "Partial Outage"', () => {
    const data = {
      components: [{ name: 'API', status: 'up' as const }, { name: 'DB', status: 'down' as const }],
      timestamp: new Date().toISOString(),
    };
    const html = renderStatusPage(data);
    assert.ok(html.includes('Partial Outage'));
  });

  it('resolveDefaultStatus() returns components array', () => {
    const data = resolveDefaultStatus();
    assert.ok(Array.isArray(data.components));
    assert.ok(data.components.length >= 3);
    assert.ok(typeof data.timestamp === 'string');
  });
});
