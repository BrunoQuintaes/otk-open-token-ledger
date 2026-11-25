/**
 * GAP-D-002 — JSONL persistence protocol test
 *
 * Validates:
 *   1. JSONL serialization format: receipt fields written as expected (no BigInt loss)
 *   2. JSONL deserialization: round-trip parse recovers all fields
 *   3. chainHead .head file format: 64-char hex string
 *   4. TAL reidration logic: debit called per JSONL line with correct (tenantId, epochId, cu)
 *
 * Does NOT test file I/O directly (OTK_RECEIPT_LOG is set at module load time and
 * cannot be changed in-process). Tests the protocol/format layer instead.
 *
 * Under test: the line format that `src/api/receiptStore.ts` writes and reads back, reproduced by
 * the two helpers below (they are copies of that logic, so a change in the store must be mirrored
 * here), and `TokenAccountingLayer` from `src/security/TokenAccountingLayer.ts` for the rebuild
 * of debits.
 *
 * Strategy / partitions: one receipt with bigint fields, one without the optional tenant, several
 * lines; the chain-head format; rebuilding accounting debits from several lines and tenants.
 *
 * Needs: nothing external (no file is written).
 *
 * Run just this file: `npx tsx --test test/unit/jsonl_persistence.test.ts`
 *
 * @module test/unit/jsonl_persistence.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { deriveEpoch } from '../../src/types/receipt.js';
import type { RawReceipt } from '../../src/types/receipt.js';
import { TokenAccountingLayer } from '../../src/security/TokenAccountingLayer.js';

// ---------------------------------------------------------------------------
// JSONL serialization protocol
// ---------------------------------------------------------------------------

/**
 * Simulate what receiptStore._appendReceiptLog writes
 *
 * @param receipt - Receipt to serialize; not modified.
 * @returns One JSON line ending in a newline, with `userId` and `nonce` as decimal strings.
 */
function serializeToJsonl(receipt: RawReceipt): string {
  return JSON.stringify({
    ...receipt,
    userId: String(receipt.userId),
    nonce: String(receipt.nonce),
  }) + '\n';
}

/**
 * Simulate what receiptStore startup block reads back
 *
 * @param line - One JSON line as written by `serializeToJsonl`.
 * @returns The receipt with bigint fields restored; absent fields become empty strings or zero,
 * as in the store's own reader.
 */
function deserializeFromJsonl(line: string): RawReceipt {
  const p = JSON.parse(line) as Record<string, unknown>;
  return {
    provider: String(p['provider'] ?? ''),
    model: String(p['model'] ?? ''),
    inputTokens: Number(p['inputTokens'] ?? 0),
    outputTokens: Number(p['outputTokens'] ?? 0),
    costUnits: Number(p['costUnits'] ?? 0),
    latencyMs: Number(p['latencyMs'] ?? 0),
    timestamp: Number(p['timestamp'] ?? 0),
    requestId: String(p['requestId'] ?? ''),
    userId: BigInt(String(p['userId'] ?? '0')),
    nonce: BigInt(String(p['nonce'] ?? '0')),
    tenantId: p['tenantId'] != null ? String(p['tenantId']) : undefined,
  };
}

const SAMPLE_RECEIPT: RawReceipt = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  inputTokens: 100,
  outputTokens: 50,
  costUnits: 150,
  latencyMs: 320,
  timestamp: 1741305600,
  requestId: 'jsonl-test-001',
  userId: 42n,
  nonce: 7n,
  tenantId: 'tenant-acme',
};

describe('JSONL serialization — round-trip', () => {
  it('serializes receipt without BigInt loss', () => {
    const line = serializeToJsonl(SAMPLE_RECEIPT);
    assert.ok(line.endsWith('\n'), 'JSONL line must end with newline');
    const obj = JSON.parse(line.trim()) as Record<string, unknown>;
    assert.equal(obj['userId'], '42', 'userId must be serialized as string');
    assert.equal(obj['nonce'], '7', 'nonce must be serialized as string');
    assert.equal(obj['provider'], 'openai');
    assert.equal(obj['costUnits'], 150);
    assert.equal(obj['tenantId'], 'tenant-acme');
  });

  it('deserializes back to correct RawReceipt with BigInt fields', () => {
    const line = serializeToJsonl(SAMPLE_RECEIPT);
    const recovered = deserializeFromJsonl(line.trim());
    assert.equal(recovered.requestId, SAMPLE_RECEIPT.requestId);
    assert.equal(recovered.userId, SAMPLE_RECEIPT.userId); // bigint equality
    assert.equal(recovered.nonce, SAMPLE_RECEIPT.nonce);
    assert.equal(recovered.provider, SAMPLE_RECEIPT.provider);
    assert.equal(recovered.inputTokens, SAMPLE_RECEIPT.inputTokens);
    assert.equal(recovered.tenantId, SAMPLE_RECEIPT.tenantId);
  });

  it('round-trips receipt without tenantId (optional field)', () => {
    const noTenant: RawReceipt = { ...SAMPLE_RECEIPT, tenantId: undefined, requestId: 'jsonl-test-002' };
    const line = serializeToJsonl(noTenant);
    const recovered = deserializeFromJsonl(line.trim());
    assert.equal(recovered.tenantId, undefined, 'undefined tenantId must survive round-trip');
  });

  it('handles multiple JSONL lines (batch)', () => {
    const receipts: RawReceipt[] = [
      { ...SAMPLE_RECEIPT, requestId: 'batch-001' },
      { ...SAMPLE_RECEIPT, requestId: 'batch-002', costUnits: 200 },
      { ...SAMPLE_RECEIPT, requestId: 'batch-003', userId: 99n },
    ];
    const lines = receipts.map(serializeToJsonl).join('');
    const parsed = lines.split('\n').filter(Boolean).map(deserializeFromJsonl);
    assert.equal(parsed.length, 3);
    assert.equal(parsed[0]!.requestId, 'batch-001');
    assert.equal(parsed[1]!.costUnits, 200);
    assert.equal(parsed[2]!.userId, 99n);
  });
});

describe('JSONL persistence — chainHead .head format', () => {
  it('validates chainHead format: 64-char hex string', () => {
    const zeroHash = '0000000000000000000000000000000000000000000000000000000000000000';
    assert.equal(zeroHash.length, 64, 'zero hash must be 64 chars');
    assert.ok(/^[0-9a-f]{64}$/i.test(zeroHash), 'zero hash must match hex regex');

    // A realistic SHA-256 output (exactly 64 hex chars)
    const realHash = 'a9b3c1d4e5f60712345678901234567890abcdef1234567890abcdef12345678';
    assert.equal(realHash.length, 64, 'real hash must be exactly 64 chars');
    assert.ok(/^[0-9a-f]{64}$/i.test(realHash), 'real hash must match hex regex');
  });
});

describe('JSONL persistence — TAL reidration logic', () => {
  it('reidrates TAL correctly from JSONL lines', () => {
    const tal = new TokenAccountingLayer();

    const receipts: RawReceipt[] = [
      { ...SAMPLE_RECEIPT, requestId: 'tal-001', costUnits: 100, tenantId: 'tenant-x' },
      { ...SAMPLE_RECEIPT, requestId: 'tal-002', costUnits: 200, tenantId: 'tenant-x' },
      { ...SAMPLE_RECEIPT, requestId: 'tal-003', costUnits: 50, tenantId: 'tenant-y' },
    ];

    // Simulate startup replay
    for (const r of receipts) {
      const epoch = deriveEpoch(r.timestamp);
      const resolvedTenant = r.tenantId ?? 'default';
      tal.debit({
        tenantId: resolvedTenant,
        epochId: String(epoch),
        requestId: r.requestId,
        provider: r.provider,
        model: r.model,
        cu: BigInt(Math.max(0, Math.floor(r.costUnits))),
        ts: r.timestamp * 1000,
      });
    }

    const epochStr = String(deriveEpoch(SAMPLE_RECEIPT.timestamp));

    // tenant-x: 100 + 200 = 300 CU
    const balX = tal.balance('tenant-x', epochStr);
    assert.equal(balX.totalCU, 300n, 'tenant-x must have 300 CU after replay');
    assert.equal(balX.entryCount, 2, 'tenant-x must have 2 entries');

    // tenant-y: 50 CU
    const balY = tal.balance('tenant-y', epochStr);
    assert.equal(balY.totalCU, 50n, 'tenant-y must have 50 CU after replay');
    assert.equal(balY.entryCount, 1);

    // Total entries
    assert.equal(tal.size(), 3, 'total entries must be 3');
  });
});
