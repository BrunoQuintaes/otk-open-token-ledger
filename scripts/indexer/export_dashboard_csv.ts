/**
 * export_dashboard_csv.ts — Export indexed receipts to standardized CSV
 *
 * Reads the JSONL indexer output and emits a CSV suitable for:
 *   - Dashboard consumption (Grafana Infinity plugin)
 *   - Spreadsheet analysis
 *   - LaTeX table generation
 *
 * Usage:
 *   npx tsx scripts/indexer/export_dashboard_csv.ts [INPUT_JSONL] [OUTPUT_CSV]
 *
 * @module export_dashboard_csv
 * @since U10.2
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IndexedReceipt } from './receipt_indexer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

const INPUT_JSONL  = process.argv[2] ?? path.join(REPO_ROOT, 'docs/_ops/indexer/receipts.jsonl');
const OUTPUT_CSV   = process.argv[3] ?? path.join(REPO_ROOT, 'docs/_ops/indexer/receipts_dashboard.csv');

const CSV_HEADER = 'blockNumber,blockTimestamp,txHash,commitment,userId,costUnits,epoch,submitter,indexedAt';

function toCsvRow(r: IndexedReceipt): string {
  return [
    r.blockNumber,
    r.blockTimestamp,
    `"${r.txHash}"`,
    `"${r.commitment}"`,
    r.userId,
    r.costUnits,
    r.epoch,
    `"${r.submitter}"`,
    `"${r.indexedAt}"`,
  ].join(',');
}

function main() {
  if (!fs.existsSync(INPUT_JSONL)) {
    console.error(`Input not found: ${INPUT_JSONL}`);
    console.error('Run `npm run indexer` first to collect on-chain data.');
    process.exit(1);
  }

  const lines = fs.readFileSync(INPUT_JSONL, 'utf8').trim().split('\n').filter(Boolean);
  const receipts: IndexedReceipt[] = lines.map(l => JSON.parse(l) as IndexedReceipt);

  const csvLines = [CSV_HEADER, ...receipts.map(toCsvRow)];
  fs.mkdirSync(path.dirname(OUTPUT_CSV), { recursive: true });
  fs.writeFileSync(OUTPUT_CSV, csvLines.join('\n') + '\n');

  console.log(`Exported ${receipts.length} receipts → ${OUTPUT_CSV}`);

  // Summary stats
  const totalCU = receipts.reduce((s, r) => s + parseInt(r.costUnits), 0);
  const uniqueUsers = new Set(receipts.map(r => r.userId)).size;
  console.log(`Summary: totalCU=${totalCU}, uniqueUsers=${uniqueUsers}, blocks=${receipts.length > 0 ? `${receipts[0].blockNumber}..${receipts[receipts.length - 1].blockNumber}` : 'n/a'}`);
}

main();
