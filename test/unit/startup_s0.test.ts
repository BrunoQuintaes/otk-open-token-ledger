/**
 * STARTUP.S0 — Canonical Integrity Tests
 *
 * Tests for:
 * 1. requestId idempotency at ingestion (200 vs 201, no double side-effects)
 * 2. cwVersion stamped on receipt and present in GET response
 * 3. canonicalHash binding includes cwVersion field
 *
 * @since STARTUP.S0_CANONICAL_INTEGRITY (2026-03-08)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';
import { flushAll } from '../../src/api/receiptStore.js';
import { canonicalHash } from '../../src/metering/SignatureManager.js';
import type { RawReceipt } from '../../src/types/receipt.js';

// ---------------------------------------------------------------------------
// Mock helpers
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

const BASE_RECEIPT = {
  requestId: 's0-idem-test-001',
  provider: 'openai',
  model: 'gpt-4o',
  inputTokens: 100,
  outputTokens: 50,
  costUnits: 150,
  latencyMs: 320,
  timestamp: 1741305600,
  userId: '42',
  nonce: '7',
};

before(() => { flushAll(); });

// ---------------------------------------------------------------------------
// 1. Idempotency — HTTP contract
// ---------------------------------------------------------------------------

describe('STARTUP.S0 — requestId idempotency: HTTP contract', () => {
  it('first POST returns 201 with duplicate:false', async () => {
    flushAll();
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', JSON.stringify({ ...BASE_RECEIPT, requestId: 's0-first-001' })), res);
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.duplicate, false);
    assert.equal(body.requestId, 's0-first-001');
  });

  it('duplicate POST with same requestId returns 200 with duplicate:true', async () => {
    flushAll();
    const payload = JSON.stringify({ ...BASE_RECEIPT, requestId: 's0-dup-001' });
    // First POST
    const res1 = mockRes();
    await handleRequest(mockReq('POST', '/receipts', payload), res1);
    assert.equal(res1.statusCode, 201);
    // Second POST (same requestId)
    const res2 = mockRes();
    await handleRequest(mockReq('POST', '/receipts', payload), res2);
    assert.equal(res2.statusCode, 200);
    const body2 = JSON.parse(res2.body);
    assert.equal(body2.ok, true);
    assert.equal(body2.duplicate, true);
    assert.equal(body2.requestId, 's0-dup-001');
  });

  it('third duplicate POST also returns 200 with duplicate:true (consistent)', async () => {
    flushAll();
    const payload = JSON.stringify({ ...BASE_RECEIPT, requestId: 's0-dup-triple-001' });
    await handleRequest(mockReq('POST', '/receipts', payload), mockRes()); // 201
    await handleRequest(mockReq('POST', '/receipts', payload), mockRes()); // 200
    const res3 = mockRes();
    await handleRequest(mockReq('POST', '/receipts', payload), res3);      // 200
    assert.equal(res3.statusCode, 200);
    assert.equal(JSON.parse(res3.body).duplicate, true);
  });
});

// ---------------------------------------------------------------------------
// 2. Idempotency — no double billing (TAL side-effect guard)
// ---------------------------------------------------------------------------

describe('STARTUP.S0 — requestId idempotency: no double TAL debit', () => {
  it('duplicate POST does not increase accounting balance', async () => {
    flushAll();
    const requestId = 's0-tal-dedup-001';
    const payload = JSON.stringify({ ...BASE_RECEIPT, requestId, costUnits: 100, tenantId: 's0-tenant' });

    // First POST — debit 100 CU
    await handleRequest(mockReq('POST', '/receipts', payload), mockRes());

    // Read balance after first POST
    const bal1Res = mockRes();
    await handleRequest(mockReq('GET', `/accounting/balance?tenantId=s0-tenant&epochId=483696`), bal1Res);
    const bal1 = JSON.parse(bal1Res.body);

    // Duplicate POST — must NOT debit again
    await handleRequest(mockReq('POST', '/receipts', payload), mockRes());

    const bal2Res = mockRes();
    await handleRequest(mockReq('GET', `/accounting/balance?tenantId=s0-tenant&epochId=483696`), bal2Res);
    const bal2 = JSON.parse(bal2Res.body);

    // Balance must be identical after duplicate
    assert.equal(bal2.totalCU, bal1.totalCU, 'TAL must not double-charge on duplicate requestId');
    assert.equal(bal2.entryCount, bal1.entryCount, 'TAL entry count must not increase on duplicate');
  });
});

// ---------------------------------------------------------------------------
// 3. cwVersion — stamped on receipt and present in GET response
// ---------------------------------------------------------------------------

describe('STARTUP.S0 — cwVersion stamped at ingestion', () => {
  it('GET /receipts/:id returns cwVersion field (string)', async () => {
    flushAll();
    const requestId = 's0-cwv-001';
    await handleRequest(
      mockReq('POST', '/receipts', JSON.stringify({ ...BASE_RECEIPT, requestId })),
      mockRes(),
    );

    const getRes = mockRes();
    await handleRequest(mockReq('GET', `/receipts/${requestId}`), getRes);
    assert.equal(getRes.statusCode, 200);
    const body = JSON.parse(getRes.body);
    assert.ok('cwVersion' in body.receipt, 'receipt must contain cwVersion field');
    assert.equal(typeof body.receipt.cwVersion, 'string', 'cwVersion must be a string');
    // Without OTK_CW_JSON_FILE configured in test env, value must be 'static'
    assert.equal(body.receipt.cwVersion, 'static', 'cwVersion must be "static" when no CW JSON loaded');
  });
});

// ---------------------------------------------------------------------------
// 4. canonicalHash — cwVersion included in binding
// ---------------------------------------------------------------------------

describe('STARTUP.S0 — canonicalHash includes cwVersion binding', () => {
  const base: RawReceipt = {
    provider: 'openai',
    model: 'gpt-4o',
    inputTokens: 100,
    outputTokens: 50,
    costUnits: 150,
    latencyMs: 200,
    timestamp: 1741305600,
    requestId: 'hash-test-001',
    userId: 1n,
    nonce: 1n,
  };

  it('canonicalHash is deterministic regardless of cwVersion', () => {
    const h1 = canonicalHash({ ...base, cwVersion: 'static' });
    const h2 = canonicalHash({ ...base, cwVersion: 'static' });
    assert.equal(h1, h2, 'hash must be deterministic for same cwVersion');
  });

  it('canonicalHash differs when cwVersion differs', () => {
    const hStatic = canonicalHash({ ...base, cwVersion: 'static' });
    const h200   = canonicalHash({ ...base, cwVersion: '2.0.0' });
    const h100   = canonicalHash({ ...base, cwVersion: '1.0.0' });
    assert.notEqual(hStatic, h200, 'hash must differ for different cwVersion');
    assert.notEqual(h200, h100, 'hash must differ between cwVersion 1.0.0 and 2.0.0');
  });

  it('canonicalHash with undefined cwVersion equals cwVersion:"none" sentinel', () => {
    const hUndefined = canonicalHash({ ...base });                    // no cwVersion field
    const hNone      = canonicalHash({ ...base, cwVersion: 'none' }); // explicit 'none'
    assert.equal(hUndefined, hNone, 'undefined cwVersion must hash identically to "none" sentinel');
  });

  it('canonicalHash with cwVersion differs from hash without (protocol version bump)', () => {
    const hOld = canonicalHash({ ...base });                      // pre-S0 receipt (no cwVersion)
    const hNew = canonicalHash({ ...base, cwVersion: 'static' }); // post-S0 receipt
    assert.notEqual(hOld, hNew, 'pre-S0 and post-S0 hashes must be distinguishable');
  });
});
