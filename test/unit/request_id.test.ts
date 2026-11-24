/**
 * H1.3 — Request-ID Propagation Tests
 *
 * Verifies X-Request-Id generation, passthrough, format, and presence
 * in response headers, body, and logger entries.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../../src/api/routes.js';
import { StructuredLogger } from '../../src/infra/logging/StructuredLogger.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

// ── UUID v4 regex ──
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ── Mock helpers (header-aware) ──
function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, {
    method,
    url,
    headers: { ...headers },
  }) as unknown as IncomingMessage;
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
  getHeader(k: string): string | undefined;
  setHeader(k: string, v: string | number): void;
  end(data?: string): void;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: '',
    headers: {},
    getHeader(k: string) { return res.headers[k.toLowerCase()]; },
    setHeader(k: string, v: string | number) { res.headers[k.toLowerCase()] = String(v); },
    end(data?: string) { res.body = data ?? ''; },
  };
  return res;
}

describe('H1.3 — Request-ID Propagation', () => {
  it('generates UUID v4 request ID when client sends none', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/health'), res as unknown as ServerResponse);
    const rid = res.headers['x-request-id'];
    assert.ok(rid, 'x-request-id header must be present');
    assert.match(rid, UUID_V4_RE, 'generated ID must be UUID v4 format');
  });

  it('passes through client-sent X-Request-Id', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('GET', '/health', '', { 'x-request-id': 'client-req-42' }),
      res as unknown as ServerResponse,
    );
    assert.equal(res.headers['x-request-id'], 'client-req-42');
  });

  it('includes requestId in success response body', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('GET', '/health', '', { 'x-request-id': 'test-success-id' }),
      res as unknown as ServerResponse,
    );
    const body = JSON.parse(res.body);
    assert.equal(body.requestId, 'test-success-id');
  });

  it('includes requestId in error response body', async () => {
    const res = mockRes();
    await handleRequest(
      mockReq('POST', '/receipts', 'not-json', { 'x-request-id': 'test-error-id' }),
      res as unknown as ServerResponse,
    );
    const body = JSON.parse(res.body);
    assert.equal(body.requestId, 'test-error-id');
    assert.equal(body.code, 'OTK-4002'); // invalid JSON
  });

  it('each request gets a unique generated ID', async () => {
    const res1 = mockRes();
    const res2 = mockRes();
    await handleRequest(mockReq('GET', '/health'), res1 as unknown as ServerResponse);
    await handleRequest(mockReq('GET', '/health'), res2 as unknown as ServerResponse);
    const id1 = res1.headers['x-request-id'];
    const id2 = res2.headers['x-request-id'];
    assert.ok(id1 && id2, 'both responses must have request IDs');
    assert.notEqual(id1, id2, 'IDs must be unique per request');
  });

  it('StructuredLogger includes requestId when set', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({
      service: 'test',
      sink: (line) => lines.push(line),
      requestId: 'log-req-123',
    });
    logger.info('test message');
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.requestId, 'log-req-123');
  });

  it('StructuredLogger.setRequestId updates per-request', () => {
    const lines: string[] = [];
    const logger = new StructuredLogger({ service: 'test', sink: (line) => lines.push(line) });
    logger.setRequestId('dynamic-req-456');
    logger.info('after set');
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.requestId, 'dynamic-req-456');
  });

  it('StructuredLogger.child inherits requestId', () => {
    const lines: string[] = [];
    const parent = new StructuredLogger({
      service: 'test',
      sink: (line) => lines.push(line),
      requestId: 'parent-req',
    });
    const child = parent.child({ tenantId: 'tenant-1' });
    child.info('child message');
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.requestId, 'parent-req');
    assert.equal(entry.tenantId, 'tenant-1');
  });
});
