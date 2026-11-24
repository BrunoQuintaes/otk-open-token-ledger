/**
 * F-FPS5-01 (revisão independente de 02/10): the intervention queue must stay readable after an interrupted
 * write. Before the fix, a torn final line fused with the next appended entry and openInterventions()
 * silently skipped the fused line, so an intact, acknowledged entry (incl. one transferred by replay(),
 * which had already removed it from the live spool) became inaccessible. Synthetic records only, in fresh
 * temporary directories; no database.
 *
 * Gates: torn tail → restart → new append; transfer through replay(); torn resolution → restart → new
 * entry; reading with visible corruption (and recovery of entries already fused by the old code, checked by
 * sha256); failure to persist keeps the source record live.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { MeasurementSpool, type SpoolRecord } from '../../src/operations/spool.js';

const fresh = (label: string) => mkdtempSync(path.join(tmpdir(), `otk-fps5-ivq-${label}-`));
const rec = (id: string): SpoolRecord => ({ v: 1, id, key: { tenantId: 'synthetic', operationId: id }, patch: { outcome: 'completed' }, localCount: null, enqueue: [], at: '2026-10-02T12:00:00.000Z' });
const TORN = '{"v":1,"kind":"intervention","id":"torn';
const ids = (s: MeasurementSpool) => s.openInterventions().map((e) => e.id);

describe('F-FPS5-01 — intervention queue survives an interrupted write', () => {
  it('torn tail → restart → new append: the new entry is accessible and the torn bytes stay, visible and traceable', () => {
    const dir = fresh('tail');
    new MeasurementSpool(dir, 'i').recordIntervention(rec('before'), 'synthetic permanent error', 'live');
    appendFileSync(new MeasurementSpool(dir, 'i').interventionFile, TORN); // crash in the middle of the next write
    const restarted = new MeasurementSpool(dir, 'i');
    restarted.recordIntervention(rec('after-restart'), 'synthetic permanent error', 'live');
    assert.deepEqual(ids(restarted), ['before', 'after-restart']);
    assert.ok(restarted.openInterventions().every((e) => e.intact));
    const bytes = readFileSync(restarted.interventionFile, 'utf8');
    assert.ok(bytes.includes(TORN), 'the defective bytes are preserved, not deleted');
    const h = restarted.inspectInterventions();
    assert.equal(h.corrupt.length, 1, 'corruption is reported, not ignored');
    assert.equal(h.corrupt[0]!.sha256, createHash('sha256').update(TORN).digest('hex'));
    assert.equal(bytes.slice(h.corrupt[0]!.offset, h.corrupt[0]!.offset + h.corrupt[0]!.length), TORN);
    assert.equal(h.tornTail, null, 'the tail was closed before appending');
  });

  it('transfer through replay(): a record moved after a torn tail is accessible; it leaves the live spool only then', async () => {
    const dir = fresh('replay');
    const first = new MeasurementSpool(dir, 'r');
    first.recordIntervention(rec('replay-before'), 'synthetic permanent error', 'replay');
    appendFileSync(first.interventionFile, TORN);
    const restarted = new MeasurementSpool(dir, 'r');
    const { v: _v, at: _at, ...live } = rec('replay-after-restart');
    restarted.append(live);
    const res = await restarted.replay(async () => ({ intervention: 'synthetic permanent error' }));
    assert.deepEqual(res, { applied: 0, already: 0, left: 0, corrupt: 0, intervention: 1 });
    assert.deepEqual(restarted.pending(), []);
    assert.deepEqual(ids(restarted), ['replay-before', 'replay-after-restart'], 'the transferred record is still reachable for re-application');
    const moved = restarted.openInterventions().find((e) => e.id === 'replay-after-restart')!;
    assert.equal(moved.intact, true);
    assert.equal(moved.source, 'replay');
  });

  it('torn resolution → restart → new entry: the unresolved entry stays open (resolution was never durable), the new one is accessible', () => {
    const dir = fresh('resolution');
    const q = new MeasurementSpool(dir, 'z');
    q.recordIntervention(rec('a'), 'synthetic permanent error', 'live');
    appendFileSync(q.interventionFile, '{"v":1,"kind":"resolved","id":"a","at":"2026-10'); // crash while resolving 'a'
    const restarted = new MeasurementSpool(dir, 'z');
    restarted.recordIntervention(rec('b'), 'synthetic permanent error', 'live');
    assert.deepEqual(ids(restarted), ['a', 'b']);
    restarted.markResolved('a', 'applied'); // re-applying is idempotent in the store; the resolution is now durable
    assert.deepEqual(ids(new MeasurementSpool(dir, 'z')), ['b']);
    assert.equal(new MeasurementSpool(dir, 'z').inspectInterventions().corrupt.length, 1);
  });

  it('entries already fused by the previous code are recovered when their sha256 checks, and the corruption is reported', () => {
    const dir = fresh('legacy');
    const q = new MeasurementSpool(dir, 'l');
    const entry = (r: SpoolRecord) => ({ v: 1, kind: 'intervention', id: r.id, record: r, reason: 'synthetic', source: 'live', detectedAt: '2026-10-02T12:00:00.000Z',
      sha256: createHash('sha256').update(JSON.stringify(r)).digest('hex') });
    const tampered = { ...entry(rec('tampered')), record: { ...rec('tampered'), patch: { outcome: 'changed' } } };
    // exactly what the old appendLine produced: torn bytes + next full line on the same line
    writeFileSync(q.interventionFile, `${JSON.stringify(entry(rec('ok-1')))}\n${TORN}${JSON.stringify(entry(rec('fused')))}\n${TORN}${JSON.stringify(tampered)}\n`);
    const open = q.openInterventions();
    assert.deepEqual(open.map((e) => [e.id, e.intact]), [['ok-1', true], ['fused', true], ['tampered', false]], 'fused entries are reachable; integrity decides, as for any line');
    const h = q.inspectInterventions();
    assert.equal(h.corrupt.length, 2);
    assert.ok(h.corrupt.every((c) => c.recovered === true && c.reason === 'json'));
  });

  // M24-R03 (RUN-M1-24H): the write failure is injected with chmod 0444, which root ignores (Linux containers often run
  // as root); there the fault cannot be injected, so the case is skipped with the reason instead of failing.
  it('failure to persist the transfer keeps the source record in the live spool (no loss, no partial move)',
    { skip: process.getuid?.() === 0 && 'running as root: chmod 0444 does not make the file unwritable, the fault cannot be injected' }, async () => {
    const dir = fresh('fail');
    const s = new MeasurementSpool(dir, 'f');
    s.recordIntervention(rec('pre'), 'synthetic permanent error', 'live');
    appendFileSync(s.interventionFile, TORN);
    chmodSync(s.interventionFile, 0o444); // the queue cannot be written (nor its torn tail closed)
    try {
      const { v: _v, at: _at, ...live } = rec('keep-me');
      s.append(live);
      const res = await s.replay(async () => ({ intervention: 'synthetic permanent error' }));
      assert.deepEqual(res, { applied: 0, already: 0, left: 1, corrupt: 0, intervention: 0 });
      assert.deepEqual(s.pending().map((r) => r.id), ['keep-me']);
    } finally { chmodSync(s.interventionFile, 0o644); }
    const res2 = await s.replay(async () => ({ intervention: 'synthetic permanent error' }));
    assert.equal(res2.intervention, 1);
    assert.deepEqual(ids(s), ['pre', 'keep-me']);
  });

  // ADV-M24-13 (RUN-M1-24H adversarial review): the same property with a fault that root cannot bypass. The queue path
  // is replaced by a directory, so every read or append of it fails for any user, on every OS; the real file is moved
  // aside and put back afterwards.
  it('failure to persist the transfer keeps the source record, with a fault that also holds for root', async () => {
    const dir = fresh('faildir');
    const s = new MeasurementSpool(dir, 'd');
    s.recordIntervention(rec('pre'), 'synthetic permanent error', 'live');
    const aside = `${s.interventionFile}.aside`;
    renameSync(s.interventionFile, aside);
    mkdirSync(s.interventionFile);
    try {
      const { v: _v, at: _at, ...live } = rec('keep-me');
      s.append(live);
      const res = await s.replay(async () => ({ intervention: 'synthetic permanent error' }));
      assert.deepEqual(res, { applied: 0, already: 0, left: 1, corrupt: 0, intervention: 0 });
      assert.deepEqual(s.pending().map((r) => r.id), ['keep-me']);
    } finally {
      rmdirSync(s.interventionFile);
      renameSync(aside, s.interventionFile);
    }
    const res2 = await s.replay(async () => ({ intervention: 'synthetic permanent error' }));
    assert.equal(res2.intervention, 1);
    assert.deepEqual(ids(s), ['pre', 'keep-me']);
  });

  it('the quarantine evidence file gets the same protection (a torn evidence line never swallows the next one)', () => {
    const dir = fresh('quar');
    const s = new MeasurementSpool(dir, 'q');
    writeFileSync(s.file, '{"v":1,"id":"crash1'); // torn live tail #1
    const { v: _v, at: _at, ...live } = rec('x1');
    s.append(live); // quarantines tail #1
    appendFileSync(s.quarantineFile, '{"kind":"torn_tail","detected'); // crash while writing evidence
    writeFileSync(s.file, `${readFileSync(s.file, 'utf8')}{"v":1,"id":"crash2`); // torn live tail #2
    const { v: _v2, at: _at2, ...live2 } = rec('x2');
    s.append(live2); // quarantines tail #2
    const lines = readFileSync(s.quarantineFile, 'utf8').split('\n').filter(Boolean);
    const parsed = lines.flatMap((l) => { try { return [JSON.parse(l) as { kind: string; rawBase64: string }]; } catch { return []; } });
    assert.equal(parsed.length, 2, 'both evidence records are readable');
    assert.deepEqual(parsed.map((p) => Buffer.from(p.rawBase64, 'base64').toString()), ['{"v":1,"id":"crash1', '{"v":1,"id":"crash2']);
    assert.deepEqual(s.pending().map((r) => r.id), ['x1', 'x2']);
  });
});
