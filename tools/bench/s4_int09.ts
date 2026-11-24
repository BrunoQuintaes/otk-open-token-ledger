/**
 * D1–D8 / S4 — INT-09 / D8-G05 / D8-G01 measurements in the FINAL configuration of this run
 * (7-validator Besu chainId 16251, metering_v3 demo setup, contracts from deploy_v3.js, solc 0.8.24
 * berlin, optimizer as in tools/hardhat/hardhat.config.js). Not comparable to historical v1/v2
 * numbers (other circuit, contract, network) and not a universal figure: one machine, one run.
 *
 *   OTK_S4_BESU_DIR=… npx tsx tools/bench/s4_int09.ts --samples 5 --out <json>
 *
 * 1. Gas: verifier alone (eth_estimateGas of verifyProof) vs full submitReceipt (receipt.gasUsed),
 *    per sample (each sample = a fresh opening/authorization/proof, synthetic CU).
 * 2. Batch: registerBatch with 1, 3 and 10 members (statement only; members proved and verified
 *    off-chain by the builder: level signature_and_proof_each). Root ≠ N on-chain proofs.
 * 3. Proof generation time (snarkjs, this machine) per sample.
 * Dev keys of the S4 network are read from files and never printed.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ethers } from 'ethers';
import {
  createBatchStatementBuilder, createKeyRing, createProofAdapterV3, createPublicAuthorizationBuilder, createReceiptCrypto,
  commitmentOf, newCommitmentOpening, PUBLIC_BUCKET_POLICY_FIXED_1000CU, bucketForReceipt, bucketPolicyRef, epochOf,
} from '../../src/zk/v3/index.js';
import type { PrivateReceiptV3 } from '../../src/types/d1d8/index.js';
import { readDeployment, chainDomainOf } from '../../src/operations/d1d8ProofPorts.js';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d; };
const BESU = process.env['OTK_S4_BESU_DIR'];
if (!BESU) throw new Error('OTK_S4_BESU_DIR required');
const SAMPLES = Number(arg('--samples', '5'));
const OUT = arg('--out', '');
const net = JSON.parse(readFileSync(path.join(BESU, 'network.json'), 'utf8')) as { rpc: string; chainId: number };
const dep = readDeployment(path.join(BESU, 'deploy_v3_besu.json'));
const depFull = JSON.parse(readFileSync(path.join(BESU, 'deploy_v3_besu.json'), 'utf8')) as { batchDomain: { chainId: string; registry: string; verifier: string; schemaVersion: string }; contracts: Record<string, string> };
const key = (n: string) => `0x${readFileSync(path.join(BESU, 'dev', `${n}.key`), 'utf8').trim()}`;
const rpc = new ethers.JsonRpcProvider(net.rpc, undefined, { staticNetwork: true });
const operator = new ethers.Wallet(key('operator'));
const payer = new ethers.Wallet(key('submitter'), rpc);
const manifest = JSON.parse(readFileSync('zk/v3/MANIFEST.json', 'utf8')) as { circuitId: string; files: Record<string, string> };
const sha = (p: string) => `0x${manifest.files[p]!.replace(/^0x/, '')}` as `0x${string}`;
const VERIFIER_ABI = ['function verifyProof(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[4] input) view returns (bool)'];
const BATCH_ABI = ['function registerBatch((bytes32 root, uint64 cardinality, uint8 memberValidation, uint64 firstEpoch, uint64 lastEpoch) st, bytes signature) external'];

const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))]!; return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean: Math.round(s.reduce((a, b) => a + b, 0) / s.length) }; };

async function main(): Promise<void> {
  const keyRing = createKeyRing([{ keyId: 'op', address: operator.address as `0x${string}`, status: 'active' }]);
  const signer = { keyId: 'op', wallet: operator };
  const crypto = createReceiptCrypto({ keyRing, signer });
  const adapter = await createProofAdapterV3({
    circuitId: manifest.circuitId, wasmPath: 'zk/v3/build/metering_v3_js/metering_v3.wasm', zkeyPath: 'zk/v3/keys/metering_v3_demo_final.zkey', vkeyPath: 'zk/v3/keys/metering_v3_demo_vkey.json',
    expected: { wasm: sha('zk/v3/build/metering_v3_js/metering_v3.wasm'), zkey: sha('zk/v3/keys/metering_v3_demo_final.zkey'), vkey: sha('zk/v3/keys/metering_v3_demo_vkey.json') },
  });
  const policy = PUBLIC_BUCKET_POLICY_FIXED_1000CU;
  const build = createPublicAuthorizationBuilder({ keyRing, signer, policy, circuitId: manifest.circuitId });
  const domain = chainDomainOf(dep);
  const verifier = new ethers.Contract(depFull.contracts['MeteringVerifierV3Demo']!, VERIFIER_ABI, rpc);
  const tag = Date.now().toString(36);

  async function member(i: number, cuMicro: bigint) {
    const k = { tenantId: `bench-${tag}`, operationId: `op-${i}` };
    const admittedAt = new Date().toISOString();
    const opening = newCommitmentOpening(k, { units: cuMicro, scale: 1_000_000n }, manifest.circuitId, { userRef: '7', epoch: epochOf(admittedAt).toString() });
    const receipt = {
      schema: 'otk.receipt.v3', key: k, source: 'otk_proxy_observed', provider: 'bench', usage: { observedAt: new Date().toISOString() },
      cu: { schema: 'otk.cu_result.v1', status: 'computed', cu: { units: cuMicro, scale: 1_000_000n } },
      config: { circuitId: manifest.circuitId, bucketPolicy: bucketPolicyRef(policy) }, userRef: '7', timing: { admittedAt }, publicCommitment: String(await commitmentOf(opening)), contentDigests: null,
    } as unknown as PrivateReceiptV3;
    const auth = await build({ receipt, opening, domain, bucket: bucketForReceipt(receipt, policy) });
    const t0 = performance.now();
    const bundle = await adapter.prove(adapter.buildWitnessInput(opening, auth));
    const proveMs = performance.now() - t0;
    return { auth, bundle, proveMs };
  }

  const verifierGas: number[] = []; const submitGas: number[] = []; const proveMs: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const m = await member(i, BigInt(1 + i) * 1_000_000n * 37n);
    proveMs.push(Math.round(m.proveMs));
    const p = m.bundle.proof;
    verifierGas.push(Number(await verifier.getFunction('verifyProof').estimateGas(p.a, p.b, p.c, m.bundle.publicSignals)));
    const call = adapter.encodeSubmission(m.auth, m.bundle);
    const reg = new ethers.Contract(dep.domain.registry, call.abi, payer);
    const rc = await (await reg.getFunction(call.functionName)(...call.args)).wait();
    submitGas.push(Number(rc!.gasUsed));
  }

  const batchDomain = { chainId: BigInt(depFull.batchDomain.chainId), registry: depFull.batchDomain.registry as `0x${string}`, verifier: depFull.batchDomain.verifier as `0x${string}`, schemaVersion: depFull.batchDomain.schemaVersion };
  const buildBatch = createBatchStatementBuilder({ keyRing, signer, adapter, expect: { circuitId: manifest.circuitId, policy } });
  const batchGas: Record<string, number> = {};
  const batchReg = new ethers.Contract(batchDomain.registry, BATCH_ABI, payer);
  let idx = 1000;
  for (const size of [1, 3, 10]) {
    const members = [];
    for (let j = 0; j < size; j++) { const m = await member(idx++, 5_000_000n + BigInt(j)); members.push({ auth: m.auth, bundle: m.bundle }); }
    const st = await buildBatch({ domain: batchDomain, members });
    const tuple = { root: st.root, cardinality: st.cardinality, memberValidation: 2, firstEpoch: st.firstEpoch, lastEpoch: st.lastEpoch };
    const rc = await (await batchReg.getFunction('registerBatch')(tuple, st.signature.signature)).wait();
    batchGas[`members_${size}`] = Number(rc!.gasUsed);
  }

  const block = await rpc.getBlockNumber();
  const result = {
    schema: 'otk.s4_int09_gas.v1', ranAt: new Date().toISOString(), network: { chainId: net.chainId, validators: 7, rpc: 'local', block },
    contracts: depFull.contracts, circuitId: manifest.circuitId, samples: SAMPLES,
    gas: { verifierOnly_estimate: stats(verifierGas), submitReceipt_gasUsed: stats(submitGas), registerBatch_gasUsed: batchGas },
    proveMs: stats(proveMs),
    limitations: [
      'one machine (Windows 11, 8 CPUs), one run; proving time depends on load',
      'verifier-only = eth_estimateGas of a view call (includes 21000 intrinsic gas); submitReceipt = mined gasUsed',
      'registerBatch records a signed root after off-chain verification of every member; it does not verify N proofs on chain',
      'demo setup (single local contribution); metering_v3 differs from v1/v2: no comparison with historical percentages',
    ],
  };
  const json = JSON.stringify(result, null, 2);
  if (OUT) writeFileSync(OUT, json + '\n');
  process.stdout.write(json + '\n');
  rpc.destroy();
  // snarkjs/ffjavascript keep a bn128 worker pool in a global after an in-process proof
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } | null }).curve_bn128?.terminate();
}
main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
