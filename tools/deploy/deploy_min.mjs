import { ethers } from "ethers";
import fs from "fs";

const RPC = process.env.RPC;
const CHAIN_ID = Number(process.env.CHAIN_ID || "1337");
const PRIVKEY = process.env.PRIVKEY;

const provider = new ethers.JsonRpcProvider(RPC, CHAIN_ID);
const wallet = new ethers.Wallet(PRIVKEY, provider);

console.log("RPC:", RPC);
console.log("chainId:", (await provider.getNetwork()).chainId.toString());
console.log("deployer:", await wallet.getAddress());

const bal = await provider.getBalance(await wallet.getAddress());
console.log("balance:", ethers.formatEther(bal), "ETH");

// 1) tx simples (self-transfer 0 wei) -> valida nonce + mempool + inclusão
const tx1 = await wallet.sendTransaction({
  to: await wallet.getAddress(),
  value: 0n
});
console.log("tx1 hash:", tx1.hash);
const r1 = await tx1.wait();
console.log("tx1 mined in block:", r1.blockNumber, "status:", r1.status);

// 2) deploy contrato mínimo (Solidity "Store(uint256)" compilado inline via bytecode)
// bytecode/abi abaixo são de um contrato mínimo:
// contract Mini { uint256 public x; event Set(uint256 v); function set(uint256 v) public { x=v; emit Set(v);} }
const abi = [
  "function x() view returns (uint256)",
  "function set(uint256 v)",
  "event Set(uint256 v)"
];
const bytecode =
  "0x6080604052348015600f57600080fd5b5060d680601d6000396000f3fe6080604052348015600f57600080fd5b506004361060325760003560e01c80630c55699c14603757806360fe47b1146051575b600080fd5b604d60048036038101906049919060a0565b606b565b005b6057607e565b604051605e919060b7565b60405180910390f35b806000819055507f5c781d3f2b1b8a8db2e0db1d0f6f5f9b5d2abbd1d7b9e7f7ccdcbb0d5f5bc0f3816040516060919060b7565b60405180910390a150565b60008054905090565b600080fd5b6000819050919050565b6097816086565b811460a157600080fd5b50565b60008135905060928160b0565b92915050565b60006020828403121560ae5760ad6081565b5b600060b984828501609a565b91505092915050565b60c6816086565b82525050565b600060208201905060df600083018460bf565b9291505056fea2646970667358221220d0b6fb2c5c0d2d45f5d0b6d7d1f7a2d1d0f9e52b0a4b6c3b2f6f3c5e6a7f2a5e64736f6c634300081a0033";

const factory = new ethers.ContractFactory(abi, bytecode, wallet);
const c = await factory.deploy();
await c.waitForDeployment();
const addr = await c.getAddress();
console.log("Mini deployed at:", addr);

// 3) chama set(123) e lê x()
const tx2 = await c.set(123n);
console.log("set tx:", tx2.hash);
const r2 = await tx2.wait();
console.log("set mined block:", r2.blockNumber, "status:", r2.status);

const x = await c.x();
console.log("x() =", x.toString());

// salva artefatos p/ vc colar na dissertação
fs.writeFileSync("deploy_result.json", JSON.stringify({
  rpc: RPC,
  chainId: CHAIN_ID,
  deployer: await wallet.getAddress(),
  contract: addr,
  tx1: tx1.hash,
  tx2: tx2.hash
}, null, 2));

console.log("OK: deploy_result.json gerado");
