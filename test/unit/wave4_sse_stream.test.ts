/**
 * W4-4F01 — SSE real-time stream tests (P5.2)
 *
 * Covers:
 *   1.  src/streaming/StreamManager.ts exists
 *   2.  src/streaming/SseRouter.ts exists
 *   3.  routes.ts has /v1/stream route
 *   4.  StreamManager.connect registers connection
 *   5.  StreamManager.disconnect removes connection
 *   6.  StreamManager.send writes SSE frame to response
 *   7.  SSE frame has correct event: + data: format
 *   8.  StreamManager.send fans out to multiple connections for same tenant
 *   9.  StreamManager.send '*' broadcasts to all tenants
 *  10.  StreamManager: connectionCount and tenantCount
 *  11.  StreamManager: getConnectionsForTenant returns correct subset
 *  12.  SseRouter exports SSE_EVENTS list
 *  13.  SSE_EVENTS includes receipt_submitted, proof_ready, chain_anchored
 *  14.  publishSseEvent routes to correct tenant
 *  15.  StreamManager: Last-Event-ID preserved on connection
 *
 * @since Wave 4 (4F-PACK-4F01 / P5.2)
 *
 * Modules under test: `src/streaming/StreamManager.ts` and `src/streaming/SseRouter.ts`; the route list in
 * `src/api/routes.ts` is checked as text.
 *
 * Strategy / partitions: as listed above (the numbering is the original plan, not the test order); one tenant
 * with one and several connections, several tenants, the broadcast target, and the last event id.
 *
 * Needs: nothing external; responses are in-memory mocks that record the written frames.
 *
 * Run just this file: `npx tsx --test test/unit/wave4_sse_stream.test.ts`
 *
 * @module test/unit/wave4_sse_stream.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

import { StreamManager, setStreamManager } from '../../src/streaming/StreamManager.js';
import { SSE_EVENTS, publishSseEvent } from '../../src/streaming/SseRouter.js';

// ──────────────────────────────────────────────────────────
// Mock ServerResponse for SSE
// ──────────────────────────────────────────────────────────

function makeSseRes(): http.ServerResponse & { written: string[]; headWritten: boolean; closed: boolean } {
  const chunks: string[] = [];
  let headWritten = false;
  let closed = false;
  const listeners: Record<string, Array<() => void>> = {};
  const res = {
    written: chunks,
    headWritten,
    closed,
    writeHead: (_status: number, _headers?: unknown) => { headWritten = true; },
    flushHeaders: () => {},
    write: (data: string) => { chunks.push(data); return true; },
    end: () => { closed = true; },
    on: (event: string, cb: () => void) => { listeners[event] = listeners[event] ?? []; listeners[event]!.push(cb); },
    emit: (event: string) => { (listeners[event] ?? []).forEach(fn => fn()); },
  } as unknown as http.ServerResponse & { written: string[]; headWritten: boolean; closed: boolean };
  return res;
}

// ──────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────

describe('W4-4F01 — File structure', () => {
  it('src/streaming/StreamManager.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/streaming/StreamManager.ts')));
  });

  it('src/streaming/SseRouter.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/streaming/SseRouter.ts')));
  });

  it('routes.ts has /v1/stream route', () => {
    const c = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(c.includes('/stream'));
  });
});

describe('W4-4F01 — SseRouter', () => {
  it('SSE_EVENTS includes all required event kinds', () => {
    assert.ok(SSE_EVENTS.includes('receipt_submitted'));
    assert.ok(SSE_EVENTS.includes('proof_ready'));
    assert.ok(SSE_EVENTS.includes('chain_anchored'));
  });

  it('SSE_EVENTS list has exactly 3 entries', () => {
    assert.strictEqual(SSE_EVENTS.length, 3);
  });
});

describe('W4-4F01 — StreamManager', () => {
  it('connect registers connection', () => {
    const mgr = new StreamManager({ pingIntervalMs: 60_000 });
    const res = makeSseRes();
    const conn = mgr.connect('tenant-1', res as any, null);
    assert.ok(conn.id.length > 0);
    assert.strictEqual(mgr.connectionCount, 1);
    assert.strictEqual(mgr.tenantCount, 1);
    mgr.disconnect(conn.id);
  });

  it('disconnect removes connection', () => {
    const mgr = new StreamManager({ pingIntervalMs: 60_000 });
    const res = makeSseRes();
    const conn = mgr.connect('t1', res as any, null);
    mgr.disconnect(conn.id);
    assert.strictEqual(mgr.connectionCount, 0);
    assert.strictEqual(mgr.tenantCount, 0);
  });

  it('send writes SSE frame to response', () => {
    const mgr = new StreamManager({ pingIntervalMs: 60_000 });
    const res = makeSseRes();
    const conn = mgr.connect('t1', res as any, null);
    mgr.send('t1', { event: 'receipt_submitted', data: { id: 'r1' } });
    assert.ok(res.written.some(w => w.includes('event: receipt_submitted')));
    assert.ok(res.written.some(w => w.includes('data:')));
    mgr.disconnect(conn.id);
  });

  it('SSE frame has correct format (id: / event: / data: / blank line)', () => {
    const mgr = new StreamManager({ pingIntervalMs: 60_000 });
    const res = makeSseRes();
    const conn = mgr.connect('t1', res as any, null);
    mgr.send('t1', { id: 'evt-001', event: 'proof_ready', data: { proof: 'abc' } });
    const frame = res.written.find(w => w.includes('event: proof_ready')) ?? '';
    assert.ok(frame.includes('id: evt-001'));
    assert.ok(frame.includes('event: proof_ready'));
    assert.ok(frame.includes('data:'));
    assert.ok(frame.endsWith('\n\n'));
    mgr.disconnect(conn.id);
  });

  it('send fans out to multiple connections for same tenant', () => {
    const mgr = new StreamManager({ pingIntervalMs: 60_000 });
    const res1 = makeSseRes();
    const res2 = makeSseRes();
    const c1 = mgr.connect('t1', res1 as any, null);
    const c2 = mgr.connect('t1', res2 as any, null);
    mgr.send('t1', { event: 'chain_anchored', data: {} });
    assert.ok(res1.written.some(w => w.includes('chain_anchored')));
    assert.ok(res2.written.some(w => w.includes('chain_anchored')));
    mgr.disconnect(c1.id);
    mgr.disconnect(c2.id);
  });

  it("send '*' broadcasts to all tenants", () => {
    const mgr = new StreamManager({ pingIntervalMs: 60_000 });
    const res1 = makeSseRes();
    const res2 = makeSseRes();
    const c1 = mgr.connect('tenant-A', res1 as any, null);
    const c2 = mgr.connect('tenant-B', res2 as any, null);
    mgr.send('*', { event: 'receipt_submitted', data: { x: 1 } });
    assert.ok(res1.written.some(w => w.includes('receipt_submitted')));
    assert.ok(res2.written.some(w => w.includes('receipt_submitted')));
    mgr.disconnect(c1.id);
    mgr.disconnect(c2.id);
  });

  it('connectionCount and tenantCount are correct', () => {
    const mgr = new StreamManager({ pingIntervalMs: 60_000 });
    const c1 = mgr.connect('t1', makeSseRes() as any, null);
    const c2 = mgr.connect('t1', makeSseRes() as any, null);
    const c3 = mgr.connect('t2', makeSseRes() as any, null);
    assert.strictEqual(mgr.connectionCount, 3);
    assert.strictEqual(mgr.tenantCount, 2);
    mgr.disconnect(c1.id);
    mgr.disconnect(c2.id);
    mgr.disconnect(c3.id);
  });

  it('getConnectionsForTenant returns correct subset', () => {
    const mgr = new StreamManager({ pingIntervalMs: 60_000 });
    const c1 = mgr.connect('t1', makeSseRes() as any, null);
    const c2 = mgr.connect('t1', makeSseRes() as any, null);
    const c3 = mgr.connect('t2', makeSseRes() as any, null);
    const t1Conns = mgr.getConnectionsForTenant('t1');
    assert.strictEqual(t1Conns.length, 2);
    mgr.disconnect(c1.id);
    mgr.disconnect(c2.id);
    mgr.disconnect(c3.id);
  });

  it('Last-Event-ID is preserved on connection', () => {
    const mgr = new StreamManager({ pingIntervalMs: 60_000 });
    const res = makeSseRes();
    const conn = mgr.connect('t1', res as any, 'evt-007');
    assert.strictEqual(conn.lastEventId, 'evt-007');
    mgr.disconnect(conn.id);
  });

  it('publishSseEvent routes to correct tenant via module singleton', () => {
    const mgr = new StreamManager({ pingIntervalMs: 60_000 });
    setStreamManager(mgr);
    const resA = makeSseRes();
    const resB = makeSseRes();
    const cA = mgr.connect('tenant-A', resA as any, null);
    const cB = mgr.connect('tenant-B', resB as any, null);
    publishSseEvent('tenant-A', 'proof_ready', { jobId: 'j1' });
    assert.ok(resA.written.some(w => w.includes('proof_ready')));
    assert.strictEqual(resB.written.filter(w => w.includes('proof_ready')).length, 0);
    mgr.disconnect(cA.id);
    mgr.disconnect(cB.id);
  });
});
