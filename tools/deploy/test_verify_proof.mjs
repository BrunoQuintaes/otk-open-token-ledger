import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function reqEnv(name, alt = null) {
  const v = process.env[name] || (alt ? process.env[alt] : null);
  if (!v) throw new Error(`Missing env var: ${name}${alt ? " (or " + alt + ")" : ""}`);
  return v;
}

const RPC = process.env.RPC || process.env.RPC_URL;
const PRIVKEY = process.env.PRIVKEY || process.env.PRIVATE_KEY; // needed for estimateGas from a funded signer
const VERIFIER = process.env.VERIFIER;

if (!RPC) throw new Error("Missing RPC/RPC_URL");
if (!VERIFIER) throw new Error("Missing VERIFIER address");
if (!PRIVKEY) throw new Error("Missing PRIVKEY/PRIVATE_KEY (needed for gas estimate + tx)");

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(PRIVKEY, provider);

// ABI mínimo do contrato exportado pelo snarkjs (Groth16Verifier)
const ABI = [
  "function verifyProof(uint[2] a, uint[2][2] b, uint[2] c, uint[3] input) public view returns (bool)"
];

const verifier = new ethers.Contract(VERIFIER, ABI, wallet);

// Support new run directory layout via RUN_DIR env var, fallback to default layout
const RUN_DIR = process.env.RUN_DIR;
const repoRoot = path.resolve(__dirname, "../..");
const proofPath = RUN_DIR
  ? path.join(RUN_DIR, "proof.json")
  : path.join(repoRoot, "zk/build/proof.json");
const pubPath = RUN_DIR
  ? path.join(RUN_DIR, "public.json")
  : path.join(repoRoot, "zk/build/public.json");

const proof = JSON.parse(fs.readFileSync(proofPath, "utf8"));
const pub = JSON.parse(fs.readFileSync(pubPath, "utf8"));

// snarkjs -> solidity verifier expects some coords swapped in pi_b
const a = [proof.pi_a[0], proof.pi_a[1]];
const b = [
  [proof.pi_b[0][1], proof.pi_b[0][0]],
  [proof.pi_b[1][1], proof.pi_b[1][0]],
];
const c = [proof.pi_c[0], proof.pi_c[1]];
const input = [pub[0], pub[1], pub[2]];

console.log("RPC:", RPC);
console.log("Verifier:", VERIFIER);
console.log("Caller:", await wallet.getAddress());

const ok = await verifier.verifyProof(a, b, c, input);
console.log("verifyProof() =>", ok);

const gas = await verifier.verifyProof.estimateGas(a, b, c, input);
console.log("estimateGas(verifyProof) =>", gas.toString());
