/**
 * GasComparisonV1V2.test.js — R24: like-for-like gas measurement, v1 vs v2.
 *
 * The dissertation compared 290,620 gas (v1 full registry tx) with 235,078 gas
 * (v2 verifier-only estimate) and called the difference a 19.2% reduction. This test
 * measures the same operations for both versions, each on a freshly deployed registry
 * (no shared state), same compiler settings (solc 0.8.24, evmVersion berlin, optimizer 200)
 * and the same in-process Hardhat network:
 *   (a) verifier.verifyProof — estimateGas (includes 21,000 intrinsic + calldata)
 *   (b) registry.submitReceipt — gasUsed of a mined transaction
 *
 * Fixtures: v1 proof zk/build/proof.json + public.json (userId 12345678901234567890,
 * usage 999, nonce 444, epoch 1, maxUsage 1000); v2 canonical MPC proof (userId 42,
 * usage 500, nonce 0, epoch 709, bucket [301, 900]).
 * Caveat (R16): the v1 registry expects nonce 0 on a fresh deployment while the v1 proof
 * was generated with nonce 444; the tx succeeds only because the contract does not bind
 * the proof's private inputs to the receipt. Gas is unaffected by that value.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import hre from 'hardhat';
import { keccak256, toUtf8Bytes, getBytes } from 'ethers';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ZK = path.resolve(__dirname, '..', '..', '..', 'zk', 'build');

// v2 canonical MPC proof (same as RegistryV2Integration.test.js)
const V2 = {
  a: ['0x2708bdb9b851a12032167716096a9136e22529cdecb5380cfdb3f8262f6b800a',
      '0x181aa1283f00387d64e67caa7ef2460c43127701f3d92608de4243ed85b6aa86'],
  b: [['0x01a85049b79129087ef1c14afa0fdd34c3b8dcfa8f84b3aeda6c5cb458410e90',
       '0x0d3ded78a15bd7e80d3d4817085b7f30a4f7c5cc3d56fbe43ac1c1eb562486c9'],
      ['0x0f0bca88cc5ed53bd6263ef45011bed511e9ee0ea3f22284afe7331a9aeb010d',
       '0x165fc5ac468346f5c54cd0a596cc9a923afbdc2d4c7b8db17c29bee944c79f84']],
  c: ['0x2ad0264ab3eb5f6b1c5b1e44bdf84508cb6dd846ec0ea4affa2f91efb0cfdee5',
      '0x2214a31739ed0afb998371cb2040df6dee5141851a45e4a86accefbcacd85c04'],
  pub: ['0x085cbe9e775af385148478081f45cd5ff095ede5a7018afc9c8cc1aca2de1430', '709', '301', '900'],
  raw: { userId: 42n, nonce: 0n, epoch: 709n, costUnits: 500n },
};

// v1 proof from snarkjs output; pi_b coordinates are swapped for the Solidity verifier
function loadV1() {
  const proof = JSON.parse(readFileSync(path.join(ZK, 'proof.json'), 'utf8'));
  const pub = JSON.parse(readFileSync(path.join(ZK, 'public.json'), 'utf8'));
  return {
    a: [proof.pi_a[0], proof.pi_a[1]],
    b: [[proof.pi_b[0][1], proof.pi_b[0][0]], [proof.pi_b[1][1], proof.pi_b[1][0]]],
    c: [proof.pi_c[0], proof.pi_c[1]],
    pub,
    raw: { userId: 12345678901234567890n, nonce: 0n, epoch: BigInt(pub[1]), costUnits: 999n },
  };
}

function canonicalHash(raw) {
  const parts = Object.keys(raw).sort().map(k => `${k}:${raw[k]}`).join('\n') + '\n';
  return keccak256(toUtf8Bytes(parts));
}

async function sign(wallet, rawHash) {
  const sig = await wallet.signMessage(getBytes(rawHash));
  return { v: parseInt(sig.slice(130, 132), 16), r: '0x' + sig.slice(2, 66), s: '0x' + sig.slice(66, 130) };
}

let ethers, deployer;
const results = {};

async function deploy(name, ...args) {
  const art = await hre.artifacts.readArtifact(name);
  const c = await new ethers.ContractFactory(art.abi, art.bytecode, deployer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

describe('R24 — like-for-like gas, v1 vs v2', () => {
  before(async () => {
    const conn = await hre.network.connect();
    ethers = conn.ethers;
    [deployer] = await ethers.getSigners();
    results.network = { name: conn.networkName ?? 'default', hardfork: conn.networkConfig?.hardfork ?? 'unknown' };
    results.compiler = { solc: '0.8.24', evmVersion: 'berlin', optimizerRuns: 200 };
  });

  for (const version of ['v1', 'v2']) {
    it(`${version}: verifier-only estimate and full submitReceipt gasUsed on a fresh registry`, async () => {
      const f = version === 'v1' ? loadV1() : V2;
      const verifier = await deploy(version === 'v1' ? 'contracts/MeteringVerifier.sol:Groth16Verifier' : 'MeteringVerifierV2MPC');
      assert.equal(await verifier.verifyProof(f.a, f.b, f.c, f.pub), true, `${version} proof must verify`);
      const verifyOnly = Number(await verifier.verifyProof.estimateGas(f.a, f.b, f.c, f.pub));

      const registry = await deploy(version === 'v1' ? 'ReceiptRegistry' : 'ReceiptRegistryV2',
        await verifier.getAddress(), deployer.address);
      const rawHash = canonicalHash({
        costUnits: f.raw.costUnits.toString(), epoch: f.raw.epoch.toString(),
        nonce: f.raw.nonce.toString(), userId: f.raw.userId.toString(),
      });
      const { v, r, s } = await sign(deployer, rawHash);
      const tx = await registry.submitReceipt(f.raw, rawHash, v, r, s, { a: f.a, b: f.b, c: f.c, pubSignals: f.pub });
      const rc = await tx.wait();
      assert.equal(rc.status, 1);
      results[version] = { verifyProofEstimate: verifyOnly, submitReceiptGasUsed: Number(rc.gasUsed) };
    });
  }

  it('reports the comparison of equal operations', () => {
    const { v1, v2 } = results;
    results.submitReceiptDeltaPercent = ((v2.submitReceiptGasUsed - v1.submitReceiptGasUsed) / v1.submitReceiptGasUsed) * 100;
    results.verifyOnlyDeltaPercent = ((v2.verifyProofEstimate - v1.verifyProofEstimate) / v1.verifyProofEstimate) * 100;
    results.measuredAt = new Date().toISOString();
    console.log('[R24] ' + JSON.stringify(results));
    const out = process.env.GAS_REPORT_OUT;
    if (out) { mkdirSync(path.dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(results, null, 2)); }
    assert.ok(v1.submitReceiptGasUsed > v1.verifyProofEstimate, 'registry tx includes more than verification');
    assert.ok(v2.submitReceiptGasUsed > v2.verifyProofEstimate);
  });
});
