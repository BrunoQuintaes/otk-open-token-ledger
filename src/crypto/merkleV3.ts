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
 */
import { ethers } from 'ethers';

export type Bytes32 = `0x${string}`;

function isBytes32(x: string): boolean {
  return /^0x[0-9a-fA-F]{64}$/.test(x);
}

export function leafHash(d: Bytes32): Bytes32 {
  if (!isBytes32(d)) throw new Error('merkleV3: leaf must be 32 bytes');
  return ethers.keccak256(ethers.concat(['0x00', d])) as Bytes32;
}

export function nodeHash(l: Bytes32, r: Bytes32): Bytes32 {
  return ethers.keccak256(ethers.concat(['0x01', l, r])) as Bytes32;
}

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

/** Same algorithm as BatchRegistryV3.computeRoot. */
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
