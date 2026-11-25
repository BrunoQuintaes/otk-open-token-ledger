/**
 * R14 / RV05 — pending proofs are retried by the server lifecycle, without client traffic.
 *
 * Real API server (src/api/server.ts, child process) with JSONL persistence; the
 * ProverDaemon is a local HTTP stub that the test switches between down and up.
 * Before RV05 nothing called retryPendingProofs(): pending receipts waited for a new
 * receipt to arrive, also after a restart.
 *
 * Not exercised: PostgreSQL, Redis, a real prover, chain.
 *
 * Strategy / scenarios (in order, sharing one API process across the two cases): receipts accepted while the prover
 * is down are sent by the NEXT server process after a restart, with no client request, each exactly once, and both
 * proof-job correlations are persisted; then the prover goes down and comes back while the server keeps running,
 * and the pending receipt is sent by the recovery loop without new traffic, never twice.
 *
 * Needs: two free 127.0.0.1 ports (API child and prover stub), a temporary directory for the receipt log, `tsx`
 * for the child, and a few seconds of wall-clock waits. The child gets `NODE_ENV`, `OTK_TENANTS`, `OTK_ADMIN_KEY`,
 * `OTK_RECEIPT_LOG`, `PROVER_URL`, `PROVER_CB_THRESHOLD`, `PROVER_CB_COOLDOWN_MS` and `PROVER_RECOVERY_INTERVAL_MS`
 * (100 ms) set to fixture values; `OTK_DB_URL` and `OTK_REDIS_URL` are removed. No external network.
 *
 * Run just this file: `npx tsx --test test/integration/prover_recovery_restart_rv05.test.ts`
 *
 * @module test/integration/prover_recovery_restart_rv05.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawnApi, stopApi, waitReady, type ApiChild } from './fixtures/apiChild.js';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import net from 'node:net';
import path from 'node:path';

const TOKEN = 'rv05-fixture-token';

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
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(`timeout waiting for ${what}`);
}

describe('RV05 — recovery loop bound to the server lifecycle', () => {
  let stub: Server;
  let api: ApiChild | undefined;
  let apiPort: number;
  let env: NodeJS.ProcessEnv;
  let receiptLog: string;
  let proverUp = false;
  const proveCalls: string[] = [];              // "userId:nonce" per POST /prove
  const accepted = new Map<string, number>();   // "userId:nonce" → times accepted

  const base = () => `http://127.0.0.1:${apiPort}`;
  const post = (requestId: string, nonce: number) => fetch(`${base()}/receipts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ requestId, provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 5,
      costUnits: 15, latencyMs: 1, timestamp: 1700000000, userId: '5', nonce: String(nonce) }),
  });

  before(async () => {
    const stubPort = await getFreePort();
    apiPort = await getFreePort();
    stub = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/prove') { res.writeHead(404); res.end(); return; }
      let b = '';
      req.on('data', c => { b += String(c); });
      req.on('end', () => {
        const { userId, nonce } = JSON.parse(b) as { userId: string; nonce: string };
        const key = `${userId}:${nonce}`;
        proveCalls.push(key);
        if (!proverUp) { res.writeHead(503); res.end('{}'); return; }
        accepted.set(key, (accepted.get(key) ?? 0) + 1);
        res.writeHead(202, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jobId: `stub-${key.replace(':', '-')}`, status: 'pending' }));
      });
    });
    await new Promise<void>(r => stub.listen(stubPort, '127.0.0.1', () => r()));
    receiptLog = path.join(mkdtempSync(path.join(tmpdir(), 'otk-rv05-')), 'receipts.jsonl');
    env = { ...process.env };
    delete env['OTK_DB_URL'];
    delete env['OTK_REDIS_URL'];
    Object.assign(env, {
      NODE_ENV: 'test',
      OTK_TENANTS: `tenant-rv05/OPERATOR:${TOKEN}`,
      OTK_ADMIN_KEY: 'itest-admin-fixture',
      OTK_RECEIPT_LOG: receiptLog,
      PROVER_URL: `http://127.0.0.1:${stubPort}`,
      PROVER_CB_THRESHOLD: '2',
      PROVER_CB_COOLDOWN_MS: '200',
      PROVER_RECOVERY_INTERVAL_MS: '100',
    });
  });

  after(async () => {
    await stopApi(api);
    await new Promise<void>(r => stub.close(() => r()));
  });

  it('receipts left pending by a stopped server are sent by the next one, with no client request', async () => {
    api = spawnApi(apiPort, env);
    try {
      await waitReady(api, 'rv05 API #1');
      assert.equal((await post('rv05-1', 1)).status, 201);
      assert.equal((await post('rv05-2', 2)).status, 201);
      await waitFor(() => proveCalls.length >= 2, 5000, 'failed prove attempts');
      assert.equal(accepted.size, 0);
    } finally { await stopApi(api); }

    proverUp = true;
    const callsBeforeRestart = proveCalls.length;
    api = spawnApi(apiPort, env);
    // the server stays up for the next case only if it became ready; otherwise it is stopped here (no orphan)
    try { await waitReady(api, 'rv05 API #2'); } catch (err) { await stopApi(api); throw err; }
    // No POST from here on: only the recovery loop can reach the prover.
    await waitFor(() => accepted.has('5:1') && accepted.has('5:2'), 10000, 'pending receipts accepted after restart');
    assert.ok(proveCalls.length > callsBeforeRestart);
    assert.equal(accepted.get('5:1'), 1);
    assert.equal(accepted.get('5:2'), 1);
    // OVERNIGHT 20261005 (F-P1-08): the stub counts a receipt as accepted when it SENDS its 202; the server appends the
    // correlation after it RECEIVES it. Reading the file at once raced that write (gate 1 run 1 on 681f8e4: 1 !== 2).
    const jobLines = () => { try { return readFileSync(receiptLog + '.jobs', 'utf-8').split('\n').filter(Boolean); } catch { return []; } };
    await waitFor(() => jobLines().length >= 2, 10000, 'both correlations written');
    const jobs = jobLines();
    assert.equal(jobs.length, 2, 'both correlations persisted');
  });

  it('prover goes down and comes back while the server runs: pending sent without new traffic, none twice', async () => {
    proverUp = false;
    assert.equal((await post('rv05-3', 3)).status, 201);
    await waitFor(() => proveCalls.includes('5:3'), 5000, 'failed attempt for receipt 3');
    await new Promise(r => setTimeout(r, 500)); // loop keeps trying; breaker opens
    proverUp = true;
    await waitFor(() => accepted.has('5:3'), 10000, 'receipt 3 accepted without new traffic');
    await new Promise(r => setTimeout(r, 400)); // a few more loop ticks
    for (const [key, n] of accepted) assert.equal(n, 1, `${key} accepted once`);
    await stopApi(api);
  });
});
