/**
 * IBatchProver — interface for ZK batch proof generation.
 *
 * Batching aggregates N receipt inputs into a single Groth16 proof,
 * reducing on-chain verification cost from N × 290,620 gas to
 * approximately (290,620 + ΔB) gas amortized per receipt.
 *
 * This is a scaffold (U12.1). The interface is frozen; implementation
 * is provided by SequentialBatchProver (runs provers sequentially)
 * and PlaceholderBatchProver (stub for future zkRollup-style batching).
 *
 * Feature flag: Set BATCHING_ENABLED=true to enable batch mode in SDK.
 *
 * Environment variable read: `BATCHING_ENABLED` (once, at module load).
 *
 * @module IBatchProver
 * @since U12.1
 */

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------
/**
 * `true` when the environment variable `BATCHING_ENABLED` is exactly `true` at module load.
 */
export const BATCHING_ENABLED =
  process.env['BATCHING_ENABLED'] === 'true';

// ---------------------------------------------------------------------------
// Input / output types
// ---------------------------------------------------------------------------

/** ZK circuit input for a single receipt (matches metering_v1.circom) */
export interface CircuitInput {
  userId: string;
  usage: string;
  nonce: string;
  epoch: string;
  maxUsage: string;
}

/** A single Groth16 proof */
export interface GrothProof {
  pi_a: [string, string, string];
  pi_b: [[string, string], [string, string], [string, string]];
  pi_c: [string, string, string];
  protocol: 'groth16';
  curve: 'bn128';
}

/** Public signals for a single proof */
export interface PublicSignals {
  commitment: string;  // pubSignals[0]
  epoch: string;       // pubSignals[1]
  maxUsage: string;    // pubSignals[2]
}

/** A single proof result (one receipt) */
export interface SingleProofResult {
  input: CircuitInput;
  proof: GrothProof;
  publicSignals: PublicSignals;
  proveTimeMs: number;
}

/** Batch proof result (N receipts → 1 or N proofs, depending on strategy) */
export interface BatchProofResult {
  /** Strategy used to generate this batch */
  strategyId: string;
  /** Number of receipts in this batch */
  batchSize: number;
  /** Individual proof results (one per receipt in SequentialBatchProver) */
  proofs: SingleProofResult[];
  /** Total time for the entire batch (ms) */
  totalTimeMs: number;
  /** Amortized time per receipt (ms) */
  amortizedTimeMs: number;
  /** Estimated on-chain gas savings vs individual submissions */
  estimatedGasSavings: GasSavingsEstimate;
}

/**
 * Estimated gas of a batch compared with individual submissions (gas units, estimates only).
 */
export interface GasSavingsEstimate {
  individualGasTotal: number;  // N × 290_620
  batchGasEstimate: number;    // 290_620 + ΔB (future: single proof for all)
  savingsGas: number;
  savingsPct: number;
}

// ---------------------------------------------------------------------------
// IBatchProver interface
// ---------------------------------------------------------------------------

/**
 * Strategy that turns several circuit inputs into proofs, with a gas estimate.
 */
export interface IBatchProver {
  /** Unique strategy identifier */
  readonly strategyId: string;

  /** Human-readable description */
  readonly description: string;

  /**
   * Generate proofs for a batch of receipts.
   * Implementations may vary in how they aggregate:
   *   - Sequential: N separate proofs (same cost, but batches submission)
   *   - Rollup: 1 aggregated proof for N receipts (reduces on-chain cost)
   *
   * @param inputs — Array of circuit inputs (length 1..MAX_BATCH_SIZE)
   * @param wasmPath — Path to circuit WASM file
   * @param zkeyPath — Path to circuit zkey file
   * @throws BatchError if inputs.length > MAX_BATCH_SIZE or proving fails
   */
  prove(
    inputs: CircuitInput[],
    wasmPath: string,
    zkeyPath: string,
  ): Promise<BatchProofResult>;

  /** Maximum supported batch size */
  readonly maxBatchSize: number;

  /** Whether this implementation actually reduces on-chain cost */
  readonly reducesOnChainCost: boolean;
}

// ---------------------------------------------------------------------------
// BatchError
// ---------------------------------------------------------------------------

/**
 * Raised by batch provers; `code` is one of {@link BATCH_ERROR}.
 */
export class BatchError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'BatchError';
    this.code = code;
  }
}

/**
 * Stable codes carried by {@link BatchError}.
 */
export const BATCH_ERROR = {
  BATCH_TOO_LARGE: 'BATCH_TOO_LARGE',
  BATCH_EMPTY: 'BATCH_EMPTY',
  PROVE_FAILED: 'PROVE_FAILED',
  NOT_IMPLEMENTED: 'NOT_IMPLEMENTED',
} as const;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Gas per ZK receipt submission (measured U8.5.4) */
export const GAS_PER_ZK_RECEIPT = 290_620;

/**
 * Compute GasSavingsEstimate for a batch.
 * For sequential batching: no gas savings, but demonstrates the interface.
 * For zkRollup batching: batchGasEstimate = 290_620 + ΔB (future work).
 *
 * @param batchSize - Number of receipts in the batch.
 * @param batchGasEstimate - Estimated gas of the batch; default = no savings.
 * @returns Individual total, batch estimate, savings (never negative) and savings percentage (2 decimals).
 */
export function computeGasSavings(
  batchSize: number,
  batchGasEstimate: number = GAS_PER_ZK_RECEIPT * batchSize,
): GasSavingsEstimate {
  const individual = batchSize * GAS_PER_ZK_RECEIPT;
  const savings = Math.max(0, individual - batchGasEstimate);
  const pct = individual > 0 ? (savings / individual) * 100 : 0;
  return {
    individualGasTotal: individual,
    batchGasEstimate,
    savingsGas: savings,
    savingsPct: Math.round(pct * 100) / 100,
  };
}
