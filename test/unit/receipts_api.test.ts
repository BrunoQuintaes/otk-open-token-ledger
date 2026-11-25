/**
 * PACK D — Receipt API endpoint tests
 *
 * Tests POST /receipts, GET /receipts/:id, POST /admin/flush-batch
 * using the same in-process mock pattern as api_routes_smoke.test.ts.
 *
 * Modules under test: `src/api/routes.ts` and `src/api/receiptStore.ts`.
 *
 * Strategy / partitions: a valid receipt (201); invalid JSON and missing required fields (400); reading a
 * stored receipt and an unknown id (404); the batch flush returns the count of stored receipts.
 *
 * Needs: nothing external; requests and responses are in-memory mocks and the store is emptied first.
 *
 * Run just this file: `npx tsx --test test/unit/receipts_api.test.ts`
 *
 * @module test/unit/receipts_api.test
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';
import { flushAll } from '../../src/api/receiptStore.js';

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as api_routes_smoke.test.ts)
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string, body = ''): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url }) as unknown as IncomingMessage;
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

const VALID_RECEIPT = JSON.stringify({
  requestId: 'req-test-001',
  provider: 'openai',
  model: 'gpt-4',
  inputTokens: 100,
  outputTokens: 50,
  costUnits: 150,
  latencyMs: 320,
  timestamp: 1741305600,
  userId: '42',
  nonce: '1',
  tenantId: 'tenant-acme',
});

// Reset store before each group to keep tests isolated
before(() => { flushAll(); });

// ---------------------------------------------------------------------------
// POST /receipts
// ---------------------------------------------------------------------------

describe('POST /receipts — success', () => {
  it('returns 201 with requestId on valid receipt', async () => {
    flushAll();
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', VALID_RECEIPT), res);
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.requestId, 'req-test-001');
    assert.equal(typeof body.costUnits, 'number');
  });
});

describe('POST /receipts — validation', () => {
  it('returns 400 on invalid JSON', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', 'not-json'), res);
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'invalid_json');
  });

  it('returns 400 when required fields are missing', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', JSON.stringify({ provider: 'openai' })), res);
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'missing_required_fields');
  });
});

// ---------------------------------------------------------------------------
// GET /receipts/:id
// ---------------------------------------------------------------------------

describe('GET /receipts/:id — success', () => {
  it('returns stored receipt by requestId', async () => {
    flushAll();
    // Store first
    const storeRes = mockRes();
    await handleRequest(mockReq('POST', '/receipts', VALID_RECEIPT), storeRes);
    assert.equal(storeRes.statusCode, 201);

    // Retrieve
    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/req-test-001'), getRes);
    assert.equal(getRes.statusCode, 200);
    const body = JSON.parse(getRes.body);
    assert.equal(body.ok, true);
    assert.equal(body.receipt.requestId, 'req-test-001');
    assert.equal(body.receipt.provider, 'openai');
    assert.equal(body.receipt.model, 'gpt-4');
    assert.equal(typeof body.receipt.userId, 'string'); // bigint serialized as string
    assert.equal(body.receipt.tenantId, 'tenant-acme');
    // PA-02: proofStatus always present; 'unknown' because daemon not running in unit tests
    assert.ok(['pending', 'unknown', 'disabled'].includes(body.proofStatus),
      `unexpected proofStatus: ${body.proofStatus}`);
  });

  it('returns 404 for unknown requestId', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/receipts/does-not-exist'), res);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'not_found');
  });
});

// ---------------------------------------------------------------------------
// POST /admin/flush-batch
// ---------------------------------------------------------------------------

describe('POST /admin/flush-batch', () => {
  it('flushes all stored receipts and returns count', async () => {
    flushAll();
    // Store two receipts
    for (const id of ['req-flush-a', 'req-flush-b']) {
      const payload = JSON.stringify({ requestId: id, provider: 'anthropic', model: 'claude-opus-4', inputTokens: 10, outputTokens: 5 });
      await handleRequest(mockReq('POST', '/receipts', payload), mockRes());
    }

    const res = mockRes();
    await handleRequest(mockReq('POST', '/admin/flush-batch'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.flushed, 2);

    // Store is now empty
    const getRes = mockRes();
    await handleRequest(mockReq('GET', '/receipts/req-flush-a'), getRes);
    assert.equal(getRes.statusCode, 404);
  });
});
