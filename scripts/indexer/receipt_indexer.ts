/**
 * receipt_indexer.ts — ReceiptSubmitted event indexer
 *
 * Connects to an IBFT (or any EVM-compatible) node and listens for
 * ReceiptSubmitted events from the ReceiptRegistry contract.
 * Persists indexed events to a JSONL file for offline analysis
 * and dashboard consumption.
 *
 * Usage:
 *   npx tsx scripts/indexer/receipt_indexer.ts [options]
 *
 * Options (env vars):
 *   RPC_URL           — JSON-RPC endpoint (default: http://localhost:8545)
 *   CONTRACT_ADDRESS  — ReceiptRegistry address (default: from deployment)
 *   INDEXER_OUT       — Output JSONL file (default: docs/_ops/indexer/receipts.jsonl)
 *   INDEXER_FROM      — Start block (default: 0 = genesis)
 *   INDEXER_POLL_MS   — Poll interval for new blocks (default: 4000ms)
 *
 * Output JSONL schema (one JSON object per line):
 *   {
 *     "blockNumber": 42,
 *     "blockTimestamp": 1714000000,
 *     "txHash": "0x...",
 *     "commitment": "0x...",
 *     "userId": "12345678",
 *     "costUnits": "1500",
 *     "epoch": "1",
 *     "submitter": "0x...",
 *     "indexedAt": "2026-02-21T22:00:00.000Z"
 *   }
 *
 * @module receipt_indexer
 * @since U10.1
 */

import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const RPC_URL          = process.env['RPC_URL']          ?? 'http://localhost:8545';
const INDEXER_OUT      = process.env['INDEXER_OUT']      ?? path.join(REPO_ROOT, 'docs/_ops/indexer/receipts.jsonl');
const INDEXER_FROM     = parseInt(process.env['INDEXER_FROM']     ?? '0', 10);
const INDEXER_POLL_MS  = parseInt(process.env['INDEXER_POLL_MS']  ?? '4000', 10);

// ReceiptRegistry ABI (ReceiptSubmitted event only)
const RECEIPT_REGISTRY_ABI = [
  'event ReceiptSubmitted(bytes32 indexed commitment, uint256 indexed userId, uint256 costUnits, uint256 epoch, address submitter)',
];

// ---------------------------------------------------------------------------
// IndexedReceipt schema
// ---------------------------------------------------------------------------
export interface IndexedReceipt {
  blockNumber: number;
  blockTimestamp: number;
  txHash: string;
  commitment: string;
  userId: string;
  costUnits: string;
  epoch: string;
  submitter: string;
  indexedAt: string;
}

// ---------------------------------------------------------------------------
// State persistence
// ---------------------------------------------------------------------------
interface IndexerState {
  lastIndexedBlock: number;
  totalIndexed: number;
}

function loadState(statePath: string): IndexerState {
  try {
    const raw = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(raw) as IndexerState;
  } catch {
    return { lastIndexedBlock: INDEXER_FROM, totalIndexed: 0 };
  }
}

function saveState(statePath: string, state: IndexerState): void {
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2));
}

// ---------------------------------------------------------------------------
// Event processing
// ---------------------------------------------------------------------------
function formatIndexedReceipt(
  log: ethers.EventLog,
  block: ethers.Block
): IndexedReceipt {
  const args = log.args;
  return {
    blockNumber:    log.blockNumber,
    blockTimestamp: block.timestamp,
    txHash:         log.transactionHash,
    commitment:     args[0] as string,
    userId:         (args[1] as bigint).toString(),
    costUnits:      (args[2] as bigint).toString(),
    epoch:          (args[3] as bigint).toString(),
    submitter:      args[4] as string,
    indexedAt:      new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Main indexer loop
// ---------------------------------------------------------------------------
async function main() {
  console.log('== OTK Receipt Indexer ==');
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`Output:   ${INDEXER_OUT}`);
  console.log(`Poll:     ${INDEXER_POLL_MS}ms`);

  fs.mkdirSync(path.dirname(INDEXER_OUT), { recursive: true });
  const statePath = INDEXER_OUT.replace('.jsonl', '_state.json');
  const state = loadState(statePath);

  console.log(`Resuming from block ${state.lastIndexedBlock} (${state.totalIndexed} indexed)`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // Resolve contract address
  let contractAddress = process.env['CONTRACT_ADDRESS'];
  if (!contractAddress) {
    // Try to load from deployment artifact
    const deployPath = path.join(REPO_ROOT, 'tools/hardhat/deployments/local/ReceiptRegistry.json');
    if (fs.existsSync(deployPath)) {
      const dep = JSON.parse(fs.readFileSync(deployPath, 'utf8')) as { address?: string };
      contractAddress = dep.address;
    }
  }
  if (!contractAddress) {
    console.error('ERROR: CONTRACT_ADDRESS not set and no deployment artifact found.');
    console.error('Set CONTRACT_ADDRESS env var or deploy first: npx hardhat deploy --network local');
    process.exit(1);
  }
  console.log(`Contract: ${contractAddress}`);

  const contract = new ethers.Contract(contractAddress, RECEIPT_REGISTRY_ABI, provider);
  const outStream = fs.createWriteStream(INDEXER_OUT, { flags: 'a' });

  console.log('Listening for ReceiptSubmitted events...');
  console.log('Press Ctrl+C to stop.');

  let running = true;
  process.on('SIGINT', () => { running = false; console.log('\nShutting down...'); });
  process.on('SIGTERM', () => { running = false; });

  while (running) {
    try {
      const latestBlock = await provider.getBlockNumber();
      const fromBlock = state.lastIndexedBlock;
      const toBlock = Math.min(latestBlock, fromBlock + 999); // max 1000 blocks per query

      if (toBlock >= fromBlock) {
        const events = await contract.queryFilter(
          contract.filters['ReceiptSubmitted']!(),
          fromBlock,
          toBlock
        ) as ethers.EventLog[];

        for (const evt of events) {
          const block = await provider.getBlock(evt.blockNumber);
          if (!block) continue;
          const indexed = formatIndexedReceipt(evt, block);
          outStream.write(JSON.stringify(indexed) + '\n');
          state.totalIndexed++;
          console.log(
            `[Block ${indexed.blockNumber}] commitment=${indexed.commitment.slice(0, 10)}... ` +
            `userId=${indexed.userId} cu=${indexed.costUnits} epoch=${indexed.epoch}`
          );
        }

        state.lastIndexedBlock = toBlock + 1;
        saveState(statePath, state);
      }
    } catch (err) {
      console.warn(`RPC error (will retry): ${(err as Error).message}`);
    }

    if (running) {
      await new Promise<void>(r => setTimeout(r, INDEXER_POLL_MS));
    }
  }

  outStream.end();
  console.log(`\nIndexer stopped. Total indexed: ${state.totalIndexed}`);
  console.log(`Output: ${INDEXER_OUT}`);
}

main().catch(e => { console.error(e); process.exit(1); });
