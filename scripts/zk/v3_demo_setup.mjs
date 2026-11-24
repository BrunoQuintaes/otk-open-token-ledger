#!/usr/bin/env node
/**
 * metering_v3 — LOCAL DEMONSTRATIVE SETUP (D6 §4–7, run 20260930-1625, front A).
 *
 * "Setup demonstrativo local": every contribution below is made by one executor on one machine.
 * Trust is concentrated in that executor. This is NOT a ceremony, has no independent participants
 * and must never be described as one. Historical v1/v2 artifacts are not read or written here.
 *
 * Entropy for each contribution comes from crypto.randomBytes inside this process and is never
 * printed, logged or written. Deleting files does not prove toxic-waste elimination; the residual
 * risk is that this process/machine retained it (see zk/v3/README.md).
 *
 * Stages (default: all):
 *   compile  circom 2.1.6 --O1 → zk/v3/build/
 *   ptau     new phase 1 (bn128, 2^11), one local contribution, preparePhase2 → zk/v3/setup/
 *   zkey     groth16 setup + one local contribution, verifyFromR1cs → zk/v3/keys/
 *   export   vkey JSON + Solidity verifier (contract MeteringVerifierV3Demo) → tools/hardhat/contracts/v3/
 *   manifest zk/v3/MANIFEST.json (sha256 of every artifact, tool versions, commands)
 *
 *   CIRCOM=<path to circom 2.1.6> node scripts/zk/v3_demo_setup.mjs [stage...]
 */
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(path.join(ROOT, 'package.json'));
const snarkjs = require('snarkjs');
const { buildBn128 } = require('ffjavascript');

const CIRCOM = process.env.CIRCOM;
const P = (...x) => path.join(ROOT, ...x);
const OUT = {
  circuit: P('zk/circuits/metering_v3.circom'),
  build: P('zk/v3/build'),
  r1cs: P('zk/v3/build/metering_v3.r1cs'),
  sym: P('zk/v3/build/metering_v3.sym'),
  wasm: P('zk/v3/build/metering_v3_js/metering_v3.wasm'),
  setup: P('zk/v3/setup'),
  ptauFinal: P('zk/v3/setup/pot11_demo_final.ptau'),
  keys: P('zk/v3/keys'),
  zkey0: P('zk/v3/keys/metering_v3_demo_0000.zkey'),
  zkeyFinal: P('zk/v3/keys/metering_v3_demo_final.zkey'),
  vkey: P('zk/v3/keys/metering_v3_demo_vkey.json'),
  verifierSol: P('tools/hardhat/contracts/v3/MeteringVerifierV3Demo.sol'),
  manifest: P('zk/v3/MANIFEST.json'),
};
const POWER = 11;
const quiet = { info() {}, debug() {}, warn: (m) => console.warn(m), error: (m) => console.error(m) };
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
// Text artifacts are hashed after CRLF→LF normalization: .gitattributes has `* text=auto`, so a
// Windows checkout may rewrite their line endings. Binary artifacts are hashed as is.
const TEXT_EXT = new Set(['.circom', '.sol', '.js', '.sym', '.json', '.md', '.txt']);
const isText = (f) => TEXT_EXT.has(path.extname(f));
const manifestHash = (f) => (isText(f) ? createHash('sha256').update(readFileSync(f, 'utf8').replace(/\r\n/g, '\n')).digest('hex') : sha256(f));
const rel = (f) => path.relative(ROOT, f).split(path.sep).join('/');
const log = [];
const step = (m) => { const line = `${new Date().toISOString()} ${m}`; log.push(line); console.log(line); };
const entropy = () => randomBytes(64).toString('hex'); // never printed

async function compile() {
  if (!CIRCOM) throw new Error('set CIRCOM to the circom 2.1.6 binary');
  mkdirSync(OUT.build, { recursive: true });
  const args = [rel(OUT.circuit), '--r1cs', '--wasm', '--sym', '--O1', '-l', 'zk/circuits', '-o', rel(OUT.build)];
  step(`circom ${args.join(' ')}`);
  const out = execFileSync(CIRCOM, args, { cwd: ROOT, encoding: 'utf8' });
  writeFileSync(P('zk/v3/build/compile_log.txt'), out.replace(/\x1b\[[0-9;]*m/g, ''));
  const info = await snarkjs.r1cs.info(OUT.r1cs, quiet);
  step(`r1cs constraints=${info.nConstraints} outputs=${info.nOutputs} pubInputs=${info.nPubInputs} prvInputs=${info.nPrvInputs}`);
}

async function ptau() {
  mkdirSync(OUT.setup, { recursive: true });
  const curve = await buildBn128();
  const p0 = P('zk/v3/setup/pot11_demo_0000.ptau'), p1 = P('zk/v3/setup/pot11_demo_0001.ptau');
  step(`powersOfTau.newAccumulator bn128 2^${POWER}`);
  await snarkjs.powersOfTau.newAccumulator(curve, POWER, p0, quiet);
  step('powersOfTau.contribute "otk-a-demo-local-1" (entropy: crypto.randomBytes, not recorded)');
  await snarkjs.powersOfTau.contribute(p0, p1, 'otk-a-demo-local-1', entropy(), quiet);
  step('powersOfTau.preparePhase2');
  await snarkjs.powersOfTau.preparePhase2(p1, OUT.ptauFinal, quiet);
  const ok = await snarkjs.powersOfTau.verify(OUT.ptauFinal, quiet);
  step(`powersOfTau.verify final = ${ok}`);
  if (!ok) throw new Error('ptau verification failed');
  // Intermediate accumulators are public data (no secret); their hashes are recorded, the files dropped.
  const inter = { [rel(p0)]: sha256(p0), [rel(p1)]: sha256(p1) };
  rmSync(p0); rmSync(p1);
  writeFileSync(P('zk/v3/setup/intermediate_ptau.sha256.json'), JSON.stringify(inter, null, 2) + '\n');
  await curve.terminate();
}

async function zkey() {
  mkdirSync(OUT.keys, { recursive: true });
  step('zKey.newZKey r1cs ptau');
  await snarkjs.zKey.newZKey(OUT.r1cs, OUT.ptauFinal, OUT.zkey0, quiet);
  step('zKey.contribute "otk-a-demo-local-1" (entropy: crypto.randomBytes, not recorded)');
  await snarkjs.zKey.contribute(OUT.zkey0, OUT.zkeyFinal, 'otk-a-demo-local-1', entropy(), quiet);
  const ok = await snarkjs.zKey.verifyFromR1cs(OUT.r1cs, OUT.ptauFinal, OUT.zkeyFinal, quiet);
  step(`zKey.verifyFromR1cs final = ${ok}`);
  if (!ok) throw new Error('zkey verification failed');
}

async function exportArtifacts() {
  const vk = await snarkjs.zKey.exportVerificationKey(OUT.zkeyFinal, quiet);
  writeFileSync(OUT.vkey, JSON.stringify(vk, null, 1) + '\n');
  const tpl = readFileSync(P('node_modules/snarkjs/templates/verifier_groth16.sol.ejs'), 'utf8');
  let sol = await snarkjs.zKey.exportSolidityVerifier(OUT.zkeyFinal, { groth16: tpl }, quiet);
  if (!sol.includes('contract Groth16Verifier')) throw new Error('unexpected verifier template');
  sol = sol.replace('contract Groth16Verifier', 'contract MeteringVerifierV3Demo')
    .replace(/pragma solidity [^;]+;/, (m) => `${m}\n\n// GENERATED by scripts/zk/v3_demo_setup.mjs from zk/v3/keys/metering_v3_demo_final.zkey.\n// LOCAL DEMONSTRATIVE SETUP — single executor, not a ceremony. Do not edit by hand.`);
  writeFileSync(OUT.verifierSol, sol);
  step('exported vkey + MeteringVerifierV3Demo.sol');
}

async function manifest() {
  const r1csHash = sha256(OUT.r1cs);
  const files = [OUT.circuit, OUT.r1cs, OUT.sym, OUT.wasm, P('zk/v3/build/metering_v3_js/witness_calculator.js'), OUT.ptauFinal, OUT.zkey0, OUT.zkeyFinal, OUT.vkey, OUT.verifierSol];
  const info = await snarkjs.r1cs.info(OUT.r1cs, quiet);
  const m = {
    schema: 'otk.zk_manifest.v1',
    circuitId: `metering_v3@sha256:${r1csHash}`,
    label: 'setup demonstrativo local — confiança concentrada no executor A (sessão Claude Code, run 20260930-1625); não é cerimônia; sem participantes independentes',
    generatedAt: new Date().toISOString(),
    circuit: { source: rel(OUT.circuit), constraints: info.nConstraints, publicSignals: ['commitment', 'epoch', 'minUsage', 'maxUsage'], privateInputs: ['usage', 'blinding', 'userRef'] },
    tools: {
      circom: { version: '2.1.6', sha256: CIRCOM && existsSync(CIRCOM) ? sha256(CIRCOM) : null, flags: '--r1cs --wasm --sym --O1 -l zk/circuits' },
      snarkjs: require(P('node_modules/snarkjs/package.json')).version,
      ffjavascript: require(P('node_modules/ffjavascript/package.json')).version,
      circomlib: execFileSync('git', ['-C', 'zk/circuits/circomlib', 'rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
      node: process.version,
    },
    phase1: { power: POWER, curve: 'bn128', contributions: ['otk-a-demo-local-1'], beacon: null, source: 'new local accumulator (not Hermez, not the historical pot12)' },
    phase2: { contributions: ['otk-a-demo-local-1'], beacon: null },
    registry: { contract: 'tools/hardhat/contracts/v3/ReceiptRegistryV3.sol', verifierContract: 'MeteringVerifierV3Demo', bucketPolicy: 'otk.public_bucket.fixed@1:width=1000CU:unit=microCU', bucketWidthUnits: '1000000000' },
    hashRule: 'sha256; files with extension .circom/.sol/.js/.sym/.json/.md/.txt hashed after CRLF→LF normalization',
    files: Object.fromEntries(files.map((f) => [rel(f), manifestHash(f)])),
    intermediate: existsSync(P('zk/v3/setup/intermediate_ptau.sha256.json')) ? JSON.parse(readFileSync(P('zk/v3/setup/intermediate_ptau.sha256.json'), 'utf8')) : null,
    // A manifest-only rerun keeps the log of the run that produced the keys.
    log: [...(existsSync(OUT.manifest) ? JSON.parse(readFileSync(OUT.manifest, 'utf8')).log ?? [] : []), ...log],
  };
  if (existsSync(OUT.manifest)) m.generatedAt = JSON.parse(readFileSync(OUT.manifest, 'utf8')).generatedAt ?? m.generatedAt;
  const tmp = OUT.manifest + '.tmp';
  writeFileSync(tmp, JSON.stringify(m, null, 2) + '\n');
  renameSync(tmp, OUT.manifest);
  step(`manifest circuitId=${m.circuitId}`);
}

const stages = process.argv.slice(2);
const all = stages.length === 0;
if (all || stages.includes('compile')) await compile();
if (all || stages.includes('ptau')) await ptau();
if (all || stages.includes('zkey')) await zkey();
if (all || stages.includes('export')) await exportArtifacts();
if (all || stages.includes('manifest')) await manifest();
await globalThis.curve_bn128?.terminate();
process.exit(0);
