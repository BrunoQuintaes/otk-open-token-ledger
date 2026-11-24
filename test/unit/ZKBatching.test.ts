/**
 * ZK Batching Module — unit tests (no live proving)
 * Tests the interface contract, types, and gas savings model.
 * @since U12.1
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BATCHING_ENABLED,
  GAS_PER_ZK_RECEIPT,
  computeGasSavings,
  BatchError,
  BATCH_ERROR,
  type CircuitInput,
  type BatchProofResult,
} from '../../src/zk/batch/IBatchProver.js';
import { SequentialBatchProver } from '../../src/zk/batch/SequentialBatchProver.js';
import { PlaceholderBatchProver } from '../../src/zk/batch/PlaceholderBatchProver.js';

// ---------------------------------------------------------------------------
// Constants and types
// ---------------------------------------------------------------------------
describe('IBatchProver constants', () => {
  it('GAS_PER_ZK_RECEIPT matches measured value (290,620)', () => {
    assert.strictEqual(GAS_PER_ZK_RECEIPT, 290_620);
  });

  it('BATCHING_ENABLED is boolean', () => {
    assert.ok(typeof BATCHING_ENABLED === 'boolean');
  });

  it('BATCH_ERROR codes are stable strings', () => {
    assert.strictEqual(BATCH_ERROR.BATCH_EMPTY, 'BATCH_EMPTY');
    assert.strictEqual(BATCH_ERROR.BATCH_TOO_LARGE, 'BATCH_TOO_LARGE');
    assert.strictEqual(BATCH_ERROR.NOT_IMPLEMENTED, 'NOT_IMPLEMENTED');
    assert.strictEqual(BATCH_ERROR.PROVE_FAILED, 'PROVE_FAILED');
  });
});

// ---------------------------------------------------------------------------
// computeGasSavings
// ---------------------------------------------------------------------------
describe('computeGasSavings', () => {
  it('sequential batch has 0% savings', () => {
    const est = computeGasSavings(10, 10 * GAS_PER_ZK_RECEIPT);
    assert.strictEqual(est.savingsGas, 0);
    assert.strictEqual(est.savingsPct, 0);
    assert.strictEqual(est.individualGasTotal, 10 * GAS_PER_ZK_RECEIPT);
  });

  it('aggregated batch (1 proof for N) has significant savings', () => {
    // Simulated: batchGas = 290,620 + 50,000 = 340,620 for N=10
    const individualTotal = 10 * GAS_PER_ZK_RECEIPT; // 2,906,200
    const batchGas = GAS_PER_ZK_RECEIPT + 50_000;     // 340,620
    const est = computeGasSavings(10, batchGas);
    assert.ok(est.savingsGas > 0, `savings=${est.savingsGas} > 0`);
    assert.ok(est.savingsPct > 80, `savings pct ${est.savingsPct}% > 80%`);
    assert.strictEqual(est.individualGasTotal, individualTotal);
    assert.strictEqual(est.batchGasEstimate, batchGas);
  });

  it('single receipt: no savings', () => {
    const est = computeGasSavings(1, GAS_PER_ZK_RECEIPT);
    assert.strictEqual(est.savingsGas, 0);
  });

  it('handles 100 receipts correctly', () => {
    const est = computeGasSavings(100, GAS_PER_ZK_RECEIPT + 50_000);
    assert.ok(est.savingsPct > 90, `100-receipt batch: ${est.savingsPct}% savings`);
  });
});

// ---------------------------------------------------------------------------
// BatchError
// ---------------------------------------------------------------------------
describe('BatchError', () => {
  it('has code and message', () => {
    const err = new BatchError(BATCH_ERROR.BATCH_EMPTY, 'empty batch');
    assert.strictEqual(err.code, BATCH_ERROR.BATCH_EMPTY);
    assert.strictEqual(err.message, 'empty batch');
    assert.strictEqual(err.name, 'BatchError');
  });

  it('is instanceof Error', () => {
    const err = new BatchError(BATCH_ERROR.PROVE_FAILED, 'fail');
    assert.ok(err instanceof Error);
  });
});

// ---------------------------------------------------------------------------
// SequentialBatchProver (without live ZK — testing interface only)
// ---------------------------------------------------------------------------
describe('SequentialBatchProver interface', () => {
  const prover = new SequentialBatchProver();

  it('strategyId is sequential_v1', () => {
    assert.strictEqual(prover.strategyId, 'sequential_v1');
  });

  it('maxBatchSize is 100', () => {
    assert.strictEqual(prover.maxBatchSize, 100);
  });

  it('reducesOnChainCost is false (sequential = no aggregation)', () => {
    assert.ok(!prover.reducesOnChainCost);
  });

  it('throws BATCH_EMPTY for empty inputs', async () => {
    await assert.rejects(
      () => prover.prove([], '/fake/wasm', '/fake/zkey'),
      (e: BatchError) => {
        assert.strictEqual(e.code, BATCH_ERROR.BATCH_EMPTY);
        return true;
      }
    );
  });

  it('throws BATCH_TOO_LARGE for >100 inputs', async () => {
    const inputs: CircuitInput[] = Array.from({ length: 101 }, (_, i) => ({
      userId: String(i), usage: '100', nonce: String(i), epoch: '1', maxUsage: '1000',
    }));
    await assert.rejects(
      () => prover.prove(inputs, '/fake/wasm', '/fake/zkey'),
      (e: BatchError) => {
        assert.strictEqual(e.code, BATCH_ERROR.BATCH_TOO_LARGE);
        return true;
      }
    );
  });
});

// ---------------------------------------------------------------------------
// PlaceholderBatchProver
// ---------------------------------------------------------------------------
describe('PlaceholderBatchProver', () => {
  const prover = new PlaceholderBatchProver();

  it('strategyId is placeholder_rollup_v0', () => {
    assert.strictEqual(prover.strategyId, 'placeholder_rollup_v0');
  });

  it('reducesOnChainCost is true (future implementation target)', () => {
    assert.ok(prover.reducesOnChainCost);
  });

  it('throws NOT_IMPLEMENTED when prove() is called', async () => {
    const inputs: CircuitInput[] = [
      { userId: '1', usage: '100', nonce: '1', epoch: '1', maxUsage: '1000' },
    ];
    await assert.rejects(
      () => prover.prove(inputs, '/fake/wasm', '/fake/zkey'),
      (e: BatchError) => {
        assert.strictEqual(e.code, BATCH_ERROR.NOT_IMPLEMENTED);
        return true;
      }
    );
  });

  it('throws BATCH_EMPTY for empty inputs (before NOT_IMPLEMENTED)', async () => {
    await assert.rejects(
      () => prover.prove([], '/fake/wasm', '/fake/zkey'),
      (e: BatchError) => {
        assert.strictEqual(e.code, BATCH_ERROR.BATCH_EMPTY);
        return true;
      }
    );
  });

  it('estimateGasSavings() predicts > 80% savings for N=10', () => {
    const est = prover.estimateGasSavings(10);
    assert.ok(est.savingsPct > 80, `Expected > 80%, got ${est.savingsPct}%`);
  });

  it('estimateGasSavings() is monotonically increasing with batch size', () => {
    const est1 = prover.estimateGasSavings(1);
    const est10 = prover.estimateGasSavings(10);
    const est100 = prover.estimateGasSavings(100);
    assert.ok(est10.savingsPct >= est1.savingsPct);
    assert.ok(est100.savingsPct >= est10.savingsPct);
  });
});

// ---------------------------------------------------------------------------
// BatchProofResult type validation
// ---------------------------------------------------------------------------
describe('BatchProofResult structure', () => {
  it('has all required fields', () => {
    const required: (keyof BatchProofResult)[] = [
      'strategyId', 'batchSize', 'proofs',
      'totalTimeMs', 'amortizedTimeMs', 'estimatedGasSavings',
    ];
    // We verify the type by constructing a conformant object
    const sample: BatchProofResult = {
      strategyId: 'test',
      batchSize: 2,
      proofs: [],
      totalTimeMs: 500,
      amortizedTimeMs: 250,
      estimatedGasSavings: computeGasSavings(2, 2 * GAS_PER_ZK_RECEIPT),
    };
    for (const f of required) {
      assert.ok(f in sample, `missing: ${f}`);
    }
  });
});
