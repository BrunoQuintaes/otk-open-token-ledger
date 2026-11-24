/**
 * QA2 — Smoke tests for src/api/routes.ts (RB-062)
 *
 * Tests handleRequest directly via in-process mock objects.
 * No server socket, no network I/O.
 *
 * Validates:
 *   - Module loads and exports handleRequest
 *   - GET /health → 200 + { ok: true }
 *   - GET /version → 200 + { apiVersion }
 *   - POST /ping  → 200 + { echo: <body> }
 *   - GET /unknown → 404 + { ok: false }
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';

// ---------------------------------------------------------------------------
// Minimal mock helpers
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('API Routes smoke — exports', () => {
  it('handleRequest is a function', () => {
    assert.equal(typeof handleRequest, 'function');
  });
});

describe('API Routes smoke — GET /health', () => {
  it('returns 200 with ok=true', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/health'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(typeof body.uptime, 'string');
  });
});

describe('API Routes smoke — GET /version', () => {
  it('returns 200 with apiVersion', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/version'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(typeof body.apiVersion, 'string');
    assert.ok(body.apiVersion.length > 0);
  });
});

describe('API Routes smoke — POST /ping', () => {
  it('echoes request body', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/ping', '{"test":1}'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.equal(body.echo, '{"test":1}');
  });
});

describe('API Routes smoke — unknown route', () => {
  it('returns 404 with ok=false', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/does-not-exist'), res);
    assert.equal(res.statusCode, 404);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, false);
  });
});
