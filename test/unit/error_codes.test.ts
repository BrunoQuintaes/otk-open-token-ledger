/**
 * H1.5 — Structured Error Codes Tests
 *
 * Verifies the OTK error code registry, envelope format, backward compatibility,
 * and integration with routes.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { sendJson, sendError, sendRbacDenial, ERROR_REGISTRY, getErrorStatus } from '../../src/api/errors.js';
import type { ServerResponse } from 'node:http';

// ── Mock Response (header-aware) ──
interface MockRes {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  setHeader(k: string, v: string | number): void;
  end(data?: string): void;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: '',
    headers: {},
    setHeader(k: string, v: string | number) { res.headers[k.toLowerCase()] = String(v); },
    end(data?: string) { res.body = data ?? ''; },
  };
  return res;
}

describe('H1.5 — Structured Error Codes', () => {
  describe('sendJson()', () => {
    it('sets status code, content-type, content-length, and body', () => {
      const res = mockRes();
      sendJson(res as unknown as ServerResponse, 201, { ok: true, id: 'test' });
      assert.equal(res.statusCode, 201);
      assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
      const body = JSON.parse(res.body);
      assert.equal(body.ok, true);
      assert.equal(body.id, 'test');
    });
  });

  describe('sendError()', () => {
    it('produces correct envelope shape with ok:false, error, code, message', () => {
      const res = mockRes();
      sendError(res as unknown as ServerResponse, 'OTK-4001');
      const body = JSON.parse(res.body);
      assert.equal(body.ok, false);
      assert.equal(body.code, 'OTK-4001');
      assert.equal(body.message, 'Validation error');
      assert.equal(body.error, 'missing_required_fields');
    });

    it('sets correct HTTP status from registry', () => {
      const res = mockRes();
      sendError(res as unknown as ServerResponse, 'OTK-4040');
      assert.equal(res.statusCode, 404);
    });

    it('includes details array when provided', () => {
      const res = mockRes();
      sendError(res as unknown as ServerResponse, 'OTK-4001', {
        details: [{ field: 'inputTokens', issue: 'Expected number, received string' }],
      });
      const body = JSON.parse(res.body);
      assert.equal(body.details.length, 1);
      assert.equal(body.details[0].field, 'inputTokens');
    });

    it('omits details when not provided', () => {
      const res = mockRes();
      sendError(res as unknown as ServerResponse, 'OTK-4002');
      const body = JSON.parse(res.body);
      assert.equal(body.details, undefined);
    });

    it('includes requestId when provided', () => {
      const res = mockRes();
      sendError(res as unknown as ServerResponse, 'OTK-4010', { requestId: 'req-abc-123' });
      const body = JSON.parse(res.body);
      assert.equal(body.requestId, 'req-abc-123');
    });

    it('preserves legacy error string for each major code', () => {
      const cases: Array<[string, string]> = [
        ['OTK-4001', 'missing_required_fields'],
        ['OTK-4002', 'invalid_json'],
        ['OTK-4010', 'unauthorized'],
        ['OTK-4030', 'forbidden'],
        ['OTK-4040', 'not_found'],
        ['OTK-4290', 'rate_limit_exceeded'],
        ['OTK-5000', 'internal_error'],
      ];
      for (const [code, legacyErr] of cases) {
        const res = mockRes();
        sendError(res as unknown as ServerResponse, code);
        const body = JSON.parse(res.body);
        assert.equal(body.error, legacyErr, `${code} should have legacy error '${legacyErr}'`);
      }
    });

    it('allows overriding legacy error string', () => {
      const res = mockRes();
      sendError(res as unknown as ServerResponse, 'OTK-4001', { legacyError: 'invalid_tier' });
      const body = JSON.parse(res.body);
      assert.equal(body.error, 'invalid_tier');
      assert.equal(body.code, 'OTK-4001');
    });

    it('falls back to OTK-5000 for unknown code', () => {
      const res = mockRes();
      sendError(res as unknown as ServerResponse, 'OTK-9999');
      assert.equal(res.statusCode, 500);
      const body = JSON.parse(res.body);
      assert.equal(body.code, 'OTK-5000');
    });

    it('includes retryAfterMs when provided', () => {
      const res = mockRes();
      sendError(res as unknown as ServerResponse, 'OTK-4290', { retryAfterMs: 5000 });
      const body = JSON.parse(res.body);
      assert.equal(body.retryAfterMs, 5000);
    });
  });

  describe('sendRbacDenial()', () => {
    it('maps 401 denial to OTK-4010', () => {
      const res = mockRes();
      sendRbacDenial(res as unknown as ServerResponse, { code: 401, error: 'unauthorized' });
      const body = JSON.parse(res.body);
      assert.equal(res.statusCode, 401);
      assert.equal(body.code, 'OTK-4010');
      assert.equal(body.error, 'unauthorized');
    });

    it('maps 403 denial to OTK-4030', () => {
      const res = mockRes();
      sendRbacDenial(res as unknown as ServerResponse, { code: 403, error: 'forbidden' });
      const body = JSON.parse(res.body);
      assert.equal(res.statusCode, 403);
      assert.equal(body.code, 'OTK-4030');
    });

    it('maps 429 denial to OTK-4291', () => {
      const res = mockRes();
      sendRbacDenial(res as unknown as ServerResponse, { code: 429, error: 'too_many_auth_failures' });
      const body = JSON.parse(res.body);
      assert.equal(res.statusCode, 429);
      assert.equal(body.code, 'OTK-4291');
    });

    it('forwards retryAfterMs on 429 denial', () => {
      const res = mockRes();
      sendRbacDenial(res as unknown as ServerResponse, { code: 429, error: 'too_many_auth_failures', retryAfterMs: 3000 });
      const body = JSON.parse(res.body);
      assert.equal(body.retryAfterMs, 3000);
    });
  });

  describe('getErrorStatus()', () => {
    it('returns correct status for known codes', () => {
      assert.equal(getErrorStatus('OTK-4001'), 400);
      assert.equal(getErrorStatus('OTK-4010'), 401);
      assert.equal(getErrorStatus('OTK-4030'), 403);
      assert.equal(getErrorStatus('OTK-4040'), 404);
      assert.equal(getErrorStatus('OTK-4290'), 429);
      assert.equal(getErrorStatus('OTK-5000'), 500);
      assert.equal(getErrorStatus('OTK-5030'), 503);
      assert.equal(getErrorStatus('OTK-4130'), 413);
      assert.equal(getErrorStatus('OTK-4090'), 409);
      assert.equal(getErrorStatus('OTK-4291'), 429);
    });

    it('returns 500 for unknown code', () => {
      assert.equal(getErrorStatus('OTK-9999'), 500);
    });
  });

  describe('ERROR_REGISTRY completeness', () => {
    it('has all documented codes', () => {
      const expected = [
        'OTK-4001', 'OTK-4002', 'OTK-4003', 'OTK-4004',
        'OTK-4010', 'OTK-4011', 'OTK-4030', 'OTK-4031',
        'OTK-4040', 'OTK-4090', 'OTK-4091', 'OTK-4130', 'OTK-4290', 'OTK-4291',
        'OTK-5000', 'OTK-5001', 'OTK-5030', 'OTK-5031',
      ];
      for (const code of expected) {
        assert.ok(ERROR_REGISTRY[code], `Missing ${code} in ERROR_REGISTRY`);
      }
    });
  });
});
