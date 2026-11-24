import { ethers } from "ethers";

const rpc = process.env.RPC_URL || "http://127.0.0.1:9545";
const provider = new ethers.JsonRpcProvider(rpc);

const pk = process.env.PRIVKEY;
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  throw new Error("Missing/invalid PRIVKEY env var. Set PRIVKEY=0x<64hex> before running sendtx.mjs");
}
const to = "0x3000bafbd1b9f8dfc191a3575b1055e9155741f4";

async function main() {
  const chainId = await provider.send("eth_chainId", []);
  const bn0 = await provider.send("eth_blockNumber", []);
  console.log("chainId:", chainId);
  console.log("blockNumber_before:", bn0);

  const wallet = new ethers.Wallet(pk, provider);
  console.log("from:", wallet.address);

  const balFrom0 = await provider.getBalance(wallet.address);
  const balTo0   = await provider.getBalance(to);
  console.log("bal_from_before:", balFrom0.toString());
  console.log("bal_to_before:", balTo0.toString());

  // keep gasPrice small; PoW chain accepts legacy gasPrice
  const tx = await wallet.sendTransaction({
    to,
    value: ethers.parseEther("0.01"),
    gasLimit: 21000n,
    gasPrice: 1000n
  });

  console.log("txHash:", tx.hash);

  const receipt = await tx.wait();
  console.log("receipt_status:", receipt.status);
  console.log("receipt_blockNumber:", receipt.blockNumber);

  const balFrom1 = await provider.getBalance(wallet.address);
  const balTo1   = await provider.getBalance(to);
  console.log("bal_from_after:", balFrom1.toString());
  console.log("bal_to_after:", balTo1.toString());

  const bn1 = await provider.send("eth_blockNumber", []);
  console.log("blockNumber_after:", bn1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
