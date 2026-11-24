/**
 * PA-03 — txHash propagation tests
 *
 * Covers:
 *   - DurableProofJob.txHash set by complete(id, result, txHash)
 *   - GET /status/:jobId includes txHash when present
 *   - GET /receipts/:id includes txHash when ProverDaemon reports it
 *   - txHash absent when not set (no spurious field)
 *
 * Uses inline stub ProverDaemon (same pattern as proof_status.test.ts).
 *
 * @since PA-03 (2026-03-12)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';
import { flushAll, resetProverStateForTest, awaitLastDispatch } from '../../src/api/receiptStore.js';
import { DurableProofQueue } from '../../src/prover/DurableProofQueue.js';
import type { ProofResult } from '../../src/prover/ProofQueue.js';

// ---------------------------------------------------------------------------
// DurableProofQueue unit tests — txHash propagation
// ---------------------------------------------------------------------------

describe('DurableProofQueue — txHash', () => {
  it('complete() stores txHash in job', () => {
    const q = new DurableProofQueue(null);
    const id = q.enqueue({
      userId: '1', usage: '100', nonce: '7', epoch: '202401',
      circuitVersion: 'v1', maxUsage: '200000',
    });
    q.dequeue(); // → processing
    const fakeResult: ProofResult = {
      proof: { pi_a: ['1', '2', '0'], pi_b: [['1', '2'], ['3', '4']], pi_c: ['5', '6', '0'], protocol: 'groth16', curve: 'bn128' },
      publicSignals: ['100', '202401', '200000'],
      proveMs: 10,
    };
    q.complete(id, fakeResult, '0xdeadbeef');
    const job = q.get(id);
    assert.ok(job, 'job should exist');
    assert.equal(job.status, 'done');
    assert.equal(job.txHash, '0xdeadbeef');
  });

  it('complete() without txHash leaves txHash undefined', () => {
    const q = new DurableProofQueue(null);
    const id = q.enqueue({
      userId: '2', usage: '50', nonce: '3', epoch: '202401',
      circuitVersion: 'v1', maxUsage: '100000',
    });
    q.dequeue();
    const fakeResult: ProofResult = {
      proof: { pi_a: ['1', '2', '0'], pi_b: [['1', '2'], ['3', '4']], pi_c: ['5', '6', '0'], protocol: 'groth16', curve: 'bn128' },
      publicSignals: ['50', '202401', '100000'],
      proveMs: 5,
    };
    q.complete(id, fakeResult);
    const job = q.get(id);
    assert.ok(job);
    assert.equal(job.status, 'done');
    assert.equal(job.txHash, undefined);
  });
});

// ---------------------------------------------------------------------------
// Stub ProverDaemon — GET /status includes txHash
// ---------------------------------------------------------------------------

let stubServer: Server;
let stubPort: number;
let _stubJobStatus = 'done';
let _stubTxHash: string | undefined = undefined;
const STUB_JOB_ID = 'pa03-test-job-1';

function startStub(): Promise<void> {
  return new Promise((resolve) => {
    stubServer = createServer((req, res) => {
      const url = req.url ?? '';
      if (req.method === 'POST' && url === '/prove') {
        let body = '';
        req.on('data', (c: Buffer | string) => { body += c; });
        req.on('end', () => {
          void body;
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jobId: STUB_JOB_ID, status: 'pending' }));
        });
        return;
      }
      if (req.method === 'GET' && url.startsWith('/status/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jobId: STUB_JOB_ID,
          status: _stubJobStatus,
          attempts: 1,
          ...(_stubTxHash ? { txHash: _stubTxHash } : {}),
        }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    stubServer.listen(0, '127.0.0.1', () => {
      stubPort = (stubServer.address() as { port: number }).port;
      resolve();
    });
  });
}

function stopStub(): Promise<void> {
  return new Promise((resolve) => stubServer.close(() => resolve()));
}

function mockReq(method: string, url: string, body = ''): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers: {} }) as unknown as IncomingMessage;
  process.nextTick(() => {
    if (body) em.emit('data', Buffer.from(body));
    em.emit('end');
  });
  return req;
}

type MockRes = ServerResponse & { body: string };

function mockRes(): MockRes {
  let body = '';
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (data: string) => { body = data; },
    get body() { return body; },
  } as unknown as MockRes;
  return res;
}

const RECEIPT_PAYLOAD = JSON.stringify({
  requestId: 'pa03-req-001',
  provider: 'openai',
  model: 'gpt-4',
  inputTokens: 100,
  outputTokens: 50,
  costUnits: 150,
  latencyMs: 320,
  timestamp: 1741305600,
  userId: '42',
  nonce: '99',
});

async function storeAndAwaitDispatch(): Promise<void> {
  const res = mockRes();
  await handleRequest(mockReq('POST', '/receipts', RECEIPT_PAYLOAD), res);
  assert.equal(res.statusCode, 201);
  // Deterministic: await the actual dispatch promise (no flaky setTimeout)
  await awaitLastDispatch();
}

describe('PA-03 — txHash in GET /receipts/:id', () => {
  before(async () => {
    await startStub();
  });

  after(async () => {
    delete process.env['PROVER_URL'];
    await stopStub();
  });

  beforeEach(() => {
    flushAll();
    resetProverStateForTest();
    process.env['PROVER_URL'] = `http://127.0.0.1:${stubPort}`;
    _stubJobStatus = 'done';
    _stubTxHash = undefined;
  });

  it('txHash present in GET /receipts/:id when daemon reports txHash', async () => {
    _stubJobStatus = 'done';
    _stubTxHash = '0xabc123def456';
    await storeAndAwaitDispatch();

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa03-req-001'), getRes);
    assert.equal(getRes.statusCode, 200);
    const body = JSON.parse(getRes.body);
    assert.equal(body.ok, true);
    assert.equal(body.proofStatus, 'proved');
    assert.equal(body.txHash, '0xabc123def456');
  });

  it('txHash absent when daemon does not report txHash', async () => {
    _stubJobStatus = 'done';
    _stubTxHash = undefined;
    await storeAndAwaitDispatch();

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa03-req-001'), getRes);
    const body = JSON.parse(getRes.body);
    assert.equal(body.proofStatus, 'proved');
    assert.equal(body.txHash, undefined, 'txHash should be absent when daemon does not report it');
  });

  it('txHash absent when proof is still pending', async () => {
    _stubJobStatus = 'pending';
    _stubTxHash = undefined;
    await storeAndAwaitDispatch();

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa03-req-001'), getRes);
    const body = JSON.parse(getRes.body);
    assert.equal(body.proofStatus, 'pending');
    assert.equal(body.txHash, undefined);
  });

  it('receipt core fields intact alongside txHash', async () => {
    _stubJobStatus = 'done';
    _stubTxHash = '0xfeedcafe';
    await storeAndAwaitDispatch();

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa03-req-001'), getRes);
    assert.equal(getRes.statusCode, 200);
    const body = JSON.parse(getRes.body);
    assert.equal(body.ok, true);
    assert.equal(body.receipt.requestId, 'pa03-req-001');
    assert.equal(body.receipt.provider, 'openai');
    assert.equal(body.proofStatus, 'proved');
    assert.equal(body.txHash, '0xfeedcafe');
  });
});
