/**
 * U8.5.4 — Gas Measurement Script
 *
 * Measures gasUsed for ReceiptRegistry.submitReceipt under two conditions:
 *   A) Mock verifier (N=10 samples, different nonces — anti-replay via nonce+userId)
 *   B) Groth16 verifier (N=1, real ZK proof from zk/build/)
 *
 * Output: JSON report + summary table to stdout
 *
 * Usage:
 *   cd tools/hardhat
 *   RAW_USER_ID=... RAW_COST_UNITS=... TRUSTED_SIGNER=... TRUSTED_SIGNER_KEY=... \
 *     npx hardhat run --network besuLocal scripts/gas_measure_u8_5_4.js
 *
 * @module gas_measure_u8_5_4
 * @since U8.5.4
 */
import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { ethers as ethersLib } from "ethers";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// pi_b rows must be reversed for Solidity pairing check
function proofToSolidity(proof, pubSignals) {
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [
      [proof.pi_b[0][1], proof.pi_b[0][0]],
      [proof.pi_b[1][1], proof.pi_b[1][0]],
    ],
    c: [proof.pi_c[0], proof.pi_c[1]],
    pubSignals,
  };
}

// EIP-191 canonical hash — must match ReceiptRegistry.sol + SignatureManager.ts
function canonicalHash(raw) {
  const s = `costUnits\n${raw.costUnits}\nepoch\n${raw.epoch}\nnonce\n${raw.nonce}\nuserId\n${raw.userId}\n`;
  return ethersLib.keccak256(ethersLib.toUtf8Bytes(s));
}

// Dummy ZK proof for MockVerifier (always accepts)
function dummyProofData() {
  const z = "0";
  return {
    a: [z, z],
    b: [[z, z], [z, z]],
    c: [z, z],
    pubSignals: [z, z, z],
  };
}

async function submitOne(registry, trustedWallet, raw, proofData) {
  const rawHash = canonicalHash(raw);
  const sig = ethersLib.Signature.from(
    await trustedWallet.signMessage(ethersLib.getBytes(rawHash))
  );
  const tx = await registry.submitReceipt(raw, rawHash, sig.v, sig.r, sig.s, proofData);
  const rc = await tx.wait();
  return { gasUsed: Number(rc.gasUsed), txHash: rc.hash, blockNumber: rc.blockNumber };
}

function stats(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = Math.round(arr.reduce((s, v) => s + v, 0) / arr.length);
  const median = sorted[Math.floor(sorted.length / 2)];
  return { min, max, avg, median, n: arr.length };
}

async function main() {
  const conn = await hre.network.connect();
  const ethers = conn.ethers;
  const [signer] = await ethers.getSigners();
  const trustedAddr = mustEnv("TRUSTED_SIGNER");
  const trustedWallet = new ethersLib.Wallet(mustEnv("TRUSTED_SIGNER_KEY"));
  const baseUserId = BigInt(mustEnv("RAW_USER_ID"));
  const costUnits = BigInt(mustEnv("RAW_COST_UNITS"));
  const N = parseInt(process.env.GAS_SAMPLES || "10");

  console.log("=".repeat(60));
  console.log("U8.5.4 — Gas Measurement: ReceiptRegistry.submitReceipt");
  console.log("=".repeat(60));
  console.log(`deployer=${signer.address}`);
  console.log(`trustedSigner=${trustedAddr}`);
  console.log(`N=${N} samples (mock), 1 sample (Groth16 from history)`);

  // -----------------------------------------------------------------------
  // Part A: MockVerifier — N samples with different (userId, nonce) pairs
  // -----------------------------------------------------------------------
  console.log("\n--- Part A: MockVerifier (N=" + N + ") ---");

  const MockVerifier = await ethers.getContractFactory("MockVerifier", signer);
  const mockVerifier = await MockVerifier.deploy();
  await mockVerifier.waitForDeployment();

  const Registry = await ethers.getContractFactory("ReceiptRegistry", signer);
  const mockRegistry = await Registry.deploy(await mockVerifier.getAddress(), trustedAddr);
  await mockRegistry.waitForDeployment();

  console.log(`mockVerifier=${await mockVerifier.getAddress()}`);
  console.log(`mockRegistry=${await mockRegistry.getAddress()}`);

  const mockGasSamples = [];
  const proof = dummyProofData();

  for (let i = 0; i < N; i++) {
    // Use unique userId per sample to avoid anti-replay (different commitment per call)
    const raw = {
      userId: baseUserId + BigInt(i),
      nonce: 0n,  // nonce 0 for each fresh userId
      epoch: 1n,
      costUnits,
    };
    const result = await submitOne(mockRegistry, trustedWallet, raw, proof);
    mockGasSamples.push(result.gasUsed);
    console.log(`  [${i}] gasUsed=${result.gasUsed} txHash=${result.txHash}`);
  }

  const mockStats = stats(mockGasSamples);
  console.log(`\nMock stats (N=${N}): min=${mockStats.min} max=${mockStats.max} avg=${mockStats.avg} median=${mockStats.median}`);

  // -----------------------------------------------------------------------
  // Part B: Groth16Verifier — real ZK proof (1 sample, from prior E2E run)
  // -----------------------------------------------------------------------
  console.log("\n--- Part B: Groth16Verifier (known tx) ---");

  // Known from U4.6 E2E: txHash=0xde2d7f42..., gasUsed fetched from chain
  const knownTxHash = "0xde2d7f42fdbdf4dab860753e063986ee5047e0cf7e2c15b7f132d41c810c6945";
  const provider = ethers.provider;
  let groth16GasUsed = null;
  try {
    const receipt = await provider.getTransactionReceipt(knownTxHash);
    if (receipt) {
      groth16GasUsed = Number(receipt.gasUsed);
      console.log(`  knownTx=${knownTxHash}`);
      console.log(`  gasUsed=${groth16GasUsed} (from eth_getTransactionReceipt)`);
    } else {
      console.log(`  WARNING: known tx not found on current RPC (receipt=null)`);
    }
  } catch (e) {
    console.log(`  WARNING: could not fetch known tx: ${e.message}`);
  }

  // Also deploy fresh Groth16 + submit real proof if zk/build/ exists
  const root = path.resolve(process.cwd(), "..", "..");
  const proofPath = path.join(root, "zk", "build", "proof.json");
  const pubPath = path.join(root, "zk", "build", "public.json");
  let freshGroth16Gas = null;

  if (fs.existsSync(proofPath) && fs.existsSync(pubPath)) {
    console.log(`\n  Submitting fresh real proof...`);
    const proofJson = loadJson(proofPath);
    const pub = loadJson(pubPath);
    const proofData = proofToSolidity(proofJson, pub);

    const Groth16Verifier = await ethers.getContractFactory("Groth16Verifier", signer);
    const groth16Verifier = await Groth16Verifier.deploy();
    await groth16Verifier.waitForDeployment();

    const freshRegistry = await Registry.deploy(await groth16Verifier.getAddress(), trustedAddr);
    await freshRegistry.waitForDeployment();

    const raw = {
      userId: baseUserId,
      nonce: 0n,
      epoch: BigInt(pub[1]),
      costUnits,
    };
    const result = await submitOne(freshRegistry, trustedWallet, raw, proofData);
    freshGroth16Gas = result.gasUsed;
    console.log(`  groth16Verifier=${await groth16Verifier.getAddress()}`);
    console.log(`  freshRegistry=${await freshRegistry.getAddress()}`);
    console.log(`  freshGroth16Gas=${freshGroth16Gas} txHash=${result.txHash}`);
  } else {
    console.log(`  (zk/build/proof.json not found — skipping fresh Groth16 submit)`);
  }

  // -----------------------------------------------------------------------
  // Summary
  // -----------------------------------------------------------------------
  const report = {
    timestamp: new Date().toISOString(),
    network: "besuLocal (IBFT, chainId=1337, Berlin)",
    phase: "U8.5.4",
    mockVerifier: {
      samples: mockGasSamples,
      ...mockStats,
    },
    groth16Verifier: {
      knownTx: {
        txHash: knownTxHash,
        gasUsed: groth16GasUsed,
        source: "eth_getTransactionReceipt (U4.6 E2E)",
      },
      freshSubmit: {
        gasUsed: freshGroth16Gas,
        source: freshGroth16Gas ? "fresh deploy + proof.json" : "skipped",
      },
    },
    delta: groth16GasUsed && mockStats.avg
      ? groth16GasUsed - mockStats.avg
      : null,
    deltaNote: "Groth16 overhead = groth16GasUsed - mock avg",
  };

  console.log("\n" + "=".repeat(60));
  console.log("SUMMARY");
  console.log("=".repeat(60));
  console.log(`Mock (no ZK):    avg=${mockStats.avg}  min=${mockStats.min}  max=${mockStats.max}`);
  if (groth16GasUsed) {
    console.log(`Groth16 (known): gasUsed=${groth16GasUsed}`);
  }
  if (freshGroth16Gas) {
    console.log(`Groth16 (fresh): gasUsed=${freshGroth16Gas}`);
  }
  if (report.delta !== null) {
    console.log(`ZK overhead (Groth16-mock): ${report.delta} gas`);
  }
  console.log("=".repeat(60));

  // Write JSON report
  const reportPath = path.join(root, "docs", "_ops", "u8", "gas_report_u8_5_4.json");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nReport written: ${reportPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
