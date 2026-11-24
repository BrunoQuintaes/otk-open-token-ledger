/**
 * Wave 2 Pack 13 — GET /system/status endpoint tests (S4.1)
 *
 * Tests the system status polling endpoint:
 *   - Returns 200 with status payload
 *   - Includes uptime, receiptCount, circuitBreakerStatus, deadLetterPending
 *   - Includes daemonReachable (false when no daemon)
 *   - Includes redisConnected, pgConnected
 *   - Public (no auth required)
 *   - Does not crash on missing dependencies
 *
 * @since Wave 2 Pack 13 (2026-03-15)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { handleRequest } from '../../src/api/routes.js';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ── Mock helpers ─────────────────────────────────────────────

function mockReq(method: string, url: string, headers?: Record<string, string>): IncomingMessage {
  return { method, url, headers: headers ?? {} } as unknown as IncomingMessage;
}

interface MockRes {
  statusCode: number;
  _headers: Record<string, string>;
  _body: string;
  setHeader(name: string, value: string): void;
  end(data: string): void;
}

function mockRes(): MockRes & ServerResponse {
  const res: any = {
    statusCode: 200,
    _headers: {},
    _body: '',
    setHeader(name: string, value: string) { res._headers[name] = value; },
    end(data: string) { res._body = data; },
  };
  return res;
}

function parseBody(res: MockRes): any {
  return JSON.parse(res._body);
}

// ── Tests ────────────────────────────────────────────────────

describe('S4.1 — GET /system/status', () => {
  beforeEach(() => {
    // Ensure PROVER_URL is disabled for test isolation (no real daemon)
    process.env['PROVER_URL'] = 'disabled';
  });

  it('returns 200 with ok: true', async () => {
    const req = mockReq('GET', '/system/status');
    const res = mockRes();
    await handleRequest(req, res);
    assert.equal(res.statusCode, 200);
    const body = parseBody(res);
    assert.equal(body.ok, true);
  });

  it('includes uptime as a string', async () => {
    const req = mockReq('GET', '/system/status');
    const res = mockRes();
    await handleRequest(req, res);
    const body = parseBody(res);
    assert.equal(typeof body.uptime, 'string');
    const uptimeSec = parseFloat(body.uptime);
    assert.ok(uptimeSec >= 0, 'uptime should be non-negative');
  });

  it('includes receiptCount as a number', async () => {
    const req = mockReq('GET', '/system/status');
    const res = mockRes();
    await handleRequest(req, res);
    const body = parseBody(res);
    assert.equal(typeof body.receiptCount, 'number');
    assert.ok(body.receiptCount >= 0);
  });

  it('includes circuitBreakerStatus with open and consecutiveFails', async () => {
    const req = mockReq('GET', '/system/status');
    const res = mockRes();
    await handleRequest(req, res);
    const body = parseBody(res);
    assert.ok(body.circuitBreakerStatus);
    assert.equal(typeof body.circuitBreakerStatus.open, 'boolean');
    assert.equal(typeof body.circuitBreakerStatus.consecutiveFails, 'number');
  });

  it('includes deadLetterPending as a number', async () => {
    const req = mockReq('GET', '/system/status');
    const res = mockRes();
    await handleRequest(req, res);
    const body = parseBody(res);
    assert.equal(typeof body.deadLetterPending, 'number');
    assert.ok(body.deadLetterPending >= 0);
  });

  it('includes daemonReachable (false when PROVER_URL=disabled)', async () => {
    process.env['PROVER_URL'] = 'disabled';
    const req = mockReq('GET', '/system/status');
    const res = mockRes();
    await handleRequest(req, res);
    const body = parseBody(res);
    assert.equal(body.daemonReachable, false);
  });

  it('includes redisConnected (false when no Redis)', async () => {
    delete process.env['OTK_REDIS_URL'];
    const req = mockReq('GET', '/system/status');
    const res = mockRes();
    await handleRequest(req, res);
    const body = parseBody(res);
    assert.equal(body.redisConnected, false);
  });

  it('includes pgConnected and ts fields', async () => {
    const req = mockReq('GET', '/system/status');
    const res = mockRes();
    await handleRequest(req, res);
    const body = parseBody(res);
    assert.equal(typeof body.pgConnected, 'boolean');
    assert.equal(typeof body.ts, 'string');
    // ts should be ISO-8601
    assert.ok(!isNaN(Date.parse(body.ts)), 'ts should be valid ISO date');
  });
});
