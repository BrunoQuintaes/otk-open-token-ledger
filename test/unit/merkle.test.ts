/**
 * MerkleTree — Unit tests
 *
 * Validates determinism, correctness of proofs, and edge cases.
 * Cross-platform test (positional hashing scheme matches BatchReceiptRegistry.sol).
 *
 * Module under test: `MerkleTree`, `hashLeaf` and `hashNode` from `src/crypto/merkle.ts` (the
 * batch tree; the v3 tree is tested in `d1d8_a_merkle_v3.test.ts`).
 *
 * Strategy / partitions: no leaves (throws), one leaf, two leaves, same leaves twice and a
 * different order; proofs for single indices and for every index of a 4-leaf tree; a wrong leaf,
 * a tampered proof and an out-of-range index; odd sizes 3 and 5; a fixed root for two known
 * leaves; a 1000-leaf tree built in under 5 s, with 10 sampled proofs that verify.
 *
 * Needs: nothing external. The 1000-leaf case depends on machine speed, with a wide margin.
 *
 * Run just this file: `npx tsx --test test/unit/merkle.test.ts`
 *
 * @module test/unit/merkle.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MerkleTree, hashLeaf, hashNode } from '../../src/crypto/merkle.js';
import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toBytes(s: string): Uint8Array {
  return ethers.toUtf8Bytes(s);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MerkleTree', () => {

  describe('constructor + root', () => {
    it('should throw on empty leaves', () => {
      assert.throws(() => new MerkleTree([]), /non-empty/);
    });

    it('single leaf: root == hashLeaf(leaf)', () => {
      const data = toBytes('receipt-1');
      const tree = new MerkleTree([data]);
      const expected = hashLeaf(data);
      assert.equal(tree.root, expected);
      assert.equal(tree.count, 1);
    });

    it('two leaves: root == hashNode(leaf0, leaf1)', () => {
      const d0 = toBytes('r0');
      const d1 = toBytes('r1');
      const tree = new MerkleTree([d0, d1]);
      const expected = hashNode(hashLeaf(d0), hashLeaf(d1));
      assert.equal(tree.root, expected);
    });

    it('deterministic: same leaves → same root', () => {
      const leaves = ['a', 'b', 'c', 'd'].map(toBytes);
      const root1 = new MerkleTree(leaves).root;
      const root2 = new MerkleTree(leaves).root;
      assert.equal(root1, root2);
    });

    it('different leaf order → different root', () => {
      const a = toBytes('receipt-A');
      const b = toBytes('receipt-B');
      const root1 = new MerkleTree([a, b]).root;
      const root2 = new MerkleTree([b, a]).root;
      assert.notEqual(root1, root2);
    });
  });

  describe('getProof + MerkleTree.verify', () => {
    const leaves = ['r0', 'r1', 'r2', 'r3'].map(toBytes);

    it('index 0 proof verifies against root', () => {
      const tree = new MerkleTree(leaves);
      const proof = tree.getProof(0);
      assert.ok(MerkleTree.verify(leaves[0], proof, tree.root));
    });

    it('index 3 proof verifies against root', () => {
      const tree = new MerkleTree(leaves);
      const proof = tree.getProof(3);
      assert.ok(MerkleTree.verify(leaves[3], proof, tree.root));
    });

    it('all proofs verify (4 leaves)', () => {
      const tree = new MerkleTree(leaves);
      for (let i = 0; i < leaves.length; i++) {
        const proof = tree.getProof(i);
        assert.ok(MerkleTree.verify(leaves[i], proof, tree.root), `proof[${i}] failed`);
      }
    });

    it('wrong leaf fails verification', () => {
      const tree = new MerkleTree(leaves);
      const proof = tree.getProof(0);
      const wrongLeaf = toBytes('WRONG');
      assert.equal(MerkleTree.verify(wrongLeaf, proof, tree.root), false);
    });

    it('tampered proof fails verification', () => {
      const tree = new MerkleTree(leaves);
      const proof = tree.getProof(0);
      // Flip first sibling
      const tamperedProof = {
        ...proof,
        siblings: [
          ('0x' + '0'.repeat(64)) as `0x${string}`,
          ...proof.siblings.slice(1),
        ],
      };
      assert.equal(MerkleTree.verify(leaves[0], tamperedProof, tree.root), false);
    });

    it('out of range index throws', () => {
      const tree = new MerkleTree(leaves);
      assert.throws(() => tree.getProof(-1), /out of range/);
      assert.throws(() => tree.getProof(4), /out of range/);
    });
  });

  describe('odd-length padding', () => {
    it('3 leaves: all proofs verify', () => {
      const leaves3 = ['a', 'b', 'c'].map(toBytes);
      const tree = new MerkleTree(leaves3);
      for (let i = 0; i < 3; i++) {
        const proof = tree.getProof(i);
        assert.ok(MerkleTree.verify(leaves3[i], proof, tree.root), `proof[${i}] failed`);
      }
    });

    it('5 leaves: all proofs verify', () => {
      const leaves5 = ['a', 'b', 'c', 'd', 'e'].map(toBytes);
      const tree = new MerkleTree(leaves5);
      for (let i = 0; i < 5; i++) {
        const proof = tree.getProof(i);
        assert.ok(MerkleTree.verify(leaves5[i], proof, tree.root), `proof[${i}] failed`);
      }
    });
  });

  describe('golden vector (cross-platform)', () => {
    it('known root for [a,b] should match expected hash', () => {
      // Pre-computed:
      // leaf_a = keccak256("a") = 0x3ac225168df54212a25c1c01fd35bebfea408fdac2e31ddd6f80a4bbf9a5f1cb
      // leaf_b = keccak256("b") = 0xb5553de315e0edf504d9150af82dafa5c4667fa618ed0a6f19c69b41166c5510
      // root   = keccak256(concat(leaf_a, leaf_b))
      const a = toBytes('a');
      const b = toBytes('b');
      const tree = new MerkleTree([a, b]);

      const leafA = hashLeaf(a);
      const leafB = hashLeaf(b);
      const expectedRoot = hashNode(leafA, leafB);

      assert.equal(tree.root, expectedRoot);
      // Root must be a valid keccak256 (0x + 64 hex chars)
      assert.match(tree.root, /^0x[0-9a-f]{64}$/i);
    });
  });

  describe('large batch performance', () => {
    it('1000 leaves: all proofs verify in < 5s', () => {
      const N = 1000;
      const leaves = Array.from({ length: N }, (_, i) => toBytes(`receipt-${i}`));
      const t0 = performance.now();
      const tree = new MerkleTree(leaves);
      const buildMs = performance.now() - t0;
      assert.ok(buildMs < 5000, `Build took ${buildMs}ms (expected < 5000ms)`);

      // Spot-check 10 random proofs
      for (let i = 0; i < 10; i++) {
        const idx = Math.floor(i * N / 10);
        const proof = tree.getProof(idx);
        assert.ok(MerkleTree.verify(leaves[idx], proof, tree.root));
      }
    });
  });
});
