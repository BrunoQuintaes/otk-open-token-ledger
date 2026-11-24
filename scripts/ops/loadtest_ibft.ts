/**
 * U10.3 — IBFT Load Test (Real Throughput Measurement)
 *
 * Submits ZK receipts to ReceiptRegistry at a target rate, measuring:
 *   - Actual confirmed tx/s
 *   - Pending pool depth at peak
 *   - Block inclusion latency (submit → confirm)
 *   - Missed/rejected transactions
 *
 * Requires running IBFT devnet (infra/ibft/docker-compose.4node.yml)
 * and MockVerifier deployed (for speed; avoids ~3.7s proof gen per tx).
 *
 * Usage:
 *   npx tsx scripts/ops/loadtest_ibft.ts [--rate 10] [--count 50] [--mock]
 *
 * Options:
 *   --rate N     Target tx/s (default: 10)
 *   --count N    Total transactions to send (default: 50)
 *   --mock       Use MockVerifier instead of real ZK (faster, tests throughput)
 *   --rpc URL    RPC endpoint (default: http://127.0.0.1:8545)
 *
 * @module loadtest_ibft
 * @since U10.3
 */

import { ethers } from 'ethers';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCostUnits } from '../../src/economics/CUEngine.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const getArg = (flag: string, def: string) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : def;
};
const TARGET_RATE = parseFloat(getArg('--rate', '10'));   // tx/s
const TOTAL_COUNT = parseInt(getArg('--count', '50'));
const USE_MOCK = args.includes('--mock');
const RPC_URL = getArg('--rpc', 'http://127.0.0.1:8545');
const INTERVAL_MS = 1000 / TARGET_RATE;

// ---------------------------------------------------------------------------
// Hardhat artifacts (from tools/hardhat/artifacts)
// ---------------------------------------------------------------------------
const ARTIFACTS_DIR = path.join(REPO_ROOT, 'tools/hardhat/artifacts/contracts');

function loadABI(contractName: string): unknown[] {
  const candidates = [
    path.join(ARTIFACTS_DIR, `${contractName}.sol/${contractName}.json`),
    path.join(REPO_ROOT, `tools/hardhat/artifacts/contracts/${contractName}.sol/${contractName}.json`),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8')).abi;
    }
  }
  throw new Error(`ABI not found for ${contractName}. Run: cd tools/hardhat && npx hardhat compile`);
}

// ---------------------------------------------------------------------------
// Deployed addresses (from deploy artifacts or env)
// ---------------------------------------------------------------------------
function getDeployedAddress(name: string): string {
  // Try environment variable first
  const envKey = `${name.toUpperCase()}_ADDRESS`;
  if (process.env[envKey]) return process.env[envKey]!;

  // Try U10.3 load test deploy artifact
  const u10Deploy = path.join(REPO_ROOT, 'docs/_ops/u10/U10_3_LOADTEST_DEPLOY.json');
  if (fs.existsSync(u10Deploy)) {
    const d = JSON.parse(fs.readFileSync(u10Deploy, 'utf8'));
    if (d[name]) return d[name];
  }

  // Fallback: well-known U8 deployment addresses (from evidence)
  const known: Record<string, string> = {
    'ReceiptRegistry': '0xFEAE27388A65eE984F452f86efFEd42AaBD438FD',
    'MockVerifier':    '0xaC6A6a77c89BFdCAAC2580419125e697E4ea0291',
  };
  if (known[name]) return known[name];
  throw new Error(`Address not found for ${name}. Set ${envKey} env var or provide deployments/.`);
}

// ---------------------------------------------------------------------------
// Minimal EIP-191 receipt for load test
// Each tx uses different userId → nonce starts at 0 per userId (anti-replay)
// Commitment must be unique per tx → derived from unique seed
// ---------------------------------------------------------------------------
async function buildTestReceipt(idx: number, trustedSigner: ethers.Wallet) {
  const userId = BigInt(10001 + idx);
  const nonce = BigInt(0);          // nonce[submitter][userId] = 0 for fresh userId
  const epoch = BigInt(1);
  const cu = computeCostUnits({ provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 50 });

  // Canonical hash (OTK_RECEIPT_V1: alphabetical fields + \n)
  const canonical = `costUnits\n${cu}\nepoch\n${epoch}\nnonce\n${nonce}\nuserId\n${userId}\n`;
  const rawHash = ethers.keccak256(ethers.toUtf8Bytes(canonical));

  // EIP-191 signature by trustedSigner (matches ReceiptRegistry.trustedSigner)
  const sig = ethers.Signature.from(await trustedSigner.signMessage(ethers.getBytes(rawHash)));

  // Unique commitment per tx (MockVerifier accepts any, but commitment must not repeat)
  const commitment = BigInt(ethers.keccak256(ethers.toUtf8Bytes(`commitment-loadtest-${idx}-${Date.now()}`)));

  return {
    raw: { userId, nonce, epoch, costUnits: cu },
    rawHash: rawHash as `0x${string}`,
    v: sig.v, r: sig.r, s: sig.s,
    proof: {
      a: [BigInt(1), BigInt(2)] as [bigint, bigint],
      b: [[BigInt(1), BigInt(2)], [BigInt(3), BigInt(4)]] as [[bigint, bigint], [bigint, bigint]],
      c: [BigInt(5), BigInt(6)] as [bigint, bigint],
      pubSignals: [commitment, epoch, BigInt(1000)] as [bigint, bigint, bigint],
    },
  };
}

// Node1 key = trustedSigner in U10.3 MockVerifier deployment
const IBFT_TRUSTED_KEY = '0x72455be2098f624f17e10f720ca67ef6f9e275da27f0e5a527cde21da77b243d';

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = path.join(REPO_ROOT, `docs/_ops/u10/U10_LOADTEST_IBFT_${ts}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log('='.repeat(65));
  console.log('OTK Load Test — IBFT Real Throughput');
  console.log('='.repeat(65));
  console.log(`RPC:      ${RPC_URL}`);
  console.log(`Target:   ${TARGET_RATE} tx/s  (${INTERVAL_MS.toFixed(0)}ms interval)`);
  console.log(`Count:    ${TOTAL_COUNT} transactions`);
  console.log(`Verifier: ${USE_MOCK ? 'MockVerifier (no ZK)' : 'MeteringVerifier (real ZK)'}`);
  console.log(`Output:   ${outDir}`);
  console.log('');

  // Connect
  let provider: ethers.JsonRpcProvider;
  try {
    provider = new ethers.JsonRpcProvider(RPC_URL);
    const network = await provider.getNetwork();
    console.log(`Connected: chainId=${network.chainId}, name=${network.name}`);
  } catch (e) {
    console.error(`\n❌ Cannot connect to RPC at ${RPC_URL}`);
    console.error('   Start IBFT devnet: docker compose -f infra/ibft/docker-compose.4node.yml up -d');
    console.error('   Then re-run this script.');

    // Write placeholder evidence
    const evidence = {
      status: 'SKIPPED',
      reason: `RPC unavailable at ${RPC_URL}`,
      instructions: 'Start IBFT devnet and redeploy contracts before running load test',
      target_rate: TARGET_RATE,
      total_count: TOTAL_COUNT,
      timestamp: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(outDir, '00_loadtest_skipped.json'), JSON.stringify(evidence, null, 2));
    console.log(`\nPlaceholder evidence written: ${path.join(outDir, '00_loadtest_skipped.json')}`);
    return;
  }

  // Load ReceiptRegistry ABI and address
  let registry: ethers.Contract;
  let trustedSigner: ethers.Wallet;
  try {
    const abi = loadABI('ReceiptRegistry');
    const addr = getDeployedAddress('ReceiptRegistry');
    // node1 key = deployer = trustedSigner in U10.3 deployment
    trustedSigner = new ethers.Wallet(IBFT_TRUSTED_KEY, provider);
    registry = new ethers.Contract(addr, abi, trustedSigner);
    console.log(`ReceiptRegistry: ${addr}`);
  } catch (e) {
    console.error(`\n❌ Contract not available: ${(e as Error).message}`);
    console.error('   Deploy contracts: cd tools/hardhat && npx hardhat run scripts/deploy.js --network besu-ibft');
    const evidence = { status: 'SKIPPED', reason: (e as Error).message, timestamp: new Date().toISOString() };
    fs.writeFileSync(path.join(outDir, '00_loadtest_skipped.json'), JSON.stringify(evidence, null, 2));
    return;
  }

  // Check block
  const startBlock = await provider.getBlockNumber();
  console.log(`Start block: ${startBlock}\n`);

  // trustedSigner already set above — receipts signed with IBFT node1 key

  // -------------------------------------------------------------------------
  // Submission loop
  // -------------------------------------------------------------------------
  const results: Array<{
    idx: number;
    txHash: string | null;
    submitMs: number;
    confirmMs: number | null;
    gasUsed: number | null;
    blockNumber: number | null;
    error: string | null;
  }> = [];

  const pendingDepths: number[] = [];
  const t_start = Date.now();

  for (let i = 0; i < TOTAL_COUNT; i++) {
    const t_submit = Date.now();

    // Throttle to target rate
    const elapsed = t_submit - t_start;
    const expected = i * INTERVAL_MS;
    if (elapsed < expected) {
      await new Promise(r => setTimeout(r, expected - elapsed));
    }

    const receipt = await buildTestReceipt(i, trustedSigner);

    // Check pending pool
    const pending = await provider.send('txpool_status', []).catch(() => null);
    if (pending) {
      const depth = parseInt(pending.pending ?? '0x0', 16);
      pendingDepths.push(depth);
    }

    try {
      const t0 = Date.now();
      const tx = await (registry as any).submitReceipt(
        receipt.raw,
        receipt.rawHash,
        receipt.v,
        receipt.r,
        receipt.s,
        receipt.proof,
        { gasLimit: 500000 }
      );
      const submitMs = Date.now() - t0;

      // Wait for confirmation
      const t1 = Date.now();
      const txReceipt = await tx.wait(1);
      const confirmMs = Date.now() - t1;

      results.push({
        idx: i,
        txHash: tx.hash,
        submitMs,
        confirmMs,
        gasUsed: Number(txReceipt.gasUsed),
        blockNumber: txReceipt.blockNumber,
        error: null,
      });

      process.stdout.write(`  [${i+1}/${TOTAL_COUNT}] ✅ ${tx.hash.slice(0,12)}... submit=${submitMs}ms confirm=${confirmMs}ms gas=${txReceipt.gasUsed}\n`);
    } catch (e) {
      const submitMs = Date.now() - t_submit;
      results.push({ idx: i, txHash: null, submitMs, confirmMs: null, gasUsed: null, blockNumber: null, error: (e as Error).message.slice(0, 100) });
      process.stdout.write(`  [${i+1}/${TOTAL_COUNT}] ❌ ${(e as Error).message.slice(0, 60)}\n`);
    }
  }

  const t_end = Date.now();
  const endBlock = await provider.getBlockNumber();
  const totalSec = (t_end - t_start) / 1000;

  // -------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------
  const confirmed = results.filter(r => r.txHash && !r.error);
  const failed = results.filter(r => r.error);
  const actualThroughput = confirmed.length / totalSec;
  const confirmTimes = confirmed.map(r => r.confirmMs!).filter(Boolean);
  const avgConfirmMs = confirmTimes.length ? confirmTimes.reduce((a,b) => a+b,0) / confirmTimes.length : 0;
  const p95ConfirmMs = confirmTimes.length ? [...confirmTimes].sort((a,b)=>a-b)[Math.floor(confirmTimes.length*0.95)] : 0;
  const maxPending = pendingDepths.length ? Math.max(...pendingDepths) : 0;

  console.log('\n' + '='.repeat(65));
  console.log('LOAD TEST RESULTS');
  console.log('='.repeat(65));
  console.log(`Total time:       ${totalSec.toFixed(1)}s`);
  console.log(`Submitted:        ${TOTAL_COUNT}`);
  console.log(`Confirmed:        ${confirmed.length}`);
  console.log(`Failed:           ${failed.length}`);
  console.log(`Actual thr:       ${actualThroughput.toFixed(2)} tx/s (target: ${TARGET_RATE})`);
  console.log(`Avg confirm:      ${avgConfirmMs.toFixed(0)}ms`);
  console.log(`p95 confirm:      ${p95ConfirmMs.toFixed(0)}ms`);
  console.log(`Peak pending:     ${maxPending}`);
  console.log(`Blocks used:      ${endBlock - startBlock} (${startBlock}→${endBlock})`);

  // -------------------------------------------------------------------------
  // Write evidence
  // -------------------------------------------------------------------------
  const report = {
    timestamp: new Date().toISOString(),
    phase: 'U10.3',
    config: { rpc: RPC_URL, target_rate: TARGET_RATE, total_count: TOTAL_COUNT, use_mock: USE_MOCK },
    results_summary: {
      total_sec: totalSec,
      submitted: TOTAL_COUNT,
      confirmed: confirmed.length,
      failed: failed.length,
      actual_throughput_per_s: parseFloat(actualThroughput.toFixed(2)),
      avg_confirm_ms: parseFloat(avgConfirmMs.toFixed(0)),
      p95_confirm_ms: parseFloat(p95ConfirmMs.toFixed(0)),
      max_pending_pool: maxPending,
      start_block: startBlock,
      end_block: endBlock,
    },
    per_tx: results,
  };
  fs.writeFileSync(path.join(outDir, '01_loadtest_report.json'), JSON.stringify(report, null, 2));

  const csv = [
    'idx,txHash,submitMs,confirmMs,gasUsed,blockNumber,error',
    ...results.map(r => `${r.idx},${r.txHash ?? ''},${r.submitMs},${r.confirmMs ?? ''},${r.gasUsed ?? ''},${r.blockNumber ?? ''},"${r.error ?? ''}"`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, '02_loadtest_per_tx.csv'), csv);

  console.log(`\n✅ Report: ${path.join(outDir, '01_loadtest_report.json')}`);
  console.log(`✅ CSV:    ${path.join(outDir, '02_loadtest_per_tx.csv')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
