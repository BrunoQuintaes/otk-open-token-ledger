/**
 * S1.3 — RBAC Runtime Validation Script
 *
 * Spawns the API server with a test OTK_TENANTS containing tokens for all 5 roles,
 * then validates HTTP behavior for each role against key protected endpoints.
 *
 * Usage:
 *   node scripts/ops/s1_3_rbac_validate.mjs [evdDir]
 *
 * Output: structured pass/fail report to stdout (capture for EVD).
 *
 * The server runs on port 18787 with fixed throwaway tokens defined below (one per role, tenant "acme").
 * When `evdDir` is given, the role matrix is also written to <evdDir>/03_role_matrix_runtime.txt.
 * Exit codes: 0 = every check passed; 1 = at least one failed.
 *
 * @since S1.3 (2026-03-14)
 * @module scripts/ops/s1_3_rbac_validate
 */

import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const PORT = 18787;
const BASE_URL = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// Test credentials (safe disposable values — S1.3 only)
// ---------------------------------------------------------------------------
const TOKENS = {
  OWNER:    's13-owner-tok',
  ADMIN:    's13-admin-tok',
  OPERATOR: 's13-op-tok',
  MEMBER:   's13-mbr-tok',
  VIEWER:   's13-vwr-tok',
};
const OTK_TENANTS = [
  `acme/OWNER:${TOKENS.OWNER}`,
  `acme/ADMIN:${TOKENS.ADMIN}`,
  `acme/OPERATOR:${TOKENS.OPERATOR}`,
  `acme/MEMBER:${TOKENS.MEMBER}`,
  `acme/VIEWER:${TOKENS.VIEWER}`,
].join(',');

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------
async function req(method, path, token, body) {
  const url = `${BASE_URL}${path}`;
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const opts = { method, headers };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

// ---------------------------------------------------------------------------
// Health wait
// ---------------------------------------------------------------------------
async function waitForHealth(maxMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${BASE_URL}/health`);
      if (res.status === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error('API server did not become healthy in time');
}

// ---------------------------------------------------------------------------
// Test matrix
// ---------------------------------------------------------------------------
const tests = [
  // --- Public endpoints (no auth required regardless of OTK_TENANTS) ---
  { label: 'PUBLIC: GET /health → 200',  method: 'GET',  path: '/health', token: null, expectStatus: 200 },
  { label: 'PUBLIC: GET /version → 200', method: 'GET',  path: '/version', token: null, expectStatus: 200 },

  // --- No token when auth enabled → 401 ---
  { label: 'NO-TOKEN: POST /receipts → 401', method: 'POST', path: '/receipts',
    token: null, body: { requestId: 'r-noauth', provider: 'openai', model: 'm', inputTokens: 10, outputTokens: 5 },
    expectStatus: 401 },
  { label: 'NO-TOKEN: GET /accounting/balance → 401', method: 'GET', path: '/accounting/balance',
    token: null, expectStatus: 401 },

  // --- OWNER: all permissions ---
  { label: 'OWNER: POST /receipts → 201', method: 'POST', path: '/receipts',
    token: TOKENS.OWNER, body: { requestId: 'r-owner-1', provider: 'openai', model: 'm', inputTokens: 10, outputTokens: 5 },
    expectStatus: 201 },
  { label: 'OWNER: GET /accounting/balance → 200', method: 'GET', path: '/accounting/balance?tenantId=acme&epochId=0',
    token: TOKENS.OWNER, expectStatus: 200 },
  { label: 'OWNER: POST /admin/flush-batch → 200', method: 'POST', path: '/admin/flush-batch',
    token: TOKENS.OWNER, expectStatus: 200 },
  { label: 'OWNER: GET /admin/chain-head → 200', method: 'GET', path: '/admin/chain-head',
    token: TOKENS.OWNER, expectStatus: 200 },
  { label: 'OWNER: GET /admin/tal-summary → 200', method: 'GET', path: '/admin/tal-summary',
    token: TOKENS.OWNER, expectStatus: 200 },
  { label: 'OWNER: POST /admin/tenants/reload → 200', method: 'POST', path: '/admin/tenants/reload',
    token: TOKENS.OWNER, body: { tenants: OTK_TENANTS }, expectStatus: 200 },

  // --- ADMIN: all except admin:keys ---
  { label: 'ADMIN: POST /receipts → 201', method: 'POST', path: '/receipts',
    token: TOKENS.ADMIN, body: { requestId: 'r-admin-1', provider: 'openai', model: 'm', inputTokens: 10, outputTokens: 5 },
    expectStatus: 201 },
  { label: 'ADMIN: POST /admin/flush-batch → 200', method: 'POST', path: '/admin/flush-batch',
    token: TOKENS.ADMIN, expectStatus: 200 },
  { label: 'ADMIN: POST /admin/tenants/reload → 403 (lacks admin:keys)', method: 'POST', path: '/admin/tenants/reload',
    token: TOKENS.ADMIN, body: { tenants: OTK_TENANTS }, expectStatus: 403 },

  // --- OPERATOR: receipts + admin ops, no reload ---
  { label: 'OPERATOR: POST /receipts → 201', method: 'POST', path: '/receipts',
    token: TOKENS.OPERATOR, body: { requestId: 'r-op-1', provider: 'openai', model: 'm', inputTokens: 10, outputTokens: 5 },
    expectStatus: 201 },
  { label: 'OPERATOR: POST /admin/flush-batch → 200', method: 'POST', path: '/admin/flush-batch',
    token: TOKENS.OPERATOR, expectStatus: 200 },
  { label: 'OPERATOR: GET /admin/chain-head → 200', method: 'GET', path: '/admin/chain-head',
    token: TOKENS.OPERATOR, expectStatus: 200 },
  { label: 'OPERATOR: POST /admin/tenants/reload → 403 (lacks admin:keys)', method: 'POST', path: '/admin/tenants/reload',
    token: TOKENS.OPERATOR, body: { tenants: OTK_TENANTS }, expectStatus: 403 },

  // --- MEMBER: receipts only, no admin ---
  { label: 'MEMBER: POST /receipts → 201', method: 'POST', path: '/receipts',
    token: TOKENS.MEMBER, body: { requestId: 'r-mbr-1', provider: 'openai', model: 'm', inputTokens: 10, outputTokens: 5 },
    expectStatus: 201 },
  { label: 'MEMBER: GET /accounting/balance → 200', method: 'GET', path: '/accounting/balance?tenantId=acme&epochId=0',
    token: TOKENS.MEMBER, expectStatus: 200 },
  { label: 'MEMBER: POST /admin/flush-batch → 403 (lacks admin:flush)', method: 'POST', path: '/admin/flush-batch',
    token: TOKENS.MEMBER, expectStatus: 403 },
  { label: 'MEMBER: GET /admin/chain-head → 403', method: 'GET', path: '/admin/chain-head',
    token: TOKENS.MEMBER, expectStatus: 403 },
  { label: 'MEMBER: POST /admin/tenants/reload → 403', method: 'POST', path: '/admin/tenants/reload',
    token: TOKENS.MEMBER, body: { tenants: '' }, expectStatus: 403 },

  // --- VIEWER: read-only, no write, no admin ---
  { label: 'VIEWER: GET /accounting/balance → 200', method: 'GET', path: '/accounting/balance?tenantId=acme&epochId=0',
    token: TOKENS.VIEWER, expectStatus: 200 },
  { label: 'VIEWER: POST /receipts → 403 (lacks receipts:write)', method: 'POST', path: '/receipts',
    token: TOKENS.VIEWER, body: { requestId: 'r-vwr-1', provider: 'openai', model: 'm', inputTokens: 10, outputTokens: 5 },
    expectStatus: 403 },
  { label: 'VIEWER: POST /admin/flush-batch → 403', method: 'POST', path: '/admin/flush-batch',
    token: TOKENS.VIEWER, expectStatus: 403 },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const evdDir = process.argv[2] || null;
let apiProc = null;
const results = [];
let passed = 0, failed = 0;

function log(msg) {
  console.log(msg);
}

try {
  // Spawn API server
  const isWin = process.platform === 'win32';
  const tsxBin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');
  const childEnv = { ...process.env };
  childEnv['API_PORT'] = String(PORT);
  childEnv['OTK_TENANTS'] = OTK_TENANTS;
  childEnv['OTK_RECEIPT_LOG'] = '';
  childEnv['NODE_ENV'] = 'test';
  delete childEnv['OTK_ADMIN_KEY'];
  delete childEnv['OTK_DB_URL'];

  const [spawnCmd, spawnArgs] = isWin
    ? ['cmd.exe', ['/c', tsxBin, 'src/api/server.ts']]
    : [tsxBin, ['src/api/server.ts']];

  apiProc = spawn(spawnCmd, spawnArgs, {
    cwd: ROOT,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(isWin ? {} : { detached: true }),
  });
  apiProc.stdout?.on('data', () => {});
  apiProc.stderr?.on('data', () => {});

  log(`\n[S1.3] Spawned API server (PID ${apiProc.pid}) on port ${PORT}`);
  log(`[S1.3] OTK_TENANTS: ${OTK_TENANTS.replace(/:[^,]*/g, ':<token>')}\n`);

  await waitForHealth();
  log('[S1.3] Server healthy. Running role matrix...\n');

  // Run test matrix
  for (const t of tests) {
    try {
      const r = await req(t.method, t.path, t.token, t.body);
      const ok = r.status === t.expectStatus;
      const symbol = ok ? '✓' : '✗';
      const line = `  ${symbol} [${ok ? 'PASS' : 'FAIL'}] ${t.label} (got ${r.status})`;
      log(line);
      results.push({ label: t.label, expected: t.expectStatus, got: r.status, pass: ok });
      if (ok) passed++; else failed++;
    } catch (err) {
      const line = `  ✗ [FAIL] ${t.label} — ERROR: ${err.message}`;
      log(line);
      results.push({ label: t.label, expected: t.expectStatus, got: 'ERROR', pass: false, error: err.message });
      failed++;
    }
  }

  log(`\n[S1.3] Results: ${passed} PASS / ${failed} FAIL\n`);

  if (evdDir) {
    const summary = JSON.stringify({ passed, failed, total: tests.length, results }, null, 2);
    writeFileSync(path.join(evdDir, '03_role_matrix_runtime.txt'), summary);
    log(`[S1.3] Evidence written to ${evdDir}/03_role_matrix_runtime.txt`);
  }

} finally {
  if (apiProc?.pid) {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/F', '/T', '/PID', String(apiProc.pid)], { stdio: 'ignore' });
    } else {
      try { process.kill(-apiProc.pid, 'SIGKILL'); } catch { apiProc.kill('SIGKILL'); }
    }
  }
}

if (failed > 0) process.exit(1);
