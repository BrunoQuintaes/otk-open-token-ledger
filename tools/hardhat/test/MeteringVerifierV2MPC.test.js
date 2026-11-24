/**
 * PACK A — MeteringVerifierV2MPC.sol
 *
 * Validates that the Solidity verifier regenerated from metering_v2_final_mpc.zkey
 * correctly verifies a real Groth16 proof generated with the same key.
 *
 * Closes the canonical mismatch: MeteringVerifierV2.sol was generated from
 * a different (unknown) key. MeteringVerifierV2MPC.sol is generated from the
 * canonical 5-contributor + Hermez Phase1 MPC key.
 *
 * Proof generated with: groth16.fullProve + groth16.exportSolidityCallData
 * Input: { userId:42, usage:500, nonce:1, epoch:709, minUsageBucket:301, maxUsageBucket:900 }
 * Key: zk/keys/metering_v2_final_mpc.zkey
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import hre from 'hardhat';

// ---------------------------------------------------------------------------
// Proof generated with metering_v2_final_mpc.zkey + exportSolidityCallData
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

let verifier;

describe('MeteringVerifierV2MPC — deployment', () => {
  before(async () => {
    const conn = await hre.network.connect();
    const [deployer] = await conn.ethers.getSigners();
    const artifact = await hre.artifacts.readArtifact('MeteringVerifierV2MPC');
    const Factory = new conn.ethers.ContractFactory(artifact.abi, artifact.bytecode, deployer);
    verifier = await Factory.deploy();
    await verifier.waitForDeployment();
  });

  it('deploys successfully', async () => {
    assert.ok(await verifier.getAddress(), 'contract should have an address');
  });
});

describe('MeteringVerifierV2MPC — proof verification', () => {
  it('verifies real Groth16 v2 MPC proof (should return true)', async () => {
    const result = await verifier.verifyProof(PA, PB, PC, PUB);
    assert.equal(result, true, 'MPC proof must verify — canonical MPC verifier ↔ MPC key alignment confirmed');
  });

  it('measures gas for verifyProof (canonical benchmark)', async () => {
    const tx = await verifier.verifyProof.estimateGas(PA, PB, PC, PUB);
    const gas = Number(tx);
    console.log(`[MeteringVerifierV2MPC] verifyProof gas: ${gas.toLocaleString()}`);
    // Expect in range of other v2 verifiers (200K–300K)
    assert.ok(gas > 100_000, `gas too low: ${gas}`);
    assert.ok(gas < 500_000, `gas too high: ${gas}`);
  });

  it('rejects invalid proof', async () => {
    const badPA = ["0x0000000000000000000000000000000000000000000000000000000000000001",
                   "0x0000000000000000000000000000000000000000000000000000000000000002"];
    const result = await verifier.verifyProof(badPA, PB, PC, PUB);
    assert.equal(result, false, 'invalid proof must not verify');
  });
});
