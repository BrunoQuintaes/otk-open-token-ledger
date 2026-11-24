/**
 * P1.2 — OpenAPI Runtime Endpoints Tests
 *
 * Tests for:
 * 1. GET /openapi.json — serves canonical OpenAPI spec as JSON
 * 2. GET /api-docs    — serves Redoc HTML viewer page
 *
 * Uses the same in-process mock pattern as existing API tests.
 * No network I/O, no server socket.
 *
 * @since P1.2 (2026-03-13)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as existing API tests)
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers: {} }) as unknown as IncomingMessage;
  process.nextTick(() => { em.emit('end'); });
  return req;
}

type MockRes = ServerResponse & { body: string; headers: Record<string, string | number> };

function mockRes(): MockRes {
  let body = '';
  const headers: Record<string, string | number> = {};
  const res = {
    statusCode: 200,
    setHeader: (name: string, value: string | number) => { headers[name.toLowerCase()] = value; },
    end: (data: string) => { body = data; },
    get body() { return body; },
    get headers() { return headers; },
  } as unknown as MockRes;
  return res;
}

// ---------------------------------------------------------------------------
// 1. GET /openapi.json — spec endpoint
// ---------------------------------------------------------------------------

describe('P1.2 — GET /openapi.json', () => {
  it('returns 200', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/openapi.json'), res);
    assert.equal(res.statusCode, 200);
  });

  it('content-type is application/json', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/openapi.json'), res);
    assert.ok(
      String(res.headers['content-type']).includes('application/json'),
      `expected application/json, got: ${res.headers['content-type']}`,
    );
  });

  it('body is valid JSON', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/openapi.json'), res);
    assert.doesNotThrow(() => JSON.parse(res.body), 'body must be valid JSON');
  });

  it('body contains openapi: "3.1.0"', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/openapi.json'), res);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    assert.equal(parsed['openapi'], '3.1.0');
  });

  it('body contains info.title', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/openapi.json'), res);
    const parsed = JSON.parse(res.body) as Record<string, unknown>;
    const info = parsed['info'] as Record<string, unknown>;
    assert.ok(info?.['title'], 'info.title should be present');
  });

  it('does not require Authorization header (public endpoint)', async () => {
    // No auth header — should still return 200, not 401
    const res = mockRes();
    await handleRequest(mockReq('GET', '/openapi.json'), res);
    assert.notEqual(res.statusCode, 401);
    assert.equal(res.statusCode, 200);
  });
});

// ---------------------------------------------------------------------------
// 2. GET /api-docs — Redoc HTML viewer
// ---------------------------------------------------------------------------

describe('P1.2 — GET /api-docs', () => {
  it('returns 200', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/api-docs'), res);
    assert.equal(res.statusCode, 200);
  });

  it('content-type is text/html', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/api-docs'), res);
    assert.ok(
      String(res.headers['content-type']).includes('text/html'),
      `expected text/html, got: ${res.headers['content-type']}`,
    );
  });

  it('body contains reference to /openapi.json (spec-url)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/api-docs'), res);
    assert.ok(
      res.body.includes('/openapi.json'),
      'HTML body must reference /openapi.json as spec-url',
    );
  });

  it('body contains <redoc> element', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/api-docs'), res);
    assert.ok(res.body.includes('<redoc'), 'HTML body must contain <redoc> element');
  });

  it('body contains Redoc CDN script tag', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/api-docs'), res);
    assert.ok(
      res.body.includes('redoc.standalone.js'),
      'HTML body must include Redoc CDN script',
    );
  });

  it('does not require Authorization header (public endpoint)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/api-docs'), res);
    assert.notEqual(res.statusCode, 401);
    assert.equal(res.statusCode, 200);
  });
});

// ---------------------------------------------------------------------------
// 3. Regression — existing endpoints unaffected
// ---------------------------------------------------------------------------

describe('P1.2 — regression: existing public endpoints', () => {
  it('GET /health still returns 200 ok=true', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/health'), res);
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).ok, true);
  });

  it('GET /version still returns 200 with apiVersion', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/version'), res);
    assert.equal(res.statusCode, 200);
    assert.ok(JSON.parse(res.body).apiVersion);
  });

  it('GET /unknown still returns 404', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/unknown-route-xyz'), res);
    assert.equal(res.statusCode, 404);
  });
});
