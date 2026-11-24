/**
 * BatchProver — Collects receipts, generates N Groth16 proofs, submits as batch.
 *
 * Integrates with VerifierBatchV1.sol: one transaction for N proofs.
 * Gas saving: (N-1) × 21,000 base tx cost vs N individual transactions.
 *
 * This is NOT recursive zkRollup (proofs not cryptographically aggregated).
 * It's a practical optimization for permissioned IBFT networks where
 * transaction throughput > proof generation throughput.
 *
 * Usage:
 *   const prover = new BatchProver({ batchSize: 10 });
 *   prover.add({ userId, usage, nonce, epoch, maxUsage });
 *   if (prover.isReady()) {
 *     const result = await prover.prove();  // generates N proofs
 *     const gas = await prover.estimate(contract);
 *     await prover.submit(contract);
 *   }
 *
 * @module BatchProver
 * @since U13 (2026-02-22)
 */

import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groth16 } from 'snarkjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProverInput {
  userId: string;
  usage: string;
  nonce: string;
  epoch: string;
  maxUsage: string;
}

export interface SingleProofResult {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
  /** pubSignals[0]=commitment, [1]=epoch, [2]=maxUsage */
  pubSignals: [bigint, bigint, bigint];
  proveMs: number;
}

export interface BatchProverResult {
  proofs: SingleProofResult[];
  totalProveMs: number;
  /** Estimated gas for the batch tx */
  estimatedGas?: bigint;
}

export interface BatchProverConfig {
  /** Number of proofs to collect before proving (default: 10) */
  batchSize?: number;
  /** Path to metering_v1 wasm */
  wasmPath?: string;
  /** Path to metering_v1 final.zkey */
  zkeyPath?: string;
}

// ---------------------------------------------------------------------------
// Internal helper: convert snarkjs proof to Solidity calldata format
// ---------------------------------------------------------------------------

function proofToSolidity(proof: Record<string, unknown>, publicSignals: string[]): SingleProofResult {
  // snarkjs proof.pi_a = [x, y, "1"] (projective)
  const pi_a = proof['pi_a'] as string[];
  const pi_b = proof['pi_b'] as string[][];
  const pi_c = proof['pi_c'] as string[];

  return {
    pA: [BigInt(pi_a[0]), BigInt(pi_a[1])],
    pB: [
      [BigInt(pi_b[0][0]), BigInt(pi_b[0][1])],
      [BigInt(pi_b[1][0]), BigInt(pi_b[1][1])],
    ],
    pC: [BigInt(pi_c[0]), BigInt(pi_c[1])],
    pubSignals: [
      BigInt(publicSignals[0]),  // commitment
      BigInt(publicSignals[1]),  // epoch
      BigInt(publicSignals[2]),  // maxUsage
    ],
    proveMs: 0,  // set by caller
  };
}

// ---------------------------------------------------------------------------
// BatchProver
// ---------------------------------------------------------------------------

export class BatchProver {
  private readonly _batchSize: number;
  private readonly _wasmPath: string;
  private readonly _zkeyPath: string;
  private readonly _pending: ProverInput[] = [];
  private _lastResult: BatchProverResult | null = null;

  constructor(config: BatchProverConfig = {}) {
    this._batchSize = config.batchSize ?? 10;
    this._wasmPath = config.wasmPath ??
      path.join(REPO_ROOT, 'zk/build/metering_v1_js/metering_v1.wasm');
    this._zkeyPath = config.zkeyPath ??
      path.join(REPO_ROOT, 'zk/keys/metering_v1_final.zkey');
  }

  // ---------------------------------------------------------------------------
  // Accumulation
  // ---------------------------------------------------------------------------

  add(input: ProverInput): void {
    if (this._pending.length > 0 && input.epoch !== this._pending[0].epoch) {
      throw new Error(
        `BatchProver: epoch mismatch — expected ${this._pending[0].epoch}, got ${input.epoch}`
      );
    }
    this._pending.push(input);
  }

  isReady(): boolean {
    return this._pending.length >= this._batchSize;
  }

  get pendingCount(): number {
    return this._pending.length;
  }

  // ---------------------------------------------------------------------------
  // Proof generation
  // ---------------------------------------------------------------------------

  /**
   * Generate proofs for all pending inputs.
   * Clears the pending queue.
   * @throws if no pending inputs or circuit files not found.
   */
  async prove(): Promise<BatchProverResult> {
    if (this._pending.length === 0) {
      throw new Error('BatchProver: no pending inputs');
    }
    if (!existsSync(this._wasmPath)) {
      throw new Error(`BatchProver: wasm not found: ${this._wasmPath}`);
    }
    if (!existsSync(this._zkeyPath)) {
      throw new Error(`BatchProver: zkey not found: ${this._zkeyPath}`);
    }

    const inputs = [...this._pending];
    this._pending.length = 0;

    const proofs: SingleProofResult[] = [];
    let totalProveMs = 0;

    for (const inp of inputs) {
      const t0 = Date.now();
      const { proof, publicSignals } = await groth16.fullProve(
        {
          userId:   inp.userId,
          usage:    inp.usage,
          nonce:    inp.nonce,
          epoch:    inp.epoch,
          maxUsage: inp.maxUsage,
        },
        this._wasmPath,
        this._zkeyPath,
      );
      const proveMs = Date.now() - t0;
      totalProveMs += proveMs;

      const result = proofToSolidity(proof as Record<string, unknown>, publicSignals);
      result.proveMs = proveMs;
      proofs.push(result);
    }

    this._lastResult = { proofs, totalProveMs };
    return this._lastResult;
  }

  // ---------------------------------------------------------------------------
  // Blockchain submission
  // ---------------------------------------------------------------------------

  /**
   * Estimate gas for submitBatch on a VerifierBatchV1 contract instance.
   */
  async estimate(
    contract: { submitBatch: { estimateGas: (proofs: unknown) => Promise<bigint> } },
    result?: BatchProverResult,
  ): Promise<bigint> {
    const res = result ?? this._lastResult;
    if (!res) throw new Error('BatchProver: call prove() first');
    return contract.submitBatch.estimateGas(res.proofs);
  }

  /**
   * Submit batch to VerifierBatchV1.sol.
   * Returns the transaction receipt.
   */
  async submit(
    contract: { submitBatch: (proofs: unknown) => Promise<{ wait: () => Promise<unknown> }> },
    result?: BatchProverResult,
  ): Promise<unknown> {
    const res = result ?? this._lastResult;
    if (!res) throw new Error('BatchProver: call prove() first');
    const tx = await contract.submitBatch(res.proofs);
    return (tx as { wait: () => Promise<unknown> }).wait();
  }

  get lastResult(): BatchProverResult | null {
    return this._lastResult;
  }
}
