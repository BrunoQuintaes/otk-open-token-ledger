/**
 * S1.4 — Auth Modes Runtime Validation Script
 *
 * Validates the 3 operational auth modes of the OTK zk-Metering runtime:
 *
 * Mode A: Auth ENABLED (OTK_TENANTS configured) → bearer + RBAC
 * Mode B: Auth DISABLED + OTK_ADMIN_KEY configured → legacy admin key for /admin/*
 * Mode C: Auth DISABLED + no OTK_ADMIN_KEY → fully open (backward compat)
 *
 * Usage:
 *   node scripts/ops/s1_4_auth_modes_validate.mjs [evdDir]
 *
 * Output: structured pass/fail report per mode.
 *
 * Each mode starts its own API server (ports 18788, 18789, 18790) with fixed throwaway credentials defined
 * below. When `evdDir` is given, per-mode results and 05_matrix.json are written there.
 * Exit codes: 0 = every check passed; 1 = at least one failed.
 *
 * @since S1.4 (2026-03-14)
 * @module scripts/ops/s1_4_auth_modes_validate
 */

import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const PORT_A = 18788;
const PORT_B = 18789;
const PORT_C = 18790;

// Test credentials — safe disposable values
const OWNER_TOKEN  = 's14-owner-tok';
const VIEWER_TOKEN = 's14-viewer-tok';
const ADMIN_KEY    = 's14-admin-key-test';
const OTK_TENANTS_A = `acme/OWNER:${OWNER_TOKEN},acme/VIEWER:${VIEWER_TOKEN}`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
async function req(baseUrl, method, pathname, opts = {}) {
  const url = `${baseUrl}${pathname}`;
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  const fetchOpts = { method, headers };
  if (opts.body !== undefined) fetchOpts.body = JSON.stringify(opts.body);
  const res = await fetch(url, fetchOpts);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

async function waitForHealth(baseUrl, maxMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    try {
      const res = await fetch(`${baseUrl}/health`);
      if (res.status === 200) return;
    } catch {}
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Server at ${baseUrl} did not become healthy`);
}

function spawnServer(port, env) {
  const isWin = process.platform === 'win32';
  const tsxBin = path.join(ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');
  const childEnv = { ...process.env, ...env, API_PORT: String(port), NODE_ENV: 'test', OTK_RECEIPT_LOG: '' };
  delete childEnv['OTK_DB_URL'];
  const [cmd, args] = isWin
    ? ['cmd.exe', ['/c', tsxBin, 'src/api/server.ts']]
    : [tsxBin, ['src/api/server.ts']];
  const proc = spawn(cmd, args, {
    cwd: ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'],
    ...(isWin ? {} : { detached: true }),
  });
  proc.stdout?.on('data', () => {});
  proc.stderr?.on('data', () => {});
  return proc;
}

function killServer(proc) {
  if (!proc?.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
  } else {
    try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
  }
}

function check(results, label, status, expected) {
  const pass = status === expected;
  results.push({ label, expected, got: status, pass });
  console.log(`  ${pass ? '✓' : '✗'} [${pass ? 'PASS' : 'FAIL'}] ${label} (expected ${expected}, got ${status})`);
  return pass;
}

// ---------------------------------------------------------------------------
// Mode A — Auth ENABLED (OTK_TENANTS)
// ---------------------------------------------------------------------------
async function runModeA(evdDir) {
  console.log('\n=== MODE A: Auth ENABLED (OTK_TENANTS) ===');
  const base = `http://127.0.0.1:${PORT_A}`;
  const results = [];
  let proc;
  try {
    proc = spawnServer(PORT_A, { OTK_TENANTS: OTK_TENANTS_A });
    await waitForHealth(base);
    console.log(`  Server healthy (port ${PORT_A})`);

    // Public
    check(results, 'GET /health → 200', (await req(base,'GET','/health')).status, 200);
    check(results, 'GET /version → 200', (await req(base,'GET','/version')).status, 200);

    // No token → 401
    check(results, 'POST /receipts no token → 401',
      (await req(base,'POST','/receipts',{body:{requestId:'r-a-0',provider:'p',model:'m',inputTokens:1,outputTokens:1}})).status, 401);
    check(results, 'GET /accounting/balance no token → 401',
      (await req(base,'GET','/accounting/balance')).status, 401);

    // OWNER → full access
    const ownerHdr = { Authorization: `Bearer ${OWNER_TOKEN}` };
    check(results, 'OWNER POST /receipts → 201',
      (await req(base,'POST','/receipts',{headers:ownerHdr,body:{requestId:'r-a-1',provider:'p',model:'m',inputTokens:10,outputTokens:5}})).status, 201);
    check(results, 'OWNER GET /accounting/balance → 200',
      (await req(base,'GET','/accounting/balance?tenantId=acme&epochId=0',{headers:ownerHdr})).status, 200);
    check(results, 'OWNER POST /admin/flush-batch → 200',
      (await req(base,'POST','/admin/flush-batch',{headers:ownerHdr})).status, 200);
    check(results, 'OWNER GET /admin/chain-head → 200',
      (await req(base,'GET','/admin/chain-head',{headers:ownerHdr})).status, 200);
    check(results, 'OWNER POST /admin/tenants/reload → 200',
      (await req(base,'POST','/admin/tenants/reload',{headers:ownerHdr,body:{tenants:OTK_TENANTS_A}})).status, 200);

    // VIEWER → read only, no write, no admin
    const viewerHdr = { Authorization: `Bearer ${VIEWER_TOKEN}` };
    check(results, 'VIEWER GET /accounting/balance → 200',
      (await req(base,'GET','/accounting/balance?tenantId=acme&epochId=0',{headers:viewerHdr})).status, 200);
    check(results, 'VIEWER POST /receipts → 403',
      (await req(base,'POST','/receipts',{headers:viewerHdr,body:{requestId:'r-a-v',provider:'p',model:'m',inputTokens:1,outputTokens:1}})).status, 403);
    check(results, 'VIEWER POST /admin/flush-batch → 403',
      (await req(base,'POST','/admin/flush-batch',{headers:viewerHdr})).status, 403);
    check(results, 'VIEWER POST /admin/tenants/reload → 403',
      (await req(base,'POST','/admin/tenants/reload',{headers:viewerHdr,body:{tenants:''}})).status, 403);

  } finally {
    killServer(proc);
    await new Promise(r => setTimeout(r, 300));
  }
  if (evdDir) writeFileSync(path.join(evdDir,'02_mode_a.txt'), JSON.stringify(results, null, 2));
  const passed = results.filter(r => r.pass).length;
  console.log(`\n  Mode A: ${passed}/${results.length} PASS`);
  return results;
}

// ---------------------------------------------------------------------------
// Mode B — Auth DISABLED + OTK_ADMIN_KEY
// ---------------------------------------------------------------------------
async function runModeB(evdDir) {
  console.log('\n=== MODE B: Auth DISABLED + OTK_ADMIN_KEY ===');
  const base = `http://127.0.0.1:${PORT_B}`;
  const results = [];
  let proc;
  try {
    proc = spawnServer(PORT_B, { OTK_ADMIN_KEY: ADMIN_KEY });
    // No OTK_TENANTS → auth disabled
    await waitForHealth(base);
    console.log(`  Server healthy (port ${PORT_B})`);

    // Public
    check(results, 'GET /health → 200', (await req(base,'GET','/health')).status, 200);

    // POST /receipts: auth disabled → open (OWNER virtual)
    check(results, 'POST /receipts no token → 201 (auth disabled, open)',
      (await req(base,'POST','/receipts',{body:{requestId:'r-b-1',provider:'p',model:'m',inputTokens:10,outputTokens:5}})).status, 201);

    // GET /accounting/balance: auth disabled → open
    check(results, 'GET /accounting/balance → 200 (auth disabled)',
      (await req(base,'GET','/accounting/balance')).status, 200);

    // Admin without x-admin-key → 401
    check(results, 'POST /admin/flush-batch no admin key → 401',
      (await req(base,'POST','/admin/flush-batch')).status, 401);
    check(results, 'GET /admin/chain-head no admin key → 401',
      (await req(base,'GET','/admin/chain-head')).status, 401);
    check(results, 'GET /admin/tal-summary no admin key → 401',
      (await req(base,'GET','/admin/tal-summary')).status, 401);
    check(results, 'POST /admin/tenants/reload no admin key → 401',
      (await req(base,'POST','/admin/tenants/reload',{body:{tenants:''}})).status, 401);

    // Admin with correct x-admin-key → 200
    const adminHdr = { 'x-admin-key': ADMIN_KEY };
    check(results, 'POST /admin/flush-batch with admin key → 200',
      (await req(base,'POST','/admin/flush-batch',{headers:adminHdr})).status, 200);
    check(results, 'GET /admin/chain-head with admin key → 200',
      (await req(base,'GET','/admin/chain-head',{headers:adminHdr})).status, 200);
    check(results, 'GET /admin/tal-summary with admin key → 200',
      (await req(base,'GET','/admin/tal-summary',{headers:adminHdr})).status, 200);
    check(results, 'POST /admin/tenants/reload with admin key → 200',
      (await req(base,'POST','/admin/tenants/reload',{headers:adminHdr,body:{tenants:''}})).status, 200);

    // Wrong admin key → 401
    check(results, 'POST /admin/flush-batch wrong admin key → 401',
      (await req(base,'POST','/admin/flush-batch',{headers:{'x-admin-key':'wrong-key'}})).status, 401);

  } finally {
    killServer(proc);
    await new Promise(r => setTimeout(r, 300));
  }
  if (evdDir) writeFileSync(path.join(evdDir,'03_mode_b.txt'), JSON.stringify(results, null, 2));
  const passed = results.filter(r => r.pass).length;
  console.log(`\n  Mode B: ${passed}/${results.length} PASS`);
  return results;
}

// ---------------------------------------------------------------------------
// Mode C — Auth DISABLED + no OTK_ADMIN_KEY (fully open)
// ---------------------------------------------------------------------------
async function runModeC(evdDir) {
  console.log('\n=== MODE C: Auth DISABLED, no OTK_ADMIN_KEY (open) ===');
  const base = `http://127.0.0.1:${PORT_C}`;
  const results = [];
  let proc;
  try {
    proc = spawnServer(PORT_C, {});
    // No OTK_TENANTS, no OTK_ADMIN_KEY
    await waitForHealth(base);
    console.log(`  Server healthy (port ${PORT_C})`);

    check(results, 'GET /health → 200', (await req(base,'GET','/health')).status, 200);
    check(results, 'POST /receipts no auth → 201 (fully open)',
      (await req(base,'POST','/receipts',{body:{requestId:'r-c-1',provider:'p',model:'m',inputTokens:10,outputTokens:5}})).status, 201);
    check(results, 'GET /accounting/balance → 200',
      (await req(base,'GET','/accounting/balance')).status, 200);
    check(results, 'POST /admin/flush-batch → 200 (no OTK_ADMIN_KEY = open)',
      (await req(base,'POST','/admin/flush-batch')).status, 200);
    check(results, 'GET /admin/chain-head → 200',
      (await req(base,'GET','/admin/chain-head')).status, 200);
    check(results, 'GET /admin/tal-summary → 200',
      (await req(base,'GET','/admin/tal-summary')).status, 200);
    check(results, 'POST /admin/tenants/reload → 200 (no admin key = open)',
      (await req(base,'POST','/admin/tenants/reload',{body:{tenants:''}})).status, 200);

  } finally {
    killServer(proc);
    await new Promise(r => setTimeout(r, 300));
  }
  if (evdDir) writeFileSync(path.join(evdDir,'04_mode_c.txt'), JSON.stringify(results, null, 2));
  const passed = results.filter(r => r.pass).length;
  console.log(`\n  Mode C: ${passed}/${results.length} PASS`);
  return results;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
const evdDir = process.argv[2] || null;

const resultsA = await runModeA(evdDir);
const resultsB = await runModeB(evdDir);
const resultsC = await runModeC(evdDir);

const allResults = [...resultsA, ...resultsB, ...resultsC];
const totalPass = allResults.filter(r => r.pass).length;
const totalFail = allResults.filter(r => !r.pass).length;

const matrix = {
  modeA: { total: resultsA.length, pass: resultsA.filter(r=>r.pass).length, results: resultsA },
  modeB: { total: resultsB.length, pass: resultsB.filter(r=>r.pass).length, results: resultsB },
  modeC: { total: resultsC.length, pass: resultsC.filter(r=>r.pass).length, results: resultsC },
  total: allResults.length,
  totalPass,
  totalFail,
};

console.log(`\n[S1.4] TOTAL: ${totalPass} PASS / ${totalFail} FAIL\n`);

if (evdDir) {
  writeFileSync(path.join(evdDir, '05_matrix.json'), JSON.stringify(matrix, null, 2));
  console.log(`[S1.4] Evidence written to ${evdDir}`);
}

if (totalFail > 0) process.exit(1);
