/**
 * Gas Sensitivity Analysis
 *
 * Computes OTK settlement cost (USD) across gas price scenarios.
 * Addresses Study Design Reviewer §5: economic validation of CUEngine.
 *
 * Usage:
 *   npx tsx scripts/audit/gas_sensitivity.ts
 *
 * Output: JSON table to stdout + docs/_ops/audit/GAS_SENSITIVITY_<TS>/
 *
 * Pure arithmetic over fixed constants (gas per receipt measured for a Groth16 proof verification, an estimated
 * batch overhead, block gas limit and block time of the test chain) crossed with gas-price, ETH-price and batch-size
 * scenarios; the target is a settlement cost under US$ 0.01 per receipt. The folder holds `report.json`,
 * `cost_matrix.csv` and `throughput.csv`; a failure to write it is only a warning. Highlights go to stderr. It does
 * not query any chain or price feed, takes no arguments and reads no environment variables.
 *
 * @module scripts/audit/gas_sensitivity
 */

import { writeFileSync, mkdirSync } from 'fs';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GAS_PER_RECEIPT_GROTH16 = 290_620;      // measured in U8.5.4
const GAS_PER_BATCH_OVERHEAD = 80_000;         // BatchReceiptRegistry.submitBatch estimate
const GAS_BLOCK_LIMIT = 12_000_000;            // IBFT config
const BLOCK_TIME_S = 4;                        // observed empirically (U10.3)

// Gas price scenarios (gwei)
const GAS_PRICE_SCENARIOS_GWEI = [5, 10, 20, 30, 50, 100, 200];

// ETH price scenarios (USD)
const ETH_PRICE_SCENARIOS_USD = [2000, 2500, 3000, 3500, 4000, 5000];

// Batch sizes for amortization analysis
const BATCH_SIZES = [1, 10, 50, 100, 500, 1000];

// ---------------------------------------------------------------------------
// Calculations
// ---------------------------------------------------------------------------

interface ThroughputMetrics {
  receiptsPerBlock: number;
  receiptsPerSecond: number;
  gasCostPerReceiptGwei: number;
}

interface CostRow {
  gasPriceGwei: number;
  ethPriceUsd: number;
  batchSize: number;
  gasCostPerReceiptGwei: number;
  costPerReceiptUsd: string;
  costPerReceiptCents: string;
  meetsTarget: boolean;  // target: < $0.01
}

function calcReceiptCost(
  gasPriceGwei: number,
  ethPriceUsd: number,
  batchSize: number
): { gwei: number; usd: number } {
  let gasPerReceipt: number;
  if (batchSize === 1) {
    // Individual Groth16
    gasPerReceipt = GAS_PER_RECEIPT_GROTH16;
  } else {
    // Batch: amortize overhead over N receipts
    // Total gas = overhead + N × (storage + event ~15K)
    const gasPerReceiptOnChain = 15_000; // storage + event per receipt in batch
    gasPerReceipt = Math.ceil(GAS_PER_BATCH_OVERHEAD / batchSize) + gasPerReceiptOnChain;
  }

  const gasPriceWei = gasPriceGwei * 1e9;
  const costEth = (gasPerReceipt * gasPriceWei) / 1e18;
  const costUsd = costEth * ethPriceUsd;
  const gweiTotal = gasPerReceipt * gasPriceGwei;

  return { gwei: gweiTotal, usd: costUsd };
}

function calcThroughput(batchSize: number): ThroughputMetrics {
  let receiptsPerBlock: number;
  let gasCostPerReceiptGwei: number;

  if (batchSize === 1) {
    receiptsPerBlock = Math.floor(GAS_BLOCK_LIMIT / GAS_PER_RECEIPT_GROTH16);
    gasCostPerReceiptGwei = GAS_PER_RECEIPT_GROTH16;
  } else {
    const totalGasBatch = GAS_PER_BATCH_OVERHEAD + batchSize * 15_000;
    const batchesPerBlock = Math.floor(GAS_BLOCK_LIMIT / totalGasBatch);
    receiptsPerBlock = batchesPerBlock * batchSize;
    gasCostPerReceiptGwei = Math.ceil(totalGasBatch / batchSize);
  }

  return {
    receiptsPerBlock,
    receiptsPerSecond: Math.floor(receiptsPerBlock / BLOCK_TIME_S),
    gasCostPerReceiptGwei,
  };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

interface Report {
  meta: {
    timestamp: string;
    gasPerReceiptGroth16: number;
    gasPerBatchOverhead: number;
    gasBlockLimit: number;
    blockTimeS: number;
    targetCostPerReceiptUsd: number;
  };
  throughput: Array<{
    batchSize: number;
    receiptsPerBlock: number;
    receiptsPerSecond: number;
    gasCostPerReceiptGwei: number;
    gasReductionVsUnit: string;
  }>;
  costMatrix: {
    headers: string[];
    rows: string[][];
    notes: string[];
  };
  scenarioHighlights: Array<{
    scenario: string;
    batchSize: number;
    gasPriceGwei: number;
    ethPriceUsd: number;
    costPerReceiptUsd: string;
    meetsTarget: boolean;
  }>;
}

function generateReport(): Report {
  // Throughput table
  const throughput = BATCH_SIZES.map(batchSize => {
    const t = calcThroughput(batchSize);
    const unit = calcThroughput(1);
    const reduction = (1 - t.gasCostPerReceiptGwei / unit.gasCostPerReceiptGwei) * 100;
    return {
      batchSize,
      ...t,
      gasReductionVsUnit: batchSize === 1 ? '0%' : `${reduction.toFixed(1)}%`,
    };
  });

  // Cost matrix: gas price rows × batch size columns (ETH=$3500 fixed)
  const ETH_FIXED = 3500;
  const headers = ['Gas (gwei)', ...BATCH_SIZES.map(b => `N=${b}`)];
  const rows = GAS_PRICE_SCENARIOS_GWEI.map(gwei => {
    const row = [gwei.toString()];
    for (const batchSize of BATCH_SIZES) {
      const { usd } = calcReceiptCost(gwei, ETH_FIXED, batchSize);
      const meets = usd < 0.01;
      const cell = `$${usd.toFixed(5)}${meets ? '' : '⚠'}`;
      row.push(cell);
    }
    return row;
  });

  // Scenario highlights (user-facing)
  const highlights = [
    // Baseline: individual Groth16
    { label: 'Individual Groth16 (v1)', batchSize: 1, gasPriceGwei: 30, ethPriceUsd: 3500 },
    // Batch=100: target scenario
    { label: 'Batch N=100 (v2 target)', batchSize: 100, gasPriceGwei: 30, ethPriceUsd: 3500 },
    // High gas: stress test
    { label: 'High gas stress (N=1)', batchSize: 1, gasPriceGwei: 100, ethPriceUsd: 5000 },
    // High gas batch: stress test
    { label: 'High gas stress (N=100)', batchSize: 100, gasPriceGwei: 100, ethPriceUsd: 5000 },
    // Low gas: optimistic
    { label: 'Low gas optimistic (N=1)', batchSize: 1, gasPriceGwei: 5, ethPriceUsd: 2000 },
  ].map(s => {
    const { usd } = calcReceiptCost(s.gasPriceGwei, s.ethPriceUsd, s.batchSize);
    return {
      scenario: s.label,
      batchSize: s.batchSize,
      gasPriceGwei: s.gasPriceGwei,
      ethPriceUsd: s.ethPriceUsd,
      costPerReceiptUsd: `$${usd.toFixed(5)}`,
      meetsTarget: usd < 0.01,
    };
  });

  return {
    meta: {
      timestamp: new Date().toISOString(),
      gasPerReceiptGroth16: GAS_PER_RECEIPT_GROTH16,
      gasPerBatchOverhead: GAS_PER_BATCH_OVERHEAD,
      gasBlockLimit: GAS_BLOCK_LIMIT,
      blockTimeS: BLOCK_TIME_S,
      targetCostPerReceiptUsd: 0.01,
    },
    throughput,
    costMatrix: {
      headers,
      rows,
      notes: [
        `ETH price fixed at $${ETH_FIXED} for matrix.`,
        '⚠ = exceeds target of $0.01/receipt.',
        'Batch gas model: overhead=80K + 15K/receipt (on-chain storage+event).',
        'Groth16 individual: 290,620 gas (measured U8.5.4).',
        'Block time: 4s (observed U10.3 empirically).',
      ],
    },
    scenarioHighlights: highlights,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const report = generateReport();

// Write EVD
const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const evdDir = `docs/_ops/audit/GAS_SENSITIVITY_${ts}`;
try {
  mkdirSync(evdDir, { recursive: true });
  writeFileSync(`${evdDir}/report.json`, JSON.stringify(report, null, 2));

  // Human-readable CSV: cost matrix
  const csvLines = [report.costMatrix.headers.join(',')];
  for (const row of report.costMatrix.rows) {
    csvLines.push(row.map(c => `"${c}"`).join(','));
  }
  writeFileSync(`${evdDir}/cost_matrix.csv`, csvLines.join('\n'));

  // Throughput CSV
  const tpHeader = 'batchSize,receiptsPerBlock,receiptsPerSecond,gasCostPerReceiptGwei,gasReductionVsUnit';
  const tpRows = report.throughput.map(r =>
    `${r.batchSize},${r.receiptsPerBlock},${r.receiptsPerSecond},${r.gasCostPerReceiptGwei},${r.gasReductionVsUnit}`
  );
  writeFileSync(`${evdDir}/throughput.csv`, [tpHeader, ...tpRows].join('\n'));

  console.error(`[gas-sensitivity] EVD written to ${evdDir}/`);
} catch (e) {
  console.error(`[gas-sensitivity] Warning: could not write EVD: ${e}`);
}

// Print full report
console.log(JSON.stringify(report, null, 2));

// Print highlights to stderr
console.error('\n=== Scenario Highlights ===');
for (const h of report.scenarioHighlights) {
  const status = h.meetsTarget ? '✅' : '❌';
  console.error(`${status} ${h.scenario}: ${h.costPerReceiptUsd}/receipt`);
}

console.error('\n=== Throughput by Batch Size ===');
for (const t of report.throughput) {
  console.error(
    `N=${t.batchSize}: ${t.receiptsPerBlock} receipts/block | ` +
    `${t.receiptsPerSecond} receipts/s | ` +
    `gas reduction: ${t.gasReductionVsUnit}`
  );
}
