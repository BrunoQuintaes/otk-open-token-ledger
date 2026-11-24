import { defineConfig } from "hardhat/config";
import hardhatEthers from "@nomicfoundation/hardhat-ethers";

const RPC = process.env.RPC || "http://127.0.0.1:9545";
const CHAIN_ID = Number(process.env.CHAIN_ID || "1337");
const PRIVKEY = process.env.PRIVKEY || "";

const BASE_SOLC = {
  version: "0.8.24",
  settings: {
    evmVersion: "berlin",
    optimizer: { enabled: true, runs: 200 }
  }
};

// v3 contracts (run 20260930-1625): same compiler and settings, plus metadata.bytecodeHash "none",
// so the CBOR trailer carries only the solc version and is identical for every source revision.
// With the IPFS hash in the trailer, scripts/ops/detect_push0.js reads a 0x5f byte of the hash as
// a PUSH0 opcode (false positive; fix requested to S0 in control/A/REQUEST_20260930-2217_*).
// Legacy contracts keep BASE_SOLC unchanged, so their bytecode stays byte-identical.
const V3_SOLC = {
  version: BASE_SOLC.version,
  settings: { ...BASE_SOLC.settings, metadata: { bytecodeHash: "none" } }
};

export default defineConfig({
  plugins: [hardhatEthers],

  solidity: {
    compilers: [BASE_SOLC],
    overrides: {
      "contracts/v3/ReceiptRegistryV3.sol": V3_SOLC,
      "contracts/v3/BatchRegistryV3.sol": V3_SOLC,
      "contracts/v3/MeteringVerifierV3Demo.sol": V3_SOLC
    }
  },

  networks: {
    ibft: {
      type: "http",
      url: RPC,
      chainId: CHAIN_ID,
      accounts: PRIVKEY ? [PRIVKEY] : []
    }
  }
});
