/**
 * RV-RUNS-02 (independent adversarial review of RUN-S, 2026-10-10; MEDIUM). With the PostgreSQL dead-letter store the
 * tenant view of /admin/dead-letters (list and counters) was computed over the 100 most recent entries of ALL tenants,
 * so another tenant could push a tenant's entries out of its own view. The tenant filter now runs in the store
 * (WHERE tenant_id = $n) and the counters are per tenant. Needs OTK_TEST_PG_URL (disposable test database).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { PgDeadLetterStore } from '../../src/infra/pg/PgDeadLetterStore.js';
import { setDeadLetterStore } from '../../src/api/IDeadLetterStore.js';
import { MemoryDeadLetterStore } from '../../src/api/IDeadLetterStore.js';
import { listDeadLetters, deadLetterCount, pendingCount } from '../../src/api/deadLetterStore.js';

let db: TestDb;
let store: PgDeadLetterStore;
const A = 'dlpg-tenant-a'; const B = 'dlpg-tenant-b';

before(async () => {
  db = await createTestDb('runs_dl_scope', { schema: false });
  store = new PgDeadLetterStore(db.pool as never);
  setDeadLetterStore(store);
  await store.add({ originalPayload: 'a-old', error: 'e', reason: 'validation_error', source: 'test', tenantId: A });
  for (let i = 0; i < 150; i++) await store.add({ originalPayload: `b-${i}`, error: 'e', reason: 'validation_error', source: 'test', tenantId: B });
});
after(async () => { setDeadLetterStore(new MemoryDeadLetterStore()); await db.drop(); });

describe('RV-RUNS-02: per-tenant dead-letters are not limited by a global window (PostgreSQL)', () => {
  it('the older entry of A is listed although 150 newer entries of B exist', async () => {
    const own = await listDeadLetters({ tenantId: A });
    assert.deepEqual(own.map((e) => e.originalPayload), ['a-old']);
  });
  it('counters are per tenant', async () => {
    assert.equal(await deadLetterCount(A), 1);
    assert.equal(await pendingCount(A), 1);
    assert.equal(await deadLetterCount(B), 150);
    assert.equal(await deadLetterCount(), 151);
  });
  it('a tenant list never contains another tenant', async () => {
    const own = await listDeadLetters({ tenantId: B, limit: 500 });
    assert.equal(own.length, 150);
    assert.ok(own.every((e) => e.tenantId === B));
  });
});
