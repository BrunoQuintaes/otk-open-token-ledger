/**
 * H-PACK-02 Tests — H1.6 (Idempotency), H1.7 (Graceful Shutdown),
 * H1.8 (Body Limits), H1.9 (Security Headers)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../../src/api/routes.js';
import { isShuttingDown, resetShutdownForTest } from '../../src/api/server.js';
import { applySecurityHeaders } from '../../src/api/securityHeaders.js';
import { readBodyWithLimits, BodyTooLargeError, RequestTimeoutError } from '../../src/api/limits.js';
import { checkIdempotency, storeIdempotencyResponse, bodyHash, resetIdempotencyStoreForTest } from '../../src/api/idempotency.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

// ── Mock helpers ──
function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, {
    method, url, headers: { ...headers },
    destroy() { em.removeAllListeners(); },
  }) as unknown as IncomingMessage;
  process.nextTick(() => {
    if (body) em.emit('data', Buffer.from(body));
    em.emit('end');
  });
  return req;
}

function mockRes() {
  const res = {
    statusCode: 200, body: '', headers: {} as Record<string, string>,
    getHeader(k: string) { return res.headers[k.toLowerCase()]; },
    setHeader(k: string, v: string | number) { res.headers[k.toLowerCase()] = String(v); },
    end(data?: string) { res.body = data ?? ''; },
  };
  return res;
}

const VALID_RECEIPT = JSON.stringify({
  requestId: 'idem-test-001',
  provider: 'openai',
  model: 'gpt-4',
  inputTokens: 100,
  outputTokens: 50,
});

// ═══════════════════════════════════════════
// H1.9 — Security Headers
// ═══════════════════════════════════════════
describe('H1.9 — Security Headers', () => {
  it('applies all 6 core security headers', () => {
    const res = mockRes();
    applySecurityHeaders(res as unknown as ServerResponse);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
    assert.equal(res.headers['x-xss-protection'], '0');
    assert.ok(res.headers['referrer-policy']?.includes('strict-origin'));
    assert.ok(res.headers['content-security-policy']?.includes("default-src 'self'"));
    assert.equal(res.headers['cache-control'], 'no-store');
  });

  it('does not set HSTS when OTK_TLS_ENABLED is not set', () => {
    delete process.env['OTK_TLS_ENABLED'];
    const res = mockRes();
    applySecurityHeaders(res as unknown as ServerResponse);
    assert.equal(res.headers['strict-transport-security'], undefined);
  });

  it('sets HSTS when OTK_TLS_ENABLED=true', () => {
    process.env['OTK_TLS_ENABLED'] = 'true';
    const res = mockRes();
    applySecurityHeaders(res as unknown as ServerResponse);
    assert.ok(res.headers['strict-transport-security']?.includes('max-age='));
    delete process.env['OTK_TLS_ENABLED'];
  });

  it('security headers present on route responses', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/health'), res as unknown as ServerResponse);
    assert.equal(res.headers['x-content-type-options'], 'nosniff');
    assert.equal(res.headers['x-frame-options'], 'DENY');
  });
});

// ═══════════════════════════════════════════
// H1.8 — Request Timeout + Body Limits
// ═══════════════════════════════════════════
describe('H1.8 — Body Limits', () => {
  it('reads body within limit', async () => {
    const data = 'hello world';
    const req = mockReq('POST', '/', data);
    const result = await readBodyWithLimits(req, 1024, 5000);
    assert.equal(result, data);
  });

  it('rejects body exceeding limit', async () => {
    const bigData = 'x'.repeat(1000);
    const req = mockReq('POST', '/', bigData);
    await assert.rejects(
      readBodyWithLimits(req, 100, 5000),
      (err: unknown) => err instanceof BodyTooLargeError,
    );
  });

  it('BodyTooLargeError has descriptive message', () => {
    const err = new BodyTooLargeError(1024);
    assert.ok(err.message.includes('1024'));
    assert.equal(err.name, 'BodyTooLargeError');
  });

  it('RequestTimeoutError has descriptive message', () => {
    const err = new RequestTimeoutError(5000);
    assert.ok(err.message.includes('5000'));
    assert.equal(err.name, 'RequestTimeoutError');
  });

  it('POST /receipts with oversized body returns 413', async () => {
    const bigBody = 'x'.repeat(2_000_000); // 2MB > 1MB default
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', bigBody), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 413);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'OTK-4130');
  });
});

// ═══════════════════════════════════════════
// H1.6 — Idempotency Keys
// ═══════════════════════════════════════════
describe('H1.6 — Idempotency Keys', () => {
  beforeEach(() => resetIdempotencyStoreForTest());

  it('bodyHash produces consistent hashes', () => {
    const h1 = bodyHash('test body');
    const h2 = bodyHash('test body');
    assert.equal(h1, h2);
  });

  it('bodyHash differs for different bodies', () => {
    const h1 = bodyHash('body A');
    const h2 = bodyHash('body B');
    assert.notEqual(h1, h2);
  });

  it('checkIdempotency returns cached:false for new key', async () => {
    const result = await checkIdempotency('key-1', 'body');
    assert.equal(result.cached, false);
    assert.equal('conflict' in result ? result.conflict : false, false);
  });

  it('checkIdempotency returns cached:true for same key+body', async () => {
    await storeIdempotencyResponse('key-2', 201, '{"ok":true}', 'body');
    const result = await checkIdempotency('key-2', 'body');
    assert.equal(result.cached, true);
    if (result.cached) {
      assert.equal(result.response.status, 201);
      assert.equal(result.response.body, '{"ok":true}');
    }
  });

  it('checkIdempotency returns conflict for same key, different body', async () => {
    await storeIdempotencyResponse('key-3', 201, '{"ok":true}', 'body-A');
    const result = await checkIdempotency('key-3', 'body-B');
    assert.equal(result.cached, false);
    assert.equal('conflict' in result ? result.conflict : false, true);
  });

  it('missing Idempotency-Key proceeds normally', async () => {
    const result = await checkIdempotency(undefined, 'body');
    assert.equal(result.cached, false);
  });

  it('POST /receipts with Idempotency-Key returns 201 on first call', async () => {
    const uniqueReceipt = JSON.stringify({ ...JSON.parse(VALID_RECEIPT), requestId: `idem-first-${Date.now()}` });
    const res = mockRes();
    await handleRequest(
      mockReq('POST', '/receipts', uniqueReceipt, { 'idempotency-key': `ik-${Date.now()}-a` }),
      res as unknown as ServerResponse,
    );
    assert.equal(res.statusCode, 201);
  });

  it('POST /receipts same Idempotency-Key returns cached response', async () => {
    const rid = `idem-cached-${Date.now()}`;
    const receipt = JSON.stringify({ ...JSON.parse(VALID_RECEIPT), requestId: rid });
    const ikey = `ik-${Date.now()}-b`;

    // First call — fresh receipt
    const res1 = mockRes();
    await handleRequest(
      mockReq('POST', '/receipts', receipt, { 'idempotency-key': ikey }),
      res1 as unknown as ServerResponse,
    );
    assert.equal(res1.statusCode, 201);

    // Second call (same key, same body) — should return cached 201
    const res2 = mockRes();
    await handleRequest(
      mockReq('POST', '/receipts', receipt, { 'idempotency-key': ikey }),
      res2 as unknown as ServerResponse,
    );
    assert.equal(res2.statusCode, 201);
  });

  it('POST /receipts same key, different body returns 409', async () => {
    const rid1 = `idem-conflict-${Date.now()}`;
    const receipt1 = JSON.stringify({ ...JSON.parse(VALID_RECEIPT), requestId: rid1 });
    const ikey = `ik-${Date.now()}-c`;

    // First call
    const res1 = mockRes();
    await handleRequest(
      mockReq('POST', '/receipts', receipt1, { 'idempotency-key': ikey }),
      res1 as unknown as ServerResponse,
    );
    assert.equal(res1.statusCode, 201);

    // Second call (same key, DIFFERENT body)
    const receipt2 = JSON.stringify({ ...JSON.parse(VALID_RECEIPT), requestId: `${rid1}-different` });
    const res2 = mockRes();
    await handleRequest(
      mockReq('POST', '/receipts', receipt2, { 'idempotency-key': ikey }),
      res2 as unknown as ServerResponse,
    );
    assert.equal(res2.statusCode, 409);
    const body = JSON.parse(res2.body);
    assert.equal(body.code, 'OTK-4091');
  });
});

// ═══════════════════════════════════════════
// H1.7 — Graceful Shutdown
// ═══════════════════════════════════════════
describe('H1.7 — Graceful Shutdown', () => {
  afterEach(() => resetShutdownForTest());

  it('isShuttingDown is false by default', () => {
    assert.equal(isShuttingDown(), false);
  });

  it('resetShutdownForTest resets the flag', () => {
    resetShutdownForTest();
    assert.equal(isShuttingDown(), false);
  });
});
