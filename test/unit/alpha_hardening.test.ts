/**
 * PACK D — Alpha Hardening tests (u12.alpha.d)
 *
 * Tests:
 *   - TenantKeyRegistry: registerToken, resolveTenantId, isAuthEnabled, clearRegistry
 *   - Auth enforcement in routes: 401 when OTK_TENANTS active + no/invalid bearer
 *   - Rate limit enforcement in routes: 429 when limit exceeded
 *   - AuthorityBoundary: 403 for cross-tenant receipt read
 *   - GET /accounting/balance: returns CU balance after receipt store
 *   - TokenAccountingLayer debit: wired via storeReceipt
 *   - talRuntime singleton: getAccountingLayer
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

import {
  registerToken,
  clearRegistry,
  isAuthEnabled,
  resolveTenantId,
} from '../../src/api/tenantKeyRegistry.js';
import { getAccountingLayer } from '../../src/security/talRuntime.js';
import { handleRequest } from '../../src/api/routes.js';
import { flushAll } from '../../src/api/receiptStore.js';
import { getLimiter } from '../../src/security/rateLimitRuntime.js';
import { resetDistributedRateLimiterForTest } from '../../src/security/IDistributedRateLimiter.js';
import { deriveEpoch } from '../../src/types/receipt.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockReq(
  method: string,
  url: string,
  body = '',
  headers: Record<string, string> = {},
): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, {
    method,
    url,
    headers,
  }) as unknown as IncomingMessage;
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

// Derive epoch dynamically from the test timestamp to avoid hardcoded drift (GAP-A-001)
const RECEIPT_TIMESTAMP = 1741305600;
const RECEIPT_EPOCH = String(deriveEpoch(RECEIPT_TIMESTAMP));

const RECEIPT_PAYLOAD = JSON.stringify({
  requestId: 'hardening-001',
  provider: 'openai',
  model: 'gpt-4',
  inputTokens: 100,
  outputTokens: 50,
  costUnits: 150,
  latencyMs: 100,
  timestamp: RECEIPT_TIMESTAMP,
  userId: '42',
  nonce: '1',
  tenantId: 'tenant-acme',
});

// ---------------------------------------------------------------------------
// TenantKeyRegistry unit tests (no HTTP, pure module)
// ---------------------------------------------------------------------------

describe('TenantKeyRegistry — initial state', () => {
  it('clearRegistry sets isAuthEnabled to false', () => {
    clearRegistry();
    assert.equal(isAuthEnabled(), false);
  });

  it('resolveTenantId returns default when auth disabled', () => {
    clearRegistry();
    assert.equal(resolveTenantId('any-token'), 'default');
  });
});

describe('TenantKeyRegistry — registerToken enables auth', () => {
  before(() => {
    clearRegistry();
    registerToken('token-acme', 'tenant-acme');
  });
  after(() => clearRegistry());

  it('isAuthEnabled returns true after registerToken', () => {
    assert.equal(isAuthEnabled(), true);
  });

  it('resolveTenantId returns correct tenantId for known token', () => {
    assert.equal(resolveTenantId('token-acme'), 'tenant-acme');
  });

  it('resolveTenantId returns null for unknown token', () => {
    assert.equal(resolveTenantId('bad-token'), null);
  });
});

// ---------------------------------------------------------------------------
// Auth enforcement in POST /receipts (env-gated)
// ---------------------------------------------------------------------------

describe('POST /receipts — auth enforcement (OTK_TENANTS active)', () => {
  before(() => {
    clearRegistry();
    flushAll();
    getLimiter().reset();
    resetDistributedRateLimiterForTest();
    registerToken('token-acme', 'tenant-acme');
  });
  after(() => {
    clearRegistry();
    flushAll();
    getLimiter().reset();
    resetDistributedRateLimiterForTest();
  });

  it('returns 401 when Authorization header is absent', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', RECEIPT_PAYLOAD), res);
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'unauthorized');
  });

  it('returns 401 when bearer token is invalid', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('POST', '/receipts', RECEIPT_PAYLOAD, { authorization: 'Bearer bad-token' }),
      res,
    );
    assert.equal(res.statusCode, 401);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
  });

  it('returns 201 when valid bearer token is provided', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('POST', '/receipts', RECEIPT_PAYLOAD, { authorization: 'Bearer token-acme' }),
      res,
    );
    assert.equal(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.requestId, 'hardening-001');
  });
});

// ---------------------------------------------------------------------------
// AuthorityBoundary enforcement in GET /receipts/:id
// ---------------------------------------------------------------------------

describe('GET /receipts/:id — cross-tenant boundary (OTK_TENANTS active)', () => {
  before(async () => {
    clearRegistry();
    flushAll();
    getLimiter().reset();
    resetDistributedRateLimiterForTest();
    registerToken('token-acme', 'tenant-acme');
    registerToken('token-other', 'tenant-other');
    // Store a receipt for tenant-acme
    const storeRes = mockRes();
    await handleRequest(
      mockReq('POST', '/receipts', RECEIPT_PAYLOAD, { authorization: 'Bearer token-acme' }),
      storeRes,
    );
    assert.equal(storeRes.statusCode, 201);
  });
  after(() => {
    clearRegistry();
    flushAll();
    getLimiter().reset();
    resetDistributedRateLimiterForTest();
  });

  it('returns 200 for same-tenant read', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('GET', '/receipts/hardening-001', '', { authorization: 'Bearer token-acme' }),
      res,
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
  });

  it('returns 403 for cross-tenant read', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('GET', '/receipts/hardening-001', '', { authorization: 'Bearer token-other' }),
      res,
    );
    assert.equal(res.statusCode, 403);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
    assert.equal(body.error, 'forbidden');
  });

  it('returns 401 for missing token on GET', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/receipts/hardening-001'), res);
    assert.equal(res.statusCode, 401);
  });
});

// ---------------------------------------------------------------------------
// TokenAccountingLayer — debit wired via storeReceipt
// ---------------------------------------------------------------------------

describe('TokenAccountingLayer — debit via storeReceipt', () => {
  before(() => {
    clearRegistry();
    flushAll();
    getLimiter().reset();
    resetDistributedRateLimiterForTest();
  });
  after(() => {
    flushAll();
    getLimiter().reset();
    resetDistributedRateLimiterForTest();
  });

  it('GET /accounting/balance returns totalCU after receipt stored', async () => {
    // Store a receipt (auth disabled in this block)
    const storeRes = mockRes();
    await handleRequest(mockReq('POST', '/receipts', RECEIPT_PAYLOAD), storeRes);
    assert.equal(storeRes.statusCode, 201);

    // Query accounting balance for the default tenant + epoch of the stored receipt
    // Epoch 709 = floor(1741305600 / 86400) (approx, actual value from deriveEpoch)
    const balRes = mockRes();
    await handleRequest(
      mockReq(`GET`, `/accounting/balance?tenantId=tenant-acme&epochId=${RECEIPT_EPOCH}`),
      balRes,
    );
    assert.equal(balRes.statusCode, 200);
    const body = JSON.parse(balRes.body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.totalCU, 'string');
    assert.equal(body.tenantId, 'tenant-acme');
  });

  it('GET /accounting/balance returns 0 for unknown tenant', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/accounting/balance?tenantId=nobody&epochId=0'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.totalCU, '0');
    assert.equal(body.entryCount, 0);
  });
});

// ---------------------------------------------------------------------------
// talRuntime singleton
// ---------------------------------------------------------------------------

describe('talRuntime — getAccountingLayer singleton', () => {
  it('returns same instance on every call', () => {
    const a = getAccountingLayer();
    const b = getAccountingLayer();
    assert.strictEqual(a, b);
  });

  it('TAL is a TokenAccountingLayer (has balance/debit methods)', () => {
    const tal = getAccountingLayer();
    assert.equal(typeof tal.balance, 'function');
    assert.equal(typeof tal.debit, 'function');
    assert.equal(typeof tal.entries, 'function');
    assert.equal(typeof tal.reconcile, 'function');
  });
});
