/**
 * Tests — ReconciliationSystem (RB-054) — QA1 edge cases
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../../src/economics/ReconciliationSystem.js';

describe('ReconciliationSystem — reconcile', () => {
  it('empty inputs → zero totals', () => {
    const r = reconcile([], []);
    assert.equal(r.totalOTK, 0);
    assert.equal(r.totalExternal, 0);
    assert.equal(r.matched, 0);
    assert.equal(r.otkOnly, 0);
    assert.equal(r.externalOnly, 0);
    assert.equal(r.items.length, 0);
  });

  it('matched records', () => {
    const otk = [{ txHash: 'tx1', userId: 'u1', costUnits: 100n, epoch: 1 }];
    const ext = [{ txHash: 'tx1', userId: 'u1', billedUsd: 0.10 }];
    const r = reconcile(otk, ext);
    assert.equal(r.matched, 1);
    assert.equal(r.otkOnly, 0);
    assert.equal(r.externalOnly, 0);
    assert.equal(r.items[0]?.status, 'matched');
    assert.equal(r.items[0]?.otkCU, 100n);
    assert.equal(r.items[0]?.externalUsd, 0.10);
  });

  it('otk_only record', () => {
    const otk = [{ txHash: 'tx2', userId: 'u2', costUnits: 200n, epoch: 2 }];
    const r = reconcile(otk, []);
    assert.equal(r.otkOnly, 1);
    assert.equal(r.matched, 0);
    assert.equal(r.externalOnly, 0);
    assert.equal(r.items[0]?.status, 'otk_only');
    assert.equal(r.items[0]?.externalUsd, null);
  });

  it('external_only record', () => {
    const ext = [{ txHash: 'tx3', userId: 'u3', billedUsd: 5.0 }];
    const r = reconcile([], ext);
    assert.equal(r.externalOnly, 1);
    assert.equal(r.matched, 0);
    assert.equal(r.otkOnly, 0);
    assert.equal(r.items[0]?.status, 'external_only');
    assert.equal(r.items[0]?.otkCU, null);
  });

  it('totals reflect input lengths independently', () => {
    const otk = [
      { txHash: 'tx1', userId: 'u1', costUnits: 100n, epoch: 1 },
      { txHash: 'tx2', userId: 'u2', costUnits: 200n, epoch: 2 },
    ];
    const ext = [
      { txHash: 'tx1', userId: 'u1', billedUsd: 0.10 },
    ];
    const r = reconcile(otk, ext);
    assert.equal(r.totalOTK, 2);
    assert.equal(r.totalExternal, 1);
    assert.equal(r.matched, 1);
    assert.equal(r.otkOnly, 1);
  });

  it('receipts sharing a txHash are aggregated without loss (R06)', () => {
    // Previously a Map keyed by txHash kept only the last receipt (999n), silently
    // dropping 100 CU. A batch transaction legitimately carries several receipts.
    const otk = [
      { txHash: 'dup', userId: 'u1', costUnits: 100n, epoch: 1, receiptId: 'r-a' },
      { txHash: 'dup', userId: 'u1', costUnits: 999n, epoch: 2, receiptId: 'r-b' },
    ];
    const ext = [{ txHash: 'dup', userId: 'u1', billedUsd: 1.0 }];
    const r = reconcile(otk, ext);
    assert.equal(r.matched, 1);
    assert.equal(r.items.length, 1);
    const item = r.items.find(i => i.txHash === 'dup');
    assert.equal(item?.otkCU, 1099n);
    assert.equal(item?.otkReceiptCount, 2);
    assert.deepEqual(item?.receiptIds, ['r-a', 'r-b']);
    assert.deepEqual(item?.epochs, [1, 2]);
  });
});

// --- ARCH2: determinism tests ---
describe('ReconciliationSystem — determinism', () => {
  it('deterministic generatedAt when nowIso provided', () => {
    const r = reconcile([], [], '2026-01-01T00:00:00Z');
    assert.equal(r.generatedAt, '2026-01-01T00:00:00Z');
  });

  it('same nowIso + same inputs → identical report structure', () => {
    const otk = [{ txHash: 'tx1', userId: 'u1', costUnits: 100n, epoch: 1 }];
    const ext = [{ txHash: 'tx1', userId: 'u1', billedUsd: 1.0 }];
    const r1 = reconcile(otk, ext, '2026-06-01T00:00:00Z');
    const r2 = reconcile(otk, ext, '2026-06-01T00:00:00Z');
    assert.equal(r1.generatedAt, r2.generatedAt);
    assert.equal(r1.matched, r2.matched);
  });
});
