/**
 * PlaceholderBatchProver — stub for future zkRollup-style aggregation.
 *
 * Represents the target state (U12 / Cap 5.3 future work):
 *   - N receipts → 1 aggregated proof
 *   - On-chain cost: ~290,620 + ΔB gas (not N × 290,620)
 *   - Requires PLONK or Halo2 circuit for recursive aggregation
 *
 * This stub:
 *   - Validates inputs (type checking, batch size)
 *   - Returns a mock BatchProofResult with correct gas savings estimate
 *   - Throws NOT_IMPLEMENTED if called in production mode
 *
 * @module PlaceholderBatchProver
 * @since U12.1
 */

import {
  IBatchProver,
  BatchProofResult,
  CircuitInput,
  BatchError,
  BATCH_ERROR,
  GAS_PER_ZK_RECEIPT,
  computeGasSavings,
} from './IBatchProver.js';

/**
 * Estimated overhead for aggregated proof vs single proof.
 * Based on PLONK batch proof overhead model from literature (future empirical calibration).
 * ΔB ≈ 50,000 gas for aggregation overhead (placeholder).
 */
const BATCH_OVERHEAD_GAS = 50_000;

export class PlaceholderBatchProver implements IBatchProver {
  readonly strategyId = 'placeholder_rollup_v0';
  readonly description =
    'Placeholder zkRollup prover (NOT IMPLEMENTED): aggregates N receipts into 1 proof. ' +
    'Requires PLONK/Halo2 recursive circuits (future work — Cap 5.3).';
  readonly maxBatchSize = 1000;
  readonly reducesOnChainCost = true; // will reduce cost when implemented

  async prove(
    inputs: CircuitInput[],
    _wasmPath: string,
    _zkeyPath: string,
  ): Promise<BatchProofResult> {
    if (inputs.length === 0) {
      throw new BatchError(BATCH_ERROR.BATCH_EMPTY, 'Batch must have at least 1 input');
    }
    if (inputs.length > this.maxBatchSize) {
      throw new BatchError(
        BATCH_ERROR.BATCH_TOO_LARGE,
        `Batch ${inputs.length} > max ${this.maxBatchSize}`
      );
    }

    throw new BatchError(
      BATCH_ERROR.NOT_IMPLEMENTED,
      `PlaceholderBatchProver.prove() is not implemented. ` +
      `Aggregated ZK batching requires PLONK/Halo2 recursive circuits (future work). ` +
      `Use SequentialBatchProver for current functionality.`
    );
  }

  /**
   * Estimate what gas savings would be if implemented.
   * Formula: batchGas = GAS_PER_ZK_RECEIPT + BATCH_OVERHEAD_GAS
   * (one verification + aggregation overhead, independent of N)
   */
  estimateGasSavings(batchSize: number): ReturnType<typeof computeGasSavings> {
    const batchGas = GAS_PER_ZK_RECEIPT + BATCH_OVERHEAD_GAS;
    return computeGasSavings(batchSize, batchGas);
  }
}

/** Singleton */
export const placeholderBatchProver = new PlaceholderBatchProver();
