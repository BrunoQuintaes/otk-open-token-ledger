/**
 * H1.4 — Input Validation Layer Tests
 *
 * Tests Zod schema validation for all POST/PUT endpoint bodies.
 *
 * Modules under test: `validateBody` from `src/api/validate.ts`, the request schemas in
 * `src/api/schemas.ts`, and `handleRequest` in `src/api/routes.ts` for the integration cases.
 *
 * Strategy / partitions: receipt submission (valid, each required field missing, wrong type,
 * negative count, extra fields stripped, empty object with several errors, user id as string and
 * as number); tenant creation (valid, a sequential token, a token shorter than 24 characters,
 * missing fields); plan assignment (valid, unknown tier); tenant update (empty object, unknown
 * role); registry reload (valid, missing field); the receipt route with an invalid body (400
 * with error code and details) and a valid one (201).
 *
 * Needs: nothing external (mock request/response objects; no server).
 *
 * Run just this file: `npx tsx --test test/unit/input_validation.test.ts`
 *
 * @module test/unit/input_validation.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateBody } from '../../src/api/validate.js';
import { ReceiptSubmissionSchema, TenantCreateSchema, PlanAssignmentSchema, TenantUpdateSchema, TenantsReloadSchema } from '../../src/api/schemas.js';
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

function mockRes() {
  const res = {
    statusCode: 200, body: '', headers: {} as Record<string, string>,
    getHeader(k: string) { return res.headers[k.toLowerCase()]; },
    setHeader(k: string, v: string | number) { res.headers[k.toLowerCase()] = String(v); },
    end(data?: string) { res.body = data ?? ''; },
  };
  return res;
}

const VALID_RECEIPT = {
  requestId: 'req-001',
  provider: 'openai',
  model: 'gpt-4',
  inputTokens: 100,
  outputTokens: 50,
};

describe('H1.4 — Input Validation (Zod Schemas)', () => {
  describe('ReceiptSubmissionSchema', () => {
    it('valid receipt passes', () => {
      const result = validateBody(VALID_RECEIPT, ReceiptSubmissionSchema);
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.provider, 'openai');
        assert.equal(result.data.costUnits, 0); // default
        assert.equal(result.data.userId, '0');   // default
      }
    });

    it('missing requestId returns field error', () => {
      const result = validateBody({ provider: 'openai', model: 'gpt-4', inputTokens: 1, outputTokens: 1 }, ReceiptSubmissionSchema);
      assert.equal(result.success, false);
      if (!result.success) {
        assert.ok(result.issues.some(i => i.field === 'requestId'));
      }
    });

    it('missing provider returns field error', () => {
      const result = validateBody({ requestId: 'r1', model: 'gpt-4', inputTokens: 1, outputTokens: 1 }, ReceiptSubmissionSchema);
      assert.equal(result.success, false);
      if (!result.success) {
        assert.ok(result.issues.some(i => i.field === 'provider'));
      }
    });

    it('inputTokens as string fails', () => {
      const result = validateBody({ ...VALID_RECEIPT, inputTokens: 'not-a-number' }, ReceiptSubmissionSchema);
      assert.equal(result.success, false);
    });

    it('negative inputTokens fails', () => {
      const result = validateBody({ ...VALID_RECEIPT, inputTokens: -5 }, ReceiptSubmissionSchema);
      assert.equal(result.success, false);
    });

    it('extra fields are stripped', () => {
      const result = validateBody({ ...VALID_RECEIPT, extraField: 'should be removed' }, ReceiptSubmissionSchema);
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal((result.data as any).extraField, undefined);
      }
    });

    it('empty object returns multiple errors', () => {
      const result = validateBody({}, ReceiptSubmissionSchema);
      assert.equal(result.success, false);
      if (!result.success) {
        assert.ok(result.issues.length >= 3, `expected 3+ issues, got ${result.issues.length}`);
      }
    });

    it('userId accepts string', () => {
      const result = validateBody({ ...VALID_RECEIPT, userId: '42' }, ReceiptSubmissionSchema);
      assert.equal(result.success, true);
      if (result.success) assert.equal(result.data.userId, '42');
    });

    it('userId accepts number', () => {
      const result = validateBody({ ...VALID_RECEIPT, userId: 42 }, ReceiptSubmissionSchema);
      assert.equal(result.success, true);
      if (result.success) assert.equal(result.data.userId, '42');
    });
  });

  describe('TenantCreateSchema', () => {
    it('valid tenant passes', () => {
      // H1-S06 (SEC02-N02): tenant tokens registered through the API need >= 24 characters (was 'tok123')
      // H1 lane B (S06 residual): and must not be sequential/repeated/low-entropy (was 'tok123-0123456789abcdefgh')
      const result = validateBody({ tenantId: 't1', token: 'tok123-9f4c1e7a2b6d08e35c71' }, TenantCreateSchema);
      assert.equal(result.success, true);
    });

    it('a sequential token of >= 24 characters fails (H1 lane B, S06 residual)', () => {
      const result = validateBody({ tenantId: 't1', token: 'tok123-0123456789abcdefgh' }, TenantCreateSchema);
      assert.equal(result.success, false);
    });

    it('token shorter than 24 characters fails (H1-S06 / SEC02-N02)', () => {
      const result = validateBody({ tenantId: 't1', token: 'tok123' }, TenantCreateSchema);
      assert.equal(result.success, false);
    });

    it('missing tenantId fails', () => {
      const result = validateBody({ token: 'tok' }, TenantCreateSchema);
      assert.equal(result.success, false);
    });

    it('missing token fails', () => {
      const result = validateBody({ tenantId: 't1' }, TenantCreateSchema);
      assert.equal(result.success, false);
    });
  });

  describe('PlanAssignmentSchema', () => {
    it('valid assignment passes', () => {
      const result = validateBody({ tenantId: 't1', tier: 'PRO' }, PlanAssignmentSchema);
      assert.equal(result.success, true);
    });

    it('invalid tier fails', () => {
      const result = validateBody({ tenantId: 't1', tier: 'ENTERPRISE' }, PlanAssignmentSchema);
      assert.equal(result.success, false);
    });
  });

  describe('TenantUpdateSchema', () => {
    it('empty object passes (all fields optional)', () => {
      const result = validateBody({}, TenantUpdateSchema);
      assert.equal(result.success, true);
    });

    it('invalid role fails', () => {
      const result = validateBody({ role: 'SUPERADMIN' }, TenantUpdateSchema);
      assert.equal(result.success, false);
    });
  });

  describe('TenantsReloadSchema', () => {
    it('valid reload passes', () => {
      const result = validateBody({ tenants: 'tenant1:tok1' }, TenantsReloadSchema);
      assert.equal(result.success, true);
    });

    it('missing tenants fails', () => {
      const result = validateBody({}, TenantsReloadSchema);
      assert.equal(result.success, false);
    });
  });

  describe('integration with routes', () => {
    it('POST /receipts with invalid type returns 400 + OTK-4001 + details', async () => {
      const res = mockRes();
      const body = JSON.stringify({ requestId: 'r1', provider: 'openai', model: 'gpt-4', inputTokens: 'bad', outputTokens: 1 });
      await handleRequest(mockReq('POST', '/receipts', body), res as unknown as ServerResponse);
      assert.equal(res.statusCode, 400);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.code, 'OTK-4001');
      assert.ok(Array.isArray(parsed.details), 'should have details array');
    });

    it('POST /receipts with valid body returns 201 (no regression)', async () => {
      const res = mockRes();
      const body = JSON.stringify(VALID_RECEIPT);
      await handleRequest(mockReq('POST', '/receipts', body), res as unknown as ServerResponse);
      assert.equal(res.statusCode, 201);
      const parsed = JSON.parse(res.body);
      assert.equal(parsed.ok, true);
    });
  });
});
