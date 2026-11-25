/**
 * H1.1 — API Versioning Tests
 *
 * Tests /v1/ prefix stripping, strict versioning redirect, and infra route bypass.
 *
 * Module under test: `handleRequest` in `src/api/routes.ts` (version-prefix handling).
 *
 * Strategy / partitions: default mode with and without the version prefix, for an infrastructure
 * route, a receipt creation, the metrics route and the OpenAPI document; strict mode with a bare
 * POST (308, method and body kept), a bare GET (301), a query string that must survive the
 * redirect, and the infrastructure and dashboard routes that never redirect.
 *
 * Needs: no server (mock request/response objects). The strict-mode block sets
 * `OTK_STRICT_VERSIONING=1` before each test and deletes it after each test.
 *
 * Run just this file: `npx tsx --test test/unit/api_versioning.test.ts`
 *
 * @module test/unit/api_versioning.test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../../src/api/routes.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

// ── Mock helpers ──
function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers: { ...headers } }) as unknown as IncomingMessage;
  process.nextTick(() => {
    if (body) em.emit('data', Buffer.from(body));
    em.emit('end');
  });
  return req;
}

interface MockRes {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  writeHeadCalled: boolean;
  writeHeadStatus: number;
  writeHeadHeaders: Record<string, string>;
  getHeader(k: string): string | undefined;
  setHeader(k: string, v: string | number): void;
  writeHead(status: number, hdrs?: Record<string, string>): void;
  end(data?: string): void;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: '',
    headers: {},
    writeHeadCalled: false,
    writeHeadStatus: 0,
    writeHeadHeaders: {},
    getHeader(k: string) { return res.headers[k.toLowerCase()]; },
    setHeader(k: string, v: string | number) { res.headers[k.toLowerCase()] = String(v); },
    writeHead(status: number, hdrs?: Record<string, string>) {
      res.writeHeadCalled = true;
      res.writeHeadStatus = status;
      res.statusCode = status;
      if (hdrs) Object.entries(hdrs).forEach(([k, v]) => res.headers[k.toLowerCase()] = v);
    },
    end(data?: string) { res.body = data ?? ''; },
  };
  return res;
}

describe('H1.1 — API Versioning', () => {
  it('GET /v1/health strips prefix and returns 200', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/v1/health'), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
  });

  it('GET /health returns 200 directly (infra, no redirect)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/health'), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 200);
    assert.equal(res.writeHeadCalled, false, 'should not redirect infra routes');
  });

  it('POST /v1/receipts works (strips prefix for routing)', async () => {
    const res = mockRes();
    // Will get 400 invalid_json but that proves the route was matched
    await handleRequest(mockReq('POST', '/v1/receipts', 'not-json'), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'OTK-4002');
  });

  it('POST /receipts still works without /v1/ prefix (backward compat)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/receipts', 'not-json'), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 400);
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'OTK-4002');
  });

  it('GET /v1/metrics strips prefix and returns metrics', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/v1/metrics'), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 200);
  });

  it('GET /metrics returns 200 directly (infra route)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/metrics'), res as unknown as ServerResponse);
    assert.equal(res.statusCode, 200);
  });

  it('GET /v1/openapi.json strips prefix and works', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/v1/openapi.json'), res as unknown as ServerResponse);
    // Either 200 (spec found) or 503 (spec file not found in test env) — both prove routing works
    assert.ok([200, 503].includes(res.statusCode));
  });

  describe('strict versioning mode (OTK_STRICT_VERSIONING=1)', () => {
    beforeEach(() => { process.env['OTK_STRICT_VERSIONING'] = '1'; });
    afterEach(() => { delete process.env['OTK_STRICT_VERSIONING']; });

    it('bare POST /receipts redirects 308 to /v1/receipts (H1R2 S21-F03: method and body preserved)', async () => {
      const res = mockRes();
      await handleRequest(mockReq('POST', '/receipts', 'test'), res as unknown as ServerResponse);
      assert.equal(res.statusCode, 308);
      assert.equal(res.headers['location'], '/v1/receipts');
    });

    it('bare GET /receipts keeps 301 to /v1/receipts', async () => {
      const res = mockRes();
      await handleRequest(mockReq('GET', '/receipts'), res as unknown as ServerResponse);
      assert.equal(res.statusCode, 301);
      assert.equal(res.headers['location'], '/v1/receipts');
    });

    it('preserves query string in redirect', async () => {
      const res = mockRes();
      await handleRequest(mockReq('GET', '/admin/tenants?page=2'), res as unknown as ServerResponse);
      assert.equal(res.statusCode, 301);
      assert.equal(res.headers['location'], '/v1/admin/tenants?page=2');
    });

    it('infra route /health does NOT redirect even in strict mode', async () => {
      const res = mockRes();
      await handleRequest(mockReq('GET', '/health'), res as unknown as ServerResponse);
      assert.equal(res.statusCode, 200);
      assert.equal(res.writeHeadCalled, false);
    });

    it('/app/* dashboard does NOT redirect even in strict mode', async () => {
      const res = mockRes();
      await handleRequest(mockReq('GET', '/app'), res as unknown as ServerResponse);
      // Dashboard returns either redirect to login or dashboard HTML — not 301
      assert.notEqual(res.statusCode, 301);
    });
  });
});
