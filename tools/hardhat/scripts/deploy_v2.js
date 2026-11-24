/**
 * deploy_v2.js — Deploy MeteringVerifierV2MPC + ReceiptRegistryV2 (W5-5A01 / S6.1)
 *
 * Deploys the production on-chain stack for metering_v2.circom (range proof circuit).
 * Uses MPC-ceremony verifier (5 contributors + Hermez Phase 1, beacon applied).
 *
 * Usage:
 *   cd tools/hardhat && npx hardhat run --network besuLocal scripts/deploy_v2.js
 *   cd tools/hardhat && npx hardhat run --network localhost scripts/deploy_v2.js
 *
 * Output: saves deployed addresses to docs/_ops/wave5/DEPLOY_V2_<timestamp>.json
 */

import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

async function main() {
  const conn = await hre.network.connect();
  const { ethers } = conn;
  const [deployer] = await ethers.getSigners();

  console.log("=== OTK zk-Metering v2 Deployment (W5-5A01 / S6.1) ===");
  console.log("Network:", hre.network.name);
  console.log("Deployer:", deployer.address);
  console.log("Block:", await ethers.provider.getBlockNumber());
  console.log("");

  // --- Step 1: Deploy MeteringVerifierV2MPC ---
  console.log("Step 1: Deploying MeteringVerifierV2MPC (MPC ceremony, 5 contributors)...");
  const VerifierArtifact = await hre.artifacts.readArtifact("MeteringVerifierV2MPC");
  const VerifierFactory = new ethers.ContractFactory(
    VerifierArtifact.abi,
    VerifierArtifact.bytecode,
    deployer
  );
  const verifier = await VerifierFactory.deploy();
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  console.log("  MeteringVerifierV2MPC:", verifierAddr);

  // --- Step 2: Deploy ReceiptRegistryV2 ---
  console.log("Step 2: Deploying ReceiptRegistryV2...");
  const RegistryArtifact = await hre.artifacts.readArtifact("ReceiptRegistryV2");
  const RegistryFactory = new ethers.ContractFactory(
    RegistryArtifact.abi,
    RegistryArtifact.bytecode,
    deployer
  );
  // Constructor: (address _verifier, address _trustedSigner)
  // trustedSigner = deployer for local dev; use OTK_TRUSTED_SIGNER env in production
  const trustedSigner = process.env["OTK_TRUSTED_SIGNER"] ?? deployer.address;
  const registry = await RegistryFactory.deploy(verifierAddr, trustedSigner);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  console.log("  ReceiptRegistryV2:", registryAddr);
  console.log("  Trusted Signer:", trustedSigner);

  // --- Step 3: Smoke-test verifier is wired correctly ---
  console.log("Step 3: Verifying contract wiring...");
  const wiredVerifier = await registry.verifier();
  if (wiredVerifier.toLowerCase() !== verifierAddr.toLowerCase()) {
    throw new Error(`Verifier mismatch: registry.verifier()=${wiredVerifier}, expected=${verifierAddr}`);
  }
  console.log("  ✓ ReceiptRegistryV2.verifier() == MeteringVerifierV2MPC");

  // --- Step 4: Save addresses ---
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.join(REPO_ROOT, "docs/_ops/wave5");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `DEPLOY_V2_${timestamp}.json`);

  const result = {
    wave: "W5-5A01",
    circuit: "metering_v2.circom",
    mpcKey: "zk/keys/metering_v2_final_mpc.zkey",
    network: hre.network.name,
    deployer: deployer.address,
    trustedSigner,
    contracts: {
      MeteringVerifierV2MPC: verifierAddr,
      ReceiptRegistryV2: registryAddr,
    },
    deployedAt: new Date().toISOString(),
  };

  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log("");
  console.log("=== Deployment Complete ===");
  console.log("  MeteringVerifierV2MPC:", verifierAddr);
  console.log("  ReceiptRegistryV2:", registryAddr);
  console.log("  Addresses saved:", outPath);
  console.log("");
  console.log("Next: Update OTK_REGISTRY_V2_ADDRESS env var to:", registryAddr);

  return result;
}

main().catch((e) => {
  console.error("Deploy failed:", e);
  process.exit(1);
});
