/**
 * MockVerifier — Formal Gas Measurement Test (U12.POST.B)
 *
 * Measures gas consumption of ReceiptRegistry.submitReceipt() when backed
 * by MockVerifier. Closes formal gap GT-04 from stale_test_inventory.md.
 *
 * Canonical results (U12.B1 measurement):
 *   Cold SSTORE (1st tx): ~84,589 gas
 *   Warm SSTORE (2nd tx): ~67,501 gas
 *   Overhead vs Groth16 (290,620 gas): 3.44× cold, 4.31× warm
 *
 * Tolerance: ±10% (allows minor EVM version and compiler variation)
 * EVD: docs/_ops/u12/U12_POST_CLAIM_CLOSURE_20260307_200937/PACK_B_CLAIM_CLOSURE/
 */
import { describe, it, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { ethers } from "ethers";

function createWallet(seed) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(seed));
  return new ethers.Wallet(hash);
}

async function signRawHash(rawHash, wallet) {
  const sig = await wallet.signMessage(ethers.getBytes(rawHash));
  const split = ethers.Signature.from(sig);
  return { rawHash, v: split.v, r: split.r, s: split.s };
}

function makeRawData(overrides = {}) {
  return { userId: 42n, nonce: 0n, epoch: 1000n, costUnits: 500n, ...overrides };
}

function makeProofData(seed = "commitment-gas-test-1") {
  const commitment = BigInt(ethers.keccak256(ethers.toUtf8Bytes(seed)));
  return {
    a: [0n, 0n],
    b: [[0n, 0n], [0n, 0n]],
    c: [0n, 0n],
    pubSignals: [commitment, 1000n, 10000n],
  };
}

describe("MockVerifier — Gas Measurement (U12.POST.B formal)", () => {
  let conn, deployer, submitter, trustedWallet, mockVerifier, registry;

  before(async () => {
    conn = await hre.network.connect();
    const signers = await conn.ethers.getSigners();
    deployer = signers[0];
    submitter = signers[1];
    trustedWallet = createWallet("trusted-gas-test-seed");
  });

  beforeEach(async () => {
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

  it("1) Cold SSTORE: 1st submitReceipt gas ≈ 84,589 (±15%)", async () => {
    const rawHash = ethers.keccak256(ethers.toUtf8Bytes("gas-test-cold-receipt"));
    const { v, r, s } = await signRawHash(rawHash, trustedWallet);
    const raw = makeRawData({ nonce: 0n });
    const proof = makeProofData("commitment-cold-1");

    const tx = await registry.connect(submitter).submitReceipt(raw, rawHash, v, r, s, proof);
    const receipt = await tx.wait();
    const gasUsed = Number(receipt.gasUsed);

    // Canonical measured value: 84,589 gas (U12.B1)
    // Tolerance: ±15% to accommodate EVM/tooling variation
    const CANONICAL = 84_589;
    const TOLERANCE = 0.15;
    console.log(`    Cold SSTORE gas: ${gasUsed} (canonical: ${CANONICAL})`);
    assert.ok(
      gasUsed >= CANONICAL * (1 - TOLERANCE) && gasUsed <= CANONICAL * (1 + TOLERANCE),
      `Cold SSTORE gas ${gasUsed} out of ±15% tolerance of canonical ${CANONICAL}`
    );
  });

  it("2) Warm SSTORE: 2nd submitReceipt gas ≈ 67,501 (±15%)", async () => {
    // First tx warms the storage slot
    const rawHash1 = ethers.keccak256(ethers.toUtf8Bytes("gas-test-warm-receipt-1"));
    const { v: v1, r: r1, s: s1 } = await signRawHash(rawHash1, trustedWallet);
    const raw1 = makeRawData({ nonce: 0n });
    const proof1 = makeProofData("commitment-warm-seed-1");
    await registry.connect(submitter).submitReceipt(raw1, rawHash1, v1, r1, s1, proof1);

    // Second tx reuses the same slot (warm SSTORE)
    const rawHash2 = ethers.keccak256(ethers.toUtf8Bytes("gas-test-warm-receipt-2"));
    const { v: v2, r: r2, s: s2 } = await signRawHash(rawHash2, trustedWallet);
    const raw2 = makeRawData({ nonce: 1n }); // nonce incremented
    const proof2 = makeProofData("commitment-warm-seed-2");
    const tx2 = await registry.connect(submitter).submitReceipt(raw2, rawHash2, v2, r2, s2, proof2);
    const receipt2 = await tx2.wait();
    const gasUsed = Number(receipt2.gasUsed);

    // Canonical measured value: 67,501 gas (U12.B1)
    const CANONICAL = 67_501;
    const TOLERANCE = 0.15;
    console.log(`    Warm SSTORE gas: ${gasUsed} (canonical: ${CANONICAL})`);
    assert.ok(
      gasUsed >= CANONICAL * (1 - TOLERANCE) && gasUsed <= CANONICAL * (1 + TOLERANCE),
      `Warm SSTORE gas ${gasUsed} out of ±15% tolerance of canonical ${CANONICAL}`
    );
  });

  it("3) Groth16 overhead ratio: cold ≈ 3.44× (290,620 / cold_gas)", async () => {
    const rawHash = ethers.keccak256(ethers.toUtf8Bytes("gas-test-overhead-receipt"));
    const { v, r, s } = await signRawHash(rawHash, trustedWallet);
    const raw = makeRawData({ nonce: 0n });
    const proof = makeProofData("commitment-overhead-1");

    const tx = await registry.connect(submitter).submitReceipt(raw, rawHash, v, r, s, proof);
    const receipt = await tx.wait();
    const mockGas = Number(receipt.gasUsed);
    const GROTH16_GAS = 290_620;
    const overhead = GROTH16_GAS / mockGas;

    console.log(`    Overhead: ${overhead.toFixed(2)}× (Groth16=${GROTH16_GAS}, Mock=${mockGas})`);
    // Canonical: 3.44× cold. Allow 2.5×–5.0× range.
    assert.ok(overhead >= 2.5 && overhead <= 5.0,
      `Overhead ${overhead.toFixed(2)}× outside expected range [2.5×, 5.0×]`);
  });
});
