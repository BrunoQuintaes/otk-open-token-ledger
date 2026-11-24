/**
 * BatchAggregator — Aggregates N SPEC-RECEIPT V1 receipts into a Merkle batch.
 *
 * Reduces on-chain settlement cost from O(N) to O(1) per batch.
 * On-chain: BatchReceiptRegistry.sol stores only root + header.
 * Off-chain: inclusion proofs available for auditors (getProof).
 *
 * Gas amortization (Groth16, gasPerReceipt=290620):
 *   N=10  → ~29.062 gas/receipt + batch overhead
 *   N=100 → ~2.906  gas/receipt + batch overhead
 *
 * ADR: docs/architecture/adr/ADR-0100-batch-settlement-merkle.md
 */

import { ethers } from 'ethers';
import {
  MerkleTree,
  type MerkleHash,
  type MerkleProof,
} from '../crypto/merkle.js';
import {
  encodeCanonicalReceiptV1Bytes,
  type CanonicalReceiptV1,
} from '../receipt/canonicalReceiptV1.js';
import { quantizeToBucket, resolveBucketConfig } from '../privacy/bucketing.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Batch header published on-chain (privacy-preserving: no individual CU). */
export interface BatchHeader {
  /** Merkle root of all N encoded receipts. Anchor for inclusion proofs. */
  root: MerkleHash;
  /** Number of receipts in the batch. */
  count: number;
  /**
   * Sum of bucketed CU values (not exact sum — privacy by design).
   * Consistent with ADR-0101: on-chain value is bucket, not raw CU.
   */
  totalCUBucket: bigint;
  /** Bucket policy identifier (e.g., "BUCKET_POLICY_V1"). */
  policyId: string;
  /** Epoch of the batch (all receipts should share the same epoch). */
  epoch: bigint;
  /** Batch creation timestamp (Unix ms). */
  createdAt: number;
}

/** Full result of finalizing a batch. */
export interface BatchResult {
  header: BatchHeader;
  /** Inclusion proofs, one per receipt, in original insertion order. */
  proofs: MerkleProof[];
  /** Canonical encoded bytes for each receipt (for auditors). */
  encodedReceipts: Uint8Array[];
}

/** State snapshot for diagnostics. */
export interface BatchAggregatorState {
  count: number;
  pendingEpoch: bigint | null;
  isFinalized: boolean;
}

// ---------------------------------------------------------------------------
// BatchAggregator
// ---------------------------------------------------------------------------

const DEFAULT_POLICY_ID = 'BUCKET_POLICY_V1';

/**
 * Stateful aggregator: collect receipts, then finalize into a Merkle batch.
 *
 * Usage:
 *   const agg = new BatchAggregator();
 *   agg.addReceipt(r1);
 *   agg.addReceipt(r2);
 *   const result = agg.finalizeBatch();
 *   const proof = result.proofs[0];
 *   const ok = MerkleTree.verify(result.encodedReceipts[0], proof, result.header.root);
 */
export class BatchAggregator {
  private readonly _receipts: CanonicalReceiptV1[] = [];
  private readonly _encoded: Uint8Array[] = [];
  private _isFinalized = false;
  private readonly _policyId: string;

  constructor(policyId: string = DEFAULT_POLICY_ID) {
    this._policyId = policyId;
  }

  // ---------------------------------------------------------------------------
  // Accumulation
  // ---------------------------------------------------------------------------

  /**
   * Add a receipt to the batch.
   * @throws if the batch has already been finalized.
   * @throws if epoch changes mid-batch (enforces single-epoch batches).
   */
  addReceipt(receipt: CanonicalReceiptV1): void {
    if (this._isFinalized) {
      throw new Error('BatchAggregator: cannot add receipt — batch is finalized');
    }

    // Validate epoch consistency (all receipts must share the same epoch)
    if (this._receipts.length > 0) {
      const expectedEpoch = this._receipts[0].epoch;
      if (receipt.epoch !== expectedEpoch) {
        throw new Error(
          `BatchAggregator: epoch mismatch — expected ${expectedEpoch}, got ${receipt.epoch}`
        );
      }
    }

    const encoded = encodeCanonicalReceiptV1Bytes(receipt);
    this._receipts.push(receipt);
    this._encoded.push(encoded);
  }

  // ---------------------------------------------------------------------------
  // Finalization
  // ---------------------------------------------------------------------------

  /**
   * Finalize the batch and return the Merkle root + header + proofs.
   *
   * After finalization, no more receipts can be added.
   * Can be called multiple times — returns the same result.
   *
   * @throws if no receipts have been added.
   */
  finalizeBatch(): BatchResult {
    if (this._encoded.length === 0) {
      throw new Error('BatchAggregator: cannot finalize empty batch');
    }

    this._isFinalized = true;

    // Build Merkle tree
    const tree = new MerkleTree(this._encoded);

    // Compute privacy-preserving CU sum (sum of bucketed values)
    const totalCUBucket = this._receipts.reduce((acc, r) => {
      const config = resolveBucketConfig(r.cost_unit);
      return acc + quantizeToBucket(r.cost_unit, config.step);
    }, 0n);

    const header: BatchHeader = {
      root: tree.root,
      count: this._receipts.length,
      totalCUBucket,
      policyId: this._policyId,
      epoch: this._receipts[0].epoch,
      createdAt: Date.now(),
    };

    // Generate all inclusion proofs
    const proofs: MerkleProof[] = this._encoded.map((_, i) => tree.getProof(i));

    return {
      header,
      proofs,
      encodedReceipts: [...this._encoded],
    };
  }

  /**
   * Get an inclusion proof for a specific receipt index.
   * @throws if not finalized yet.
   */
  getProof(index: number): MerkleProof {
    if (!this._isFinalized) {
      throw new Error('BatchAggregator: must call finalizeBatch() before getProof()');
    }
    const tree = new MerkleTree(this._encoded);
    return tree.getProof(index);
  }

  // ---------------------------------------------------------------------------
  // Diagnostics
  // ---------------------------------------------------------------------------

  inspect(): BatchAggregatorState {
    return {
      count: this._receipts.length,
      pendingEpoch: this._receipts.length > 0 ? this._receipts[0].epoch : null,
      isFinalized: this._isFinalized,
    };
  }

  get count(): number {
    return this._receipts.length;
  }
}

// ---------------------------------------------------------------------------
// Encoding helpers for BatchReceiptRegistry.sol
// ---------------------------------------------------------------------------

/**
 * Encode a BatchHeader for EIP-191 signature by a trusted signer.
 * Canonical encoding: keccak256("OTK_BATCH_V1" || 0x1f || root || 0x1f || count || ...)
 */
export function encodeBatchHeaderForSigning(header: BatchHeader): Uint8Array {
  const domain = 'OTK_BATCH_V1';
  const SEP = '\x1f';
  const canonical = [
    domain,
    header.root,
    header.count.toString(),
    header.totalCUBucket.toString(),
    header.policyId,
    header.epoch.toString(),
    header.createdAt.toString(),
  ].join(SEP);
  return ethers.toUtf8Bytes(canonical);
}

/**
 * Compute keccak256 hash of a BatchHeader (for on-chain submission).
 */
export function hashBatchHeader(header: BatchHeader): string {
  return ethers.keccak256(encodeBatchHeaderForSigning(header));
}
