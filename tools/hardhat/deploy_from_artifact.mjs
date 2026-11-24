import { ethers } from "ethers";
import fs from "fs";

const RPC = process.env.RPC;
const PRIVKEY = process.env.PRIVKEY;

const provider = new ethers.JsonRpcProvider(RPC, 1337);
const wallet = new ethers.Wallet(PRIVKEY, provider);

console.log("Deployer:", wallet.address);

const artifactPath = "./artifacts/contracts/MeteringVerifier.sol/Groth16Verifier.json";
const artifact = JSON.parse(fs.readFileSync(artifactPath));

const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

console.log("Deploying...");
const contract = await factory.deploy({ gasLimit: 10000000, gasPrice: 1000 });
await contract.waitForDeployment();

const addr = await contract.getAddress();
console.log("✅ Deployed at:", addr);

const tx = contract.deploymentTransaction();
if (tx) {
  const receipt = await tx.wait();
  console.log("Gas used:", receipt.gasUsed.toString());
  console.log("Block:", receipt.blockNumber);
}
