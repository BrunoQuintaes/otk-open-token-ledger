/**
 * PA-03 Closeout — Full Loop Integration Test
 *
 * Validates the complete PA-03 loop:
 *   generateProof() (snarkjs Groth16 — real ZK) →
 *   submitReceipt() on-chain (ReceiptRegistry) →
 *   txHash confirmed →
 *   ReceiptSubmitted event emitted
 *
 * This test replicates the exact execution path of ProverDaemon.submitProofOnChain():
 *   - canonicalHashForChain() (4-field keccak256, alphabetical order)
 *   - proofToSolidity() (pi_b coordinate reversal)
 *   - wallet.signMessage() EIP-191 personal sign
 *   - ReceiptRegistry.submitReceipt() call
 *
 * Uses Hardhat in-process network + real snarkjs groth16.fullProve().
 * ZK artifacts: zk/build/metering_v1_js/metering_v1.wasm + zk/build/metering_v1_final.zkey
 *
 * @since PA-03 (2026-03-12)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";
import { ethers } from "ethers";
import { groth16 } from "snarkjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

const WASM_PATH = path.join(ROOT, "zk", "build", "metering_v1_js", "metering_v1.wasm");
// H1R2 B3: OTK_PA03_V1_ZKEY lets the author point at the historical key where it already lives (outside the repo),
// instead of copying it into zk/build/. Unset or empty -> the default path below, exactly as before (skip unchanged).
const ZKEY_PATH = process.env.OTK_PA03_V1_ZKEY
  ? path.resolve(process.env.OTK_PA03_V1_ZKEY)
  : path.join(ROOT, "zk", "build", "metering_v1_final.zkey");

/**
 * Convert snarkjs proof → Solidity calldata format.
 * CRITICAL: pi_b G2 coordinates reversed (matches ProverDaemon.proofToSolidity).
 */
function proofToSolidity(proof, publicSignals) {
  return {
    a: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])],
    b: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],  // reversed
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],  // reversed
    ],
    c: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])],
    pubSignals: [BigInt(publicSignals[0]), BigInt(publicSignals[1]), BigInt(publicSignals[2])],
  };
}

/**
 * Canonical 4-field hash for ReceiptRegistry.submitReceipt.
 * Fields alphabetical: costUnits, epoch, nonce, userId.
 * Matches ProverDaemon.canonicalHashForChain() and deploy_besu_u4_6.js.
 */
function canonicalHashForChain(input) {
  const s = `costUnits\n${input.usage}\nepoch\n${input.epoch}\nnonce\n${input.nonce}\nuserId\n${input.userId}\n`;
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

// PKG-03 (RUN-M1-RESUME-R2-20261012): the historical v1 proving key (zk/build/metering_v1_final.zkey, ~360 KB, ignored by
// git) is not in the repository nor in the academic package. Without it the suite was CANCELLED by the before() hook (a
// failure that the package run had to "declare"); each test is now SKIPPED with the reason (counted as skipped, never as
// passed; a suite-level skip would drop them from the counts). With the key present (author's battery) they run as before.
const V1_KEY_ABSENT = !fs.existsSync(ZKEY_PATH)
  && "historical v1 proving key zk/build/metering_v1_final.zkey not present (not versioned, not distributed); the v3 loop is covered by d1d8_a_registry_v3";

describe("PA-03 Closeout — Full Loop (ZK Proof + On-Chain)", () => {
  // snarkjs keeps bn128 worker threads alive until the curve is terminated; without this the
  // test file never exits once the v1 zkey is present (observed 2026-09-30, clean clone).
  after(async () => { await globalThis.curve_bn128?.terminate(); });

  let conn;
  let deployer;
  let registry;
  let verifier;

  before(async () => {
    if (V1_KEY_ABSENT) return; // both tests are skipped below
    // Verify ZK artifacts exist
    assert.ok(fs.existsSync(WASM_PATH), `wasm missing: ${WASM_PATH}`);
    assert.ok(fs.existsSync(ZKEY_PATH), `zkey missing: ${ZKEY_PATH}`);

    conn = await hre.network.connect();
    const signers = await conn.ethers.getSigners();
    deployer = signers[0];

    // Deploy Groth16Verifier (metering_v1)
    const VerifierFactory = await conn.ethers.getContractFactory(
      "contracts/MeteringVerifier.sol:Groth16Verifier"
    );
    verifier = await VerifierFactory.deploy();
    await verifier.waitForDeployment();

    // Deploy ReceiptRegistry with deployer as trustedSigner
    // (deployer signs rawHash off-chain, same account calls submitReceipt)
    const RegFactory = await conn.ethers.getContractFactory("ReceiptRegistry");
    registry = await RegFactory.deploy(
      await verifier.getAddress(),
      await deployer.getAddress()
    );
    await registry.waitForDeployment();
  });

  it("generates fresh ZK proof and submits on-chain — captures real txHash", { skip: V1_KEY_ABSENT }, async () => {
    // --- Circuit inputs (mirror what ProverDaemon receives from API) ---
    const circuitInput = {
      userId: "42",
      usage: "150",
      nonce: "0",
      epoch: "483695",   // fixed test epoch — matches raw.epoch below
      maxUsage: "1000000",
    };

    // --- Generate fresh ZK proof (real snarkjs.groth16.fullProve) ---
    const t0 = Date.now();
    const { proof, publicSignals } = await groth16.fullProve(circuitInput, WASM_PATH, ZKEY_PATH);
    const proveMs = Date.now() - t0;

    assert.ok(proof, "proof must be generated");
    assert.equal(publicSignals.length, 3, "pubSignals must have 3 elements");
    assert.equal(publicSignals[1], circuitInput.epoch, "pubSignals[1] must match epoch input");

    // --- Build raw receipt data (matches ProverDaemon.submitProofOnChain input) ---
    const raw = {
      userId:    BigInt(circuitInput.userId),
      nonce:     BigInt(circuitInput.nonce),
      epoch:     BigInt(circuitInput.epoch),
      costUnits: BigInt(circuitInput.usage),
    };

    // --- Compute rawHash (canonical 4-field, alphabetical) ---
    const rawHash = canonicalHashForChain(circuitInput);

    // --- Sign rawHash via EIP-191 personal sign (matches ProverDaemon) ---
    const rawHashBytes = ethers.getBytes(rawHash);
    const deployerWallet = deployer;  // uses Hardhat provider
    const sig = ethers.Signature.from(await deployerWallet.signMessage(rawHashBytes));

    // --- Convert proof to Solidity format (pi_b reversed) ---
    const proofData = proofToSolidity(proof, publicSignals);

    // --- Submit on-chain ---
    const t1 = Date.now();
    const tx = await registry.submitReceipt(raw, rawHash, sig.v, sig.r, sig.s, proofData);
    const receipt = await tx.wait();
    const submitMs = Date.now() - t1;

    assert.ok(receipt, "tx receipt must be non-null");
    assert.equal(receipt.status, 1, "tx must succeed (status=1)");
    assert.ok(receipt.hash, "txHash must be present");
    assert.match(receipt.hash, /^0x[0-9a-fA-F]{64}$/, "txHash must be 66-char hex");

    // --- Verify ReceiptSubmitted event ---
    const event = receipt.logs
      .map(log => { try { return registry.interface.parseLog(log); } catch { return null; } })
      .find(e => e?.name === "ReceiptSubmitted");

    assert.ok(event, "ReceiptSubmitted event must be emitted");
    assert.equal(event.args.userId, raw.userId, "event.userId must match");
    assert.equal(event.args.costUnits, raw.costUnits, "event.costUnits must match");
    assert.equal(event.args.epoch, raw.epoch, "event.epoch must match");

    // --- Nonce advanced ---
    const expectedNonce = await registry.getNonce(await deployer.getAddress(), raw.userId);
    assert.equal(expectedNonce, 1n, "nonce must advance to 1 after first submit");

    // --- Commitment marked used ---
    const commitment = `0x${BigInt(publicSignals[0]).toString(16).padStart(64, "0")}`;
    const isUsed = await registry.usedCommitments(commitment);
    assert.ok(isUsed, "commitment must be marked as used (anti-replay)");

    // --- Report ---
    process.stderr.write(`[PA-03 Closeout] proveMs=${proveMs} submitMs=${submitMs}\n`);
    process.stderr.write(`[PA-03 Closeout] txHash=${receipt.hash}\n`);
    process.stderr.write(`[PA-03 Closeout] blockNumber=${receipt.blockNumber}\n`);
    process.stderr.write(`[PA-03 Closeout] pubSignals=${JSON.stringify(publicSignals)}\n`);
    process.stderr.write(`[PA-03 Closeout] ReceiptSubmitted userId=${raw.userId} costUnits=${raw.costUnits} epoch=${raw.epoch}\n`);
  });

  it("second submit with same commitment is rejected (anti-replay)", { skip: V1_KEY_ABSENT }, async () => {
    // Use different userId/nonce to get a fresh commitment but same circuit inputs
    // We want to test that a REUSED commitment is rejected
    // Best way: try to submit the same proof again → CommitmentAlreadyUsed
    const circuitInput = {
      userId: "42",
      usage: "150",
      nonce: "0",    // same inputs = same commitment = should be rejected
      epoch: "483695",
      maxUsage: "1000000",
    };
    const { proof, publicSignals } = await groth16.fullProve(circuitInput, WASM_PATH, ZKEY_PATH);
    const raw = {
      userId:    BigInt(circuitInput.userId),
      nonce:     1n,  // advance nonce to pass nonce check
      epoch:     BigInt(circuitInput.epoch),
      costUnits: BigInt(circuitInput.usage),
    };
    const rawHash = canonicalHashForChain({ ...circuitInput, nonce: "1" });
    const sig = ethers.Signature.from(await deployer.signMessage(ethers.getBytes(rawHash)));
    const proofData = proofToSolidity(proof, publicSignals);

    // Same proof → same commitment (pubSignals[0]) → must revert CommitmentAlreadyUsed
    await assert.rejects(
      registry.submitReceipt(raw, rawHash, sig.v, sig.r, sig.s, proofData),
      /CommitmentAlreadyUsed/,
      "Second submit with same commitment must revert"
    );
  });
});
