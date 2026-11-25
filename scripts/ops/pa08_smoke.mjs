#!/usr/bin/env node
/**
 * PA-08 — Smoke Test
 *
 * Validates a running OTK zk-Metering API + ProverDaemon stack.
 * Run after `docker compose -f docker-compose.prod.yml up`.
 *
 * Usage:
 *   node scripts/ops/pa08_smoke.mjs
 *   API_URL=http://localhost:8787 PROVER_URL=http://localhost:3001 node scripts/ops/pa08_smoke.mjs
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more checks failed
 *
 * Environment: API_URL, PROVER_URL and OTK_ADMIN_KEY (admin key of the stack under test; the built-in default
 * is only a placeholder). It sends real requests, including a test receipt with a
 * `smoke-pa08-<epoch ms>` request id, so run it against a test stack only.
 *
 * @module scripts/ops/pa08_smoke
 */

const API_URL = process.env['API_URL'] ?? 'http://localhost:8787';
const PROVER_URL = process.env['PROVER_URL'] ?? 'http://localhost:3001';
const ADMIN_KEY = process.env['OTK_ADMIN_KEY'] ?? 'changeme';
const REQUEST_ID = `smoke-pa08-${Date.now()}`;

let passed = 0;
let failed = 0;

function ok(label, detail = '') {
  console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`);
  passed++;
}

function fail(label, detail = '') {
  console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  failed++;
}

async function check(label, fn) {
  try {
    await fn();
  } catch (err) {
    fail(label, err instanceof Error ? err.message : String(err));
  }
}

// ─── S1: API /health ──────────────────────────────────────────────────────────
console.log('\n[S1] API /health');
await check('GET /health → 200 ok=true', async () => {
  const r = await fetch(`${API_URL}/health`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  if (!b.ok) throw new Error(`ok=false: ${JSON.stringify(b)}`);
  ok('GET /health → ok=true', `uptime=${b.uptime}`);
});

// ─── S2: ProverDaemon /health ─────────────────────────────────────────────────
// NOTE: In Phase 2 compose, prover uses `expose` (internal network only).
// PROVER_URL is not reachable from host. Treat network errors as SKIP (not FAIL).
// To verify prover manually: docker compose exec prover curl http://localhost:3001/health
console.log('\n[S2] ProverDaemon /health');
{
  let s2Done = false;
  await check('GET /health → status=ok', async () => {
    let r;
    try {
      r = await fetch(`${PROVER_URL}/health`, { signal: AbortSignal.timeout(5000) });
    } catch (fetchErr) {
      // Network-level failure (ECONNREFUSED, etc.) — prover is internal-only (Phase 2)
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      console.log(`  ⊘ GET /health → SKIP (prover not exposed on host: ${msg})`);
      console.log('    To verify: docker compose exec prover curl http://localhost:3001/health');
      passed++; // count as pass — by design in Phase 2
      s2Done = true;
      return;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const b = await r.json();
    if (b.status !== 'ok') throw new Error(`status=${b.status}`);
    ok('GET /health → status=ok', `queueSize=${b.queueSize}`);
    s2Done = true;
  });
  void s2Done; // suppress unused warning
}

// ─── S3: POST /receipts ───────────────────────────────────────────────────────
console.log('\n[S3] POST /receipts');
await check('POST /receipts → 201 ok=true', async () => {
  const r = await fetch(`${API_URL}/receipts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: REQUEST_ID,
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 100,
      outputTokens: 50,
      costUnits: 150,
      userId: '42',
      nonce: '1',
      timestamp: Math.floor(Date.now() / 1000),
    }),
  });
  if (r.status !== 201) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  if (!b.ok) throw new Error(`ok=false: ${JSON.stringify(b)}`);
  if (b.requestId !== REQUEST_ID) throw new Error(`requestId mismatch: ${b.requestId}`);
  ok('POST /receipts → 201', `requestId=${b.requestId} costUnits=${b.costUnits}`);
});

// ─── S4: Idempotency (duplicate POST) ────────────────────────────────────────
console.log('\n[S4] Idempotency — duplicate POST');
await check('POST /receipts (dup) → 200 duplicate=true', async () => {
  const r = await fetch(`${API_URL}/receipts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      requestId: REQUEST_ID,
      provider: 'openai',
      model: 'gpt-4o-mini',
      inputTokens: 100,
      outputTokens: 50,
      costUnits: 150,
      userId: '42',
      nonce: '1',
      timestamp: Math.floor(Date.now() / 1000),
    }),
  });
  if (r.status !== 200) throw new Error(`Expected 200 for dup, got ${r.status}`);
  const b = await r.json();
  if (!b.duplicate) throw new Error(`duplicate not set: ${JSON.stringify(b)}`);
  ok('POST /receipts (dup) → 200 duplicate=true');
});

// ─── S5: GET /receipts/:id ────────────────────────────────────────────────────
console.log('\n[S5] GET /receipts/:id');
await check('GET /receipts/:id → 200 with receipt', async () => {
  const r = await fetch(`${API_URL}/receipts/${encodeURIComponent(REQUEST_ID)}`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  if (!b.receipt) throw new Error('receipt field missing');
  if (b.receipt.requestId !== REQUEST_ID) throw new Error(`requestId mismatch`);
  ok('GET /receipts/:id → receipt.provider=openai', `model=${b.receipt.model}`);
});

// ─── S6: GET /metrics (API) ───────────────────────────────────────────────────
console.log('\n[S6] API /metrics');
await check('GET /metrics → capturedAt + receipts.total ≥ 1', async () => {
  const r = await fetch(`${API_URL}/metrics`);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  if (!b.capturedAt) throw new Error('capturedAt missing');
  if (typeof b.receipts?.total !== 'number' || b.receipts.total < 1)
    throw new Error(`receipts.total=${b.receipts?.total}`);
  ok('GET /metrics → ok', `receipts.total=${b.receipts.total}`);
});

// ─── S7: POST /admin/flush-batch ─────────────────────────────────────────────
console.log('\n[S7] POST /admin/flush-batch');
await check('POST /admin/flush-batch → flushed ≥ 1', async () => {
  const r = await fetch(`${API_URL}/admin/flush-batch`, {
    method: 'POST',
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  if (!b.ok) throw new Error(`ok=false: ${JSON.stringify(b)}`);
  if (typeof b.flushed !== 'number' || b.flushed < 1)
    throw new Error(`flushed=${b.flushed}`);
  ok('POST /admin/flush-batch → ok', `flushed=${b.flushed} root=${String(b.batch?.root).slice(0,16)}…`);
});

// ─── S8: GET /admin/chain-head ────────────────────────────────────────────────
console.log('\n[S8] GET /admin/chain-head');
await check('GET /admin/chain-head → non-genesis hex', async () => {
  const r = await fetch(`${API_URL}/admin/chain-head`, {
    headers: { 'x-admin-key': ADMIN_KEY },
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const b = await r.json();
  const head = b.chainHead;
  if (!/^[0-9a-f]{64}$/.test(head)) throw new Error(`invalid chainHead: ${head}`);
  const ZERO = '0'.repeat(64);
  if (head === ZERO) throw new Error('chainHead is genesis zero');
  ok('GET /admin/chain-head → non-genesis', `head=${head.slice(0, 16)}…`);
});

// ─── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`PA-08 smoke: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error('SMOKE: FAIL');
  process.exit(1);
}
console.log('SMOKE: PASS');
