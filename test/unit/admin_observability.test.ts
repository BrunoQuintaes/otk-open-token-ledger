/**
 * GAP-D-004 — Admin observability endpoints test
 *
 * Tests:
 *   - GET /admin/chain-head: returns chainHead hash + auditEntryCount
 *   - GET /admin/tal-summary: returns totalEntries; with ?tenantId&epochId returns balance
 *   - Admin auth: 401 when OTK_ADMIN_KEY set but x-admin-key missing/wrong
 *   - GET /admin/chain-head: chain head changes after storeReceipt
 *
 * These endpoints close GAP-C-004 (admin observability).
 *
 * Modules under test: `handleRequest` in `src/api/routes.ts` for the two admin read endpoints,
 * with `src/api/receiptStore.ts` (stored receipts move the audit chain head) and the token
 * accounting layer from `src/security/talRuntime.ts`.
 *
 * Strategy / partitions: admin key not configured (open), configured with the header missing,
 * wrong and correct; chain head before and after a stored receipt; the accounting summary
 * without parameters, after a debit, and for one tenant and epoch.
 *
 * Needs: no server (mock request/response objects). Sets and deletes `OTK_ADMIN_KEY` in
 * `process.env` in its hooks; the stores are flushed before and after the file.
 *
 * Run just this file: `npx tsx --test test/unit/admin_observability.test.ts`
 *
 * @module test/unit/admin_observability.test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';
import { flushAll, storeReceipt, chainHead } from '../../src/api/receiptStore.js';
import { clearRegistry } from '../../src/api/tenantKeyRegistry.js';
import { getAccountingLayer } from '../../src/security/talRuntime.js';
import { deriveEpoch } from '../../src/types/receipt.js';
import type { RawReceipt } from '../../src/types/receipt.js';

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as existing tests)
// ---------------------------------------------------------------------------

function mockReq(
  method: string,
  url: string,
  body = '',
  headers: Record<string, string> = {},
): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers }) as unknown as IncomingMessage;
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

const SAMPLE_RECEIPT: RawReceipt = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5-20251001',
  inputTokens: 200,
  outputTokens: 100,
  costUnits: 300,
  latencyMs: 150,
  timestamp: 1741305600,
  requestId: 'admin-obs-001',
  userId: 42n,
  nonce: 1n,
  tenantId: 'tenant-obs',
};

before(() => {
  flushAll();
  clearRegistry();
  // Ensure OTK_ADMIN_KEY is not set (clean state for open-admin tests)
  delete process.env['OTK_ADMIN_KEY'];
});

after(() => {
  flushAll();
  delete process.env['OTK_ADMIN_KEY'];
});

// ---------------------------------------------------------------------------
// GET /admin/chain-head
// ---------------------------------------------------------------------------

describe('GET /admin/chain-head — baseline (no admin key)', () => {
  it('returns 200 with chainHead and auditEntryCount when no admin key configured', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/chain-head'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.chainHead, 'string', 'chainHead must be a string');
    assert.equal(body.chainHead.length, 64, 'chainHead must be 64-char hex');
    assert.equal(typeof body.auditEntryCount, 'number');
    assert.ok(typeof body.ts === 'string', 'ts must be ISO string');
  });

  it('chainHead changes after storeReceipt', async () => {
    const before = chainHead();

    storeReceipt({ ...SAMPLE_RECEIPT, requestId: 'chain-head-test-001' });

    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/chain-head'), res);
    const body = JSON.parse(res.body);
    assert.notEqual(body.chainHead, before, 'chainHead must change after storeReceipt');
    assert.ok(body.auditEntryCount >= 1, 'auditEntryCount must be >= 1 after store');
  });
});

describe('GET /admin/chain-head — admin key enforcement', () => {
  before(() => { process.env['OTK_ADMIN_KEY'] = 'test-admin-secret'; });
  after(() => { delete process.env['OTK_ADMIN_KEY']; });

  it('returns 401 when x-admin-key missing', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/chain-head'), res);
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'unauthorized');
  });

  it('returns 401 when x-admin-key is wrong', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/chain-head', '', { 'x-admin-key': 'wrong-key' }), res);
    assert.equal(res.statusCode, 401);
  });

  it('returns 200 when x-admin-key is correct', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('GET', '/admin/chain-head', '', { 'x-admin-key': 'test-admin-secret' }),
      res,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.chainHead.length, 64);
  });
});

// ---------------------------------------------------------------------------
// GET /admin/tal-summary
// ---------------------------------------------------------------------------

describe('GET /admin/tal-summary — summary without params', () => {
  it('returns 200 with totalEntries and hint when no tenantId/epochId', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/tal-summary'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.totalEntries, 'number', 'totalEntries must be number');
    assert.ok(typeof body.hint === 'string', 'hint must be present when no params');
    assert.ok(typeof body.ts === 'string');
  });

  it('totalEntries reflects TAL state after debit', async () => {
    // Directly debit the TAL
    const tal = getAccountingLayer();
    const epochId = String(deriveEpoch(SAMPLE_RECEIPT.timestamp));
    tal.debit({
      tenantId: 'tenant-obs-direct',
      epochId,
      requestId: 'tal-summary-direct-001',
      provider: 'openai',
      model: 'gpt-4',
      cu: 99n,
      ts: Date.now(),
    });

    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/tal-summary'), res);
    const body = JSON.parse(res.body);
    assert.ok(body.totalEntries >= 1, `totalEntries=${body.totalEntries} must be >= 1 after debit`);
  });
});

describe('GET /admin/tal-summary — with tenantId+epochId params', () => {
  it('returns balance for specific tenant/epoch', async () => {
    const tal = getAccountingLayer();
    const epochId = String(deriveEpoch(SAMPLE_RECEIPT.timestamp));
    const tenantId = 'tenant-summary-test';

    // Debit 3 entries for this tenant
    for (let i = 0; i < 3; i++) {
      tal.debit({
        tenantId,
        epochId,
        requestId: `summary-req-${i}`,
        provider: 'openai',
        model: 'gpt-4',
        cu: 100n,
        ts: Date.now(),
      });
    }

    const res = mockRes();
    await handleRequest(
      mockReq('GET', `/admin/tal-summary?tenantId=${tenantId}&epochId=${epochId}`),
      res,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(body.balance, 'balance must be present when params provided');
    assert.equal(body.balance.tenantId, tenantId);
    assert.equal(body.balance.epochId, epochId);
    assert.equal(body.balance.totalCU, '300', 'totalCU must be 300 (3x100)');
    assert.equal(body.balance.entryCount, 3);
  });
});

describe('GET /admin/tal-summary — admin key enforcement', () => {
  before(() => { process.env['OTK_ADMIN_KEY'] = 'summary-admin-key'; });
  after(() => { delete process.env['OTK_ADMIN_KEY']; });

  it('returns 401 when admin key missing', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/admin/tal-summary'), res);
    assert.equal(res.statusCode, 401);
  });

  it('returns 200 when admin key correct', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('GET', '/admin/tal-summary', '', { 'x-admin-key': 'summary-admin-key' }),
      res,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
  });
});
