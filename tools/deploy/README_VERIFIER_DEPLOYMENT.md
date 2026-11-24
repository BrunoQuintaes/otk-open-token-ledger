# MeteringVerifier Deployment Guide (U8.4)

## Overview

This directory contains the deployment tooling for the `Groth16Verifier` contract (exported from the metering_v1 ZK circuit).

## Prerequisites

1. **Node.js** (v24+ recommended)
2. **Dependencies installed**:
   ```bash
   cd tools/deploy
   npm install
   ```
3. **IBFT network running** (or any EVM-compatible network)
4. **Funded deployer account**

## Environment Variables

Set these before deploying:

```bash
export RPC=http://localhost:8545          # Your IBFT/EVM RPC URL
export PRIVKEY=0x1234...                  # Deployer private key (NEVER commit!)
export CHAIN_ID=1337                      # Optional, default 1337
```

## Deployment Steps

### 1. Export Solidity Verifier (if not done)

```bash
cd ../../
snarkjs zkey export solidityverifier zk/build/metering_v1_final.zkey contracts/MeteringVerifier.sol
```

### 2. Deploy to IBFT

```bash
cd tools/deploy
RPC=http://localhost:8545 PRIVKEY=0x... node deploy_metering_verifier.mjs
```

**Output:**
- Contract address
- Gas used
- Deployment info saved to `out/verifier_deploy_<timestamp>.json`

### 3. Test On-Chain Verification

Use the proof artifacts from U8.2/U8.3:
- `zk/build/proof.json` - Groth16 proof
- `zk/build/public.json` - Public signals: [commitment, epoch, maxUsage]

Example test (requires web3/ethers script):
```javascript
const verifier = new ethers.Contract(VERIFIER_ADDRESS, abi, provider);
const result = await verifier.verifyProof(
  proof.pi_a,
  proof.pi_b,
  proof.pi_c,
  publicSignals
);
console.log("Verification result:", result); // Should be true
```

## Files

- `deploy_metering_verifier.mjs` - Deployment script for Groth16Verifier
- `deploy_min.mjs` - Minimal deployment example (reference)
- `package.json` - Dependencies (ethers, solc)

## Security Notes

⚠️ **NEVER commit private keys to the repository!**

- Use environment variables
- Or use a `.env` file (add to `.gitignore`)
- For production: use hardware wallets or key management services

## Troubleshooting

### "Cannot find module 'solc'"
```bash
npm install solc@^0.8 --save-dev
```

### "Deployer has 0 balance"
Fund the deployer account with test ETH from the IBFT genesis or faucet.

### "Failed to connect to RPC"
Check that:
1. IBFT network is running
2. RPC URL is correct
3. Port is accessible (firewall/network)

## Gas Measurements

Typical gas usage (IBFT/Ethereum):
- **Deploy**: ~1,500,000 - 2,000,000 gas
- **verifyProof()**: ~200,000 - 300,000 gas

Actual values depend on network and proof complexity.

## Next Steps (U8.5)

After successful deployment:
1. Create `ReceiptRegistry.sol` contract
2. Integrate verifier with registry
3. Implement anti-replay protection
4. Deploy complete system

---

**Related:**
- ZK Circuit: `zk/circuits/metering_v1.circom`
- Statement Spec: `docs/U8_1_STATEMENT_SPEC.md`
- Verifier Contract: `contracts/MeteringVerifier.sol`
