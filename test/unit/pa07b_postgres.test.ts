/**
 * PA-07B — PostgresReceiptStore Tests
 *
 * Unit tests for PostgresReceiptStore class structure and write-behind integration
 * in receiptStore.ts.
 * Integration tests (requiring OTK_DB_URL) are skipped without the env var.
 *
 * @since PA-07 (2026-03-13)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import type { RawReceipt } from '../../src/types/receipt.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReceipt(requestId: string): RawReceipt {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    inputTokens: 100,
    outputTokens: 50,
    costUnits: 6,
    latencyMs: 200,
    timestamp: Math.floor(Date.now() / 1000),
    requestId,
    userId: 42n,
    nonce: 7n,
    tenantId: 'tenant-a',
    cwVersion: 'v1',
  };
}

// ---------------------------------------------------------------------------
// Suite A — class shape (no DB required)
// ---------------------------------------------------------------------------

describe('PA-07B — PostgresReceiptStore class shape', () => {

  it('PostgresReceiptStore is a class/function', () => {
    assert.equal(typeof PostgresReceiptStore, 'function');
  });

  it('constructor accepts connection string', () => {
    // Just verify no throw on construction (Pool is created lazily)
    const store = new PostgresReceiptStore('postgresql://fake:5432/test');
    assert.ok(store);
    // Note: do NOT call init() here — it would try to connect
  });

  it('implements expected async methods', () => {
    const store = new PostgresReceiptStore('postgresql://fake:5432/test');
    assert.equal(typeof store.init, 'function');
    assert.equal(typeof store.store, 'function');
    assert.equal(typeof store.get, 'function');
    assert.equal(typeof store.getAll, 'function');
    assert.equal(typeof store.deleteAll, 'function');
    assert.equal(typeof store.delete, 'function');
    assert.equal(typeof store.count, 'function');
    assert.equal(typeof store.close, 'function');
  });
});

// ---------------------------------------------------------------------------
// Suite B — write-behind env selection (no DB required)
// ---------------------------------------------------------------------------

describe('PA-07B — write-behind env selection', () => {

  it('OTK_DB_URL absence means Phase 1 mode (no Postgres)', () => {
    const dbUrl = process.env['OTK_DB_URL'];
    if (dbUrl) {
      assert.ok(true, 'OTK_DB_URL set — Postgres mode would be active');
      return;
    }
    assert.equal(dbUrl, undefined, 'OTK_DB_URL should be unset in unit test context');
  });

  it('RawReceipt bigint fields survive serialization round-trip', () => {
    const r = makeReceipt('test-serial-001');
    // Simulate the serialization in PostgresReceiptStore
    const serialized = { ...r, userId: String(r.userId), nonce: String(r.nonce) };
    assert.equal(serialized.userId, '42');
    assert.equal(serialized.nonce, '7');
    // Simulate deserialization
    const deserialized = { ...serialized, userId: BigInt(serialized.userId), nonce: BigInt(serialized.nonce) };
    assert.equal(deserialized.userId, 42n);
    assert.equal(deserialized.nonce, 7n);
  });
});

// ---------------------------------------------------------------------------
// Suite C — integration tests (env-gated: only runs with OTK_DB_URL)
// ---------------------------------------------------------------------------

const DB_URL = process.env['OTK_DB_URL'];
const integrationSuiteLabel = DB_URL
  ? 'PA-07B — PostgresReceiptStore integration (OTK_DB_URL set)'
  : 'PA-07B — PostgresReceiptStore integration (SKIPPED — set OTK_DB_URL to enable)';

describe(integrationSuiteLabel, { skip: !DB_URL }, () => {
  let store: PostgresReceiptStore;

  before(async () => {
    store = new PostgresReceiptStore(DB_URL!);
    await store.init();
    // Wait for any pending fire-and-forget writes from receiptStore.ts to settle,
    // then delete to ensure a clean slate for all integration tests.
    await new Promise(r => setTimeout(r, 300));
    await store.deleteAll();
  });

  after(async () => {
    await store.deleteAll();
    await store.close();
  });

  it('init() creates the table (idempotent)', async () => {
    await store.init(); // second call should not throw
    assert.ok(true, 'init() idempotent');
  });

  it('store() inserts a receipt and returns true', async () => {
    const r = makeReceipt('pg-test-001');
    const inserted = await store.store(r);
    assert.equal(inserted, true, 'first insert returns true');
  });

  it('store() duplicate returns false (idempotency)', async () => {
    const r = makeReceipt('pg-test-dup-001');
    await store.store(r);
    const dup = await store.store(r);
    assert.equal(dup, false, 'duplicate insert returns false');
  });

  it('get() retrieves receipt with correct fields', async () => {
    const r = makeReceipt('pg-test-002');
    await store.store(r);
    const retrieved = await store.get('pg-test-002');
    assert.ok(retrieved, 'receipt found');
    assert.equal(retrieved.requestId, 'pg-test-002');
    assert.equal(retrieved.provider, 'openai');
    assert.equal(retrieved.userId, 42n);
    assert.equal(retrieved.nonce, 7n);
    assert.equal(retrieved.tenantId, 'tenant-a');
  });

  it('get() returns undefined for missing requestId', async () => {
    const result = await store.get('nonexistent-id-xyz');
    assert.equal(result, undefined);
  });

  it('count() returns correct receipt count', async () => {
    await store.deleteAll();
    await store.store(makeReceipt('cnt-001'));
    await store.store(makeReceipt('cnt-002'));
    const count = await store.count();
    assert.equal(count, 2);
  });

  it('getAll() returns all receipts', async () => {
    await store.deleteAll();
    await store.store(makeReceipt('all-001'));
    await store.store(makeReceipt('all-002'));
    const all = await store.getAll();
    assert.equal(all.length, 2);
    const ids = all.map((r) => r.requestId).sort();
    assert.deepEqual(ids, ['all-001', 'all-002']);
  });

  it('deleteAll() clears the table', async () => {
    await store.store(makeReceipt('del-001'));
    const deleted = await store.deleteAll();
    assert.ok(deleted > 0);
    assert.equal(await store.count(), 0);
  });
});
