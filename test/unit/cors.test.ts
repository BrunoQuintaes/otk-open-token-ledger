/**
 * H1.2 — CORS Configuration Tests
 *
 * Checks how allowed browser origins are parsed and how the cross-origin response headers are set.
 *
 * Modules under test: `src/api/cors.ts` (`parseCorsConfig`, `applyCors`, `handlePreflight`) and,
 * for the integration cases, `handleRequest` in `src/api/routes.ts`.
 *
 * Strategy / partitions: configuration undefined, `*`, one origin and a comma-separated list;
 * headers for allow-all, for a matching explicit origin (with Vary and credentials), for a
 * non-matching origin (none) and no credentials header with the wildcard; a preflight answer;
 * the router answering a preflight request and adding the origin header to a normal response.
 *
 * Needs: nothing external (mock request/response objects; no server).
 *
 * Run just this file: `npx tsx --test test/unit/cors.test.ts`
 *
 * @module test/unit/cors.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseCorsConfig, applyCors, handlePreflight, type CorsConfig } from '../../src/api/cors.js';
import { handleRequest } from '../../src/api/routes.js';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { EventEmitter } from 'node:events';

// ── Mock helpers ──
function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers: { ...headers } }) as unknown as IncomingMessage;
  process.nextTick(() => em.emit('end'));
  return req;
}

interface MockRes {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  ended: boolean;
  getHeader(k: string): string | undefined;
  setHeader(k: string, v: string | number): void;
  end(data?: string): void;
}

function mockRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    body: '',
    headers: {},
    ended: false,
    getHeader(k: string) { return res.headers[k.toLowerCase()]; },
    setHeader(k: string, v: string | number) { res.headers[k.toLowerCase()] = String(v); },
    end(data?: string) { res.body = data ?? ''; res.ended = true; },
  };
  return res;
}

describe('H1.2 — CORS Configuration', () => {
  describe('parseCorsConfig()', () => {
    it('returns allowAll=true when undefined', () => {
      const config = parseCorsConfig(undefined);
      assert.equal(config.allowAll, true);
      assert.equal(config.allowCredentials, false);
    });

    it('returns allowAll=true for "*"', () => {
      const config = parseCorsConfig('*');
      assert.equal(config.allowAll, true);
    });

    it('parses single explicit origin', () => {
      const config = parseCorsConfig('https://app.example.com');
      assert.equal(config.allowAll, false);
      assert.deepEqual(config.allowedOrigins, ['https://app.example.com']);
      assert.equal(config.allowCredentials, true);
    });

    it('parses comma-separated origins', () => {
      const config = parseCorsConfig('https://a.com, https://b.com');
      assert.equal(config.allowedOrigins.length, 2);
      assert.deepEqual(config.allowedOrigins, ['https://a.com', 'https://b.com']);
    });
  });

  describe('applyCors()', () => {
    it('sets Access-Control-Allow-Origin: * for allowAll', () => {
      const res = mockRes();
      const config: CorsConfig = { allowAll: true, allowedOrigins: [], allowCredentials: false };
      applyCors(mockReq('GET', '/'), res as unknown as ServerResponse, config);
      assert.equal(res.headers['access-control-allow-origin'], '*');
    });

    it('sets matching origin + Vary + Credentials for explicit origin', () => {
      const res = mockRes();
      const config: CorsConfig = { allowAll: false, allowedOrigins: ['https://app.com'], allowCredentials: true };
      applyCors(
        mockReq('GET', '/', { origin: 'https://app.com' }),
        res as unknown as ServerResponse,
        config,
      );
      assert.equal(res.headers['access-control-allow-origin'], 'https://app.com');
      assert.equal(res.headers['vary'], 'Origin');
      assert.equal(res.headers['access-control-allow-credentials'], 'true');
    });

    it('sets no CORS headers for non-matching origin', () => {
      const res = mockRes();
      const config: CorsConfig = { allowAll: false, allowedOrigins: ['https://app.com'], allowCredentials: true };
      applyCors(
        mockReq('GET', '/', { origin: 'https://evil.com' }),
        res as unknown as ServerResponse,
        config,
      );
      assert.equal(res.headers['access-control-allow-origin'], undefined);
    });

    it('does not set credentials header for wildcard', () => {
      const res = mockRes();
      const config: CorsConfig = { allowAll: true, allowedOrigins: [], allowCredentials: false };
      applyCors(mockReq('GET', '/'), res as unknown as ServerResponse, config);
      assert.equal(res.headers['access-control-allow-credentials'], undefined);
    });
  });

  describe('handlePreflight()', () => {
    it('returns 204 with correct headers', () => {
      const res = mockRes();
      const config: CorsConfig = { allowAll: true, allowedOrigins: [], allowCredentials: false };
      handlePreflight(mockReq('OPTIONS', '/receipts'), res as unknown as ServerResponse, config);
      assert.equal(res.statusCode, 204);
      assert.ok(res.headers['access-control-allow-methods']?.includes('POST'));
      assert.ok(res.headers['access-control-allow-headers']?.includes('Authorization'));
      assert.equal(res.headers['access-control-max-age'], '86400');
      assert.equal(res.ended, true);
    });
  });

  describe('integration with handleRequest', () => {
    it('OPTIONS /receipts returns 204 with CORS headers', async () => {
      const res = mockRes();
      await handleRequest(mockReq('OPTIONS', '/receipts'), res as unknown as ServerResponse);
      assert.equal(res.statusCode, 204);
      assert.ok(res.headers['access-control-allow-methods']);
    });

    it('GET /health includes CORS origin header', async () => {
      const res = mockRes();
      await handleRequest(mockReq('GET', '/health'), res as unknown as ServerResponse);
      assert.equal(res.headers['access-control-allow-origin'], '*');
    });
  });
});
