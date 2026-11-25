/**
 * MerkleTree — Deterministic binary Merkle tree with keccak256.
 *
 * Hashing scheme (positional — preserves receipt ordering):
 *   leaf  = keccak256(data)
 *   node  = keccak256(concat(left, right))
 *   empty = keccak256(0x00) — used as zero-padding for odd-length levels
 *
 * Solidity verification:
 *   Compatible with inline proof verification (not OZ sorted-pair — uses positional).
 *   BatchReceiptRegistry.sol uses the same hashNode scheme.
 *
 * ADR: docs/architecture/adr/ADR-0100-batch-settlement-merkle.md
 *
 * Used by `src/batch/BatchAggregator.ts`. Leaves and inner nodes are hashed without a domain prefix, so a 64-byte
 * leaf is indistinguishable from an inner node; `src/crypto/merkleV3.ts` is the domain-separated scheme used by the
 * V3 registry. Pure functions, no I/O, no environment variables.
 *
 * @module src/crypto/merkle
 */

import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 0x-prefixed 32-byte hex hash (66 characters). */
export type MerkleHash = `0x${string}`;

/** Inclusion proof of one leaf: its index and the sibling hashes from the leaf level up. */
export interface MerkleProof {
  /** Leaf index in the original array (0-based). */
  index: number;
  /** Sibling hashes from leaf to root (bottom-up). */
  siblings: MerkleHash[];
}

// ---------------------------------------------------------------------------
// Zero hash (for padding odd levels)
// ---------------------------------------------------------------------------

const ZERO_HASH: MerkleHash = ethers.keccak256('0x00') as MerkleHash;

// ---------------------------------------------------------------------------
// MerkleTree
// ---------------------------------------------------------------------------

/**
 * Builds a complete binary Merkle tree from an array of Uint8Array leaves.
 * Odd-length levels are padded with ZERO_HASH.
 *
 * Example (4 leaves):
 *         Root
 *        /    \
 *      N01    N23
 *      / \    / \
 *     L0  L1 L2  L3
 */
export class MerkleTree {
  /** keccak256 of each leaf (raw bytes). */
  private readonly leaves: MerkleHash[];
  /** All tree levels: levels[0] = leaf hashes, levels[last] = [root]. */
  private readonly levels: MerkleHash[][];

  /**
   * Hashes the leaves and builds every level eagerly (memory proportional to 2 × leaves).
   *
   * @param rawLeaves - Array of raw byte arrays (e.g., SPEC-RECEIPT encoded bytes).
   *                   Must be non-empty.
   * @throws {Error} When `rawLeaves` is empty.
   */
  constructor(rawLeaves: Uint8Array[]) {
    if (rawLeaves.length === 0) throw new Error('MerkleTree: rawLeaves must be non-empty');

    this.leaves = rawLeaves.map(data => ethers.keccak256(data) as MerkleHash);
    this.levels = this._buildLevels(this.leaves);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Merkle root of the tree.
   *
   * @returns The root hash (the leaf hash itself for a single leaf).
   */
  get root(): MerkleHash {
    return this.levels[this.levels.length - 1][0];
  }

  /**
   * Number of leaves.
   *
   * @returns The leaf count (before padding).
   */
  get count(): number {
    return this.leaves.length;
  }

  /**
   * Compute Merkle inclusion proof for leaf at `index`.
   * Proof can be verified with `MerkleTree.verify()`.
   *
   * @param index - Zero-based leaf index.
   * @returns The proof; a missing right sibling is ZERO_HASH.
   * @throws {RangeError} When `index` is outside 0..count-1.
   */
  getProof(index: number): MerkleProof {
    if (index < 0 || index >= this.leaves.length) {
      throw new RangeError(`MerkleTree.getProof: index ${index} out of range [0, ${this.leaves.length - 1}]`);
    }

    const siblings: MerkleHash[] = [];
    let currentIndex = index;

    for (let level = 0; level < this.levels.length - 1; level++) {
      const nodes = this.levels[level];
      const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
      const sibling = siblingIndex < nodes.length ? nodes[siblingIndex] : ZERO_HASH;
      siblings.push(sibling);
      currentIndex = Math.floor(currentIndex / 2);
    }

    return { index, siblings };
  }

  /**
   * Verify a Merkle proof.
   *
   * @param leafData - The raw bytes of the leaf (will be hashed internally).
   * @param proof    - Proof from getProof().
   * @param root     - Expected Merkle root.
   * @returns `true` when the recomputed root equals `root` (case-insensitive hex).
   */
  static verify(leafData: Uint8Array, proof: MerkleProof, root: MerkleHash): boolean {
    let hash: MerkleHash = ethers.keccak256(leafData) as MerkleHash;
    let currentIndex = proof.index;

    for (const sibling of proof.siblings) {
      if (currentIndex % 2 === 0) {
        // Current node is left child
        hash = _hashNode(hash, sibling);
      } else {
        // Current node is right child
        hash = _hashNode(sibling, hash);
      }
      currentIndex = Math.floor(currentIndex / 2);
    }

    return hash.toLowerCase() === root.toLowerCase();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Hashes level by level up to the root, padding odd levels with ZERO_HASH.
   *
   * @param leaves - Leaf hashes.
   * @returns All levels, leaves first and the root level last.
   */
  private _buildLevels(leaves: MerkleHash[]): MerkleHash[][] {
    const levels: MerkleHash[][] = [leaves];
    let current = leaves;

    while (current.length > 1) {
      const next: MerkleHash[] = [];
      for (let i = 0; i < current.length; i += 2) {
        const left = current[i];
        const right = i + 1 < current.length ? current[i + 1] : ZERO_HASH;
        next.push(_hashNode(left, right));
      }
      levels.push(next);
      current = next;
    }

    return levels;
  }
}

// ---------------------------------------------------------------------------
// Internal hash functions (exported for BatchReceiptRegistry Solidity compat)
// ---------------------------------------------------------------------------

/**
 * Hash a single leaf: keccak256(data).
 *
 * @param data - Raw leaf bytes.
 * @returns The leaf hash.
 */
export function hashLeaf(data: Uint8Array): MerkleHash {
  return ethers.keccak256(data) as MerkleHash;
}

/**
 * Hash two child nodes: keccak256(concat(left, right)).
 *
 * @param left - Left child hash.
 * @param right - Right child hash.
 * @returns The parent hash (positional: order matters).
 */
function _hashNode(left: MerkleHash, right: MerkleHash): MerkleHash {
  const packed = ethers.concat([ethers.getBytes(left), ethers.getBytes(right)]);
  return ethers.keccak256(packed) as MerkleHash;
}

export { _hashNode as hashNode };
