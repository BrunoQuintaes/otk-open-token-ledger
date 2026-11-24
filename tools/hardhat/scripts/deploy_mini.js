import { network } from "hardhat";

async function main() {
  const conn = await network.connect();
  const { ethers } = conn;

  const [deployer] = await ethers.getSigners();
  const addr = await deployer.getAddress();
  const bal  = await ethers.provider.getBalance(addr);

  console.log("deployer:", addr);
  console.log("balance:", ethers.formatEther(bal), "ETH");

  const Mini = await ethers.getContractFactory("Mini");
  const mini = await Mini.deploy();
  await mini.waitForDeployment();

  const caddr = await mini.getAddress();
  console.log("Mini deployed at:", caddr);

  const tx = await mini.set(123n, { gasLimit: 500000 });
  console.log("set tx:", tx.hash);
  const r = await tx.wait();
  console.log("set mined block:", r.blockNumber, "status:", r.status);

  const x = await mini.x();
  console.log("x() =", x.toString());
}

main().catch((e) => { console.error(e); process.exit(1); });
