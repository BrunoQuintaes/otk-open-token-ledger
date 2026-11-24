/**
 * Wave 2 Pack 14 — ReceiptArchive tests (E3.1)
 *
 * Tests the archive module at unit level without a real PostgreSQL instance.
 * Validates: constructor, isReady, graceful fallback, query result shapes,
 * getArchiveStats empty results, singleton pattern.
 *
 * @since Wave 2 Pack 14 (2026-03-15)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { ReceiptArchive, getReceiptArchive, resetArchiveForTest } from '../../src/archive/ReceiptArchive.js';

describe('E3.1 — ReceiptArchive (no real PG)', () => {
  beforeEach(() => {
    resetArchiveForTest();
    delete process.env['OTK_DB_URL'];
  });

  it('constructor creates instance with connection string', () => {
    const archive = new ReceiptArchive('postgres://localhost:5432/test');
    assert.ok(archive);
    assert.equal(archive.isReady, false, 'should not be ready before init');
  });

  it('isReady is false before init', () => {
    const archive = new ReceiptArchive('postgres://localhost:5432/test');
    assert.equal(archive.isReady, false);
  });

  it('archiveReceipt returns false when not initialized', async () => {
    const archive = new ReceiptArchive('postgres://localhost:5432/test');
    const result = await archive.archiveReceipt({
      provider: 'openai',
      model: 'gpt-4',
      inputTokens: 100,
      outputTokens: 50,
      costUnits: 10,
      latencyMs: 200,
      timestamp: 1700000000,
      requestId: 'req-1',
      userId: 1n,
      nonce: 0n,
    });
    assert.equal(result, false, 'should return false when pool is null');
  });

  it('queryReceipts returns empty when not initialized', async () => {
    const archive = new ReceiptArchive('postgres://localhost:5432/test');
    const result = await archive.queryReceipts({ tenantId: 'test' });
    assert.deepEqual(result.receipts, []);
    assert.equal(result.total, 0);
    assert.ok(result.query);
    assert.equal(result.query.tenantId, 'test');
  });

  it('getArchiveStats returns zeroed stats when not initialized', async () => {
    const archive = new ReceiptArchive('postgres://localhost:5432/test');
    const stats = await archive.getArchiveStats();
    assert.equal(stats.count, 0);
    assert.equal(stats.oldest, null);
    assert.equal(stats.newest, null);
  });

  it('close is safe on uninitialized archive', async () => {
    const archive = new ReceiptArchive('postgres://localhost:5432/test');
    await archive.close(); // should not throw
    assert.equal(archive.isReady, false);
  });

  it('getReceiptArchive returns null when OTK_DB_URL is not set', () => {
    delete process.env['OTK_DB_URL'];
    const archive = getReceiptArchive();
    assert.equal(archive, null);
  });

  it('getReceiptArchive returns instance when OTK_DB_URL is set', () => {
    process.env['OTK_DB_URL'] = 'postgres://localhost:5432/test';
    const archive = getReceiptArchive();
    assert.ok(archive instanceof ReceiptArchive);
    delete process.env['OTK_DB_URL'];
  });
});
