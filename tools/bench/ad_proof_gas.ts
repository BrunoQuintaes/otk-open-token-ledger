/**
 * FECHAMENTO_GEMINI_AD / B — metering_v3 proof generation, off-chain verification and on-chain gas, measured SEPARATELY:
 *   cold  : one fresh process per proof (node + tsx start, artifact load, witness, prove, verify) — child ad_proof_cold.ts;
 *   warm  : one persistent process, artifacts loaded once; witness (wtns.calculate) and prove (groth16.prove) timed apart,
 *           then groth16.verify; 2 warm-up proofs excluded and recorded;
 *   chain : on the NEW isolated Besu (C5): verifyProof alone by eth_estimateGas (an ESTIMATE, incl. 21 000 intrinsic gas)
 *           and the full submitReceipt transaction (gasUsed from the mined RECEIPT), calldata bytes, wall time from send to
 *           receipt; every sample is a distinct operation (anti-replay), the first registration reported apart.
 * No latency is derived from gas. Gas on a private chain is not money on a public chain.
 *
 *   node --import tsx tools/bench/ad_proof_gas.ts --besu-dir <net> --out <dir> [--warm 30] [--cold 8] [--gas 12]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ethers } from 'ethers';
import * as snarkjs from 'snarkjs';
import {
  createKeyRing, createProofAdapterV3, createPublicAuthorizationBuilder, commitmentOf, newCommitmentOpening,
  PUBLIC_BUCKET_POLICY_FIXED_1000CU, bucketForReceipt, bucketPolicyRef, epochOf,
} from '../../src/zk/v3/index.js';
import type { PrivateReceiptV3 } from '../../src/types/d1d8/index.js';
import { readDeployment, chainDomainOf } from '../../src/operations/d1d8ProofPorts.js';

const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d; };
const NET = arg('besu-dir', ''); const OUT = path.resolve(arg('out', ''));
const WARM = Number(arg('warm', '30')); const COLD = Number(arg('cold', '8')); const GAS = Number(arg('gas', '12'));
if (!NET || !arg('out', '')) { console.error('--besu-dir and --out required'); process.exit(4); }
const ROOT = process.cwd();
const manifest = JSON.parse(fs.readFileSync('zk/v3/MANIFEST.json', 'utf8')) as { circuitId: string; files: Record<string, string>; tools?: unknown };
const sha = (p: string) => `0x${manifest.files[p]!.replace(/^0x/, '')}` as `0x${string}`;
const WASM = 'zk/v3/build/metering_v3_js/metering_v3.wasm'; const ZKEY = 'zk/v3/keys/metering_v3_demo_final.zkey'; const VKEY = 'zk/v3/keys/metering_v3_demo_vkey.json';
const VERIFIER_ABI = ['function verifyProof(uint256[2] a, uint256[2][2] b, uint256[2] c, uint256[4] input) view returns (bool)'];
const stats = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); if (!s.length) return { n: 0 }; const q = (p: number) => { const pos = (s.length - 1) * p; const lo = Math.floor(pos); const hi = Math.ceil(pos); return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo); }; const mean = s.reduce((a, b) => a + b, 0) / s.length; const sd = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, s.length - 1)); const r = (v: number) => +v.toFixed(2); return { n: s.length, mean: r(mean), sd: r(sd), p50: r(q(0.5)), p95: r(q(0.95)), min: r(s[0]!), max: r(s[s.length - 1]!) }; };

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const git = (a: string[]) => { try { return execFileSync('git', a, { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
  const net = JSON.parse(fs.readFileSync(path.join(NET, 'network.json'), 'utf8')) as { rpc: string; chainId: number; project?: string; image: string };
  const dep = readDeployment(path.join(NET, 'deploy_v3_besu.json'));
  const depFull = JSON.parse(fs.readFileSync(path.join(NET, 'deploy_v3_besu.json'), 'utf8')) as { contracts: Record<string, string> };
  const key = (n: string) => `0x${fs.readFileSync(path.join(NET, 'dev', `${n}.key`), 'utf8').trim()}`;
  const rpc = new ethers.JsonRpcProvider(net.rpc, undefined, { staticNetwork: true });
  const operator = new ethers.Wallet(key('operator'));
  const payer = new ethers.Wallet(key('submitter'), rpc);
  const keyRing = createKeyRing([{ keyId: 'op', address: operator.address as `0x${string}`, status: 'active' }]);
  const signer = { keyId: 'op', wallet: operator };
  const policy = PUBLIC_BUCKET_POLICY_FIXED_1000CU;
  const build = createPublicAuthorizationBuilder({ keyRing, signer, policy, circuitId: manifest.circuitId });
  const domain = chainDomainOf(dep);
  const tLoad0 = performance.now();
  const adapter = await createProofAdapterV3({ circuitId: manifest.circuitId, wasmPath: WASM, zkeyPath: ZKEY, vkeyPath: VKEY, expected: { wasm: sha(WASM), zkey: sha(ZKEY), vkey: sha(VKEY) } });
  const wasmBytes = new Uint8Array(fs.readFileSync(WASM)); const zkeyBytes = new Uint8Array(fs.readFileSync(ZKEY)); const vkey = JSON.parse(fs.readFileSync(VKEY, 'utf8'));
  const warmLoadMs = performance.now() - tLoad0;
  const tag = Date.now().toString(36);
  let idx = 0;
  async function member(cuMicro: bigint) {
    const k = { tenantId: `bench-b-${tag}`, operationId: `op-${idx++}` };
    const admittedAt = new Date().toISOString();
    const opening = newCommitmentOpening(k, { units: cuMicro, scale: 1_000_000n }, manifest.circuitId, { userRef: '7', epoch: epochOf(admittedAt).toString() });
    const receipt = { schema: 'otk.receipt.v3', key: k, source: 'otk_proxy_observed', provider: 'bench', usage: { observedAt: new Date().toISOString() },
      cu: { schema: 'otk.cu_result.v1', status: 'computed', cu: { units: cuMicro, scale: 1_000_000n } },
      config: { circuitId: manifest.circuitId, bucketPolicy: bucketPolicyRef(policy) }, userRef: '7', timing: { admittedAt }, publicCommitment: String(await commitmentOf(opening)), contentDigests: null } as unknown as PrivateReceiptV3;
    const auth = await build({ receipt, opening, domain, bucket: bucketForReceipt(receipt, policy) });
    return { auth, input: adapter.buildWitnessInput(opening, auth) };
  }

  // ── warm: persistent process ──
  const warm: Array<{ i: number; warmup: boolean; witnessMs: number; proveMs: number; verifyMs: number; verified: boolean }> = [];
  for (let i = 0; i < WARM + 2; i++) {
    const m = await member(BigInt(1 + i) * 37_000_000n);
    const wtns = { type: 'mem' } as { type: 'mem'; data?: Uint8Array };
    const t0 = performance.now(); await snarkjs.wtns.calculate(m.input as never, wasmBytes, wtns); const t1 = performance.now();
    const { proof, publicSignals } = await snarkjs.groth16.prove(zkeyBytes, wtns as never); const t2 = performance.now();
    const ok = await snarkjs.groth16.verify(vkey, publicSignals, proof); const t3 = performance.now();
    warm.push({ i, warmup: i < 2, witnessMs: t1 - t0, proveMs: t2 - t1, verifyMs: t3 - t2, verified: ok === true });
  }
  // ── cold: one fresh process per proof ──
  const cold: Array<Record<string, unknown>> = [];
  for (let i = 0; i < COLD; i++) {
    const t0 = performance.now();
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'tools/bench/ad_proof_cold.ts'], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    const wallMs = performance.now() - t0;
    let inner: Record<string, unknown> = {}; try { inner = JSON.parse(r.stdout.trim().split(/\r?\n/).pop() ?? '{}'); } catch { inner = { parseError: r.stdout.slice(-200), stderr: r.stderr.slice(-300) }; }
    cold.push({ i, exit: r.status, processWallMs: wallMs, ...inner });
  }
  // ── chain: distinct operations on the new network ──
  const verifier = new ethers.Contract(depFull.contracts['MeteringVerifierV3Demo']!, VERIFIER_ABI, rpc);
  const chain: Array<Record<string, unknown>> = [];
  const startBlock = await rpc.getBlockNumber();
  for (let i = 0; i < GAS; i++) {
    const m = await member(BigInt(5 + i) * 1_000_000n);
    const bundle = await adapter.prove(m.input);
    const p = bundle.proof;
    const verifyEstimate = Number(await verifier.getFunction('verifyProof').estimateGas(p.a, p.b, p.c, bundle.publicSignals));
    const verifyResult = await verifier.getFunction('verifyProof').staticCall(p.a, p.b, p.c, bundle.publicSignals);
    const call = adapter.encodeSubmission(m.auth, bundle);
    const reg = new ethers.Contract(dep.domain.registry, call.abi, payer);
    const data = reg.interface.encodeFunctionData(call.functionName, call.args);
    const bytes = ethers.getBytes(data); const zero = bytes.filter((b) => b === 0).length;
    const submitEstimate = Number(await reg.getFunction(call.functionName).estimateGas(...call.args));
    const t0 = performance.now();
    const tx = await reg.getFunction(call.functionName)(...call.args);
    const rc = await tx.wait();
    const confirmMs = performance.now() - t0;
    chain.push({ i, first: i === 0, verifyProof_estimateGas: verifyEstimate, verifyProof_result: verifyResult, submit_estimateGas: submitEstimate, submit_gasUsed_receipt: Number(rc!.gasUsed), status: rc!.status, block: rc!.blockNumber, txHash: rc!.hash,
      calldataBytes: bytes.length, calldataZeroBytes: zero, calldataNonzeroBytes: bytes.length - zero, calldataGas_4_16_derived: zero * 4 + (bytes.length - zero) * 16, sendToReceiptMs: +confirmMs.toFixed(1) });
    // replay of the same authorization must be refused (anti-replay): estimateGas reverts
    if (i === 0) { try { await reg.getFunction(call.functionName).estimateGas(...call.args); chain[0]!['replayRefused'] = false; } catch { chain[0]!['replayRefused'] = true; } }
  }
  const block = await rpc.getBlockNumber();
  const result = {
    schema: 'otk.bench_b.v1', ranAt: new Date().toISOString(), commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), dirty: git(['status', '--porcelain']).split('\n').filter(Boolean).length,
    machine: { cpu: `${os.cpus().length} × ${os.cpus()[0]!.model}`, memGB: +(os.totalmem() / 2 ** 30).toFixed(1), os: `${os.type()} ${os.release()}`, node: process.version },
    circuit: { circuitId: manifest.circuitId, wasm: manifest.files[WASM], zkey: manifest.files[ZKEY], vkey: manifest.files[VKEY], setup: 'demonstrative local setup (zk/v3/README.md), not a ceremony', snarkjs: JSON.parse(fs.readFileSync('node_modules/snarkjs/package.json', 'utf8')).version },
    network: { project: net.project ?? null, chainId: net.chainId, image: net.image, validators: 7, consensus: 'IBFT 2.0, block period 2 s', startBlock, endBlock: block, contracts: depFull.contracts, evm: 'solc 0.8.24, evmVersion berlin (tools/hardhat/hardhat.config.js)' },
    warm: { artifactLoadMs: +warmLoadMs.toFixed(1), excludedWarmup: 2, witnessMs: stats(warm.filter((w) => !w.warmup).map((w) => w.witnessMs)), proveMs: stats(warm.filter((w) => !w.warmup).map((w) => w.proveMs)), verifyMs: stats(warm.filter((w) => !w.warmup).map((w) => w.verifyMs)), allVerified: warm.every((w) => w.verified), raw: warm },
    cold: { processWallMs: stats(cold.map((c) => Number(c['processWallMs']))), proveMs: stats(cold.map((c) => Number(c['proveMs'])).filter(Number.isFinite)), loadMs: stats(cold.map((c) => Number(c['loadMs'])).filter(Number.isFinite)), raw: cold },
    gas: {
      verifyProof_estimateGas: stats(chain.map((c) => Number(c['verifyProof_estimateGas']))), submit_gasUsed_receipt_all: stats(chain.map((c) => Number(c['submit_gasUsed_receipt']))),
      submit_gasUsed_receipt_first: chain[0]?.['submit_gasUsed_receipt'] ?? null, submit_gasUsed_receipt_subsequent: stats(chain.slice(1).map((c) => Number(c['submit_gasUsed_receipt']))),
      sendToReceiptMs: stats(chain.map((c) => Number(c['sendToReceiptMs']))), raw: chain,
    },
    labels: {
      verifyProof_estimateGas: 'ESTIMATE (eth_estimateGas of a view call, includes 21 000 intrinsic + calldata); not mined',
      submit_gasUsed_receipt: 'REAL (gasUsed of the mined transaction receipt on the local Besu)',
      calldataGas_4_16_derived: 'DERIVED from calldata bytes (4 per zero byte, 16 per non-zero byte), not measured',
      sendToReceiptMs: 'wall time measured from send to receipt (block period 2 s dominates); not derived from gas',
    },
    limitations: ['one machine, one run, local private chain; gas is not money on a public chain', 'demo setup; v1/v2 not compared (other circuit/contract/keys)', 'proving time depends on concurrent load (heavy lock held)'],
  };
  fs.writeFileSync(path.join(OUT, 'b_results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ warmProveP50: result.warm.proveMs, coldWall: result.cold.processWallMs, gas: { verify: result.gas.verifyProof_estimateGas, submit: result.gas.submit_gasUsed_receipt_all }, replayRefused: chain[0]?.['replayRefused'] }));
  rpc.destroy();
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } | null }).curve_bn128?.terminate();
}
main().then(() => process.exit(0), (e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
