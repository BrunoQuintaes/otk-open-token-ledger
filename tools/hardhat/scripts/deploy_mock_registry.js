/**
 * deploy_mock_registry.js
 * Deploys MockVerifier + ReceiptRegistry(mock) for load testing (U10.3).
 * Usage: cd tools/hardhat && npx hardhat run --network besuLocal scripts/deploy_mock_registry.js
 */
import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";

async function main() {
  const conn = await hre.network.connect();
  const { ethers } = conn;
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address);

  // Deploy MockVerifier (always-true)
  const Mock = await ethers.getContractFactory("MockVerifier", deployer);
  const mock = await Mock.deploy();
  await mock.waitForDeployment();
  const mockAddr = await mock.getAddress();
  console.log("MockVerifier:", mockAddr);

  // Deploy ReceiptRegistry with MockVerifier + deployer as trusted signer
  const Registry = await ethers.getContractFactory("ReceiptRegistry", deployer);
  const registry = await Registry.deploy(mockAddr, deployer.address);
  await registry.waitForDeployment();
  const regAddr = await registry.getAddress();
  console.log("ReceiptRegistry:", regAddr);

  // Save addresses
  const out = { MockVerifier: mockAddr, ReceiptRegistry: regAddr, deployer: deployer.address, timestamp: new Date().toISOString() };
  const outPath = path.resolve("../../docs/_ops/u10/U10_3_LOADTEST_DEPLOY.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log("Addresses saved:", outPath);
}

main().catch(e => { console.error(e); process.exit(1); });
