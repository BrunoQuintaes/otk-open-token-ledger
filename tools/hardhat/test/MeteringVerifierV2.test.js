/**
 * MeteringVerifierV2 — On-Chain Gas Measurement (U12.POST.B — closes B-04)
 *
 * Uses a REAL Groth16 proof: metering_v2.circom + metering_v2_hermez_final.zkey
 * Proof exported via groth16.exportSolidityCallData() to ensure correct G2 point ordering.
 *
 * Input: userId=42, usage=500 (bucket [301=0x12d, 900=0x384]), nonce=1, epoch=709=0x2c5
 * pubSignals: [commitment, epoch=709, minUsageBucket=301, maxUsageBucket=900]
 *
 * EVD: docs/_ops/u12/U12_POST_CLAIM_CLOSURE_20260307_200937/PACK_B_CLAIM_CLOSURE/
 */
import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import hre from "hardhat";

// Proof values from groth16.exportSolidityCallData() — correct G2 point ordering for EVM
const PA = [
  "0x1595a48ad456fceb8b0e4f732773928638d8b9b91a70394d9a8ac3500487f658",
  "0x25d0baad237f6774bee61a35ab8f58f37cc6833091ea2f96d4ee5104aacd7dc4",
];
const PB = [
  [
    "0x1d308cd2e4bb1c9da8760c2ab2a43f94ecda2e7bf27c44fb43f90b1422a0c1d1",
    "0x03023da81eb8c4405fa63a5a3e241a6c3f646fa328b53aaf240ff100636b2a63",
  ],
  [
    "0x14ab906430436fdf786dd1b78d98df5400b6155ff98620c4e4ed6ffef0dde241",
    "0x2dfd86fa536e87dda7e40e8ce92cfad376e751d8d84113f33c925bd304b3454a",
  ],
];
const PC = [
  "0x04d4c1c503b8a29e220fa42d36591992a0f86cb9f383b93db7d1509c4671bdaa",
  "0x2a04724c932bf4a358f946cfe87ff847c076e0917f54b9be4b6539eacd43d025",
];
const PUB = [
  "0x085cbe9e775af385148478081f45cd5ff095ede5a7018afc9c8cc1aca2de1430",
  "0x00000000000000000000000000000000000000000000000000000000000002c5",
  "0x000000000000000000000000000000000000000000000000000000000000012d",
  "0x0000000000000000000000000000000000000000000000000000000000000384",
];

describe("MeteringVerifierV2Hermez — Real Groth16 Proof + Gas (B-04 closure)", () => {
  let conn;
  let verifier;

  before(async () => {
    conn = await hre.network.connect();
    const artifact = await hre.artifacts.readArtifact(
      "contracts/MeteringVerifierV2Hermez.sol:Groth16Verifier"
    );
    const Factory = await conn.ethers.getContractFactoryFromArtifact(artifact);
    verifier = await Factory.deploy();
    await verifier.waitForDeployment();
  });

  it("1) Real v2 (Hermez key) proof verifies correctly on-chain", async () => {
    const result = await verifier.verifyProof(PA, PB, PC, PUB);
    assert.equal(result, true, "Real Groth16 v2 proof must verify as true");
  });

  it("2) Measure gas for verifyProof() — closes B-04", async () => {
    const tx = await verifier.verifyProof.send(PA, PB, PC, PUB);
    const receipt = await tx.wait();
    const gasUsed = Number(receipt.gasUsed);

    console.log(`    MeteringVerifierV2Hermez gas: ${gasUsed.toLocaleString()}`);
    console.log(`    MeteringVerifier v1 gas:       290,620`);
    console.log(`    MockVerifier cold gas:          84,589`);
    console.log(`    v2/v1 ratio: ${(gasUsed / 290620).toFixed(2)}x`);
    console.log(`    +constraints (v2 ~280 vs v1 ~240 = +17%): expected ~${Math.round(290620 * 1.17).toLocaleString()}`);

    // Groth16 BN254 pairing: ~260K-380K gas expected
    assert.ok(gasUsed > 150_000, `gas ${gasUsed} suspiciously low`);
    assert.ok(gasUsed < 500_000, `gas ${gasUsed} exceeds 500K sanity bound`);
  });

  it("3) Tampered pubSignals fail verification", async () => {
    const bad = ["0x0000000000000000000000000000000000000000000000000000000000003039", ...PUB.slice(1)];
    const result = await verifier.verifyProof(PA, PB, PC, bad);
    assert.equal(result, false, "Tampered commitment must fail");
  });
});
