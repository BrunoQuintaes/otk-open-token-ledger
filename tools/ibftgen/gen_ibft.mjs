import { ethers } from "ethers";
import fs from "fs";

const ROOT = process.env.ROOT;
const k1 = process.env.K1;
const k2 = process.env.K2;

function addrFromPriv(pk){
  const w = new ethers.Wallet(pk);
  return w.address.toLowerCase();
}

// Besu enode pubkey: secp256k1 uncompressed without 0x04 prefix
function enodePubFromPriv(pk){
  const sk = new ethers.SigningKey(pk);
  const pub = sk.publicKey.toLowerCase(); // 0x04 + 128 hex
  return pub.startsWith("0x04") ? pub.slice(4) : pub.slice(2);
}

const v1 = addrFromPriv(k1);
const v2 = addrFromPriv(k2);

const p1 = enodePubFromPriv(k1);
const p2 = enodePubFromPriv(k2);

const enode1 = `enode://${p1}@besu-node1:30303`;
const enode2 = `enode://${p2}@besu-node2:30303`;

// IBFT2 extraData:
//  - 32 bytes vanity (64 hex zeros)
//  - validator addresses (20 bytes each, no 0x)
//  - 65 bytes proposer seal (130 hex zeros)
const vanity = "0".repeat(64);
const seal   = "0".repeat(130);
const validators = [v1, v2].map(a => a.replace("0x","")).join("");
const extraData = "0x" + vanity + validators + seal;

// Prefund (prefund wallet + validators)
const alloc = {
  "3000bafbd1b9f8dfc191a3575b1055e9155741f4": { "balance": "0x21e19e0c9bab2400000" }
};
alloc[v1.replace("0x","")] = { "balance": "0x21e19e0c9bab2400000" };
alloc[v2.replace("0x","")] = { "balance": "0x21e19e0c9bab2400000" };

const genesis = {
  config: {
    chainId: 1337,
    londonBlock: 0,
    ibft2: {
      blockperiodseconds: 2,
      epochlength: 30000,
      requesttimeoutseconds: 10
    }
  },
  nonce: "0x0",
  timestamp: "0x0",
  extraData,
  gasLimit: "0x5F5E100",
  difficulty: "0x1",
  mixHash: "0x" + "0".repeat(64),
  coinbase: "0x0000000000000000000000000000000000000000",
  alloc
};

const staticNodes = [enode1, enode2];

fs.mkdirSync(`${ROOT}/infra/ibft/config`, { recursive: true });
fs.writeFileSync(`${ROOT}/infra/ibft/config/genesis.json`, JSON.stringify(genesis,null,2));
fs.writeFileSync(`${ROOT}/infra/ibft/config/static-nodes.json`, JSON.stringify(staticNodes,null,2));

console.log("validators:", v1, v2);
console.log("enode1:", enode1);
console.log("enode2:", enode2);
console.log("wrote genesis + static-nodes");
