/**
 * deploy_v3.js — deploy MeteringVerifierV3Demo + ReceiptRegistryV3 + BatchRegistryV3
 * (D1/D2/D6, run 20260930-1625). Parameters come from zk/v3/MANIFEST.json, so the registry is
 * bound to exactly the circuit, bucket policy and verifier of the manifest.
 *
 * LOCAL DEMONSTRATIVE SETUP keys (see zk/v3/README.md). Never deploy over a historical network
 * state or reuse v1/v2 registry addresses.
 *
 *   cd tools/hardhat
 *   OTK_V3_SIGNER_ADDRESS=0x… OTK_DEPLOY_OUT=<file.json> npx hardhat run --network <net> scripts/deploy_v3.js
 *
 * OTK_V3_SIGNER_ADDRESS is the operator key ADDRESS (public), required: keep the operator key separate
 * from the deployer/owner key and from any key enabled on v1/v2 registries (those accept EIP-191
 * signatures over arbitrary hashes, R16). OTK_V3_ALLOW_DEPLOYER_SIGNER=1 allows deployer = signer
 * for throwaway local tests only.
 * OTK_DEPLOY_OUT is where the addresses are written (no default path under docs/_ops).
 */
import hre from "hardhat";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "../../..");

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "zk/v3/MANIFEST.json"), "utf8"));
  const conn = await hre.network.connect();
  const { ethers } = conn;
  const [deployer] = await ethers.getSigners();
  const signer = process.env["OTK_V3_SIGNER_ADDRESS"] ?? (process.env["OTK_V3_ALLOW_DEPLOYER_SIGNER"] === "1" ? deployer.address : null);
  if (!signer) throw new Error("set OTK_V3_SIGNER_ADDRESS (operator key address, distinct from the deployer)");
  if (!ethers.isAddress(signer)) throw new Error("OTK_V3_SIGNER_ADDRESS is not an address");

  const circuitIdHash = ethers.keccak256(ethers.toUtf8Bytes(manifest.circuitId));
  const bucketPolicyId = ethers.keccak256(ethers.toUtf8Bytes(manifest.registry.bucketPolicy));
  const width = BigInt(manifest.registry.bucketWidthUnits);
  // The policy id hashes only the version string: refuse a width that contradicts it.
  const m = /width=(\d+)CU:unit=microCU$/.exec(manifest.registry.bucketPolicy);
  if (!m || BigInt(m[1]) * 1_000_000n !== width) throw new Error(`bucketWidthUnits ${width} contradicts policy ${manifest.registry.bucketPolicy}`);

  const verifier = await (await ethers.getContractFactory("MeteringVerifierV3Demo")).deploy();
  await verifier.waitForDeployment();
  const registry = await (await ethers.getContractFactory("ReceiptRegistryV3")).deploy(await verifier.getAddress(), signer, circuitIdHash, bucketPolicyId, width);
  await registry.waitForDeployment();
  const batch = await (await ethers.getContractFactory("BatchRegistryV3")).deploy(signer);
  await batch.waitForDeployment();

  // Wiring checks before anyone uses the addresses.
  if ((await registry.verifier()).toLowerCase() !== (await verifier.getAddress()).toLowerCase()) throw new Error("verifier wiring");
  if ((await registry.circuitId()) !== circuitIdHash) throw new Error("circuitId wiring");
  if ((await registry.bucketPolicy()) !== bucketPolicyId) throw new Error("bucketPolicy wiring");
  if (!(await registry.isSigner(signer)) || !(await batch.isSigner(signer))) throw new Error("signer wiring");

  const net = await ethers.provider.getNetwork();
  const result = {
    schema: "otk.deploy_v3.v1",
    label: manifest.label,
    chainId: net.chainId.toString(),
    deployer: deployer.address,
    signer,
    circuitId: manifest.circuitId,
    circuitIdHash,
    bucketPolicy: manifest.registry.bucketPolicy,
    bucketPolicyId,
    bucketWidthUnits: width.toString(),
    manifestFiles: { zkey: manifest.files["zk/v3/keys/metering_v3_demo_final.zkey"], verifierSol: manifest.files["tools/hardhat/contracts/v3/MeteringVerifierV3Demo.sol"] },
    contracts: { MeteringVerifierV3Demo: await verifier.getAddress(), ReceiptRegistryV3: await registry.getAddress(), BatchRegistryV3: await batch.getAddress() },
    domain: { chainId: net.chainId.toString(), registry: await registry.getAddress(), verifier: await verifier.getAddress(), schemaVersion: await registry.SCHEMA_VERSION() },
    batchDomain: { chainId: net.chainId.toString(), registry: await batch.getAddress(), verifier: await verifier.getAddress(), schemaVersion: await batch.SCHEMA_VERSION() },
    block: await ethers.provider.getBlockNumber(),
    deployedAt: new Date().toISOString(),
  };
  const out = process.env["OTK_DEPLOY_OUT"];
  if (out) fs.writeFileSync(out, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify(result, null, 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
