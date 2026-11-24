/**
 * D1–D8 / C — D2-G06 (storage part) and D3-G02 restore: an isolated backup/restore of the D1–D8
 * tables (pg_dump/psql inside the C stack's PostgreSQL container) recovers the legitimate
 * openings, receipts, conferences and operations exactly; tenant B cannot read tenant A's
 * opening; the dump is a secret-bearing artefact (it contains openings) and is deleted after
 * the test — it is never written to the evidence folder.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { PgOpeningStore } from '../../src/operations/PgOpeningStore.js';
import { PgReceiptV3Store } from '../../src/operations/receiptV3Store.js';
import { PgOperationStore } from '../../src/operations/PgOperationStore.js';
import { createReceiptCryptoDouble, newCommitmentOpeningDouble } from '../fixtures/d1d8/c/doubles.js';
import { admitReq, conference, receiptV3, CU } from '../fixtures/d1d8/c/builders.js';

const CONTAINER = process.env['OTK_TEST_PG_CONTAINER'] ?? 'otk-d1d8-1625-c-postgres-1';
const TABLES = ['otk_operations', 'otk_quota_usage', 'otk_ledger', 'otk_outbox', 'otk_openings', 'otk_receipts_v3', 'otk_conferences'];
let src: TestDb; let dst: TestDb;

function docker(args: string[], input?: string) {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

before(async () => { src = await createTestDb('backup_src'); dst = await createTestDb('backup_dst', { schema: false }); });
after(async () => { await src.drop(); await dst.drop(); });

describe('D2-G06 / D3-G02: isolated backup and restore of the durable C tables', () => {
  it('openings, receipt v3 + conference and operations come back exactly; tenant scoping holds', async () => {
    const crypto = createReceiptCryptoDouble();
    const a = { tenantId: 'A', operationId: 'op' }; const b = { tenantId: 'B', operationId: 'op' };
    const openings = new PgOpeningStore(src.pool);
    const oa = newCommitmentOpeningDouble(a, CU(48n), 'metering_v3@test', { userRef: '7', epoch: '1' });
    const ob = newCommitmentOpeningDouble(b, CU(7n), 'metering_v3@test', { userRef: '8', epoch: '1' });
    await openings.put(oa); await openings.put(ob);
    const receipts = new PgReceiptV3Store(src.pool);
    const r = receiptV3(a);
    const d = crypto.digestReceipt(r);
    await receipts.putReceipt(r, await crypto.signReceipt(r), d);
    const rep = conference(a, d);
    await receipts.putConference(rep, await crypto.signConference(rep), crypto.digestConference(rep));
    const ops = new PgOperationStore(src.pool, { quotaFor: () => null, epochOf: () => 'e' });
    assert.equal((await ops.admit(admitReq(a, 10n))).outcome, 'admitted');

    const dump = docker(['exec', CONTAINER, 'pg_dump', '-U', 'otk', '--no-owner', ...TABLES.flatMap((t) => ['-t', t]), src.name]);
    assert.ok(dump.includes('otk_openings'));
    docker(['exec', '-i', CONTAINER, 'psql', '-U', 'otk', '-v', 'ON_ERROR_STOP=1', '-q', dst.name], dump);

    const ro = new PgOpeningStore(dst.pool);
    assert.deepEqual(await ro.get(a), oa);
    assert.deepEqual(await ro.get(b), ob);
    assert.equal(await ro.get({ tenantId: 'B', operationId: 'other' }), null);
    const rr = new PgReceiptV3Store(dst.pool);
    const back = await rr.getReceipt(a);
    assert.deepEqual(back?.receipt, r);
    assert.equal(crypto.verifyReceipt(back!.receipt, back!.envelope).ok, true);
    assert.deepEqual((await rr.getConference(a))?.report, rep);
    const rops = new PgOperationStore(dst.pool, { quotaFor: () => null, epochOf: () => 'e' });
    assert.equal((await rops.get(a))?.reservation.state, 'held');
    assert.equal(await rops.get({ tenantId: 'B', operationId: 'op' }), null, 'B has an opening but no operation: nothing mixed');
    // a restored opening still refuses a different secret for the same operation
    await assert.rejects(ro.put({ ...oa, blinding: '1' }));
  });
});
