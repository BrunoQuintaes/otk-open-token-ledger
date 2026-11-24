/**
 * SequentialBatchProver — runs N proofs sequentially and returns all results.
 *
 * This is NOT a zkRollup (no aggregation). It demonstrates the batch interface
 * and provides a baseline for measuring amortized costs.
 *
 * Gas savings: 0% (each receipt still requires 290,620 gas on-chain).
 * Future: replace with PLONK/Halo2 aggregation to get O(1) on-chain cost.
 *
 * @module SequentialBatchProver
 * @since U12.1
 */

import {
  IBatchProver,
  BatchProofResult,
  SingleProofResult,
  CircuitInput,
  PublicSignals,
  GrothProof,
  BatchError,
  BATCH_ERROR,
  GAS_PER_ZK_RECEIPT,
  computeGasSavings,
} from './IBatchProver.js';

const MAX_BATCH = 100;

export class SequentialBatchProver implements IBatchProver {
  readonly strategyId = 'sequential_v1';
  readonly description =
    'Sequential Groth16 prover: runs N proofs independently. ' +
    'No on-chain cost reduction. Use for baseline measurement only.';
  readonly maxBatchSize = MAX_BATCH;
  readonly reducesOnChainCost = false;

  async prove(
    inputs: CircuitInput[],
    wasmPath: string,
    zkeyPath: string,
  ): Promise<BatchProofResult> {
    if (inputs.length === 0) {
      throw new BatchError(BATCH_ERROR.BATCH_EMPTY, 'Batch must have at least 1 input');
    }
    if (inputs.length > MAX_BATCH) {
      throw new BatchError(
        BATCH_ERROR.BATCH_TOO_LARGE,
        `Batch size ${inputs.length} exceeds max ${MAX_BATCH}`
      );
    }

    const t0 = Date.now();
    const proofs: SingleProofResult[] = [];

    // Dynamic import to avoid loading snarkjs when not needed
    const snarkjs = await import('snarkjs');

    for (const input of inputs) {
      const tp0 = Date.now();
      const { proof: rawProof, publicSignals: rawSignals } =
        await snarkjs.groth16.fullProve(input, wasmPath, zkeyPath);

      const proof = rawProof as GrothProof;
      const publicSignals: PublicSignals = {
        commitment: String(rawSignals[0]),
        epoch:      String(rawSignals[1]),
        maxUsage:   String(rawSignals[2]),
      };

      proofs.push({
        input,
        proof,
        publicSignals,
        proveTimeMs: Date.now() - tp0,
      });
    }

    const totalTimeMs = Date.now() - t0;
    const amortizedTimeMs = proofs.length > 0 ? totalTimeMs / proofs.length : 0;

    return {
      strategyId: this.strategyId,
      batchSize: inputs.length,
      proofs,
      totalTimeMs,
      amortizedTimeMs,
      estimatedGasSavings: computeGasSavings(
        inputs.length,
        inputs.length * GAS_PER_ZK_RECEIPT  // sequential: no savings
      ),
    };
  }
}

/** Singleton */
export const sequentialBatchProver = new SequentialBatchProver();
