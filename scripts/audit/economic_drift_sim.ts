/**
 * Economic Drift Simulator — Monte Carlo
 *
 * Compares CU computed in BigInt (OTK deterministic) vs IEEE 754 float reference
 * to quantify cumulative arithmetic error over large transaction volumes.
 *
 * Addresses Reproducibility Reviewer §6 and ADR-0103.
 *
 * Usage:
 *   npx tsx scripts/audit/economic_drift_sim.ts [--N=100000] [--seed=42]
 *
 * Output:
 *   JSON + CSV report to stdout + docs/_ops/audit/DRIFT_SIM_<TS>/
 */

import { writeFileSync, mkdirSync } from 'fs';
import { PROVIDER_WEIGHTS_INT, MODEL_WEIGHTS_INT } from '../../src/pricing/CostUnits.js';

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, v] = a.slice(2).split('=');
      return [k, v ?? 'true'];
    })
);

const N = parseInt(args['N'] ?? '100000', 10);
const SEED = parseInt(args['seed'] ?? '42', 10);
const THRESHOLD_PCT = parseFloat(args['threshold'] ?? '0.1'); // 0.1% acceptable drift

// ---------------------------------------------------------------------------
// Deterministic PRNG (SFC32 — period 2^128)
// Produces identical sequences across platforms given the same seed.
// ---------------------------------------------------------------------------

function makeSFC32(seed: number) {
  let a = seed | 0, b = seed | 0, c = seed | 0, d = 1;
  return function (): number {
    a |= 0; b |= 0; c |= 0; d |= 0;
    let t = (a + b | 0) + d | 0;
    d = d + 1 | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = (c << 21 | c >>> 11);
    c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Float reference: mirrors CostUnits.ts formula but with IEEE 754
// ---------------------------------------------------------------------------

const PROVIDER_WEIGHTS_FLOAT: Record<string, number> = Object.fromEntries(
  Object.entries(PROVIDER_WEIGHTS_INT).map(([k, v]) => [k, Number(v) / 1000])
);

const MODEL_WEIGHTS_FLOAT: Record<string, number> = Object.fromEntries(
  Object.entries(MODEL_WEIGHTS_INT).map(([k, v]) => [k, Number(v) / 1000])
);

function cuFloat(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const wp = PROVIDER_WEIGHTS_FLOAT[provider] ?? 1.0;
  const wm = MODEL_WEIGHTS_FLOAT[model] ?? 1.0;
  return Math.round((inputTokens + outputTokens) * wp * wm);
}

// ---------------------------------------------------------------------------
// BigInt reference: mirrors CostUnits.ts (deterministic)
// ---------------------------------------------------------------------------

const WEIGHT_SCALE = 1000n;

function cuBigInt(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): bigint {
  const wp = PROVIDER_WEIGHTS_INT[provider] ?? 1000n;
  const wm = MODEL_WEIGHTS_INT[model] ?? 1000n;
  const total = BigInt(inputTokens + outputTokens);
  // CU = floor( total * wp * wm / WEIGHT_SCALE^2 + 0.5 )
  const scaled = total * wp * wm;
  const divisor = WEIGHT_SCALE * WEIGHT_SCALE;
  return (scaled + divisor / 2n) / divisor;
}

// ---------------------------------------------------------------------------
// Sampling distributions
// ---------------------------------------------------------------------------

const PROVIDERS = ['openai', 'anthropic', 'deepseek', 'gemini'] as const;
const MODELS: Record<string, string[]> = {
  openai: ['gpt-4o', 'gpt-4-turbo', 'gpt-3.5-turbo'],
  anthropic: ['claude-sonnet-4', 'claude-opus-4', 'claude-haiku-4'],
  deepseek: ['deepseek-chat', 'deepseek-coder'],
  gemini: ['gemini-2.0-flash', 'gemini-pro'],
};

// Provider distribution: openai=50%, anthropic=30%, deepseek=12%, gemini=8%
const PROVIDER_CDF = [0.50, 0.80, 0.92, 1.00];

function sampleProvider(rng: () => number): string {
  const r = rng();
  if (r < PROVIDER_CDF[0]) return PROVIDERS[0];
  if (r < PROVIDER_CDF[1]) return PROVIDERS[1];
  if (r < PROVIDER_CDF[2]) return PROVIDERS[2];
  return PROVIDERS[3];
}

function sampleModel(provider: string, rng: () => number): string {
  const list = MODELS[provider];
  return list[Math.floor(rng() * list.length)];
}

// Tokens: log-normal-like via exponential + uniform
function sampleTokens(rng: () => number): { input: number; output: number } {
  // Input: concentrated in 100-5000 range
  const input = Math.max(10, Math.floor(100 + rng() * 4900));
  // Output: concentrated in 50-2000 range
  const output = Math.max(5, Math.floor(50 + rng() * 1950));
  return { input, output };
}

// ---------------------------------------------------------------------------
// Monte Carlo simulation
// ---------------------------------------------------------------------------

interface DriftStats {
  N: number;
  seed: number;
  thresholdPct: number;
  // Totals
  totalCUBigInt: bigint;
  totalCUFloat: bigint;  // rounded float sum as bigint
  cumulativeDrift: bigint;
  // Per-transaction
  maxDriftPerTx: number;
  driftPerTxSum: number;
  driftPerTxSq: number;
  txsWithDrift: number;
  // Percentiles (stored as sorted array of drift values — sampled 1/100)
  driftSample: number[];
}

function runSimulation(): DriftStats {
  const rng = makeSFC32(SEED);
  const stats: DriftStats = {
    N,
    seed: SEED,
    thresholdPct: THRESHOLD_PCT,
    totalCUBigInt: 0n,
    totalCUFloat: 0n,
    cumulativeDrift: 0n,
    maxDriftPerTx: 0,
    driftPerTxSum: 0,
    driftPerTxSq: 0,
    txsWithDrift: 0,
    driftSample: [],
  };

  for (let i = 0; i < N; i++) {
    const provider = sampleProvider(rng);
    const model = sampleModel(provider, rng);
    const { input, output } = sampleTokens(rng);

    const cuBig = cuBigInt(provider, model, input, output);
    const cuFlt = cuFloat(provider, model, input, output);
    const cuFltBig = BigInt(cuFlt);

    const drift = cuBig > cuFltBig ? Number(cuBig - cuFltBig) : Number(cuFltBig - cuBig);

    stats.totalCUBigInt += cuBig;
    stats.totalCUFloat += cuFltBig;
    stats.cumulativeDrift += BigInt(drift);

    if (drift > stats.maxDriftPerTx) stats.maxDriftPerTx = drift;
    if (drift > 0) stats.txsWithDrift++;

    stats.driftPerTxSum += drift;
    stats.driftPerTxSq += drift * drift;

    // Sample 1% of transactions for percentile computation
    if (i % 100 === 0) stats.driftSample.push(drift);
  }

  return stats;
}

function percentile(sorted: number[], p: number): number {
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

interface Report {
  simulation: {
    N: number;
    seed: number;
    thresholdPct: number;
    timestamp: string;
  };
  results: {
    totalCUBigInt: string;
    totalCUFloat: string;
    cumulativeDrift: string;
    cumulativeDriftPct: string;
    avgDriftPerTx: string;
    stdDriftPerTx: string;
    maxDriftPerTx: number;
    txsWithDrift: number;
    txsWithDriftPct: string;
    p50Drift: number;
    p95Drift: number;
    p99Drift: number;
  };
  verdict: {
    pass: boolean;
    actualDriftPct: string;
    thresholdPct: number;
    message: string;
  };
}

function generateReport(stats: DriftStats): Report {
  const driftSorted = [...stats.driftSample].sort((a, b) => a - b);
  const mean = stats.driftPerTxSum / stats.N;
  const variance = stats.driftPerTxSq / stats.N - mean * mean;
  const std = Math.sqrt(Math.max(0, variance));
  const totalCUFloat = stats.totalCUFloat;
  const driftPct = totalCUFloat > 0n
    ? (Number(stats.cumulativeDrift) / Number(totalCUFloat)) * 100
    : 0;
  const txsWithDriftPct = (stats.txsWithDrift / stats.N) * 100;

  const pass = driftPct <= THRESHOLD_PCT;

  return {
    simulation: {
      N: stats.N,
      seed: stats.seed,
      thresholdPct: stats.thresholdPct,
      timestamp: new Date().toISOString(),
    },
    results: {
      totalCUBigInt: stats.totalCUBigInt.toString(),
      totalCUFloat: stats.totalCUFloat.toString(),
      cumulativeDrift: stats.cumulativeDrift.toString(),
      cumulativeDriftPct: driftPct.toFixed(6) + '%',
      avgDriftPerTx: mean.toFixed(4),
      stdDriftPerTx: std.toFixed(4),
      maxDriftPerTx: stats.maxDriftPerTx,
      txsWithDrift: stats.txsWithDrift,
      txsWithDriftPct: txsWithDriftPct.toFixed(2) + '%',
      p50Drift: percentile(driftSorted, 50),
      p95Drift: percentile(driftSorted, 95),
      p99Drift: percentile(driftSorted, 99),
    },
    verdict: {
      pass,
      actualDriftPct: driftPct.toFixed(6) + '%',
      thresholdPct: THRESHOLD_PCT,
      message: pass
        ? `PASS — cumulative drift ${driftPct.toFixed(6)}% < threshold ${THRESHOLD_PCT}%`
        : `FAIL — cumulative drift ${driftPct.toFixed(6)}% exceeds threshold ${THRESHOLD_PCT}%`,
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

console.error(`[drift-sim] Running N=${N.toLocaleString()} transactions, seed=${SEED}...`);
const t0 = performance.now();
const stats = runSimulation();
const elapsed = ((performance.now() - t0) / 1000).toFixed(2);
console.error(`[drift-sim] Done in ${elapsed}s`);

const report = generateReport(stats);

// Write EVD
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const evdDir = `docs/_ops/audit/DRIFT_SIM_${ts}`;
try {
  mkdirSync(evdDir, { recursive: true });
  writeFileSync(`${evdDir}/report.json`, JSON.stringify(report, null, 2));
  // CSV
  const csv = [
    'metric,value',
    `N,${report.simulation.N}`,
    `seed,${report.simulation.seed}`,
    `totalCUBigInt,${report.results.totalCUBigInt}`,
    `totalCUFloat,${report.results.totalCUFloat}`,
    `cumulativeDrift,${report.results.cumulativeDrift}`,
    `cumulativeDriftPct,${report.results.cumulativeDriftPct}`,
    `avgDriftPerTx,${report.results.avgDriftPerTx}`,
    `stdDriftPerTx,${report.results.stdDriftPerTx}`,
    `maxDriftPerTx,${report.results.maxDriftPerTx}`,
    `txsWithDrift,${report.results.txsWithDrift}`,
    `txsWithDriftPct,${report.results.txsWithDriftPct}`,
    `p50Drift,${report.results.p50Drift}`,
    `p95Drift,${report.results.p95Drift}`,
    `p99Drift,${report.results.p99Drift}`,
    `verdict,${report.verdict.pass ? 'PASS' : 'FAIL'}`,
  ].join('\n');
  writeFileSync(`${evdDir}/report.csv`, csv);
  console.error(`[drift-sim] EVD written to ${evdDir}/`);
} catch (e) {
  console.error(`[drift-sim] Warning: could not write EVD: ${e}`);
}

// Print report to stdout
console.log(JSON.stringify(report, null, 2));

// Exit code: 0=PASS, 1=FAIL
process.exit(report.verdict.pass ? 0 : 1);
