/**
 * PA-02 — proofStatus Tests
 *
 * Covers:
 *   - proofStatus: 'disabled' when PROVER_URL=disabled
 *   - proofStatus: 'unknown' when no dispatch occurred (no jobId)
 *   - proofStatus: 'pending'   when job status = pending/processing
 *   - proofStatus: 'proved'    when job status = done
 *   - proofStatus: 'failed'    when job status = dead_letter
 *   - proofStatus returned by GET /receipts/:id
 *
 * Uses an inline stub HTTP server as mock ProverDaemon.
 * Avoids starting a real ProverDaemon; controls job status per-test.
 *
 * @since PA-02 (2026-03-12)
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';
import { flushAll, resetProverStateForTest, getProofStatus, awaitLastDispatch } from '../../src/api/receiptStore.js';

// ---------------------------------------------------------------------------
// Inline stub ProverDaemon
// ---------------------------------------------------------------------------

let stubServer: Server;
let stubPort: number;
// Mutable — per-test control of what GET /status/:jobId returns
let _stubJobStatus = 'pending';
const STUB_JOB_ID = 'pa02-test-job-1';

function startStub(): Promise<void> {
  return new Promise((resolve) => {
    stubServer = createServer((req, res) => {
      const url = req.url ?? '';
      // POST /prove → 202 { jobId }
      if (req.method === 'POST' && url === '/prove') {
        let body = '';
        req.on('data', (c: Buffer | string) => { body += c; });
        req.on('end', () => {
          void body; // consumed but not needed
          res.writeHead(202, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ jobId: STUB_JOB_ID, status: 'pending' }));
        });
        return;
      }
      // GET /status/:jobId → { jobId, status, attempts }
      if (req.method === 'GET' && url.startsWith('/status/')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          jobId: STUB_JOB_ID,
          status: _stubJobStatus,
          attempts: 1,
          ...(  _stubJobStatus === 'dead_letter' ? { error: 'max retries exceeded' } : {}),
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

// ---------------------------------------------------------------------------
// Mock HTTP helpers (same pattern as receipts_api.test.ts)
// ---------------------------------------------------------------------------

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
  requestId: 'pa02-req-001',
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

/** Store a receipt via POST and wait for async dispatch to settle. */
async function storeAndAwaitDispatch(): Promise<void> {
  const res = mockRes();
  await handleRequest(mockReq('POST', '/receipts', RECEIPT_PAYLOAD), res);
  assert.equal(res.statusCode, 201);
  // Deterministic: await the actual dispatch promise (no flaky setTimeout)
  await awaitLastDispatch();
}

// ---------------------------------------------------------------------------
// Suite A — proofStatus: 'disabled' (PROVER_URL=disabled)
// ---------------------------------------------------------------------------

describe('proofStatus — disabled', () => {
  before(() => {
    flushAll();
    resetProverStateForTest();
    process.env['PROVER_URL'] = 'disabled';
  });

  after(() => {
    delete process.env['PROVER_URL'];
  });

  it('GET /receipts/:id returns proofStatus=disabled when PROVER_URL=disabled', async () => {
    // Store receipt (dispatch no-ops when disabled)
    const storeRes = mockRes();
    await handleRequest(mockReq('POST', '/receipts', RECEIPT_PAYLOAD), storeRes);
    assert.equal(storeRes.statusCode, 201);

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa02-req-001'), getRes);
    assert.equal(getRes.statusCode, 200);
    const body = JSON.parse(getRes.body);
    assert.equal(body.ok, true);
    assert.equal(body.proofStatus, 'disabled');
    assert.equal(body.jobId, undefined, 'no jobId when disabled');
  });

  it('getProofStatus returns disabled directly', async () => {
    const result = await getProofStatus('any-request-id');
    assert.equal(result.proofStatus, 'disabled');
  });
});

// ---------------------------------------------------------------------------
// Suite B — proofStatus: 'unknown' (no dispatch / daemon unreachable)
// ---------------------------------------------------------------------------

describe('proofStatus — unknown', () => {
  before(() => {
    flushAll();
    resetProverStateForTest();
    // Point at a port that is not listening
    process.env['PROVER_URL'] = 'http://127.0.0.1:19999';
  });

  after(() => {
    delete process.env['PROVER_URL'];
  });

  it('GET /receipts/:id returns proofStatus=unknown when daemon unreachable', async () => {
    const storeRes = mockRes();
    await handleRequest(mockReq('POST', '/receipts', RECEIPT_PAYLOAD), storeRes);
    assert.equal(storeRes.statusCode, 201);
    await awaitLastDispatch();

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa02-req-001'), getRes);
    assert.equal(getRes.statusCode, 200);
    const body = JSON.parse(getRes.body);
    assert.equal(body.ok, true);
    assert.equal(body.proofStatus, 'unknown');
  });

  it('getProofStatus returns unknown when no jobId in map', async () => {
    const result = await getProofStatus('nonexistent-request-id');
    assert.equal(result.proofStatus, 'unknown');
    assert.equal(result.jobId, undefined);
  });
});

// ---------------------------------------------------------------------------
// Suite C — proofStatus with stub ProverDaemon (pending/proved/failed)
// ---------------------------------------------------------------------------

describe('proofStatus — stub ProverDaemon', () => {
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
    _stubJobStatus = 'pending'; // reset per test
  });

  it('proofStatus=pending when job.status=pending', async () => {
    _stubJobStatus = 'pending';
    await storeAndAwaitDispatch();

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa02-req-001'), getRes);
    const body = JSON.parse(getRes.body);
    assert.equal(body.proofStatus, 'pending');
    assert.equal(body.jobId, STUB_JOB_ID);
  });

  it('proofStatus=pending when job.status=processing', async () => {
    _stubJobStatus = 'processing';
    await storeAndAwaitDispatch();

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa02-req-001'), getRes);
    const body = JSON.parse(getRes.body);
    assert.equal(body.proofStatus, 'pending');
  });

  it('proofStatus=proved when job.status=done', async () => {
    _stubJobStatus = 'done';
    await storeAndAwaitDispatch();

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa02-req-001'), getRes);
    const body = JSON.parse(getRes.body);
    assert.equal(body.proofStatus, 'proved');
    assert.equal(body.jobId, STUB_JOB_ID);
  });

  it('proofStatus=failed when job.status=dead_letter', async () => {
    _stubJobStatus = 'dead_letter';
    await storeAndAwaitDispatch();

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa02-req-001'), getRes);
    const body = JSON.parse(getRes.body);
    assert.equal(body.proofStatus, 'failed');
    assert.equal(body.jobId, STUB_JOB_ID);
    assert.equal(body.proofError, 'max retries exceeded');
  });

  it('proofAttempts present when daemon reports attempts', async () => {
    _stubJobStatus = 'pending';
    await storeAndAwaitDispatch();

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa02-req-001'), getRes);
    const body = JSON.parse(getRes.body);
    assert.equal(body.proofAttempts, 1);
  });

  it('receipt fields still correct alongside proofStatus', async () => {
    _stubJobStatus = 'done';
    await storeAndAwaitDispatch();

    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/pa02-req-001'), getRes);
    assert.equal(getRes.statusCode, 200);
    const body = JSON.parse(getRes.body);
    assert.equal(body.ok, true);
    assert.equal(body.receipt.requestId, 'pa02-req-001');
    assert.equal(body.receipt.provider, 'openai');
    assert.equal(typeof body.receipt.userId, 'string');
    assert.equal(body.proofStatus, 'proved');
  });
});
