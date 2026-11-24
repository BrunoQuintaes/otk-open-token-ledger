import { ethers } from "hardhat";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function main() {
  console.log("=== Deploying MeteringVerifier via Hardhat ===");
  
  // Get signer
  const [deployer] = await ethers.getSigners();
  console.log("Deployer address:", deployer.address);
  
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer balance:", ethers.formatEther(balance), "ETH");
  
  // Get contract factory
  const Groth16Verifier = await ethers.getContractFactory("Groth16Verifier");
  
  console.log("Deploying Groth16Verifier...");
  
  // Deploy with manual gas settings
  const verifier = await Groth16Verifier.deploy({
    gasLimit: 10000000, // 10M gas
  });
  
  await verifier.waitForDeployment();
  
  const address = await verifier.getAddress();
  console.log("✅ Groth16Verifier deployed to:", address);
  
  // Get deployment transaction
  const deployTx = verifier.deploymentTransaction();
  if (deployTx) {
    const receipt = await deployTx.wait();
    console.log("Gas used:", receipt.gasUsed.toString());
    console.log("Block number:", receipt.blockNumber);
  }
  
  // Save deployment info
  const deployInfo = {
    contract: "Groth16Verifier",
    address: address,
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
  };
  
  const outDir = path.join(__dirname, "../out");
  fs.mkdirSync(outDir, { recursive: true });
  
  const outFile = path.join(outDir, `verifier_deploy_hardhat_${Date.now()}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployInfo, null, 2));
  console.log("Deployment info saved to:", outFile);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
