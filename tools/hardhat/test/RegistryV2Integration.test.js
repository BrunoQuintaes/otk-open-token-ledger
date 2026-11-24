/**
 * RegistryV2Integration.test.js — W5-5A01 (S6.1) end-to-end integration test
 *
 * Tests the full on-chain v2 pipeline:
 *   MeteringVerifierV2MPC + ReceiptRegistryV2 + EIP-191 signature + Groth16 range proof
 *
 * Uses the canonical MPC proof generated for:
 *   Input: { userId:42, usage:500, nonce:0, epoch:709, minUsageBucket:301, maxUsageBucket:900 }
 *   Key: metering_v2_final_mpc.zkey (5 contributors + Hermez Phase 1, beacon applied)
 *
 * Proof source: MeteringVerifierV2MPC.test.js (same proof, extended to registry context)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';
import { keccak256, toUtf8Bytes, concat, getBytes, Wallet, zeroPadValue, toBeHex, ContractFactory } from 'ethers';

// ---------------------------------------------------------------------------
// Canonical MPC proof (metering_v2_final_mpc.zkey)
// Input: userId=42, usage=500, nonce=0, epoch=709, minBucket=301, maxBucket=900
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
  "0x00000000000000000000000000000000000000000000000000000000000002c5", // 709
  "0x000000000000000000000000000000000000000000000000000000000000012d", // 301
  "0x0000000000000000000000000000000000000000000000000000000000000384", // 900
];

// Receipt data matching the proof inputs above
const RAW_RECEIPT = {
  userId: 42n,
  nonce: 0n,
  epoch: 709n,
  costUnits: 500n,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Compute a minimal canonical hash for the test receipt (fields in alphabetical order).
 * Mirrors SignatureManager.canonicalHash() for testing purposes.
 */
function testCanonicalHash(fields) {
  const sorted = Object.keys(fields).sort();
  const parts = sorted.map(k => `${k}:${fields[k]}`).join('\n') + '\n';
  return keccak256(toUtf8Bytes(parts));
}

/**
 * Sign a rawHash with EIP-191 personal_sign using an ethers Wallet.
 * Returns { v, r, s } matching Solidity ecrecover expectations.
 */
async function signRawHash(wallet, rawHash) {
  // ethers signMessage applies the EIP-191 prefix internally
  const sig = await wallet.signMessage(getBytes(rawHash));
  // Split into v, r, s
  const r = '0x' + sig.slice(2, 66);
  const s = '0x' + sig.slice(66, 130);
  const v = parseInt(sig.slice(130, 132), 16);
  return { v, r, s };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let verifier, registry, deployer, wallet;

describe('RegistryV2Integration — setup', () => {
  before(async () => {
    const conn = await hre.network.connect();
    const { ethers } = conn;
    [deployer] = await ethers.getSigners();

    // Use deployer as trusted signer for tests
    wallet = deployer;

    // Deploy MeteringVerifierV2MPC
    const VerifierArtifact = await hre.artifacts.readArtifact('MeteringVerifierV2MPC');
    const VerifierFactory = new ethers.ContractFactory(
      VerifierArtifact.abi, VerifierArtifact.bytecode, deployer
    );
    verifier = await VerifierFactory.deploy();
    await verifier.waitForDeployment();

    // Deploy ReceiptRegistryV2 with deployer as trusted signer
    const RegistryArtifact = await hre.artifacts.readArtifact('ReceiptRegistryV2');
    const RegistryFactory = new ethers.ContractFactory(
      RegistryArtifact.abi, RegistryArtifact.bytecode, deployer
    );
    registry = await RegistryFactory.deploy(
      await verifier.getAddress(),
      deployer.address,
    );
    await registry.waitForDeployment();
  });

  it('deploys MeteringVerifierV2MPC', async () => {
    assert.ok(await verifier.getAddress(), 'verifier should have address');
  });

  it('deploys ReceiptRegistryV2', async () => {
    assert.ok(await registry.getAddress(), 'registry should have address');
  });

  it('ReceiptRegistryV2.verifier() points to MeteringVerifierV2MPC', async () => {
    const wired = await registry.verifier();
    assert.equal(
      wired.toLowerCase(),
      (await verifier.getAddress()).toLowerCase(),
      'verifier address mismatch',
    );
  });
});

describe('RegistryV2Integration — proof verification', () => {
  it('MeteringVerifierV2MPC verifies the canonical MPC proof', async () => {
    const result = await verifier.verifyProof(PA, PB, PC, PUB);
    assert.equal(result, true, 'MPC verifier must accept the canonical proof');
  });
});

describe('RegistryV2Integration — receipt submission', () => {
  it('submitReceipt succeeds with valid signature + valid proof', async () => {
    // Build a minimal canonical hash for this test receipt
    const rawFields = {
      costUnits: RAW_RECEIPT.costUnits.toString(),
      epoch: RAW_RECEIPT.epoch.toString(),
      nonce: RAW_RECEIPT.nonce.toString(),
      userId: RAW_RECEIPT.userId.toString(),
    };
    const rawHash = testCanonicalHash(rawFields);
    const { v, r, s } = await signRawHash(wallet, rawHash);

    const rawReceiptData = {
      userId: RAW_RECEIPT.userId,
      nonce: RAW_RECEIPT.nonce,
      epoch: RAW_RECEIPT.epoch,
      costUnits: RAW_RECEIPT.costUnits,
    };

    const proofData = {
      a: PA,
      b: PB,
      c: PC,
      pubSignals: PUB,
    };

    // Submit receipt — should not revert
    const tx = await registry.submitReceipt(rawReceiptData, rawHash, v, r, s, proofData);
    const receipt = await tx.wait();
    assert.ok(receipt.status === 1, 'transaction should succeed');

    // Check ReceiptSubmittedV2 event was emitted
    const events = receipt.logs.filter(log => {
      try {
        const parsed = registry.interface.parseLog(log);
        return parsed?.name === 'ReceiptSubmittedV2';
      } catch { return false; }
    });
    assert.equal(events.length, 1, 'should emit exactly one ReceiptSubmittedV2 event');

    // Decode and verify event fields
    const parsed = registry.interface.parseLog(events[0]);
    assert.equal(parsed.args.userId.toString(), RAW_RECEIPT.userId.toString(), 'userId');
    assert.equal(parsed.args.epoch.toString(), RAW_RECEIPT.epoch.toString(), 'epoch');
    assert.equal(parsed.args.minUsageBucket.toString(), '301', 'minUsageBucket');
    assert.equal(parsed.args.maxUsageBucket.toString(), '900', 'maxUsageBucket');
  });

  it('nonce increments after submission', async () => {
    const nonce = await registry.getNonce(deployer.address, RAW_RECEIPT.userId);
    assert.equal(nonce.toString(), '1', 'nonce should be 1 after one submission');
  });

  it('submitReceipt rejects duplicate commitment (anti-replay)', async () => {
    // Attempt re-submission of the same proof
    const rawFields = {
      costUnits: RAW_RECEIPT.costUnits.toString(),
      epoch: RAW_RECEIPT.epoch.toString(),
      nonce: '1', // nonce=1 now (incremented)
      userId: RAW_RECEIPT.userId.toString(),
    };
    const rawHash = testCanonicalHash(rawFields);
    const { v, r, s } = await signRawHash(wallet, rawHash);

    const rawReceiptData = {
      userId: RAW_RECEIPT.userId,
      nonce: 1n,
      epoch: RAW_RECEIPT.epoch,
      costUnits: RAW_RECEIPT.costUnits,
    };
    const proofData = { a: PA, b: PB, c: PC, pubSignals: PUB };

    // This will fail because the commitment hash is already used
    await assert.rejects(
      registry.submitReceipt(rawReceiptData, rawHash, v, r, s, proofData),
      /CommitmentAlreadyUsed/,
      'should reject duplicate commitment',
    );
  });

  it('submitReceipt rejects wrong nonce', async () => {
    const rawFields = {
      costUnits: '100',
      epoch: '710',
      nonce: '99', // wrong nonce (should be 1)
      userId: '99',
    };
    const rawHash = testCanonicalHash(rawFields);
    const { v, r, s } = await signRawHash(wallet, rawHash);

    const rawReceiptData = { userId: 99n, nonce: 99n, epoch: 710n, costUnits: 100n };
    const proofData = { a: PA, b: PB, c: PC, pubSignals: PUB };

    await assert.rejects(
      registry.submitReceipt(rawReceiptData, rawHash, v, r, s, proofData),
      /InvalidNonce/,
      'should reject wrong nonce',
    );
  });
});

describe('RegistryV2Integration — gas benchmark', () => {
  it('measures submitReceipt gas (canonical benchmark)', async () => {
    // R24: measure on a freshly deployed registry. The shared registry above already
    // consumed this proof's commitment, so the old benchmark reverted with
    // CommitmentAlreadyUsed. The receipt matches the proof inputs (userId 42, nonce 0).
    const RegistryArtifact = await hre.artifacts.readArtifact('ReceiptRegistryV2');
    const freshRegistry = await new ContractFactory(
      RegistryArtifact.abi, RegistryArtifact.bytecode, deployer
    ).deploy(await verifier.getAddress(), deployer.address);
    await freshRegistry.waitForDeployment();

    const rawFields = {
      costUnits: RAW_RECEIPT.costUnits.toString(),
      epoch: RAW_RECEIPT.epoch.toString(),
      nonce: '0',
      userId: RAW_RECEIPT.userId.toString(),
    };
    const rawHash = testCanonicalHash(rawFields);
    const { v, r, s } = await signRawHash(wallet, rawHash);

    const rawReceiptData = { ...RAW_RECEIPT, nonce: 0n };
    const proofData = { a: PA, b: PB, c: PC, pubSignals: PUB };

    const gas = await freshRegistry.submitReceipt.estimateGas(
      rawReceiptData, rawHash, v, r, s, proofData
    );
    console.log(`[RegistryV2] submitReceipt gas: ${Number(gas).toLocaleString()}`);
    assert.ok(Number(gas) > 50_000, `gas too low: ${gas}`);
    assert.ok(Number(gas) < 600_000, `gas too high: ${gas}`);
  });
});
