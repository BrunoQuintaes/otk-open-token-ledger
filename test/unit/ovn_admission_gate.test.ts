/**
 * OVERNIGHT 20261005 / F-P1-04 — AdmissionGate: bound, arrival order, bounded wait, release on error.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AdmissionGate, AdmissionQueueTimeout } from '../../src/operations/admissionGate.js';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('AdmissionGate', () => {
  it('never runs more than `limit` at once and serves waiters in arrival order', async () => {
    const g = new AdmissionGate(2, 1_000);
    let running = 0; let peak = 0; const order: number[] = [];
    const releases: Array<() => void> = [];
    const jobs = Array.from({ length: 5 }, (_, i) => g.run(async () => {
      running++; peak = Math.max(peak, running); order.push(i);
      await new Promise<void>((r) => releases.push(r));
      running--;
    }));
    await tick();
    assert.equal(g.inFlight, 2); assert.equal(g.queued, 3);
    while (releases.length || g.inFlight) { releases.shift()?.(); await tick(); }
    await Promise.all(jobs);
    assert.equal(peak, 2);
    assert.deepEqual(order, [0, 1, 2, 3, 4]);
    assert.equal(g.maxQueued, 3);
  });

  it('a waiter that exceeds queueTimeoutMs is refused with AdmissionQueueTimeout and leaves the queue', async () => {
    const g = new AdmissionGate(1, 30);
    let release!: () => void;
    const first = g.run(() => new Promise<void>((r) => { release = r; }));
    await assert.rejects(g.run(async () => 'never'), AdmissionQueueTimeout);
    assert.equal(g.queued, 0);
    release(); await first;
    assert.equal(await g.run(async () => 'ok'), 'ok');
  });

  it('a failing job releases its slot', async () => {
    const g = new AdmissionGate(1, 1_000);
    await assert.rejects(g.run(async () => { throw new Error('boom'); }), /boom/);
    assert.equal(g.inFlight, 0);
    assert.equal(await g.run(async () => 1), 1);
  });

  it('refuses a non-positive limit', () => {
    assert.throws(() => new AdmissionGate(0, 1), RangeError);
  });
});
