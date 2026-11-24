import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * Deploy MeteringVerifier (Groth16) para IBFT
 * FIXED VERSION: Com gasLimit manual para evitar estimateGas do Besu
 */

// Valida env vars
const RPC = process.env.RPC || process.env.RPC_URL;
const PRIVKEY = process.env.PRIVKEY || process.env.PRIVATE_KEY;
const CHAIN_ID = Number(process.env.CHAIN_ID || "1337");

if (!RPC) {
  console.error("ERROR: Missing RPC or RPC_URL env var");
  process.exit(1);
}

if (!PRIVKEY) {
  console.error("ERROR: Missing PRIVKEY or PRIVATE_KEY env var");
  process.exit(1);
}

// Conecta ao provider
const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const wallet = new ethers.Wallet(PRIVKEY, provider);

console.log("=== U8.4: Deploy MeteringVerifier (Groth16) - FIXED VERSION ===");
console.log("RPC:", RPC);

try {
  const network = await provider.getNetwork();
  console.log("Chain ID:", network.chainId.toString());
} catch (err) {
  console.error("ERROR: Failed to connect to RPC:", err.message);
  process.exit(1);
}

const deployerAddr = await wallet.getAddress();
console.log("Deployer:", deployerAddr);

const balance = await provider.getBalance(deployerAddr);
console.log("Balance:", ethers.formatEther(balance), "ETH");

if (balance === 0n) {
  console.error("ERROR: Deployer has 0 balance. Fund the account first.");
  process.exit(1);
}

// Lê o Solidity source
const verifierPath = path.resolve(__dirname, "../../contracts/MeteringVerifier.sol");
if (!fs.existsSync(verifierPath)) {
  console.error("ERROR: MeteringVerifier.sol not found at:", verifierPath);
  process.exit(1);
}

const source = fs.readFileSync(verifierPath, "utf8");
console.log("Verifier source loaded:", verifierPath);

// Compila inline usando solc
let solc;
try {
  solc = await import("solc");
} catch (err) {
  console.error("ERROR: solc not found. Install with: cd tools/deploy && npm i solc@^0.8");
  process.exit(1);
}

const input = {
  language: "Solidity",
  sources: { "MeteringVerifier.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    outputSelection: { "*": { "*": ["abi", "evm.bytecode"] } },
  },
};

console.log("Compiling MeteringVerifier.sol with solc...");
const output = JSON.parse(solc.default.compile(JSON.stringify(input)));

if (output.errors?.length) {
  const fatal = output.errors.filter((e) => e.severity === "error");
  if (fatal.length) {
    console.error("COMPILATION ERRORS:");
    fatal.forEach((e) => console.error(e.formattedMessage));
    process.exit(1);
  }
}

const contract = output.contracts["MeteringVerifier.sol"]["Groth16Verifier"];
if (!contract) {
  console.error("ERROR: Contract 'Groth16Verifier' not found in compilation output");
  process.exit(1);
}

const abi = contract.abi;
const bytecode = contract.evm.bytecode.object;
console.log("Bytecode size:", bytecode.length / 2, "bytes");

// Deploy com gasLimit MANUAL (FIX para Besu)
console.log("Deploying Groth16Verifier with manual gasLimit...");
const factory = new ethers.ContractFactory(abi, bytecode, wallet);

let deployTx;
try {
  deployTx = await factory.getDeployTransaction();

  // OVERRIDE: Especificar gasLimit manual em vez de deixar o provider estimar
  deployTx.gasLimit = 5000000n; // 5M gas (verifier contracts are complex)
  deployTx.gasPrice = 1000n; // 0x3e8 = minimum gas price for Besu

  console.log("Manual gasLimit set to:", deployTx.gasLimit.toString());
  console.log("Manual gasPrice set to:", deployTx.gasPrice.toString());
} catch (err) {
  console.error("ERROR: Failed to create deploy transaction:", err.message);
  process.exit(1);
}

let sentTx;
try {
  sentTx = await wallet.sendTransaction(deployTx);
  console.log("Deploy TX hash:", sentTx.hash);
} catch (err) {
  console.error("ERROR: Failed to send deploy transaction:", err.message);
  console.error("Full error:", err);
  process.exit(1);
}

let receipt;
try {
  receipt = await sentTx.wait();
  console.log("✅ Deployed at:", receipt.contractAddress);
  console.log("Block number:", receipt.blockNumber);
  console.log("Gas used:", receipt.gasUsed.toString());
  console.log("Effective gas price:", ethers.formatUnits(receipt.gasPrice || 0n, "gwei"), "gwei");
} catch (err) {
  console.error("ERROR: Transaction failed:", err.message);
  process.exit(1);
}

// Salva deployment info
const deployInfo = {
  contract: "Groth16Verifier",
  address: receipt.contractAddress,
  deployer: deployerAddr,
  txHash: sentTx.hash,
  blockNumber: receipt.blockNumber,
  gasUsed: receipt.gasUsed.toString(),
  gasPrice: (receipt.gasPrice || 0n).toString(),
  chainId: CHAIN_ID,
  rpc: RPC,
  timestamp: new Date().toISOString(),
};

const outDir = path.resolve(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });

const outFile = path.join(outDir, `verifier_deploy_${Date.now()}.json`);
fs.writeFileSync(outFile, JSON.stringify(deployInfo, null, 2));
console.log("Deployment info saved to:", outFile);

console.log("\n=== DEPLOYMENT SUCCESS ===");
console.log("Verifier address:", receipt.contractAddress);
console.log("Copy this address for on-chain testing");
