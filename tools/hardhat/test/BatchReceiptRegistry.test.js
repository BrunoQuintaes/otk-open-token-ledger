/**
 * BatchReceiptRegistry — Hardhat Tests (U13)
 *
 * Smoke tests for on-chain Merkle batch settlement (ADR-0100).
 * Verifies: deploy, submitBatch (EIP-191 + anti-replay), verifyInclusion (positional).
 *
 * Runs with: node --test test/BatchReceiptRegistry.test.js
 *
 * Merkle scheme (positional, same as src/crypto/merkle.ts):
 *   hashLeaf(data) = keccak256(data)
 *   hashNode(left, right) = keccak256(abi.encodePacked(left, right))
 *   No padding for even levels — proof path uses positional index.
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { ethers } from "ethers";

// ---------------------------------------------------------------------------
// Minimal Merkle tree (mirrors src/crypto/merkle.ts — positional, no sorting)
// ---------------------------------------------------------------------------

const ZERO_HASH = ethers.keccak256(new Uint8Array(1)); // keccak256(0x00)

function hashLeafJs(data) {
  return ethers.keccak256(data);
}

function hashNodeJs(left, right) {
  return ethers.keccak256(ethers.concat([ethers.getBytes(left), ethers.getBytes(right)]));
}

/**
 * Build a simple positional Merkle tree.
 * @param {string[]} leafHashes — array of 0x... hex strings (keccak256 of each leaf data)
 * @returns {{ root: string, levels: string[][] }}
 */
function buildMerkleTree(leafHashes) {
  if (leafHashes.length === 0) throw new Error("Empty tree");

  const levels = [leafHashes.slice()];

  while (levels[levels.length - 1].length > 1) {
    const prev = levels[levels.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      const left = prev[i];
      const right = i + 1 < prev.length ? prev[i + 1] : ZERO_HASH;
      next.push(hashNodeJs(left, right));
    }
    levels.push(next);
  }

  return {
    root: levels[levels.length - 1][0],
    levels,
  };
}

/**
 * Get inclusion proof for leaf at `index`.
 * @returns {string[]} sibling hashes from leaf to root
 */
function getMerkleProof(levels, index) {
  const proof = [];
  let currentIndex = index;

  for (let lvl = 0; lvl < levels.length - 1; lvl++) {
    const level = levels[lvl];
    const siblingIndex = currentIndex % 2 === 0 ? currentIndex + 1 : currentIndex - 1;
    const sibling = siblingIndex < level.length ? level[siblingIndex] : ZERO_HASH;
    proof.push(sibling);
    currentIndex = Math.floor(currentIndex / 2);
  }

  return proof;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a deterministic wallet from a seed string */
function createWallet(seed) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(seed));
  return new ethers.Wallet(hash);
}

/**
 * Encode a BatchHeader for EIP-191 signing.
 * Must match encodeBatchHeaderForSigning() in BatchAggregator.ts.
 */
function encodeBatchHeader(header) {
  const SEP = "\x1f";
  const canonical = [
    "OTK_BATCH_V1",
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
 * Hash a batch header (keccak256 of canonical encoding).
 */
function hashBatchHeader(header) {
  return ethers.keccak256(encodeBatchHeader(header));
}

/**
 * Sign a batch header with EIP-191 personal sign.
 * Returns { rawHash, v, r, s, signer }.
 */
async function signBatchHeader(header, wallet) {
  const rawHash = hashBatchHeader(header);
  const rawHashBytes = ethers.getBytes(rawHash);
  const sig = await wallet.signMessage(rawHashBytes);
  const split = ethers.Signature.from(sig);
  return {
    rawHash,
    v: split.v,
    r: split.r,
    s: split.s,
    signer: wallet.address,
  };
}

/**
 * Build a simple batch: N mock receipts, each encoded as UTF-8 string.
 * Returns { leafDatas, leafHashes, tree }.
 */
function buildMockBatch(n = 3) {
  const leafDatas = [];
  const leafHashes = [];

  for (let i = 0; i < n; i++) {
    const data = ethers.toUtf8Bytes(`mock-receipt-${i}-epoch-1000`);
    const hash = hashLeafJs(data);
    leafDatas.push(data);
    leafHashes.push(hash);
  }

  const tree = buildMerkleTree(leafHashes);
  return { leafDatas, leafHashes, tree };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchReceiptRegistry", () => {
  let conn;
  let deployer;
  let submitter;
  let trustedWallet;
  let BatchReceiptRegistry;
  let registry;

  before(async () => {
    conn = await hre.network.connect();
    [deployer, submitter] = await conn.ethers.getSigners();
    trustedWallet = createWallet("trusted-batch-signer-seed");
    BatchReceiptRegistry = await conn.ethers.getContractFactory("BatchReceiptRegistry");
  });

  beforeEach(async () => {
    registry = await BatchReceiptRegistry.deploy(trustedWallet.address);
    await registry.waitForDeployment();
  });

  // -------------------------------------------------------------------------
  // Deployment
  // -------------------------------------------------------------------------

  describe("deployment", () => {
    it("sets trustedSigner correctly", async () => {
      const signer = await registry.trustedSigner();
      assert.equal(signer, trustedWallet.address);
    });

    it("reverts if trustedSigner is zero address", async () => {
      await assert.rejects(
        () => BatchReceiptRegistry.deploy(ethers.ZeroAddress),
        /zero signer/i
      );
    });
  });

  // -------------------------------------------------------------------------
  // submitBatch
  // -------------------------------------------------------------------------

  describe("submitBatch", () => {
    it("accepts valid batch with 3 receipts", async () => {
      const { tree } = buildMockBatch(3);
      const header = {
        root: tree.root,
        count: 3,
        totalCUBucket: 900n,
        policyId: "BUCKET_POLICY_V1",
        epoch: 1000n,
        createdAt: 1740000000000n,
      };
      const sig = await signBatchHeader(header, trustedWallet);

      const tx = await registry.connect(submitter).submitBatch(header, sig);
      const receipt = await tx.wait();
      assert.ok(receipt.status === 1, "tx should succeed");

      // Verify event was emitted
      const events = receipt.logs.filter(log => {
        try {
          const parsed = registry.interface.parseLog(log);
          return parsed && parsed.name === "BatchSubmitted";
        } catch { return false; }
      });
      assert.equal(events.length, 1, "BatchSubmitted event expected");
    });

    it("marks batchRoot as used after submission", async () => {
      const { tree } = buildMockBatch(2);
      const header = {
        root: tree.root,
        count: 2,
        totalCUBucket: 600n,
        policyId: "BUCKET_POLICY_V1",
        epoch: 1000n,
        createdAt: 1740000000000n,
      };
      const sig = await signBatchHeader(header, trustedWallet);

      await registry.submitBatch(header, sig);
      const used = await registry.usedRoots(tree.root);
      assert.equal(used, true, "root should be marked used");
    });

    it("reverts on replay (same root submitted twice)", async () => {
      const { tree } = buildMockBatch(2);
      const header = {
        root: tree.root,
        count: 2,
        totalCUBucket: 600n,
        policyId: "BUCKET_POLICY_V1",
        epoch: 1000n,
        createdAt: 1740000000000n,
      };
      const sig = await signBatchHeader(header, trustedWallet);

      await registry.submitBatch(header, sig);
      await assert.rejects(
        () => registry.submitBatch(header, sig),
        /BatchRootAlreadyUsed/
      );
    });

    it("reverts if count is 0 (EmptyBatch)", async () => {
      const header = {
        root: ethers.keccak256(ethers.toUtf8Bytes("empty")),
        count: 0,
        totalCUBucket: 0n,
        policyId: "BUCKET_POLICY_V1",
        epoch: 1000n,
        createdAt: 1740000000000n,
      };
      const sig = await signBatchHeader(header, trustedWallet);
      await assert.rejects(
        () => registry.submitBatch(header, sig),
        /EmptyBatch/
      );
    });

    it("reverts on invalid signature (wrong signer)", async () => {
      const { tree } = buildMockBatch(2);
      const header = {
        root: tree.root,
        count: 2,
        totalCUBucket: 600n,
        policyId: "BUCKET_POLICY_V1",
        epoch: 1000n,
        createdAt: 1740000000000n,
      };
      const wrongWallet = createWallet("wrong-wallet-seed");
      const sig = await signBatchHeader(header, wrongWallet);

      await assert.rejects(
        () => registry.submitBatch(header, sig),
        /InvalidBatchSignature/
      );
    });
  });

  // -------------------------------------------------------------------------
  // verifyInclusion — on-chain Merkle proof check
  // -------------------------------------------------------------------------

  describe("verifyInclusion", () => {
    it("verifies leaf 0 in 3-leaf batch", async () => {
      const { leafDatas, leafHashes, tree } = buildMockBatch(3);
      const proof0 = getMerkleProof(tree.levels, 0);

      const ok = await registry.verifyInclusion(leafHashes[0], proof0, 0, tree.root);
      assert.equal(ok, true);
    });

    it("verifies leaf 1 in 3-leaf batch", async () => {
      const { leafDatas, leafHashes, tree } = buildMockBatch(3);
      const proof1 = getMerkleProof(tree.levels, 1);

      const ok = await registry.verifyInclusion(leafHashes[1], proof1, 1, tree.root);
      assert.equal(ok, true);
    });

    it("verifies leaf 2 (odd index, right child) in 3-leaf batch", async () => {
      const { leafDatas, leafHashes, tree } = buildMockBatch(3);
      const proof2 = getMerkleProof(tree.levels, 2);

      const ok = await registry.verifyInclusion(leafHashes[2], proof2, 2, tree.root);
      assert.equal(ok, true);
    });

    it("returns false for wrong leaf hash", async () => {
      const { leafHashes, tree } = buildMockBatch(3);
      const proof0 = getMerkleProof(tree.levels, 0);
      const wrongHash = ethers.keccak256(ethers.toUtf8Bytes("tampered"));

      const ok = await registry.verifyInclusion(wrongHash, proof0, 0, tree.root);
      assert.equal(ok, false);
    });

    it("returns false for wrong index", async () => {
      const { leafHashes, tree } = buildMockBatch(3);
      const proof0 = getMerkleProof(tree.levels, 0);

      // proof[0] is correct but index=1 will mismatch
      const ok = await registry.verifyInclusion(leafHashes[0], proof0, 1, tree.root);
      assert.equal(ok, false);
    });

    it("verifies all leaves in 5-leaf batch", async () => {
      const { leafHashes, tree } = buildMockBatch(5);

      for (let i = 0; i < 5; i++) {
        const proof = getMerkleProof(tree.levels, i);
        const ok = await registry.verifyInclusion(leafHashes[i], proof, i, tree.root);
        assert.equal(ok, true, `leaf ${i} should verify`);
      }
    });

    it("reverts on empty proof (InvalidProofLength)", async () => {
      const { leafHashes, tree } = buildMockBatch(2);
      await assert.rejects(
        () => registry.verifyInclusion(leafHashes[0], [], 0, tree.root),
        /InvalidProofLength/
      );
    });
  });

  // -------------------------------------------------------------------------
  // hashLeaf helper
  // -------------------------------------------------------------------------

  describe("hashLeaf()", () => {
    it("matches keccak256 of data", async () => {
      const data = ethers.toUtf8Bytes("hello-batch");
      const expected = ethers.keccak256(data);
      const actual = await registry.hashLeaf(data);
      assert.equal(actual, expected);
    });
  });

  // -------------------------------------------------------------------------
  // gas measurement
  // -------------------------------------------------------------------------

  describe("gas cost", () => {
    it("submitBatch N=10 costs < 120,000 gas", async () => {
      const { tree } = buildMockBatch(10);
      const header = {
        root: tree.root,
        count: 10,
        totalCUBucket: 3000n,
        policyId: "BUCKET_POLICY_V1",
        epoch: 1000n,
        createdAt: 1740000000000n,
      };
      const sig = await signBatchHeader(header, trustedWallet);
      const tx = await registry.submitBatch(header, sig);
      const receipt = await tx.wait();
      const gasUsed = Number(receipt.gasUsed);

      assert.ok(
        gasUsed < 120_000,
        `Expected < 120K gas, got ${gasUsed}`
      );
    });
  });
});
