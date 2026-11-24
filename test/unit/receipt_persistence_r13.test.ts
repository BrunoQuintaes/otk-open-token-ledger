/**
 * R13 — a receipt is acknowledged only after the synchronous durable write succeeds.
 *
 * OTK_RECEIPT_LOG points into a directory that does not exist yet, so appendFileSync
 * fails (ENOENT) until the test creates it. No database or network is used.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RawReceipt } from '../../src/types/receipt.js';

const dir = path.join(mkdtempSync(path.join(tmpdir(), 'otk-r13-')), 'not-created-yet');
const LOG = path.join(dir, 'receipts.jsonl');
process.env['OTK_RECEIPT_LOG'] = LOG;
process.env['OTK_DB_URL'] = '';
process.env['PROVER_URL'] = 'disabled';
delete process.env['OTK_TENANTS'];

let store: typeof import('../../src/api/receiptStore.js');
let talRuntime: typeof import('../../src/security/talRuntime.js');
let routes: typeof import('../../src/api/routes.js');
let deriveEpoch: (ts: number) => bigint;

before(async () => {
  store = await import('../../src/api/receiptStore.js');
  talRuntime = await import('../../src/security/talRuntime.js');
  routes = await import('../../src/api/routes.js');
  deriveEpoch = (await import('../../src/types/receipt.js')).deriveEpoch;
});

const TS = 1700000000;
const receipt = (requestId: string): RawReceipt => ({
  provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 2000, costUnits: 3000,
  latencyMs: 10, timestamp: TS, requestId, userId: 1n, nonce: 1n,
});

function mockReq(method: string, url: string, body = ''): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers: {} }) as unknown as IncomingMessage;
  process.nextTick(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); });
  return req;
}
function mockRes(): ServerResponse & { body: string } {
  let body = '';
  return { statusCode: 200, setHeader: () => {}, end: (d: string) => { body = d; }, get body() { return body; } } as unknown as ServerResponse & { body: string };
}

describe('R13 — persist before acknowledging', () => {
  it('reports jsonl-sync as the durability mode', () => {
    assert.deepEqual(store.persistenceStatus(), { mode: 'jsonl-sync', durableBeforeAck: true, pgWriteFailures: 0 });
  });

  it('a failed write is not acknowledged and leaves no side effect', () => {
    const r = receipt('r13-fail');
    assert.deepEqual(store.storeReceipt(r, 't13'), { stored: false, reason: 'persistence_failed' });
    assert.equal(store.getReceipt('r13-fail'), undefined, 'not in memory');
    assert.equal(talRuntime.getAccountingLayer().balance('t13', String(deriveEpoch(TS))).entryCount, 0, 'not debited');
    // the same requestId can be retried once storage is back (not marked duplicate)
    mkdirSync(dir, { recursive: true });
    assert.deepEqual(store.storeReceipt(r, 't13'), { stored: true });
    const lines = readFileSync(LOG, 'utf-8').split('\n').filter(Boolean);
    assert.equal(lines.length, 1);
    assert.equal(JSON.parse(lines[0]!).requestId, 'r13-fail');
    assert.equal(talRuntime.getAccountingLayer().balance('t13', String(deriveEpoch(TS))).totalCU, 3000n);
  });

  it('POST /receipts answers 503 (not 200 "duplicate") when the write fails', async () => {
    // RECEIPT_LOG is fixed at module load; removing its directory makes the next write fail
    const { rmSync } = await import('node:fs');
    rmSync(dir, { recursive: true, force: true });
    const res = mockRes();
    await routes.handleRequest(mockReq('POST', '/receipts', JSON.stringify({
      requestId: 'r13-http', provider: 'openai', model: 'gpt-4o', inputTokens: 1, outputTokens: 1,
      costUnits: 1, timestamp: TS, userId: '1', nonce: '2',
    })), res);
    assert.equal(res.statusCode, 503);
    assert.equal(store.getReceipt('r13-http'), undefined);
  });
});
