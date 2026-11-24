/**
 * Core flow across a restart (review findings R02, R06, R07*, R12, R14, N1 + R01 check).
 *
 * authenticated entry → tenant identification → metering → JSONL persistence →
 * restart → billing → reconciliation
 *
 * Real components: API server (src/api/server.ts, child process, bearer-token auth via
 * OTK_TENANTS), receiptStore JSONL persistence and replay, TAL, UsageMeterService,
 * ReconciliationSystem, CUWeightsLoader.
 * Substitutes: ProverDaemon (local HTTP stub, starts unavailable), the on-chain batch
 * transaction (synthetic txHash), the provider invoice (synthetic 0.105 USD line).
 * Not exercised: PostgreSQL, Redis, Stripe, real proofs, chain. (*R07 needs PG; see unit tests.)
 *
 * Expected values by hand: gpt-4o seed 2026-04 = 0.005 USD/1K in, 0.015 USD/1K out.
 *   one receipt 1000/2000 tokens = 0.035 USD; tenant-a has 3 → 0.105 USD, 9000 CU (3 × 3000 declared).
 *   tenant-b: 1 receipt of a model with CU weight but absent from the price seed (o3, weight 3.0):
 *   100 + 100 tokens → 600 CU computed by the server (D5-G04: the declared 500 is not debited;
 *   before D5-G04 the client value 500 was the debit and an unknown model was accepted).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawnSync } from 'node:child_process';
import { spawnApi, stopApi, waitReady, type ApiChild } from './fixtures/apiChild.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveEpoch } from '../../src/types/receipt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

const TOKEN_A = 'itest-fixture-a';
const TOKEN_B = 'itest-fixture-b';
const TS = 1700000000;
const EPOCH = String(deriveEpoch(TS));

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? resolve(addr.port) : reject(new Error('no port'))));
    });
    srv.on('error', reject);
  });
}

async function waitFor(check: () => Promise<boolean> | boolean, maxMs: number, what: string): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { if (await check()) return; } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${what}`);
}

describe('Core flow across restart (R02/R06/R12/R14, R01 preserved)', () => {
  let stub: Server;
  let stubPort: number;
  let api: ApiChild | undefined;
  let apiPort: number;
  let baseEnv: NodeJS.ProcessEnv;
  let receiptLog: string;
  const proveCalls: string[] = [];         // "userId:nonce" per POST /prove
  const accepted = new Map<string, string>(); // "userId:nonce" → jobId
  let proverUp = false;

  const base = () => `http://127.0.0.1:${apiPort}`;
  const post = (token: string | null, body: Record<string, unknown>) => fetch(`${base()}/receipts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const receipt = (requestId: string, userId: number, nonce: number, over: Record<string, unknown> = {}) => ({
    requestId, provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 2000,
    costUnits: 3000, latencyMs: 10, timestamp: TS, userId: String(userId), nonce: String(nonce), ...over,
  });

  before(async () => {
    [stubPort, apiPort] = await Promise.all([getFreePort(), getFreePort()]);
    stub = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (req.method === 'POST' && u.pathname === '/prove') {
        let b = '';
        req.on('data', c => { b += String(c); });
        req.on('end', () => {
          const { userId, nonce } = JSON.parse(b) as { userId: string; nonce: string };
          const key = `${userId}:${nonce}`;
          proveCalls.push(key);
          if (!proverUp) { res.writeHead(503); res.end('{}'); return; }
          const jobId = `stub-${key.replace(':', '-')}`;
          accepted.set(key, jobId);
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jobId, status: 'pending' }));
        });
        return;
      }
      const m = u.pathname.match(/^\/status\/(.+)$/);
      if (req.method === 'GET' && m) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jobId: m[1], status: 'done', attempts: 1 }));
        return;
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>(r => stub.listen(stubPort, '127.0.0.1', () => r()));

    receiptLog = path.join(mkdtempSync(path.join(tmpdir(), 'otk-core-flow-')), 'receipts.jsonl');
    baseEnv = { ...process.env };
    delete baseEnv['OTK_DB_URL'];
    delete baseEnv['OTK_REDIS_URL'];
    Object.assign(baseEnv, {
      NODE_ENV: 'test',
      OTK_TENANTS: `tenant-a/OPERATOR:${TOKEN_A},tenant-b/OPERATOR:${TOKEN_B}`,
      OTK_ADMIN_KEY: 'itest-admin-fixture',
      OTK_RECEIPT_LOG: receiptLog,
      PROVER_URL: `http://127.0.0.1:${stubPort}`,
      PROVER_CB_THRESHOLD: '2',
      PROVER_CB_COOLDOWN_MS: '300',
    });
  });

  after(async () => {
    await stopApi(api);
    await new Promise<void>(r => stub.close(() => r()));
  });

  it('phase 1: authenticated metering while the prover is down, then recovery', async () => {
    api = spawnApi(apiPort, baseEnv);
    try {
    await waitReady(api, 'core_flow API #1');

    const anon = await post(null, receipt('anon-1', 99, 1));
    assert.ok(anon.status === 401 || anon.status === 403, `unauthenticated POST must be rejected, got ${anon.status}`);

    assert.equal((await post(TOKEN_A, receipt('a-1', 11, 1))).status, 201);
    assert.equal((await post(TOKEN_A, receipt('a-2', 11, 2))).status, 201);
    assert.equal((await post(TOKEN_B, receipt('b-1', 22, 1, { model: 'o3', inputTokens: 100, outputTokens: 100, costUnits: 500 }))).status, 201);
    await waitFor(() => proveCalls.length >= 2, 5000, 'two failed prove attempts');

    const dup = await post(TOKEN_A, receipt('a-1', 11, 1));
    assert.equal(dup.status, 200);
    assert.equal(((await dup.json()) as { duplicate: boolean }).duplicate, true);

    // Prover comes back; after the 300 ms cooldown the next receipt triggers the half-open trial.
    proverUp = true;
    await new Promise(r => setTimeout(r, 450));
    // Body claims tenant-b, token belongs to tenant-a: the authenticated tenant must win.
    assert.equal((await post(TOKEN_A, receipt('a-3', 11, 3, { tenantId: 'tenant-b' }))).status, 201);

    await waitFor(() => accepted.size === 4, 10000, 'all four receipts accepted by the prover');
    assert.deepEqual([...accepted.keys()].sort(), ['11:1', '11:2', '11:3', '22:1']);
    assert.ok(!proveCalls.includes('99:1'), 'rejected request never reached the prover');
    // OVERNIGHT 20261005 (F-P1-08): the stub counts acceptance when it SENDS its 202; the server writes the correlation
    // after it RECEIVES it. Stopping the server right after the stub-side count could cut the last write (phase 2 reads it).
    const jobLines = () => { try { return readFileSync(receiptLog + '.jobs', 'utf-8').split('\n').filter(Boolean).length; } catch { return 0; } };
    await waitFor(() => jobLines() >= 4, 10000, 'four correlations written before the stop');
    } finally { await stopApi(api); } // never leave an orphaned server holding the port
  });

  it('phase 2: JSONL holds each receipt once, with its tenant', () => {
    const lines = readFileSync(receiptLog, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>);
    assert.equal(lines.length, 4, 'no duplicate, no unauthenticated receipt');
    const byId = Object.fromEntries(lines.map(l => [l['requestId'], l['tenantId']]));
    assert.deepEqual(byId, { 'a-1': 'tenant-a', 'a-2': 'tenant-a', 'b-1': 'tenant-b', 'a-3': 'tenant-a' });
    const jobs = readFileSync(receiptLog + '.jobs', 'utf-8').split('\n').filter(Boolean);
    assert.equal(jobs.length, 4, 'one proof-job correlation per receipt');
  });

  it('phase 3: after restart, tenant, balance and isolation are preserved; nothing is re-sent', async () => {
    const callsBefore = proveCalls.length;
    api = spawnApi(apiPort, baseEnv);
    try {
    await waitReady(api, 'core_flow API #2');

    const own = await fetch(`${base()}/receipts/a-1`, { headers: { authorization: `Bearer ${TOKEN_A}` } });
    assert.equal(own.status, 200);
    const body = await own.json() as { receipt: { tenantId: string }; proofStatus: string; jobId?: string };
    assert.equal(body.receipt.tenantId, 'tenant-a');
    assert.equal(body.jobId, 'stub-11-1', 'proof correlation survived the restart');
    assert.equal(body.proofStatus, 'proved');

    const other = await fetch(`${base()}/receipts/a-1`, { headers: { authorization: `Bearer ${TOKEN_B}` } });
    assert.equal(other.status, 403, 'tenant-b cannot read tenant-a receipt');

    const bal = await fetch(`${base()}/accounting/balance?tenantId=tenant-a&epochId=${EPOCH}`, { headers: { authorization: `Bearer ${TOKEN_A}` } });
    const b = await bal.json() as { totalCU: string; entryCount: number };
    assert.equal(b.totalCU, '9000');
    assert.equal(b.entryCount, 3);
    const cross = await fetch(`${base()}/accounting/balance?tenantId=tenant-b&epochId=${EPOCH}`, { headers: { authorization: `Bearer ${TOKEN_A}` } });
    assert.equal(cross.status, 403, 'tenant-a cannot read tenant-b balance (N1)');
    const implicit = await fetch(`${base()}/accounting/balance?epochId=${EPOCH}`, { headers: { authorization: `Bearer ${TOKEN_B}` } });
    assert.equal(((await implicit.json()) as { tenantId: string; totalCU: string }).totalCU, '600', 'no tenantId → caller tenant');

    await new Promise(r => setTimeout(r, 800));
    assert.equal(proveCalls.length, callsBefore, 'accepted receipts are not re-sent after restart');
    } finally { await stopApi(api); }
  });

  it('phase 4: a fresh process computes billing and reconciliation from the persisted data', () => {
    const env = { ...baseEnv, PROVER_URL: 'disabled', OTK_TENANTS: '' };
    const arg = JSON.stringify({ tenants: ['tenant-a', 'tenant-b'], epochId: EPOCH, batchTenant: 'tenant-a', externalUsd: 0.105 });
    const child = spawnSync(process.execPath, ['--import', 'tsx', path.join(__dirname, 'fixtures', 'core_flow_worker.ts'), arg], {
      cwd: ROOT, env, encoding: 'utf8', timeout: 60000,
    });
    assert.equal(child.status, 0, `worker failed: ${child.stderr}`);
    const out = JSON.parse(child.stdout.trim().split('\n').pop()!) as {
      billing: Record<string, { totalUsd: number; totalCU: string; balanceCU: string; complete: boolean; priceVersion: string; unpricedEntries: Array<{ requestId: string; reason: string }> }>;
      reconciliation: { otkCU: string; otkReceiptCount: number; receiptIds: string[]; expectedUsd: number; externalUsd: number; deltaUsd: number; discrepancyFlag: boolean; status: string };
      r01: { original: boolean; tampered: boolean };
      restoredReceipts: number;
      defaultCU: string;
    };

    assert.equal(out.restoredReceipts, 4);
    assert.equal(out.defaultCU, '0', 'nothing re-attributed to default after restart (R12)');
    const a = out.billing['tenant-a']!;
    assert.ok(Math.abs(a.totalUsd - 0.105) < 1e-12, `tenant-a USD ${a.totalUsd}`);
    assert.equal(a.totalCU, '9000');
    assert.equal(a.balanceCU, '9000');
    assert.equal(a.complete, true);
    assert.equal(a.priceVersion, '2026-04');

    const bb = out.billing['tenant-b']!;
    assert.equal(bb.totalCU, '600');
    assert.equal(bb.complete, false, 'unknown model is not billed as USD 0');
    assert.deepEqual(bb.unpricedEntries, [{ requestId: 'b-1', reason: 'unknown_price' }]);

    const rec = out.reconciliation;
    assert.equal(rec.otkCU, '9000');
    assert.equal(rec.otkReceiptCount, 3);
    assert.deepEqual([...rec.receiptIds].sort(), ['a-1', 'a-2', 'a-3']);
    assert.ok(Math.abs(rec.expectedUsd - 0.105) < 1e-12);
    assert.ok(Math.abs(rec.deltaUsd) < 1e-12);
    assert.equal(rec.discrepancyFlag, false);
    assert.equal(rec.status, 'matched');

    assert.deepEqual(out.r01, { original: true, tampered: false });
  });
});
