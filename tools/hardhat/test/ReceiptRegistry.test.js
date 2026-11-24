/**
 * ReceiptRegistry — Hardhat Tests (U8.5.3)
 *
 * 7 behavioral tests with MockVerifier isolation.
 * Uses node:test (Hardhat v3 compatible) + ethers v6.
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { ethers } from "ethers";

// --- Helpers ---

/** Create a deterministic test wallet from a seed */
function createWallet(seed) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(seed));
  return new ethers.Wallet(hash);
}

/** Build a fake rawHash, sign it with EIP-191, return { rawHash, v, r, s } */
async function signRawHash(rawHash, wallet) {
  const rawHashBytes = ethers.getBytes(rawHash);
  const sig = await wallet.signMessage(rawHashBytes);
  const split = ethers.Signature.from(sig);
  return { rawHash, v: split.v, r: split.r, s: split.s };
}

/** Default raw receipt data struct */
function makeRawData(overrides = {}) {
  return {
    userId: 42n,
    nonce: 0n,
    epoch: 1000n,
    costUnits: 500n,
    ...overrides,
  };
}

/** Default proof data struct with a unique commitment */
function makeProofData(overrides = {}) {
  const commitment = overrides.commitment ??
    BigInt(ethers.keccak256(ethers.toUtf8Bytes("commitment-" + Date.now() + Math.random())));
  const epoch = overrides.epoch ?? 1000n;
  const maxUsage = overrides.maxUsage ?? 10000n;

  return {
    a: [0n, 0n],
    b: [[0n, 0n], [0n, 0n]],
    c: [0n, 0n],
    pubSignals: [commitment, epoch, maxUsage], // canonical: [commitment, epoch, maxUsage]
  };
}

// --- Tests ---

describe("ReceiptRegistry", () => {
  let conn;
  let deployer;
  let submitter;
  let trustedWallet;
  let otherWallet;
  let mockVerifier;
  let registry;

  before(async () => {
    conn = await hre.network.connect();
    const signers = await conn.ethers.getSigners();
    deployer = signers[0];
    submitter = signers[1];

    // Trusted signer (off-chain wallet for signing receipts)
    trustedWallet = createWallet("trusted-signer-seed");
    // Different signer (for invalid signature tests)
    otherWallet = createWallet("other-signer-seed");
  });

  beforeEach(async () => {
    // Fresh deploy per test for isolation
    const MockFactory = await conn.ethers.getContractFactory("MockVerifier");
    mockVerifier = await MockFactory.deploy();
    await mockVerifier.waitForDeployment();

    const RegFactory = await conn.ethers.getContractFactory("ReceiptRegistry");
    registry = await RegFactory.deploy(
      await mockVerifier.getAddress(),
      trustedWallet.address
    );
    await registry.waitForDeployment();
  });

  // ─── Test 1: Happy path ───────────────────────────────────

  it("1) Happy path: valid submission emits event and increments nonce", async () => {
    const rawHash = ethers.keccak256(ethers.toUtf8Bytes("valid-receipt-1"));
    const { v, r, s } = await signRawHash(rawHash, trustedWallet);
    const raw = makeRawData();
    const proof = makeProofData();

    // Check nonce before
    const nonceBefore = await registry.getNonce(submitter.address, raw.userId);
    assert.equal(nonceBefore, 0n, "nonce should start at 0");

    // Submit via submitter account
    const registryAsSubmitter = registry.connect(submitter);
    const tx = await registryAsSubmitter.submitReceipt(raw, rawHash, v, r, s, proof);
    const receipt = await tx.wait();

    // Verify event
    const event = receipt.logs.find((log) => {
      try {
        return registry.interface.parseLog(log)?.name === "ReceiptSubmitted";
      } catch { return false; }
    });
    assert.ok(event, "ReceiptSubmitted event should be emitted");

    const parsed = registry.interface.parseLog(event);
    assert.equal(parsed.args.userId, raw.userId, "event userId should match");
    assert.equal(parsed.args.costUnits, raw.costUnits, "event costUnits should match");
    assert.equal(parsed.args.epoch, proof.pubSignals[1], "event epoch should match pubSignals[1]");
    assert.equal(parsed.args.submitter, submitter.address, "event submitter should match");

    // Check nonce after
    const nonceAfter = await registry.getNonce(submitter.address, raw.userId);
    assert.equal(nonceAfter, 1n, "nonce should be incremented to 1");
  });

  // ─── Test 2: Invalid signature ────────────────────────────

  it("2) Invalid signature: wrong signer reverts", async () => {
    const rawHash = ethers.keccak256(ethers.toUtf8Bytes("bad-sig-receipt"));
    // Sign with the WRONG wallet (not trustedWallet)
    const { v, r, s } = await signRawHash(rawHash, otherWallet);
    const raw = makeRawData();
    const proof = makeProofData();

    const registryAsSubmitter = registry.connect(submitter);
    await assert.rejects(
      registryAsSubmitter.submitReceipt(raw, rawHash, v, r, s, proof),
      (err) => {
        const msg = err.message || "";
        return msg.includes("InvalidSignature") || msg.includes("revert");
      },
      "should revert with InvalidSignature"
    );
  });

  // ─── Test 3: Invalid proof ────────────────────────────────

  it("3) Invalid proof: mock verifier returns false reverts", async () => {
    const rawHash = ethers.keccak256(ethers.toUtf8Bytes("bad-proof-receipt"));
    const { v, r, s } = await signRawHash(rawHash, trustedWallet);
    const raw = makeRawData();
    const proof = makeProofData();

    // Make verifier reject
    await mockVerifier.setVerify(false);

    const registryAsSubmitter = registry.connect(submitter);
    await assert.rejects(
      registryAsSubmitter.submitReceipt(raw, rawHash, v, r, s, proof),
      (err) => {
        const msg = err.message || "";
        return msg.includes("InvalidProof") || msg.includes("revert");
      },
      "should revert with InvalidProof"
    );
  });

  // ─── Test 4: Wrong nonce ──────────────────────────────────

  it("4) Wrong nonce: nonce mismatch reverts", async () => {
    const rawHash = ethers.keccak256(ethers.toUtf8Bytes("wrong-nonce-receipt"));
    const { v, r, s } = await signRawHash(rawHash, trustedWallet);
    // Set nonce to 5 but registry expects 0
    const raw = makeRawData({ nonce: 5n });
    const proof = makeProofData();

    const registryAsSubmitter = registry.connect(submitter);
    await assert.rejects(
      registryAsSubmitter.submitReceipt(raw, rawHash, v, r, s, proof),
      (err) => {
        const msg = err.message || "";
        return msg.includes("InvalidNonce") || msg.includes("revert");
      },
      "should revert with InvalidNonce"
    );
  });

  // ─── Test 5: Duplicate commitment ─────────────────────────

  it("5) Duplicate commitment: second submission with same commitment reverts", async () => {
    // Use a fixed commitment for both submissions
    const fixedCommitment = BigInt(ethers.keccak256(ethers.toUtf8Bytes("dup-commitment")));

    // First submission (should succeed)
    const rawHash1 = ethers.keccak256(ethers.toUtf8Bytes("receipt-dup-1"));
    const sig1 = await signRawHash(rawHash1, trustedWallet);
    const raw1 = makeRawData({ nonce: 0n });
    const proof1 = makeProofData({ commitment: fixedCommitment });

    const registryAsSubmitter = registry.connect(submitter);
    const tx = await registryAsSubmitter.submitReceipt(
      raw1, rawHash1, sig1.v, sig1.r, sig1.s, proof1
    );
    await tx.wait();

    // Second submission with same commitment (should fail)
    const rawHash2 = ethers.keccak256(ethers.toUtf8Bytes("receipt-dup-2"));
    const sig2 = await signRawHash(rawHash2, trustedWallet);
    const raw2 = makeRawData({ nonce: 1n }); // nonce incremented
    const proof2 = makeProofData({ commitment: fixedCommitment }); // same commitment!

    await assert.rejects(
      registryAsSubmitter.submitReceipt(raw2, rawHash2, sig2.v, sig2.r, sig2.s, proof2),
      (err) => {
        const msg = err.message || "";
        return msg.includes("CommitmentAlreadyUsed") || msg.includes("revert");
      },
      "should revert with CommitmentAlreadyUsed"
    );
  });

  // ─── Test 6: Epoch mismatch ───────────────────────────────

  it("6) Epoch mismatch: raw.epoch != proof.pubSignals[1] reverts", async () => {
    const rawHash = ethers.keccak256(ethers.toUtf8Bytes("epoch-mismatch-receipt"));
    const { v, r, s } = await signRawHash(rawHash, trustedWallet);
    // raw says epoch 1000, proof says epoch 2000
    const raw = makeRawData({ epoch: 1000n });
    const proof = makeProofData({ epoch: 2000n });

    const registryAsSubmitter = registry.connect(submitter);
    await assert.rejects(
      registryAsSubmitter.submitReceipt(raw, rawHash, v, r, s, proof),
      (err) => {
        const msg = err.message || "";
        return msg.includes("EpochMismatch") || msg.includes("revert");
      },
      "should revert with EpochMismatch"
    );
  });

  // ─── Test 7: getNonce behavior ────────────────────────────

  it("7) getNonce: returns correct values before and after submissions", async () => {
    const addr = submitter.address;
    const userId = 99n;

    // Before any submission
    assert.equal(await registry.getNonce(addr, userId), 0n, "initial nonce should be 0");

    // Submit receipt with nonce 0
    const rawHash = ethers.keccak256(ethers.toUtf8Bytes("nonce-query-receipt"));
    const { v, r, s } = await signRawHash(rawHash, trustedWallet);
    const raw = makeRawData({ userId, nonce: 0n });
    const proof = makeProofData();

    const registryAsSubmitter = registry.connect(submitter);
    await (await registryAsSubmitter.submitReceipt(raw, rawHash, v, r, s, proof)).wait();

    // After first submission
    assert.equal(await registry.getNonce(addr, userId), 1n, "nonce should be 1 after first submit");

    // Different userId should still be 0
    assert.equal(await registry.getNonce(addr, 100n), 0n, "other userId nonce should still be 0");

    // Different submitter should still be 0
    assert.equal(await registry.getNonce(deployer.address, userId), 0n, "other submitter nonce should be 0");
  });
});
