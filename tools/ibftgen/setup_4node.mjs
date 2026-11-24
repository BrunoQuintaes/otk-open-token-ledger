/**
 * setup_4node.mjs — Generate keys for node3/node4 and output network config
 * Usage: node tools/ibftgen/setup_4node.mjs
 *
 * Reads existing node1/node2 keys, generates new node3/node4 keys,
 * outputs network-config.json with all 4 nodes' addresses and enode pubkeys.
 *
 * IMPORTANT: This script reads/writes private keys locally. Never commit key files.
 */
import { ethers } from "ethers";
import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "../../");
const IBFT = path.join(ROOT, "infra/ibft");
const NODES = [1, 2, 3, 4];
const IPS = {
  1: "172.31.200.11",
  2: "172.31.200.12",
  3: "172.31.200.13",
  4: "172.31.200.14",
};

function readOrGenerateKey(nodeNum) {
  const keyPath = path.join(IBFT, `node${nodeNum}/data/key`);
  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, "utf8").trim();
    const pk = raw.startsWith("0x") ? raw : "0x" + raw;
    console.log(`  node${nodeNum}: existing key loaded`);
    return pk;
  }
  // Generate new key
  const wallet = ethers.Wallet.createRandom();
  const pk = wallet.privateKey; // 0x-prefixed
  const rawHex = pk.slice(2); // strip 0x for file
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });
  fs.writeFileSync(keyPath, rawHex, "utf8");
  console.log(`  node${nodeNum}: NEW key generated`);
  return pk;
}

function deriveAddress(pk) {
  return new ethers.Wallet(pk).address.toLowerCase();
}

function deriveEnodePub(pk) {
  const sk = new ethers.SigningKey(pk);
  const pub = sk.publicKey.toLowerCase(); // 0x04 + 128 hex
  return pub.startsWith("0x04") ? pub.slice(4) : pub.slice(2);
}

console.log("=== OTK IBFT 4-Node Setup ===\n");
console.log("Reading/generating keys...");

const nodes = NODES.map((n) => {
  const pk = readOrGenerateKey(n);
  const address = deriveAddress(pk);
  const enodePub = deriveEnodePub(pk);
  const ip = IPS[n];
  return {
    node: n,
    address: address.replace("0x", ""),
    addressPrefixed: address,
    enodePub,
    ip,
    enode: `enode://${enodePub}@${ip}:30303?discport=0`,
  };
});

console.log("\nNode info:");
for (const n of nodes) {
  console.log(`  node${n.node}: addr=${n.addressPrefixed} ip=${n.ip}`);
}

// Sort validators alphabetically (IBFT requirement)
const validators = nodes.map((n) => n.address).sort();
console.log("\nValidators (sorted):", validators.join(", "));

// Build network config
const networkConfig = {
  chainId: 1337,
  nodes: nodes.map((n) => ({
    node: n.node,
    address: n.addressPrefixed,
    ip: n.ip,
    enode: n.enode,
  })),
  validators,
  enodes: nodes.map((n) => n.enode),
  toEncode: validators.map((v) => "0x" + v),
};

// Write network-config.json
const configPath = path.join(IBFT, "config/network-config.json");
fs.writeFileSync(configPath, JSON.stringify(networkConfig, null, 2), "utf8");
console.log(`\nWrote: ${configPath}`);

// Write toEncode.json (for Besu RLP encode)
const toEncodePath = path.join(IBFT, "config/toEncode.json");
fs.writeFileSync(
  toEncodePath,
  JSON.stringify(networkConfig.toEncode, null, 2),
  "utf8"
);
console.log(`Wrote: ${toEncodePath}`);

// Write validators.json
const validatorsPath = path.join(IBFT, "config/validators.json");
fs.writeFileSync(
  validatorsPath,
  JSON.stringify(validators, null, 2),
  "utf8"
);
console.log(`Wrote: ${validatorsPath}`);

// Write static-nodes.json
const staticNodesPath = path.join(IBFT, "config/static-nodes.json");
fs.writeFileSync(
  staticNodesPath,
  JSON.stringify(networkConfig.enodes, null, 2),
  "utf8"
);
console.log(`Wrote: ${staticNodesPath}`);

console.log("\nNext: run Besu RLP encode to generate extraData for genesis.json");
console.log(
  `  docker run --rm -v "${path.resolve(IBFT, "config")}":/config hyperledger/besu:25.12.0 rlp encode --from=/config/toEncode.json --type=IBFT_EXTRA_DATA`
);
