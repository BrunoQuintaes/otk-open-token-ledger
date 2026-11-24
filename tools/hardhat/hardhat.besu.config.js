import { defineConfig } from "hardhat/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";

/** Minimal config to target local Besu IBFT RPC at :8545 (Berlin EVM) */
export default defineConfig({
  solidity: {
    version: "0.8.24",
    settings: { evmVersion: "berlin" }
  },
  plugins: [hardhatEthers],
  networks: {
    besuLocal: {
      type: "http",
      url: "http://127.0.0.1:8545",
      chainId: 1337,
      // Inject PRIVATE_KEY from env — never commit keys
      accounts: process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : []
    }
  }
});
