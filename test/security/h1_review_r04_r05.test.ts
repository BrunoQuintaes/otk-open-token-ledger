/**
 * H1 adversarial review (2026-10-13), findings R-04 and R-05 on src/auth/subjectStatus.ts.
 *   R-04 a deactivation whose store write FAILED was undone by the next refresh on the same replica (the store still had
 *        an older row inactive=false); failed writes were never retried in the background;
 *   R-05 flushSubjectStatus() drained a GLOBAL error list: with two concurrent deactivations, the caller whose write
 *        failed could get "ok" (and the other one the error).
 * In-memory store with an injectable write failure; no network.
 */
import { describe, it, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as ss from '../../src/auth/subjectStatus.js';

process.env['OTK_SUBJECT_STATUS_TTL_MS'] = '0';
const RUN = Date.now().toString(36);

class FlakyStore extends ss.MemorySubjectStatusStore {
  failFor = new Set<string>();
  override async put(rec: ss.SubjectStatusRecord): Promise<void> {
    if (this.failFor.has(rec.id)) throw new Error('connection terminated');
    return super.put(rec);
  }
}

let store: FlakyStore;
beforeEach(async () => {
  ss.resetSubjectStatusStoreForTest();
  store = new FlakyStore();
  assert.equal(await ss.setSubjectStatusStore(store), true);
});
after(() => ss.resetSubjectStatusStoreForTest());

describe('H1 R-04: a failed deactivation write is never undone by a refresh and is retried', () => {
  it('tenant with an old active row: write fails, refresh keeps it inactive; after recovery the store gets it', async () => {
    const T = `r04-${RUN}`;
    await store.put({ kind: 'tenant', id: T, inactive: false, notBeforeS: 0, keysNotBeforeS: 0 });   // old reactivation row
    await ss.syncSubjectStatusNow();
    assert.equal(ss.isTenantInactive(T), false, 'control: active');
    store.failFor.add(T);
    ss.markTenantInactive(T);
    assert.equal((await ss.flushSubjectStatus({ kind: 'tenant', id: T })).ok, false, 'the caller is told (503)');
    await ss.syncSubjectStatusNow();
    await ss.flushSubjectStatus();
    assert.equal(ss.isTenantInactive(T), true, 'the old store row must not reactivate the tenant on this replica');
    store.failFor.delete(T);
    // background retry of the unconfirmed write: a refresh already in flight (idle timer) is shared, so the retry lands
    // on the next refresh at the latest (bounded by OTK_SUBJECT_STATUS_TTL_MS)
    for (let i = 0; i < 2; i++) { await ss.syncSubjectStatusNow(); await ss.flushSubjectStatus(); }
    const row = (await store.listAll()).find((r) => r.id === T);
    assert.equal(row?.inactive, true, 'the deactivation reaches the shared store without a new admin call');
    assert.equal(ss.isTenantInactive(T), true);
  });
});

describe('H1 R-05: each caller gets the outcome of its own write', () => {
  it('two concurrent deactivations, only T1 fails: T1 not ok, T2 ok — whichever flushes first', async () => {
    const T1 = `r05a-${RUN}`; const T2 = `r05b-${RUN}`;
    store.failFor.add(T1);
    ss.markTenantInactive(T1);
    ss.markTenantInactive(T2);
    const r2 = await ss.flushSubjectStatus({ kind: 'tenant', id: T2 });
    const r1 = await ss.flushSubjectStatus({ kind: 'tenant', id: T1 });
    assert.equal(r2.ok, true, 'T2 was written');
    assert.equal(r1.ok, false, 'T1 was not: its caller must answer 503');
  });
});
