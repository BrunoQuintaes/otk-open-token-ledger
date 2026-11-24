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
