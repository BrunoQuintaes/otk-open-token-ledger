/**
 * F3 — Event Delivery behavioral tests
 *
 * Validates:
 *   - buildEnvelope produces correct EventEnvelope shape
 *   - EventDispatcher: emit, subscribe/unsubscribe, latest, buffer bounds, reset
 *   - GET /events/latest route reflects emitted events
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { buildEnvelope, EventDispatcher, getDispatcher } from '../../src/publisher/index.js';
import type { EventEnvelope } from '../../src/publisher/index.js';
import { handleRequest } from '../../src/api/routes.js';

// ---------------------------------------------------------------------------
// Mock helpers (same pattern as api_routes_smoke)
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

// ---------------------------------------------------------------------------
// buildEnvelope
// ---------------------------------------------------------------------------

describe('buildEnvelope', () => {
  it('produces correct shape with all required fields', () => {
    const env = buildEnvelope('usage_metered', 'provider:openai', { tokens: 100 }, 1_700_000_000, 'ev-001');
    assert.equal(env.eventId, 'ev-001');
    assert.equal(env.eventKind, 'usage_metered');
    assert.equal(env.source, 'provider:openai');
    assert.equal(env.timestamp, 1_700_000_000);
    assert.deepEqual(env.payload, { tokens: 100 });
    assert.equal(env.deliveryStatus, 'pending');
  });

  it('auto-generates eventId when omitted', () => {
    const env = buildEnvelope('health_check', 'api', {});
    assert.equal(typeof env.eventId, 'string');
    assert.ok(env.eventId.length > 0);
  });

  it('defaults timestamp to current unix seconds when omitted', () => {
    const before = Math.floor(Date.now() / 1000);
    const env = buildEnvelope('health_check', 'api', {});
    const after = Math.floor(Date.now() / 1000);
    assert.ok(env.timestamp >= before);
    assert.ok(env.timestamp <= after);
  });
});

// ---------------------------------------------------------------------------
// EventDispatcher
// ---------------------------------------------------------------------------

describe('EventDispatcher — emit and subscribe', () => {
  it('emit fans out to subscriber', () => {
    const d = new EventDispatcher();
    const received: EventEnvelope[] = [];
    d.subscribe(e => received.push(e));
    d.emit(buildEnvelope('usage_metered', 'test', {}, 1_000_000, 'e1'));
    assert.equal(received.length, 1);
    assert.equal(received[0].eventId, 'e1');
  });

  it('emit marks deliveryStatus as delivered', () => {
    const d = new EventDispatcher();
    d.emit(buildEnvelope('usage_metered', 'test', {}, 1_000_000, 'e2'));
    assert.equal(d.latest()[0].deliveryStatus, 'delivered');
  });

  it('subscribe returns unsubscribe function', () => {
    const d = new EventDispatcher();
    const calls: number[] = [];
    const unsub = d.subscribe(() => calls.push(1));
    d.emit(buildEnvelope('health_check', 'test', {}, 1_000_000, 'e3'));
    unsub();
    d.emit(buildEnvelope('health_check', 'test', {}, 1_000_000, 'e4'));
    assert.equal(calls.length, 1); // second emit not received
  });

  it('subscriber errors are swallowed (do not break dispatch)', () => {
    const d = new EventDispatcher();
    d.subscribe(() => { throw new Error('subscriber explosion'); });
    assert.doesNotThrow(() => d.emit(buildEnvelope('health_check', 'test', {}, 1_000_000, 'e5')));
    assert.equal(d.size, 1);
  });
});

describe('EventDispatcher — latest and buffer', () => {
  it('latest() returns last N events', () => {
    const d = new EventDispatcher();
    for (let i = 0; i < 5; i++) {
      d.emit(buildEnvelope('usage_metered', 'test', {}, 1_000_000, `e${i}`));
    }
    assert.equal(d.latest(3).length, 3);
    assert.equal(d.latest(3)[2].eventId, 'e4'); // last one
  });

  it('buffer respects maxSize (oldest dropped when full)', () => {
    const d = new EventDispatcher(3);
    for (let i = 0; i < 5; i++) {
      d.emit(buildEnvelope('usage_metered', 'test', {}, 1_000_000, `e${i}`));
    }
    assert.equal(d.size, 3);
    // First two were dropped; buffer contains e2, e3, e4
    const ids = d.latest(10).map(e => e.eventId);
    assert.deepEqual(ids, ['e2', 'e3', 'e4']);
  });

  it('reset clears buffer but keeps subscribers', () => {
    const d = new EventDispatcher();
    d.emit(buildEnvelope('health_check', 'test', {}, 1_000_000, 'ex'));
    let subCalled = false;
    d.subscribe(() => { subCalled = true; });
    d.reset();
    assert.equal(d.size, 0);
    // Subscriber still active after reset
    d.emit(buildEnvelope('health_check', 'test', {}, 1_000_000, 'ey'));
    assert.equal(subCalled, true);
  });
});

// ---------------------------------------------------------------------------
// GET /events/latest route
// ---------------------------------------------------------------------------

describe('GET /events/latest — route smoke', () => {
  beforeEach(() => { getDispatcher().reset(); });

  it('returns 200 with ok=true and events array', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/events/latest'), res);
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.events));
  });

  it('reflects emitted events in response', async () => {
    getDispatcher().emit(buildEnvelope('usage_metered', 'provider:openai', { totalTokens: 50 }, 1_000_000, 'r1'));
    const res = mockRes();
    await handleRequest(mockReq('GET', '/events/latest'), res);
    const body = JSON.parse(res.body);
    assert.equal(body.events.length, 1);
    assert.equal(body.events[0].eventId, 'r1');
    assert.equal(body.events[0].deliveryStatus, 'delivered');
  });
});
