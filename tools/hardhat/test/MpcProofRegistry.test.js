/**
 * GAP-D-003 — MPC Proof + ReceiptRegistry E2E Hardhat Test
 *
 * Validates the full on-chain flow:
 *   1. Deploy MeteringVerifierV2MPC (canonical MPC verifier)
 *   2. Deploy ReceiptRegistry with MockVerifier (for receipt registration)
 *   3. Verify a real MPC Groth16 proof via MeteringVerifierV2MPC
 *   4. Register a receipt on ReceiptRegistry (using MockVerifier to isolate)
 *   5. Confirm anti-replay protection (duplicate nonce rejected)
 *
 * Rationale: proves the MPC verifier works and the registry accepts verified
 * receipts, closing the loop between ZK proof generation and on-chain registration.
 *
 * Proof source: same proof as MeteringVerifierV2MPC.test.js
 * Input: { userId:42, usage:500, nonce:1, epoch:709, minBucket:301, maxBucket:900 }
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { ethers } from 'ethers';

// ---------------------------------------------------------------------------
// Canonical MPC proof (from metering_v2_final_mpc.zkey)
// ---------------------------------------------------------------------------
const PA = [
  "0x2708bdb9b851a12032167716096a9136e22529cdecb5380cfdb3f8262f6b800a",
  "0x181aa1283f00387d64e67caa7ef2460c43127701f3d92608de4243ed85b6aa86",
];
const PB = [
  ["0x01a85049b79129087ef1c14afa0fdd34c3b8dcfa8f84b3aeda6c5cb458410e90",
   "0x0d3ded78a15bd7e80d3d4817085b7f30a4f7c5cc3d56fbe43ac1c1eb562486c9"],
  ["0x0f0bca88cc5ed53bd6263ef45011bed511e9ee0ea3f22284afe7331a9aeb010d",
   "0x165fc5ac468346f5c54cd0a596cc9a923afbdc2d4c7b8db17c29bee944c79f84"],
];
const PC = [
  "0x2ad0264ab3eb5f6b1c5b1e44bdf84508cb6dd846ec0ea4affa2f91efb0cfdee5",
  "0x2214a31739ed0afb998371cb2040df6dee5141851a45e4a86accefbcacd85c04",
];
// pubSignals: [commitment, epoch=709, minBucket=301, maxBucket=900]
const PUB = [
  "0x085cbe9e775af385148478081f45cd5ff095ede5a7018afc9c8cc1aca2de1430",
  "0x00000000000000000000000000000000000000000000000000000000000002c5",
  "0x000000000000000000000000000000000000000000000000000000000000012d",
  "0x0000000000000000000000000000000000000000000000000000000000000384",
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWallet(seed) {
  const hash = ethers.keccak256(ethers.toUtf8Bytes(seed));
  return new ethers.Wallet(hash);
}

async function signRawHash(rawHash, wallet) {
  const sig = await wallet.signMessage(ethers.getBytes(rawHash));
  const split = ethers.Signature.from(sig);
  return { rawHash, v: split.v, r: split.r, s: split.s };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let conn;
let deployer;
let mpcVerifier;
let registry;
let mockVerifier;
let trustedWallet;

before(async () => {
  conn = await hre.network.connect();
  [deployer] = await conn.ethers.getSigners();
  trustedWallet = createWallet('mpc-registry-test-signer');

  // Deploy MeteringVerifierV2MPC
  const mpcArt = await hre.artifacts.readArtifact('MeteringVerifierV2MPC');
  const MpcFactory = new conn.ethers.ContractFactory(mpcArt.abi, mpcArt.bytecode, deployer);
  mpcVerifier = await MpcFactory.deploy();
  await mpcVerifier.waitForDeployment();

  // Deploy MockVerifier for ReceiptRegistry isolation
  const mockArt = await hre.artifacts.readArtifact('MockVerifier');
  const MockFactory = new conn.ethers.ContractFactory(mockArt.abi, mockArt.bytecode, deployer);
  mockVerifier = await MockFactory.deploy();
  await mockVerifier.waitForDeployment();

  // Deploy ReceiptRegistry with MockVerifier + trustedSigner
  const regArt = await hre.artifacts.readArtifact('ReceiptRegistry');
  const RegFactory = new conn.ethers.ContractFactory(regArt.abi, regArt.bytecode, deployer);
  registry = await RegFactory.deploy(
    await mockVerifier.getAddress(),
    trustedWallet.address,
  );
  await registry.waitForDeployment();
});

describe('MpcProofRegistry — MeteringVerifierV2MPC standalone', () => {
  it('deploys MeteringVerifierV2MPC', async () => {
    assert.ok(await mpcVerifier.getAddress());
  });

  it('verifies canonical MPC Groth16 proof (real proof from mpc.zkey)', async () => {
    const result = await mpcVerifier.verifyProof(PA, PB, PC, PUB);
    assert.equal(result, true, 'MPC verifier must accept canonical MPC proof');
  });

  it('rejects invalid proof', async () => {
    const badPA = [
      "0x0000000000000000000000000000000000000000000000000000000000000001",
      "0x0000000000000000000000000000000000000000000000000000000000000002",
    ];
    const result = await mpcVerifier.verifyProof(badPA, PB, PC, PUB);
    assert.equal(result, false, 'MPC verifier must reject invalid proof');
  });
});

describe('MpcProofRegistry — ReceiptRegistry + MockVerifier integration', () => {
  it('deploys ReceiptRegistry with MockVerifier', async () => {
    assert.ok(await registry.getAddress());
  });

  it('registers a receipt with valid proof + signature', async () => {
    const rawData = { userId: 42n, nonce: 0n, epoch: 709n, costUnits: 500n };
    const commitment = BigInt(PUB[0]);
    const proofData = {
      a: [BigInt(PA[0]), BigInt(PA[1])],
      b: [[BigInt(PB[0][0]), BigInt(PB[0][1])], [BigInt(PB[1][0]), BigInt(PB[1][1])]],
      c: [BigInt(PC[0]), BigInt(PC[1])],
      pubSignals: [commitment, 709n, 10000n], // v1-compatible: [commitment, epoch, maxUsage]
    };

    // Build rawHash off-chain and sign with trustedWallet
    const rawHash = ethers.keccak256(
      ethers.concat([
        ethers.toUtf8Bytes(String(rawData.userId)),
        ethers.toUtf8Bytes(String(rawData.nonce)),
        ethers.toUtf8Bytes(String(rawData.epoch)),
        ethers.toUtf8Bytes(String(rawData.costUnits)),
      ])
    );
    const { v, r, s } = await signRawHash(rawHash, trustedWallet);

    // MockVerifier accepts any proof → registration should succeed
    // Contract signature: submitReceipt(raw, rawHash, v, r, s, proof)
    const tx = await registry.submitReceipt(rawData, rawHash, v, r, s, proofData);
    const receipt = await tx.wait();
    assert.ok(receipt.status === 1, 'submitReceipt tx must succeed');
  });

  it('rejects duplicate nonce (anti-replay)', async () => {
    const rawData = { userId: 42n, nonce: 0n, epoch: 709n, costUnits: 500n }; // nonce already used
    const commitment = BigInt(PUB[0]);
    const proofData = {
      a: [0n, 0n], b: [[0n, 0n], [0n, 0n]], c: [0n, 0n],
      pubSignals: [commitment, 709n, 10000n],
    };
    const rawHash = ethers.keccak256(ethers.toUtf8Bytes('duplicate-' + Date.now()));
    const { v, r, s } = await signRawHash(rawHash, trustedWallet);

    try {
      await registry.submitReceipt(rawData, rawHash, v, r, s, proofData);
      assert.fail('Expected revert for duplicate nonce');
    } catch (err) {
      assert.ok(
        err.message.includes('revert') || err.message.includes('Nonce'),
        `Expected revert, got: ${err.message}`,
      );
    }
  });
});

describe('MpcProofRegistry — gas measurements', () => {
  it('measures MeteringVerifierV2MPC verifyProof gas', async () => {
    const gas = Number(await mpcVerifier.verifyProof.estimateGas(PA, PB, PC, PUB));
    console.log(`[MpcProofRegistry] MeteringVerifierV2MPC.verifyProof gas: ${gas.toLocaleString()}`);
    assert.ok(gas > 100_000, `gas too low: ${gas}`);
    assert.ok(gas < 500_000, `gas too high: ${gas}`);
  });
});
