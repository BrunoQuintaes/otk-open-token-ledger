/**
 * D1–D8 / C — measurement spool (D7 §4, D7-G09): fsync'd JSONL, bounded, torn tail ignored,
 * records appended during a replay are kept, only numbers are written. No database here.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MeasurementSpool, SpoolFullError } from '../../src/operations/spool.js';
import { decodeFacts, type FinalFacts } from '../../src/operations/proxyDurable.js';
import { encodeJson } from '../../src/operations/codec.js';
import { usage } from '../fixtures/d1d8/c/builders.js';

const dir = () => mkdtempSync(path.join(tmpdir(), 'otkd1d8c-spool-unit-'));
const facts = (): FinalFacts => ({ outcome: 'completed', usage: usage(10n, 5n), cu: null, price: null, delivery: 'client_disconnected', providerRequestId: 'p', localCount: null, at: '2026-10-01T00:00:00.000Z' });
const rec = (id: string) => ({ id, key: { tenantId: 't', operationId: id }, patch: JSON.parse(encodeJson(facts())), localCount: null, enqueue: [] });

describe('D1D8-C measurement spool', () => {
  it('append is durable and bounded (refuses past maxEntries instead of growing)', () => {
    const s = new MeasurementSpool(dir(), 'inst/1', { maxEntries: 2 });
    s.append(rec('a')); s.append(rec('b'));
    assert.throws(() => s.append(rec('c')), SpoolFullError);
    assert.deepEqual(s.pending().map((r) => r.id), ['a', 'b']);
    assert.match(path.basename(s.file), /^spool-inst_1\.jsonl$/, 'instance id sanitised in the file name');
  });

  it('facts round trip exactly (bigint usage) and contain numbers only', () => {
    const s = new MeasurementSpool(dir(), 'i');
    s.append(rec('a'));
    assert.deepEqual(decodeFacts(s.pending()[0]!.patch), facts());
    assert.ok(!readFileSync(s.file, 'utf8').includes('content'), 'no message/response fields');
  });

  it('replay removes applied/already, keeps retry, keeps records appended meanwhile; torn tail ignored', async () => {
    const s = new MeasurementSpool(dir(), 'i');
    s.append(rec('a')); s.append(rec('b')); s.append(rec('c'));
    const res = await s.replay(async (r) => {
      if (r.id === 'a') { s.append(rec('late')); return 'applied'; }
      return r.id === 'b' ? 'already' : 'retry';
    });
    assert.deepEqual(res, { applied: 1, already: 1, left: 2, corrupt: 0, intervention: 0 }); // S4: result also counts quarantined corrupt lines (ABC-01)
    assert.deepEqual(s.pending().map((r) => r.id).sort(), ['c', 'late']);
    appendFileSync(s.file, '{"v":1,"id":"torn","key"');
    assert.deepEqual(s.pending().map((r) => r.id).sort(), ['c', 'late']);
    const again = await s.replay(async () => { throw new Error('db still down'); });
    assert.deepEqual(again, { applied: 0, already: 0, left: 2, corrupt: 0, intervention: 0 }, 'a failing apply keeps the record; the torn tail is quarantined, not counted as a record');
  });
});
