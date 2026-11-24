import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:9545";
const CHAIN_ID = Number(process.env.CHAIN_ID || 1337);
const PRIVKEY = process.env.PRIVKEY;

if (!PRIVKEY) {
  console.error("ERROR: missing PRIVKEY in env (use a LOCAL/TEST key only).");
  process.exit(2);
}

const ART = path.resolve(process.cwd(), "tools", "hardhat", "artifacts", "contracts", "Mini.sol", "Mini.json");
if (!fs.existsSync(ART)) {
  console.error(`ERROR: artifact not found: ${ART}. Run: cd tools/hardhat && npx hardhat compile`);
  process.exit(2);
}

const artifact = JSON.parse(fs.readFileSync(ART, "utf8"));
const abi = artifact.abi;
const bytecode = artifact.bytecode;

const outDir = path.resolve(process.cwd(), "docs", "_ops", "f3");
fs.mkdirSync(outDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = path.join(outDir, `deploy_compiled_result_${ts}.json`);

const provider = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: "ibft-local" });
const wallet = new ethers.Wallet(PRIVKEY, provider);

console.log(`RPC_URL=${RPC_URL}`);
console.log(`CHAIN_ID=${CHAIN_ID}`);
console.log(`DEPLOYER=${wallet.address}`);

const bal = await provider.getBalance(wallet.address);
console.log(`BALANCE=${ethers.formatEther(bal)} ETH`);

const factory = new ethers.ContractFactory(abi, bytecode, wallet);

console.log("Deploying Mini (compiled)...");
const contract = await factory.deploy();
const dep = await contract.deploymentTransaction();
console.log(`deployTx=${dep?.hash}`);

await contract.waitForDeployment();
const addr = await contract.getAddress();
console.log(`Mini deployed at: ${addr}`);

console.log("Calling set(123)...");
const tx = await contract.set(123);
console.log(`setTx=${tx.hash}`);
const rc = await tx.wait();
console.log(`set mined: block=${rc.blockNumber} status=${rc.status}`);

const stored = await contract.x();
console.log(`x()=${stored.toString()}`);

const result = {
  rpcUrl: RPC_URL,
  chainId: CHAIN_ID,
  deployer: wallet.address,
  contract: addr,
  deployTx: dep?.hash,
  setTx: tx.hash,
  blockNumber: rc.blockNumber,
  status: rc.status,
  x: stored.toString(),
};

fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
console.log(`OK: wrote ${outPath}`);
