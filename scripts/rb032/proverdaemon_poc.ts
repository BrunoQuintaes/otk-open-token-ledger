/**
 * RB-032 PoC: metering_v2 proof generation (single-shot, inline)
 *
 * Demonstra geração end-to-end de prova Groth16 com:
 *   - circuit: metering_v2.circom (430 NL + 444 L constraints)
 *   - zkey:    metering_v2_final_mpc.zkey (MPC 5 contribuidores — produção)
 *   - vkey:    metering_v2_vkey_mpc.json  (verificação local)
 *
 * Sem daemon HTTP; sem on-chain; sem alterar fluxo default do SDK.
 *
 * Uso:
 *   npx tsx scripts/rb032/proverdaemon_poc.ts [--out=<dir>]
 *
 * Saída:
 *   <out>/proof.json      — prova Groth16 gerada
 *   <out>/public.json     — pubSignals [commitment, epoch, minBucket, maxBucket]
 *   <out>/params.json     — inputs + metadata
 *   <out>/verify.json     — resultado da verificação local
 *
 * English summary: proof of concept that generates one Groth16 proof of the metering_v2 circuit with the
 * ceremony's final proving key (fixed sample inputs: usage 750 inside the public bucket [500, 1000]) and verifies it
 * locally. Needs `zk/build/metering_v2_js/metering_v2.wasm` and the keys in `zk/keys/`; exits with code 1 when any
 * is missing or the proof fails. Default output folder: `docs/_ops/rb032/_poc_out`. No network, no chain, no
 * environment variables.
 *
 * @module scripts/rb032/proverdaemon_poc
 * @since RB-032 (2026-03-03)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { groth16 } from 'snarkjs';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const WASM_PATH = path.join(REPO_ROOT, 'zk/build/metering_v2_js/metering_v2.wasm');
const ZKEY_PATH = path.join(REPO_ROOT, 'zk/keys/metering_v2_final_mpc.zkey');
const VKEY_PATH = path.join(REPO_ROOT, 'zk/keys/metering_v2_vkey_mpc.json');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------

function arg(name: string, def: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=', 2)[1]! : def;
}

const outDir = arg('out', path.join(REPO_ROOT, 'docs/_ops/rb032/_poc_out'));
fs.mkdirSync(outDir, { recursive: true });

// ---------------------------------------------------------------------------
// Circuit input (metering_v2 format)
// Constraint: minUsageBucket <= usage <= maxUsageBucket
// ---------------------------------------------------------------------------

const circuitInput = {
  // Private signals
  userId:   '42',      // userId hash (bigint-serialized)
  usage:    '750',     // CU consumed (within [500, 1000] bucket)
  nonce:    '1',       // anti-replay nonce
  // Public signals
  epoch:          '1',    // billing epoch
  minUsageBucket: '500',  // bucket lower bound (public — hides exact usage)
  maxUsageBucket: '1000', // bucket upper bound (public)
};

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

function check(p: string, label: string): void {
  if (!fs.existsSync(p)) {
    console.error(`[rb032] MISSING ${label}: ${p}`);
    process.exit(1);
  }
  const size = fs.statSync(p).size;
  console.log(`[rb032] ${label}: ${p} (${(size / 1024).toFixed(1)} KB)`);
}

console.log('[rb032] === RB-032 PoC: metering_v2 proof generation ===');
check(WASM_PATH, 'WASM');
check(ZKEY_PATH, 'ZKEY (MPC)');
check(VKEY_PATH, 'VKEY (MPC)');

// ---------------------------------------------------------------------------
// Generate proof
// ---------------------------------------------------------------------------

console.log('\n[rb032] Input:', circuitInput);
console.log('[rb032] Generating Groth16 proof (metering_v2 + MPC zkey)...');

const t0 = Date.now();
const { proof, publicSignals } = await groth16.fullProve(circuitInput, WASM_PATH, ZKEY_PATH);
const proveMs = Date.now() - t0;

console.log(`[rb032] fullProve done in ${proveMs}ms`);
console.log('[rb032] publicSignals:', publicSignals);

// pubSignals order (CLAUDE.md §8 — metering_v2):
//   [0] commitment (Poseidon OUTPUT)
//   [1] epoch
//   [2] minUsageBucket
//   [3] maxUsageBucket
if (publicSignals.length !== 4) {
  console.error(`[rb032] ERROR: expected 4 pubSignals, got ${publicSignals.length}`);
  process.exit(1);
}
console.log('[rb032] pubSignals[0] = commitment:', publicSignals[0]);
console.log('[rb032] pubSignals[1] = epoch:     ', publicSignals[1], '(expected:', circuitInput.epoch, ')');
console.log('[rb032] pubSignals[2] = minBucket: ', publicSignals[2], '(expected:', circuitInput.minUsageBucket, ')');
console.log('[rb032] pubSignals[3] = maxBucket: ', publicSignals[3], '(expected:', circuitInput.maxUsageBucket, ')');

// Sanity checks
if (publicSignals[1] !== circuitInput.epoch) {
  console.error('[rb032] ERROR: epoch mismatch in pubSignals');
  process.exit(1);
}
if (publicSignals[2] !== circuitInput.minUsageBucket) {
  console.error('[rb032] ERROR: minUsageBucket mismatch in pubSignals');
  process.exit(1);
}
if (publicSignals[3] !== circuitInput.maxUsageBucket) {
  console.error('[rb032] ERROR: maxUsageBucket mismatch in pubSignals');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Verify locally
// ---------------------------------------------------------------------------

console.log('\n[rb032] Verifying proof locally (vkey MPC)...');
const vKey = JSON.parse(fs.readFileSync(VKEY_PATH, 'utf8'));
const tv0 = Date.now();
const valid = await groth16.verify(vKey, publicSignals, proof);
const verifyMs = Date.now() - tv0;

console.log(`[rb032] verify done in ${verifyMs}ms — valid=${valid}`);
if (!valid) {
  console.error('[rb032] ERROR: proof verification FAILED');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Write artifacts
// ---------------------------------------------------------------------------

const params = {
  timestamp: new Date().toISOString(),
  circuit: 'metering_v2',
  zkeyPath: ZKEY_PATH,
  vkeyPath: VKEY_PATH,
  wasmPath: WASM_PATH,
  input: circuitInput,
  proveMs,
  verifyMs,
  valid,
  pubSignalsMap: {
    commitment:     publicSignals[0],
    epoch:          publicSignals[1],
    minUsageBucket: publicSignals[2],
    maxUsageBucket: publicSignals[3],
  },
};

fs.writeFileSync(path.join(outDir, 'proof.json'),   JSON.stringify(proof, null, 2));
fs.writeFileSync(path.join(outDir, 'public.json'),  JSON.stringify(publicSignals, null, 2));
fs.writeFileSync(path.join(outDir, 'params.json'),  JSON.stringify(params, null, 2));
fs.writeFileSync(path.join(outDir, 'verify.json'),  JSON.stringify({ valid, verifyMs }, null, 2));

console.log(`\n[rb032] Artifacts written to: ${outDir}`);
console.log('[rb032] ✅ PASS — metering_v2 proof generated and verified');
console.log(`[rb032]   proveMs:  ${proveMs}ms`);
console.log(`[rb032]   verifyMs: ${verifyMs}ms`);
console.log(`[rb032]   commitment (pubSignals[0]): ${publicSignals[0]}`);
