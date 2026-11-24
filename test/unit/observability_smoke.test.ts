/**
 * F1.2 — Observability smoke tests
 *
 * Validates the operational path:
 *   getCollector() → record(event) → GET /metrics → ObservabilitySnapshot
 *
 * Uses the same in-process mock pattern as api_routes_smoke.test.ts.
 * No server socket, no network I/O.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';
import { getCollector } from '../../src/observability/runtime.js';
import type { NormalizedUsageEvent } from '../../src/providers/types.js';

// ---------------------------------------------------------------------------
// Minimal mock helpers (same pattern as api_routes_smoke)
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url }) as unknown as IncomingMessage;
  process.nextTick(() => em.emit('end'));
  return req;
}

type MockRes = ServerResponse & { body: string };

function mockRes(): MockRes {
  let body = '';
  return {
    statusCode: 200,
    setHeader: () => {},
    end: (data: string) => { body = data; },
    get body() { return body; },
  } as unknown as MockRes;
}

function evt(provider: string, model: string): NormalizedUsageEvent {
  return {
    provider, model,
    inputTokens: 10, outputTokens: 5, totalTokens: 15,
    latencyMs: 100, costUnits: 200, timestamp: 1_000_000, requestId: 'r1',
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Observability runtime — getCollector', () => {
  it('getCollector is a function', () => {
    assert.equal(typeof getCollector, 'function');
  });

  it('returns an object with record/snapshot/reset', () => {
    const col = getCollector();
    assert.equal(typeof col.record, 'function');
    assert.equal(typeof col.snapshot, 'function');
    assert.equal(typeof col.reset, 'function');
  });

  it('same instance on every call (singleton)', () => {
    assert.strictEqual(getCollector(), getCollector());
  });
});

describe('Observability smoke — GET /metrics', () => {
  beforeEach(() => { getCollector().reset(); });

  it('returns 200 with snapshot shape (capturedAt + providers array)', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/metrics?format=json'), res);
    assert.equal(res.statusCode, 200);
    const snap = JSON.parse(res.body);
    assert.ok('capturedAt' in snap, 'capturedAt missing');
    assert.ok(Array.isArray(snap.providers), 'providers is not an array');
  });

  it('empty snapshot has providers=[]', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/metrics?format=json'), res);
    const snap = JSON.parse(res.body);
    assert.deepEqual(snap.providers, []);
  });

  it('reflects recorded event in snapshot', async () => {
    getCollector().record(evt('openai', 'gpt-4o'));
    const res = mockRes();
    await handleRequest(mockReq('GET', '/metrics?format=json'), res);
    const snap = JSON.parse(res.body);
    assert.equal(snap.providers.length, 1);
    assert.equal(snap.providers[0].provider, 'openai');
    assert.equal(snap.providers[0].model, 'gpt-4o');
    assert.equal(snap.providers[0].healthStatus, 'healthy');
  });

  it('degraded health reflected in snapshot', async () => {
    getCollector().record(evt('anthropic', 'claude-sonnet'), true);
    getCollector().record(evt('anthropic', 'claude-sonnet'), true);
    const res = mockRes();
    await handleRequest(mockReq('GET', '/metrics?format=json'), res);
    const snap = JSON.parse(res.body);
    const entry = snap.providers.find((p: { provider: string }) => p.provider === 'anthropic');
    assert.ok(entry, 'anthropic entry missing');
    assert.equal(entry.healthStatus, 'degraded');
  });
});
