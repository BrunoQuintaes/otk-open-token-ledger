import hre from "hardhat";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("=== Deploy Groth16Verifier ===");
  
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deployer:", deployer.address);
  
  const balance = await hre.ethers.provider.getBalance(deployer.address);
  console.log("Balance:", hre.ethers.formatEther(balance), "ETH");
  
  const Verifier = await hre.ethers.getContractFactory("Groth16Verifier");
  console.log("Deploying...");
  
  const verifier = await Verifier.deploy({ gasLimit: 10000000 });
  await verifier.waitForDeployment();
  
  const addr = await verifier.getAddress();
  console.log("✅ Deployed at:", addr);
  
  const tx = verifier.deploymentTransaction();
  if (tx) {
    const receipt = await tx.wait();
    console.log("Gas used:", receipt.gasUsed.toString());
    console.log("Block:", receipt.blockNumber);
    
    fs.mkdirSync("out", { recursive: true });
    fs.writeFileSync(
      `out/verifier_${Date.now()}.json`,
      JSON.stringify({ address: addr, gasUsed: receipt.gasUsed.toString() }, null, 2)
    );
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
