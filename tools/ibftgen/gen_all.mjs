/**
 * gen_all.mjs — Parameterized IBFT network config generator (N validators)
 *
 * Usage:
 *   node gen_all.mjs --n 7 --subnet 172.31.200 --base-ip 11
 *   node gen_all.mjs --n 4   (uses defaults: subnet=172.31.200, base-ip=11)
 *
 * What it does:
 *   1. For each node 1..N, reads or generates a private key in infra/ibft/node{i}/data/key
 *   2. Derives validator addresses and enode public keys
 *   3. Calls Besu RLP encode (via docker) to produce IBFT2 extraData
 *   4. Writes: genesis.json, static-nodes.json, validators.json, network-config.json, toEncode.json
 *
 * Constraints:
 *   - Keys are NEVER output to stdout (only addresses/pubkeys)
 *   - Keys stay in infra/ibft/node{i}/data/key (gitignored)
 *   - Uses Besu's own RLP encoder for correct IBFT2 extraData
 */
import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

// ---- CLI args ----
function parseArg(name, def) {
  const idx = process.argv.indexOf(name);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : def;
}

const N = parseInt(parseArg("--n", "7"), 10);
const SUBNET = parseArg("--subnet", "172.31.200");
const BASE_IP = parseInt(parseArg("--base-ip", "11"), 10);
const CHAIN_ID = parseInt(parseArg("--chain-id", "1337"), 10);

// ---- Paths ----
const ROOT = path.resolve(import.meta.dirname, "../../");
const IBFT = path.join(ROOT, "infra/ibft");
const CONFIG = path.join(IBFT, "config");

// ---- Helpers ----
function addrFromPriv(pk) {
  return new ethers.Wallet(pk).address.toLowerCase();
}

function enodePubFromPriv(pk) {
  const sk = new ethers.SigningKey(pk);
  const pub = sk.publicKey.toLowerCase(); // 0x04 + 128 hex
  return pub.startsWith("0x04") ? pub.slice(4) : pub.slice(2);
}

function readOrGenerateKey(nodeNum) {
  const keyPath = path.join(IBFT, `node${nodeNum}/data/key`);
  fs.mkdirSync(path.dirname(keyPath), { recursive: true });

  if (fs.existsSync(keyPath)) {
    const raw = fs.readFileSync(keyPath, "utf8").trim();
    if (raw.length >= 64) {
      const pk = raw.startsWith("0x") ? raw : "0x" + raw;
      console.log(`  node${nodeNum}: existing key loaded`);
      return pk;
    }
  }

  // Generate new key
  const wallet = ethers.Wallet.createRandom();
  const pk = wallet.privateKey;
  fs.writeFileSync(keyPath, pk.slice(2), "utf8"); // store without 0x
  console.log(`  node${nodeNum}: NEW key generated`);
  return pk;
}

// ---- Main ----
console.log(`=== gen_all.mjs — N=${N}, subnet=${SUBNET}, base-ip=${BASE_IP}, chainId=${CHAIN_ID} ===\n`);
console.log("Reading/generating keys...");

const nodes = [];
for (let i = 1; i <= N; i++) {
  const pk = readOrGenerateKey(i);
  const address = addrFromPriv(pk).replace("0x", "");
  const enodePub = enodePubFromPriv(pk);
  const ip = `${SUBNET}.${BASE_IP + i - 1}`;
  nodes.push({
    node: i,
    address,
    addressPrefixed: "0x" + address,
    enodePub,
    ip,
    enode: `enode://${enodePub}@${ip}:30303?discport=0`,
  });
}

console.log("\nNode info:");
for (const n of nodes) {
  console.log(`  node${n.node}: addr=0x${n.address} ip=${n.ip}`);
}

// Sort validators alphabetically (IBFT requirement)
const validators = nodes.map((n) => n.address).sort();
const toEncode = validators.map((v) => "0x" + v);

console.log(`\nValidators (sorted, ${validators.length}):`);
validators.forEach((v, i) => console.log(`  [${i}] ${v}`));

// ---- RLP encode extraData via Besu ----
console.log("\nGenerating IBFT2 extraData via Besu RLP encode...");
fs.mkdirSync(CONFIG, { recursive: true });
const toEncodePath = path.join(CONFIG, "toEncode.json");
fs.writeFileSync(toEncodePath, JSON.stringify(toEncode, null, 2), "utf8");

let extraData;
try {
  const configPathUnix = CONFIG.replace(/\\/g, "/");
  const cmd = `docker run --rm -v "${configPathUnix}:/config" hyperledger/besu:25.12.0 rlp encode --from=/config/toEncode.json --type=IBFT_EXTRA_DATA`;
  const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
  extraData = execSync(cmd, { encoding: "utf8", timeout: 30000, env }).trim();
  console.log(`  extraData: ${extraData.slice(0, 30)}... (${extraData.length} chars)`);
} catch (e) {
  console.error("ERROR: Besu RLP encode failed:", e.message);
  process.exit(1);
}

// ---- Build alloc (prefund all validators + deploy wallet) ----
const alloc = {
  "3000bafbd1b9f8dfc191a3575b1055e9155741f4": {
    balance: "0x21e19e0c9bab2400000",
  },
};
for (const v of validators) {
  alloc[v] = { balance: "0x21e19e0c9bab2400000" };
}

// ---- Genesis ----
const genesis = {
  config: {
    chainId: CHAIN_ID,
    ibft2: {
      requesttimeoutseconds: 10,
      blockperiodseconds: 2,
      epochlength: 30000,
    },
    londonBlock: 0,
    berlinBlock: 0,
  },
  nonce: "0x0",
  timestamp: "0x0",
  extraData,
  gasLimit: "0x5F5E100",
  difficulty: "0x1",
  mixHash: "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
  coinbase: "0x0000000000000000000000000000000000000000",
  alloc,
};

// ---- Write all config files ----
fs.writeFileSync(path.join(CONFIG, "genesis.json"), JSON.stringify(genesis, null, 4), "utf8");
console.log(`\nWrote: genesis.json (${validators.length} validators, chainId=${CHAIN_ID})`);

const enodes = nodes.map((n) => n.enode);
fs.writeFileSync(path.join(CONFIG, "static-nodes.json"), JSON.stringify(enodes, null, 2), "utf8");
console.log(`Wrote: static-nodes.json (${enodes.length} enodes)`);

fs.writeFileSync(path.join(CONFIG, "validators.json"), JSON.stringify(validators, null, 2), "utf8");
console.log(`Wrote: validators.json (${validators.length} validators)`);

const networkConfig = {
  chainId: CHAIN_ID,
  n: N,
  subnet: SUBNET,
  baseIp: BASE_IP,
  nodes: nodes.map((n) => ({
    node: n.node,
    address: n.addressPrefixed,
    ip: n.ip,
    enode: n.enode,
  })),
  validators,
  enodes,
  toEncode,
};
fs.writeFileSync(path.join(CONFIG, "network-config.json"), JSON.stringify(networkConfig, null, 2), "utf8");
console.log(`Wrote: network-config.json`);

console.log(`\n=== Done — ${N}-node IBFT config generated ===`);
