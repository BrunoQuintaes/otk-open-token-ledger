/**
 * Merkle tree for BatchRegistryV3 (D1 §5, R21). Shared byte-for-byte with
 * tools/hardhat/contracts/v3/BatchRegistryV3.sol.
 *
 *   leaf(d)    = keccak256(0x00 ‖ d)          d = member authorizationDigest (32 bytes)
 *   node(l, r) = keccak256(0x01 ‖ l ‖ r)
 *   odd level  → the last node is promoted unchanged (never duplicated)
 *
 * Domain separation stops an inner node being presented as a leaf. The path depends on
 * (index, cardinality), so an inclusion proof is checked against the registered cardinality and
 * must consume exactly its siblings. The legacy src/crypto/merkle.ts is unchanged.
 *
 * Used by `src/zk/v3/batch.ts` and `src/zk/v3/index.ts`; must stay byte-compatible with the Solidity contract named
 * above. Pure functions, no I/O, no environment variables.
 *
 * @module src/crypto/merkleV3
 */
import { ethers } from 'ethers';

/** 0x-prefixed 32-byte hex value (66 characters). */
export type Bytes32 = `0x${string}`;

// Strict 32-byte hex check (0x plus 64 hex digits, any case).
function isBytes32(x: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(x);
}

/**
 * Hashes a leaf with the 0x00 domain prefix.
 *
 * @param d - 32-byte member digest.
 * @returns keccak256(0x00 ‖ d).
 * @throws {Error} When `d` is not 32-byte hex.
 */
export function leafHash(d: Bytes32): Bytes32 {
  if (!isBytes32(d)) throw new Error('merkleV3: leaf must be 32 bytes');
  return ethers.keccak256(ethers.concat(['0x00', d])) as Bytes32;
}

/**
 * Hashes an inner node with the 0x01 domain prefix.
 *
 * @param l - Left child hash.
 * @param r - Right child hash.
 * @returns keccak256(0x01 ‖ l ‖ r).
 */
export function nodeHash(l: Bytes32, r: Bytes32): Bytes32 {
  return ethers.keccak256(ethers.concat(['0x01', l, r])) as Bytes32;
}

/**
 * Computes the root of a list of member digests (odd nodes promoted, not duplicated).
 *
 * @param leaves - Member digests in registry order.
 * @returns The root.
 * @throws {Error} When the list is empty or a digest is not 32-byte hex.
 */
export function merkleRoot(leaves: readonly Bytes32[]): Bytes32 {
  if (leaves.length === 0) throw new Error('merkleV3: empty tree');
  let level = leaves.map(leafHash);
  while (level.length > 1) {
    const next: Bytes32[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(i + 1 < level.length ? nodeHash(level[i]!, level[i + 1]!) : level[i]!);
    level = next;
  }
  return level[0]!;
}

/**
 * Builds the inclusion proof of one member (no sibling is emitted at a level where the node is promoted).
 *
 * @param leaves - Member digests in registry order.
 * @param index - Zero-based member index.
 * @returns Sibling hashes from the leaf level up.
 * @throws {Error} When `index` is not an integer in range, or a digest is not 32-byte hex.
 */
export function merkleProof(leaves: readonly Bytes32[], index: number): Bytes32[] {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length) throw new Error('merkleV3: index out of range');
  let level = leaves.map(leafHash);
  let i = index;
  const proof: Bytes32[] = [];
  while (level.length > 1) {
    const isLastOdd = i === level.length - 1 && level.length % 2 === 1;
    if (!isLastOdd) proof.push(level[i % 2 === 0 ? i + 1 : i - 1]!);
    const next: Bytes32[] = [];
    for (let k = 0; k < level.length; k += 2) next.push(k + 1 < level.length ? nodeHash(level[k]!, level[k + 1]!) : level[k]!);
    level = next;
    i = Math.floor(i / 2);
  }
  return proof;
}

/**
 * Same algorithm as BatchRegistryV3.computeRoot.
 *
 * @param d - Member digest (32-byte hex).
 * @param index - Zero-based member index.
 * @param cardinality - Number of members registered for the batch.
 * @param proof - Sibling hashes from the leaf level up.
 * @returns The recomputed root, or `null` when index/cardinality are invalid, a sibling is missing or malformed, or
 *   the proof has unused siblings.
 * @throws {Error} When `d` is not 32-byte hex.
 */
export function rootFromProof(d: Bytes32, index: bigint, cardinality: bigint, proof: readonly Bytes32[]): Bytes32 | null {
  if (cardinality <= 0n || index < 0n || index >= cardinality) return null;
  let h = leafHash(d);
  let i = index, n = cardinality, used = 0;
  while (n > 1n) {
    if (!(i === n - 1n && n % 2n === 1n)) {
      const sib = proof[used++];
      if (!sib || !isBytes32(sib)) return null;
      h = i % 2n === 0n ? nodeHash(h, sib) : nodeHash(sib, h);
    }
    i /= 2n;
    n = (n + 1n) / 2n;
  }
  return used === proof.length ? h : null;
}
