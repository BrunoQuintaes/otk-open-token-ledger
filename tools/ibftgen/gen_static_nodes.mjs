import { ethers } from "ethers";
import fs from "fs";

const ROOT = process.env.ROOT;
const k1 = process.env.K1;
const k2 = process.env.K2;

function enodePubFromPriv(pk){
  const sk = new ethers.SigningKey(pk);
  const pub = sk.publicKey.toLowerCase(); // 0x04 + 128 hex
  return pub.startsWith("0x04") ? pub.slice(4) : pub.slice(2);
}

const p1 = enodePubFromPriv(k1);
const p2 = enodePubFromPriv(k2);

// IPs CANÔNICOS do compose + discport=0
const enode1 = `enode://${p1}@172.16.239.11:30303?discport=0`;
const enode2 = `enode://${p2}@172.16.239.12:30303?discport=0`;

fs.mkdirSync(`${ROOT}/infra/ibft/config`, { recursive: true });
fs.writeFileSync(`${ROOT}/infra/ibft/config/static-nodes.json`, JSON.stringify([enode1,enode2], null, 2), { encoding: "utf8" });

console.log("enode1:", enode1);
console.log("enode2:", enode2);
console.log("wrote static-nodes.json (utf8)");
