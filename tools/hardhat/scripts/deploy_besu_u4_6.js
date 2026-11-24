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

// snarkjs proof.json -> ProofData solidity format (pi_b reversed)
function proofToSolidity(proof, pubSignals) {
  const a = [proof.pi_a[0], proof.pi_a[1]];
  const b = [
    [proof.pi_b[0][1], proof.pi_b[0][0]],
    [proof.pi_b[1][1], proof.pi_b[1][0]],
  ];
  const c = [proof.pi_c[0], proof.pi_c[1]];
  return { a, b, c, pubSignals };
}

// Canonical hash: alphabetical field concat + \n → keccak256(utf8)
// Fields: costUnits, epoch, nonce, userId (alphabetical)
function canonicalHash(raw) {
  const s = `costUnits\n${raw.costUnits}\nepoch\n${raw.epoch}\nnonce\n${raw.nonce}\nuserId\n${raw.userId}\n`;
  return ethersLib.keccak256(ethersLib.toUtf8Bytes(s));
}

async function main() {
  // Hardhat v3: ethers accessed via network connection
  const conn = await hre.network.connect();
  const ethers = conn.ethers;
  const signer = (await ethers.getSigners())[0];

  // Deploy Groth16Verifier
  const Verifier = await ethers.getContractFactory("Groth16Verifier", signer);
  const verifier = await Verifier.deploy();
  await verifier.waitForDeployment();

  // Deploy ReceiptRegistry(verifier, trustedSigner)
  const trustedAddr = mustEnv("TRUSTED_SIGNER");
  const Registry = await ethers.getContractFactory("ReceiptRegistry", signer);
  const registry = await Registry.deploy(await verifier.getAddress(), trustedAddr);
  await registry.waitForDeployment();

  // Load ZK proof + pubSignals
  const root = path.resolve(process.cwd(), "..", "..");
  const proofJson = loadJson(path.join(root, "zk", "build", "proof.json"));
  const pub = loadJson(path.join(root, "zk", "build", "public.json"));
  if (!Array.isArray(pub) || pub.length !== 3) throw new Error("public.json must be [commitment,epoch,maxUsage]");
  const proofData = proofToSolidity(proofJson, pub);

  // Build RawReceiptData — fields: userId, nonce, epoch, costUnits
  const raw = {
    userId:     BigInt(mustEnv("RAW_USER_ID")),
    nonce:      BigInt(mustEnv("RAW_NONCE")),
    epoch:      BigInt(pub[1]),   // must match pubSignals[1]
    costUnits:  BigInt(mustEnv("RAW_COST_UNITS")),
  };

  // Compute canonical hash + EIP-191 sign with trustedSigner key
  const rawHash = canonicalHash(raw);
  const trustedWallet = new ethersLib.Wallet(mustEnv("TRUSTED_SIGNER_KEY"));
  const sig = ethersLib.Signature.from(await trustedWallet.signMessage(ethersLib.getBytes(rawHash)));

  console.log("deployer=", signer.address);
  console.log("verifier=", await verifier.getAddress());
  console.log("registry=", await registry.getAddress());
  console.log("trustedSigner=", trustedAddr);
  console.log("raw=", raw);
  console.log("rawHash=", rawHash);
  console.log("pubSignals=", pub);

  const tx = await registry.submitReceipt(raw, rawHash, sig.v, sig.r, sig.s, proofData);
  const rc = await tx.wait();
  console.log("txHash=", rc.hash);
  console.log("blockNumber=", rc.blockNumber);

  for (const log of rc.logs) {
    try {
      const parsed = registry.interface.parseLog(log);
      console.log("event=", parsed.name, JSON.stringify(parsed.args, (_, v) => typeof v === "bigint" ? v.toString() : v, 2));
    } catch {}
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
