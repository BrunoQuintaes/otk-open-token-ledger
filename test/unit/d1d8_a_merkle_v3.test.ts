/**
 * D1-G05 (TS side) — Merkle v3 with domain separation and cardinality-bound paths.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ethers } from 'ethers';
import { leafHash, merkleProof, merkleRoot, nodeHash, rootFromProof, type Bytes32 } from '../../src/crypto/merkleV3.js';

const d = (i: number) => ethers.keccak256(ethers.toUtf8Bytes(`member-${i}`)) as Bytes32;
const k = (...parts: string[]) => ethers.keccak256(ethers.concat(parts));

test('hand-built roots for 1, 2 and 3 leaves (odd node promoted, not duplicated)', () => {
  const [a, b, c] = [d(0), d(1), d(2)];
  const la = k('0x00', a), lb = k('0x00', b), lc = k('0x00', c);
  assert.equal(merkleRoot([a]), la);
  assert.equal(merkleRoot([a, b]), k('0x01', la, lb));
  assert.equal(merkleRoot([a, b, c]), k('0x01', k('0x01', la, lb), lc));
  assert.notEqual(merkleRoot([a, b, c]), merkleRoot([a, b, c, c])); // duplicating the last leaf changes the root
});

test('every index of trees with 1..9 leaves verifies; changes are rejected', () => {
  for (let n = 1; n <= 9; n++) {
    const leaves = Array.from({ length: n }, (_, i) => d(i));
    const root = merkleRoot(leaves);
    for (let i = 0; i < n; i++) {
      const p = merkleProof(leaves, i);
      assert.equal(rootFromProof(leaves[i]!, BigInt(i), BigInt(n), p), root, `n=${n} i=${i}`);
      // other member at this index, other index, other cardinality, extra/missing sibling
      assert.notEqual(rootFromProof(d(100), BigInt(i), BigInt(n), p), root);
      if (n > 1) assert.notEqual(rootFromProof(leaves[i]!, BigInt((i + 1) % n), BigInt(n), p), root);
      // Note: a path alone does not bind the cardinality (index 0 of a 3-leaf tree also closes as
      // index 0 of a 4-leaf tree). The cardinality is bound by the signed, registered statement and
      // BatchRegistryV3 always uses the registered value; see the Hardhat test for that check.
      assert.equal(rootFromProof(leaves[i]!, BigInt(i), BigInt(n), [...p, d(7)]), null);
      if (p.length) assert.equal(rootFromProof(leaves[i]!, BigInt(i), BigInt(n), p.slice(1)), null);
    }
    assert.equal(rootFromProof(leaves[0]!, BigInt(n), BigInt(n), []), null); // index ≥ cardinality
  }
});

test('an inner node cannot be presented as a leaf (domain separation)', () => {
  const leaves = [d(0), d(1), d(2), d(3)];
  const inner = nodeHash(leafHash(d(0)), leafHash(d(1)));
  const root = merkleRoot(leaves);
  const sibling = nodeHash(leafHash(d(2)), leafHash(d(3)));
  // Without separation, (inner, [sibling]) at index 0 of a 2-leaf tree would reproduce the root.
  assert.notEqual(rootFromProof(inner, 0n, 2n, [sibling]), root);
});
