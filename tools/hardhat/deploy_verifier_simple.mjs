import("hardhat").then(async ({ ethers }) => {
  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Balance:", await ethers.provider.getBalance(deployer.address));
  
  const Factory = await ethers.getContractFactory("Groth16Verifier");
  const contract = await Factory.deploy({ gasLimit: 10000000 });
  await contract.waitForDeployment();
  
  const addr = await contract.getAddress();
  console.log("✅ Deployed:", addr);
  
  const tx = contract.deploymentTransaction();
  if (tx) {
    const receipt = await tx.wait();
    console.log("Gas:", receipt.gasUsed.toString());
  }
});
