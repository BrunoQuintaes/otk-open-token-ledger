/**
 * U9 — Benchmark Harness
 *
 * Measures throughput and latency of the OTK metering pipeline components:
 *   1. CU computation (computeCostUnits)
 *   2. Canonical hash (keccak256)
 *   3. EIP-191 signing (signMessage)
 *   4. Full pipeline (CU + hash + sign)
 *
 * Workloads: N=100, 500, 1000 receipts
 * Output: JSON + CSV reports in docs/_ops/u9/
 *
 * Known on-chain gas from U8.5.4:
 *   submitReceipt (Groth16): 290,620 gas
 *
 * Usage:
 *   npx ts-node --esm scripts/benchmark/u9_benchmark_harness.ts
 *   # OR via npm script: npm run benchmark
 *
 * `npm run benchmark` runs it with tsx. Results go to a new `docs/_ops/u9/U9_BENCHMARK_<timestamp>/` folder (one JSON
 * and one CSV). Signing uses a test signer (no real key); no network; no environment variables. Exit code 1 on any
 * error.
 *
 * @module scripts/benchmark/u9_benchmark_harness
 * @since U9.1
 */

import { computeCostUnits, type CUInput } from '../../src/economics/CUEngine.js';
import { createTestSigner, sign as smSign } from '../../src/metering/SignatureManager.js';
import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SAMPLE_INPUTS: CUInput[] = [
  { provider: 'openai',     model: 'gpt-4o',          inputTokens: 1000, outputTokens: 500  },
  { provider: 'openai',     model: 'gpt-3.5-turbo',   inputTokens: 800,  outputTokens: 300  },
  { provider: 'anthropic',  model: 'claude-3-opus',   inputTokens: 2000, outputTokens: 1000 },
  { provider: 'anthropic',  model: 'claude-3-haiku',  inputTokens: 500,  outputTokens: 200  },
  { provider: 'deepseek',   model: 'deepseek-chat',   inputTokens: 1500, outputTokens: 700  },
];

// ---------------------------------------------------------------------------
// Timer utilities
// ---------------------------------------------------------------------------

function hrMs(): number {
  const [s, ns] = process.hrtime();
  return s * 1e3 + ns / 1e6;
}

interface BenchResult {
  name: string;
  n: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  throughputPerSec: number;
  samples: number[];
}

function bench(name: string, n: number, fn: (i: number) => void): BenchResult {
  // Warmup (10% of N, min 5)
  const warmup = Math.max(5, Math.floor(n * 0.1));
  for (let i = 0; i < warmup; i++) fn(i);

  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = hrMs();
    fn(i);
    samples.push(hrMs() - t0);
  }

  const totalMs = samples.reduce((a, b) => a + b, 0);
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    name,
    n,
    totalMs: Math.round(totalMs * 100) / 100,
    avgMs: Math.round((totalMs / n) * 10000) / 10000,
    minMs: Math.round(sorted[0] * 10000) / 10000,
    maxMs: Math.round(sorted[sorted.length - 1] * 10000) / 10000,
    throughputPerSec: Math.round(n / (totalMs / 1000)),
    samples,
  };
}

async function benchAsync(
  name: string,
  n: number,
  fn: (i: number) => Promise<void>
): Promise<BenchResult> {
  const warmup = Math.max(5, Math.floor(n * 0.1));
  for (let i = 0; i < warmup; i++) await fn(i);

  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = hrMs();
    await fn(i);
    samples.push(hrMs() - t0);
  }

  const totalMs = samples.reduce((a, b) => a + b, 0);
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    name,
    n,
    totalMs: Math.round(totalMs * 100) / 100,
    avgMs: Math.round((totalMs / n) * 10000) / 10000,
    minMs: Math.round(sorted[0] * 10000) / 10000,
    maxMs: Math.round(sorted[sorted.length - 1] * 10000) / 10000,
    throughputPerSec: Math.round(n / (totalMs / 1000)),
    samples,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(REPO_ROOT, 'docs', '_ops', 'u9', `U9_BENCHMARK_${ts}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('='.repeat(60));
  console.log('U9 — Benchmark Harness (OTK zk-Metering)');
  console.log('='.repeat(60));
  console.log(`Output: ${outDir}`);
  console.log('');

  const workloads = [100, 500, 1000];
  const allResults: Record<string, BenchResult[]> = {};

  // Deterministic test signer
  const signer = createTestSigner('u9-benchmark');

  for (const n of workloads) {
    console.log(`\n--- Workload N=${n} ---`);
    const results: BenchResult[] = [];

    // 1. CU computation
    const cuResult = bench(`CU computation`, n, (i) => {
      const input = SAMPLE_INPUTS[i % SAMPLE_INPUTS.length];
      computeCostUnits(input);
    });
    results.push(cuResult);
    console.log(`  CU:     avg=${cuResult.avgMs}ms  thr=${cuResult.throughputPerSec}/s`);

    // 2. Canonical hash (keccak256 of receipt fields)
    const hashResult = bench(`Canonical hash`, n, (i) => {
      const s = `costUnits\n${BigInt(i + 1)}\nepoch\n1\nnonce\n${BigInt(i)}\nuserId\n${BigInt(12345678 + i)}\n`;
      ethers.keccak256(ethers.toUtf8Bytes(s));
    });
    results.push(hashResult);
    console.log(`  Hash:   avg=${hashResult.avgMs}ms  thr=${hashResult.throughputPerSec}/s`);

    // 3. EIP-191 sign
    const signResult = await benchAsync(`EIP-191 sign`, n, async (i) => {
      const hash = ethers.keccak256(ethers.toUtf8Bytes(`test-${i}`));
      await signer.signMessage(ethers.getBytes(hash));
    });
    results.push(signResult);
    console.log(`  Sign:   avg=${signResult.avgMs}ms  thr=${signResult.throughputPerSec}/s`);

    // 4. Full pipeline: CU + hash + sign
    const pipelineResult = await benchAsync(`Full pipeline`, n, async (i) => {
      const input = SAMPLE_INPUTS[i % SAMPLE_INPUTS.length];
      const cu = computeCostUnits(input);
      const s = `costUnits\n${cu}\nepoch\n1\nnonce\n${BigInt(i)}\nuserId\n${BigInt(12345678 + i)}\n`;
      const hash = ethers.keccak256(ethers.toUtf8Bytes(s));
      await signer.signMessage(ethers.getBytes(hash));
    });
    results.push(pipelineResult);
    console.log(`  Pipeline: avg=${pipelineResult.avgMs}ms  thr=${pipelineResult.throughputPerSec}/s`);

    allResults[`N=${n}`] = results;
  }

  // ---------------------------------------------------------------------------
  // Known on-chain data (from U8.5.4)
  // ---------------------------------------------------------------------------
  const onChain = {
    submitReceipt_groth16_gasUsed: 290620,
    network: 'Besu IBFT (chainId=1337, Berlin)',
    txHash: '0xde2d7f42fdbdf4dab860753e063986ee5047e0cf7e2c15b7f132d41c810c6945',
    blockNumber: 432,
    note: 'Single measurement from U8.5.4 E2E run',
  };

  // ---------------------------------------------------------------------------
  // Summary table
  // ---------------------------------------------------------------------------
  console.log('\n' + '='.repeat(60));
  console.log('SUMMARY TABLE');
  console.log('='.repeat(60));
  console.log('Component        | N=100 thr/s | N=500 thr/s | N=1000 thr/s');
  console.log('-'.repeat(60));

  const components = ['CU computation', 'Canonical hash', 'EIP-191 sign', 'Full pipeline'];
  for (const comp of components) {
    const r100 = allResults['N=100']?.find(r => r.name === comp);
    const r500 = allResults['N=500']?.find(r => r.name === comp);
    const r1000 = allResults['N=1000']?.find(r => r.name === comp);
    const pad = (s: string, n: number) => s.padEnd(n);
    console.log(
      `${pad(comp, 16)} | ${pad(String(r100?.throughputPerSec ?? '-'), 11)} | ` +
      `${pad(String(r500?.throughputPerSec ?? '-'), 11)} | ${r1000?.throughputPerSec ?? '-'}`
    );
  }

  console.log('\nOn-chain (Groth16):');
  console.log(`  gasUsed: ${onChain.submitReceipt_groth16_gasUsed} (from U8.5.4)`);

  // ---------------------------------------------------------------------------
  // Write JSON report
  // ---------------------------------------------------------------------------
  const jsonReport = {
    timestamp: new Date().toISOString(),
    phase: 'U9.1',
    platform: process.platform,
    nodeVersion: process.version,
    workloads: allResults,
    onChain,
  };

  const jsonPath = path.join(outDir, 'benchmark_results.json');
  fs.writeFileSync(jsonPath, JSON.stringify(jsonReport, (_, v) =>
    typeof v === 'bigint' ? v.toString() : v, 2));

  // ---------------------------------------------------------------------------
  // Write CSV report
  // ---------------------------------------------------------------------------
  const csvLines = ['component,N,totalMs,avgMs,minMs,maxMs,throughputPerSec'];
  for (const [label, results] of Object.entries(allResults)) {
    const n = parseInt(label.replace('N=', ''));
    for (const r of results) {
      csvLines.push(`"${r.name}",${n},${r.totalMs},${r.avgMs},${r.minMs},${r.maxMs},${r.throughputPerSec}`);
    }
  }

  const csvPath = path.join(outDir, 'benchmark_results.csv');
  fs.writeFileSync(csvPath, csvLines.join('\n'));

  console.log(`\nJSON: ${jsonPath}`);
  console.log(`CSV:  ${csvPath}`);
  console.log('\n✅ U9 Benchmark complete');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
