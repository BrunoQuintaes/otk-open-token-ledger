/**
 * Measures how long one Groth16 proof of the metering_v1 circuit takes to generate (5 runs, snarkjs fullProve).
 *
 * Reads the compiled circuit (`zk/build/metering_v1_js/metering_v1.wasm`), the final proving key
 * (`zk/build/metering_v1_final.zkey`) and an input (`zk/build/metering_input.json`); build them first with
 * `scripts/zk/zk_build.sh` and the setup scripts. Prints each run and the mean, min, max, standard deviation (ms)
 * and coefficient of variation to stdout; writes nothing. The platform line it prints is a fixed text, not detected.
 * Paths come from `URL.pathname`, which on Windows starts with a slash before the drive letter.
 *
 * Usage: `node scripts/benchmark/measure_zk_prove_time.mjs`. No arguments, no environment variables, no network.
 *
 * @module scripts/benchmark/measure_zk_prove_time
 */
import { readFileSync } from 'fs';
import { groth16 } from 'snarkjs';

const wasmPath = new URL('../../zk/build/metering_v1_js/metering_v1.wasm', import.meta.url).pathname;
const zkeyPath = new URL('../../zk/build/metering_v1_final.zkey', import.meta.url).pathname;
const inputPath = new URL('../../zk/build/metering_input.json', import.meta.url).pathname;

const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const N = 5;
const times = [];

console.log('ZK Proof Generation Time Measurement');
console.log('Circuit: metering_v1.circom (~240 constraints, Groth16/BN254)');
console.log('Platform: Windows 11, Node.js v24.13.0');
console.log('Input:', input);
console.log(`\nRunning ${N} proof generations...`);

for (let i = 0; i < N; i++) {
  const t0 = performance.now();
  const { proof, publicSignals } = await groth16.fullProve(input, wasmPath, zkeyPath);
  const t1 = performance.now();
  const ms = t1 - t0;
  times.push(ms);
  console.log(`  Run ${i+1}: ${ms.toFixed(0)} ms`);
}

const avg = times.reduce((a, b) => a + b, 0) / N;
const min = Math.min(...times);
const max = Math.max(...times);
const variance = times.reduce((acc, t) => acc + (t - avg) ** 2, 0) / N;
const stdDev = Math.sqrt(variance);
const cv = (stdDev / avg * 100);

console.log(`\nResults (N=${N}):`);
console.log(`  avg:    ${avg.toFixed(0)} ms  (${(avg/1000).toFixed(2)} s)`);
console.log(`  min:    ${min.toFixed(0)} ms`);
console.log(`  max:    ${max.toFixed(0)} ms`);
console.log(`  stdDev: ${stdDev.toFixed(0)} ms`);
console.log(`  CV:     ${cv.toFixed(1)}%`);
