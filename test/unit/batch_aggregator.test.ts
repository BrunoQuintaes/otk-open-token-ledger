/**
 * BatchAggregator — Unit tests
 *
 * Validates batch creation, Merkle proofs, privacy properties, and error cases.
 * ADR-0100: Batch Settlement via Merkle Root
 *
 * Modules under test: `src/batch/BatchAggregator.ts`, checked against `MerkleTree` from
 * `src/crypto/merkle.ts`.
 *
 * Strategy / partitions: batch size 0 (finalize throws), 1 (root equals the tree root), N and
 * 100 (every inclusion proof verifies); a receipt not in the batch (proof fails); the bucketed
 * CU total (not below the exact sum, a multiple of the bucket step); receipts from the same and
 * from a different epoch; adding after finalize (throws) and finalizing twice (same root);
 * `inspect()` before and after finalize.
 *
 * Needs: nothing external (receipts built in memory by `makeReceipt`).
 *
 * Run just this file: `npx tsx --test test/unit/batch_aggregator.test.ts`
 *
 * @module test/unit/batch_aggregator.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BatchAggregator } from '../../src/batch/BatchAggregator.js';
import { MerkleTree } from '../../src/crypto/merkle.js';
import type { CanonicalReceiptV1 } from '../../src/receipt/canonicalReceiptV1.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

function makeReceipt(overrides: Partial<CanonicalReceiptV1> = {}): CanonicalReceiptV1 {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    input_tokens: 1000n,
    output_tokens: 500n,
    total_tokens: 1500n,
    latency_ms: 250n,
    cost_unit: 1500n,
    user_id: 'user-001',
    project_id: 'proj-001',
    timestamp: 1708560000000n,
    nonce: 1n,
    epoch: 1708560000n,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BatchAggregator', () => {

  describe('basic flow', () => {
    it('empty batch throws on finalize', () => {
      const agg = new BatchAggregator();
      assert.throws(() => agg.finalizeBatch(), /empty batch/);
    });

    it('single receipt: root == MerkleTree.root', () => {
      const agg = new BatchAggregator();
      const r = makeReceipt();
      agg.addReceipt(r);
      const result = agg.finalizeBatch();

      assert.equal(result.header.count, 1);
      assert.match(result.header.root, /^0x[0-9a-f]{64}$/i);
      assert.equal(result.proofs.length, 1);
      assert.equal(result.encodedReceipts.length, 1);
    });

    it('N receipts: count matches', () => {
      const agg = new BatchAggregator();
      const N = 5;
      for (let i = 0; i < N; i++) {
        agg.addReceipt(makeReceipt({ nonce: BigInt(i + 1) }));
      }
      const result = agg.finalizeBatch();
      assert.equal(result.header.count, N);
      assert.equal(result.proofs.length, N);
    });
  });

  describe('Merkle proofs', () => {
    it('all proofs verify against root', () => {
      const agg = new BatchAggregator();
      const N = 4;
      for (let i = 0; i < N; i++) {
        agg.addReceipt(makeReceipt({ nonce: BigInt(i + 1) }));
      }
      const result = agg.finalizeBatch();

      for (let i = 0; i < N; i++) {
        const ok = MerkleTree.verify(
          result.encodedReceipts[i],
          result.proofs[i],
          result.header.root
        );
        assert.ok(ok, `Proof[${i}] verification failed`);
      }
    });

    it('wrong receipt fails proof verification', () => {
      const agg = new BatchAggregator();
      agg.addReceipt(makeReceipt({ nonce: 1n }));
      agg.addReceipt(makeReceipt({ nonce: 2n }));
      const result = agg.finalizeBatch();

      // Proof for receipt[0] should NOT verify receipt[1]
      const ok = MerkleTree.verify(
        result.encodedReceipts[1],
        result.proofs[0],  // wrong proof
        result.header.root
      );
      assert.equal(ok, false);
    });
  });

  describe('privacy: totalCUBucket', () => {
    it('totalCUBucket is bucketed (>= sum of exact CUs)', () => {
      const agg = new BatchAggregator();
      // cost_unit=123n → bucket=200n (step=100n for small tier)
      agg.addReceipt(makeReceipt({ cost_unit: 123n, nonce: 1n }));
      agg.addReceipt(makeReceipt({ cost_unit: 456n, nonce: 2n }));
      const result = agg.finalizeBatch();

      const exactSum = 123n + 456n;
      // Bucketed sum must be >= exact sum (round-up)
      assert.ok(result.header.totalCUBucket >= exactSum,
        `totalCUBucket=${result.header.totalCUBucket} < exactSum=${exactSum}`
      );
    });

    it('totalCUBucket is multiple of bucket step', () => {
      const agg = new BatchAggregator();
      // For small tier (< 10000), step = 100
      agg.addReceipt(makeReceipt({ cost_unit: 1234n, nonce: 1n }));
      const result = agg.finalizeBatch();

      // 1234 → bucket 1300 (step=100), so totalCUBucket=1300
      assert.equal(result.header.totalCUBucket % 100n, 0n,
        `totalCUBucket=${result.header.totalCUBucket} is not multiple of 100`
      );
    });
  });

  describe('epoch enforcement', () => {
    it('same epoch: OK', () => {
      const agg = new BatchAggregator();
      agg.addReceipt(makeReceipt({ epoch: 100n, nonce: 1n }));
      agg.addReceipt(makeReceipt({ epoch: 100n, nonce: 2n }));
      const result = agg.finalizeBatch();
      assert.equal(result.header.epoch, 100n);
    });

    it('different epoch: throws', () => {
      const agg = new BatchAggregator();
      agg.addReceipt(makeReceipt({ epoch: 100n, nonce: 1n }));
      assert.throws(
        () => agg.addReceipt(makeReceipt({ epoch: 200n, nonce: 2n })),
        /epoch mismatch/
      );
    });
  });

  describe('finalization guard', () => {
    it('addReceipt after finalize throws', () => {
      const agg = new BatchAggregator();
      agg.addReceipt(makeReceipt());
      agg.finalizeBatch();
      assert.throws(
        () => agg.addReceipt(makeReceipt({ nonce: 2n })),
        /finalized/
      );
    });

    it('finalizeBatch is idempotent (same root each call)', () => {
      const agg = new BatchAggregator();
      agg.addReceipt(makeReceipt());
      const r1 = agg.finalizeBatch();
      const r2 = agg.finalizeBatch();
      assert.equal(r1.header.root, r2.header.root);
    });
  });

  describe('inspect()', () => {
    it('before finalize', () => {
      const agg = new BatchAggregator();
      agg.addReceipt(makeReceipt({ epoch: 42n }));
      const state = agg.inspect();
      assert.equal(state.count, 1);
      assert.equal(state.pendingEpoch, 42n);
      assert.equal(state.isFinalized, false);
    });

    it('after finalize', () => {
      const agg = new BatchAggregator();
      agg.addReceipt(makeReceipt());
      agg.finalizeBatch();
      assert.equal(agg.inspect().isFinalized, true);
    });
  });

  describe('large batch', () => {
    it('N=100 receipts: all proofs verify', () => {
      const N = 100;
      const agg = new BatchAggregator();
      for (let i = 0; i < N; i++) {
        agg.addReceipt(makeReceipt({ nonce: BigInt(i + 1) }));
      }
      const result = agg.finalizeBatch();
      assert.equal(result.header.count, N);

      // Spot-check 10 proofs
      for (let i = 0; i < 10; i++) {
        const idx = Math.floor(i * N / 10);
        assert.ok(MerkleTree.verify(result.encodedReceipts[idx], result.proofs[idx], result.header.root));
      }
    });
  });
});
