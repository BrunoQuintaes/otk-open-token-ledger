/**
 * gen_network.mjs — Parameterizable IBFT network config generator
 *
 * Reads network-config.json from infra/ibft/config/ and regenerates:
 *   - genesis.json (with RLP-encoded extraData via Besu docker)
 *   - static-nodes.json
 *   - validators.json
 *
 * Usage:
 *   node tools/ibftgen/gen_network.mjs [--extra-data <hex>]
 *
 * If --extra-data is provided, uses it directly. Otherwise, calls Besu RLP encode.
 *
 * Requires: network-config.json with { validators, enodes, chainId, nodes }
 */
import fs from "fs";
import path from "path";
import { execSync } from "child_process";

const ROOT = path.resolve(import.meta.dirname, "../../");
const CONFIG = path.join(ROOT, "infra/ibft/config");

// Parse --extra-data flag
let extraDataArg = null;
const edIdx = process.argv.indexOf("--extra-data");
if (edIdx !== -1 && process.argv[edIdx + 1]) {
  extraDataArg = process.argv[edIdx + 1];
}

// Read network config
const netConfigPath = path.join(CONFIG, "network-config.json");
if (!fs.existsSync(netConfigPath)) {
  console.error("ERROR: network-config.json not found. Run setup_4node.mjs first.");
  process.exit(1);
}
const netConfig = JSON.parse(fs.readFileSync(netConfigPath, "utf8"));
const { validators, enodes, chainId, nodes } = netConfig;

console.log(`=== gen_network.mjs ===`);
console.log(`Validators: ${validators.length}`);
console.log(`Chain ID: ${chainId}`);

// Get extraData
let extraData;
if (extraDataArg) {
  extraData = extraDataArg;
  console.log(`ExtraData: provided via --extra-data`);
} else {
  console.log(`ExtraData: calling Besu RLP encode...`);
  try {
    const toEncodePath = path.join(CONFIG, "toEncode.json");
    const cmd = `docker run --rm -v "${CONFIG.replace(/\\/g, "/")}:/config" hyperledger/besu:25.12.0 rlp encode --from=/config/toEncode.json --type=IBFT_EXTRA_DATA`;
    const env = { ...process.env, MSYS_NO_PATHCONV: "1" };
    extraData = execSync(cmd, { encoding: "utf8", env }).trim();
    console.log(`ExtraData: ${extraData.slice(0, 20)}...`);
  } catch (e) {
    console.error("ERROR: Besu RLP encode failed. Provide --extra-data manually.");
    console.error(e.message);
    process.exit(1);
  }
}

// Build alloc: prefund all validators + the deploy wallet
const alloc = {
  "3000bafbd1b9f8dfc191a3575b1055e9155741f4": {
    balance: "0x21e19e0c9bab2400000",
  },
};
for (const v of validators) {
  alloc[v] = { balance: "0x21e19e0c9bab2400000" };
}

// Build genesis
const genesis = {
  config: {
    chainId,
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
  mixHash:
    "0x63746963616c2062797a616e74696e65206661756c7420746f6c6572616e6365",
  coinbase: "0x0000000000000000000000000000000000000000",
  alloc,
};

// Write all configs
fs.writeFileSync(
  path.join(CONFIG, "genesis.json"),
  JSON.stringify(genesis, null, 4),
  "utf8"
);
console.log(`Wrote: genesis.json (${validators.length} validators, chainId=${chainId})`);

fs.writeFileSync(
  path.join(CONFIG, "static-nodes.json"),
  JSON.stringify(enodes, null, 2),
  "utf8"
);
console.log(`Wrote: static-nodes.json (${enodes.length} enodes)`);

fs.writeFileSync(
  path.join(CONFIG, "validators.json"),
  JSON.stringify(validators, null, 2),
  "utf8"
);
console.log(`Wrote: validators.json (${validators.length} validators)`);

console.log(`\n=== Done ===`);
