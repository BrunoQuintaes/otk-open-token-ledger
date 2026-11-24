import { ethers } from "ethers";
import fs from "fs";

const ROOT = process.env.ROOT;
const k1 = process.env.K1;
const k2 = process.env.K2;

const a1 = (new ethers.Wallet(k1)).address.toLowerCase().replace("0x","");
const a2 = (new ethers.Wallet(k2)).address.toLowerCase().replace("0x","");

const vals = [a1,a2].sort(); // obrigatório asc
fs.mkdirSync(`${ROOT}/infra/ibft/config`, { recursive: true });
fs.writeFileSync(`${ROOT}/infra/ibft/config/validators.json`, JSON.stringify(vals, null, 2), { encoding: "utf8" });
console.log("validators(sorted):", vals.join(","));
