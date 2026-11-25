/**
 * PA-05 — Besu IBFT E2E Validation Script
 *
 * Validates the full OTK loop against a real Besu IBFT network (chainId=1337).
 * Assumes Besu IBFT is already running at http://127.0.0.1:9545 (infra/ibft/).
 *
 * Flow:
 *   1. Connect to Besu RPC (no Hardhat spawn)
 *   2. Deploy Groth16Verifier + ReceiptRegistry inline with ethers.js
 *   3. Start ProverDaemon pointing to Besu
 *   4. Start API server
 *   5. POST /receipts → poll proofStatus → confirmed txHash in Besu
 *   6. Verify ReceiptSubmitted event via getLogs
 *   7. Write EVD + return verdict
 *
 * Usage:
 *   node scripts/ops/pa05_besu_e2e.mjs [evdDir]
 *
 * Env vars:
 *   BESU_RPC_URL         (default: http://127.0.0.1:9545)
 *   BESU_DEPLOYER_KEY    (optional: hex private key for funded account)
 *                        If not set, reads from infra/ibft/node1/data/key
 *
 * Needs the same ZK build artifacts as pa03_http_e2e.mjs and free ports 3001 and 8787; it spawns the ProverDaemon
 * and the API server and stops them at the end. The deployer key (env or node key file of the local dev
 * network) is passed to the prover as its signer and is never logged. Evidence files go to `evdDir`.
 * Exit codes: 0 = loop closed on Besu; 1 = not closed or fatal error.
 *
 * @since PA-05 (2026-03-13)
 * @module scripts/ops/pa05_besu_e2e
 */

import { ethers } from '../../node_modules/ethers/lib.esm/index.js';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const HH_DIR = path.join(ROOT, 'tools', 'hardhat');

// --- Config ---
const BESU_RPC_URL = process.env['BESU_RPC_URL'] ?? 'http://127.0.0.1:9545';
const BESU_CHAIN_ID = 1337;
const PROVER_PORT = 3001;
const API_PORT = 8787;

// --- ZK artifacts ---
const WASM_V1 = path.join(ROOT, 'zk', 'build', 'metering_v1_js', 'metering_v1.wasm');
const ZKEY_V1 = path.join(ROOT, 'zk', 'build', 'metering_v1_final.zkey');

// --- Deployer key: env var > node1 key file (local dev network, no monetary value) ---
const NODE1_KEY_PATH = path.join(ROOT, 'infra', 'ibft', 'node1', 'data', 'key');
function loadDeployerKey() {
  if (process.env['BESU_DEPLOYER_KEY']) {
    const k = process.env['BESU_DEPLOYER_KEY'].trim();
    return k.startsWith('0x') ? k : `0x${k}`;
  }
  if (!existsSync(NODE1_KEY_PATH)) {
    throw new Error(`No BESU_DEPLOYER_KEY env var and key file not found: ${NODE1_KEY_PATH}`);
  }
  const raw = readFileSync(NODE1_KEY_PATH, 'utf-8').trim();
  return raw.startsWith('0x') ? raw : `0x${raw}`;
}

// --- EVD directory ---
const evdDir = process.argv[2] ?? path.join(ROOT, 'docs', '_ops', 'startup', `PA05_BESU_${Date.now()}`);

// --- Process handles ---
let proverProc = null;
let apiProc = null;

// --- Log buffers ---
const logs = { prover: [], api: [] };

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function evdWrite(filename, content) {
  if (!existsSync(evdDir)) mkdirSync(evdDir, { recursive: true });
  writeFileSync(path.join(evdDir, filename), content, 'utf-8');
  log(`EVD: wrote ${filename}`);
}

// --- Poll until URL ready ---
async function waitForUrl(url, maxMs = 30000, interval = 500) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (r.ok) return true;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

// --- Windows-compatible binary paths ---
const IS_WIN = process.platform === 'win32';
const TSX_CMD = IS_WIN
  ? path.join(ROOT, 'node_modules', '.bin', 'tsx.cmd')
  : path.join(ROOT, 'node_modules', '.bin', 'tsx');

function spawnProc(name, cmdArgs, options) {
  let spawnCmd, spawnArgs;
  if (IS_WIN) {
    spawnCmd = 'cmd.exe';
    spawnArgs = ['/c', ...cmdArgs];
  } else {
    [spawnCmd, ...spawnArgs] = cmdArgs;
  }
  log(`Spawning [${name}]: ${cmdArgs.slice(0, 3).join(' ')} ...`);
  const proc = spawn(spawnCmd, spawnArgs, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(IS_WIN ? {} : { detached: true }),
  });
  proc.stdout?.on('data', (d) => { const s = d.toString(); logs[name]?.push(s); });
  proc.stderr?.on('data', (d) => { const s = d.toString(); logs[name]?.push(s); });
  proc.on('error', (e) => log(`[${name}] error: ${e.message}`));
  proc.on('exit', (code) => log(`[${name}] exited with code ${code}`));
  return proc;
}

async function cleanup() {
  log('Cleanup: killing child processes...');
  for (const [name, proc] of [['api', apiProc], ['prover', proverProc]]) {
    if (!proc || proc.exitCode !== null) continue;
    try {
      if (process.platform === 'win32') {
        spawn('taskkill', ['/F', '/T', '/PID', String(proc.pid)], { stdio: 'ignore' });
      } else {
        try { process.kill(-proc.pid, 'SIGKILL'); } catch { proc.kill('SIGKILL'); }
      }
      log(`Killed [${name}] pid=${proc.pid}`);
    } catch (e) { log(`Kill [${name}] failed: ${e.message}`); }
  }
  await new Promise(r => setTimeout(r, 2000));
}

// --- Deploy contracts directly via ethers.js (no Hardhat) ---
async function deployContracts(provider, deployer) {
  log('Loading Hardhat artifacts for deployment...');

  const verifierArt = JSON.parse(readFileSync(
    path.join(HH_DIR, 'artifacts', 'contracts', 'MeteringVerifier.sol', 'Groth16Verifier.json'),
    'utf-8',
  ));
  const registryArt = JSON.parse(readFileSync(
    path.join(HH_DIR, 'artifacts', 'contracts', 'ReceiptRegistry.sol', 'ReceiptRegistry.json'),
    'utf-8',
  ));

  const deployerAddr = await deployer.getAddress();
  log(`Deployer: ${deployerAddr}`);

  const balance = await provider.getBalance(deployerAddr);
  log(`Deployer balance: ${ethers.formatEther(balance)} ETH`);
  if (balance === 0n) throw new Error('Deployer has zero balance — check genesis allocation');

  const deployStart = Date.now();

  // Deploy Groth16Verifier
  log('Deploying Groth16Verifier...');
  const VerifierFactory = new ethers.ContractFactory(verifierArt.abi, verifierArt.bytecode, deployer);
  const verifier = await VerifierFactory.deploy();
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  log(`Groth16Verifier deployed: ${verifierAddr}`);

  // Deploy ReceiptRegistry (trustedSigner = deployer address)
  log('Deploying ReceiptRegistry...');
  const RegistryFactory = new ethers.ContractFactory(registryArt.abi, registryArt.bytecode, deployer);
  const registry = await RegistryFactory.deploy(verifierAddr, deployerAddr);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  log(`ReceiptRegistry deployed: ${registryAddr} (trustedSigner=${deployerAddr})`);

  const deployMs = Date.now() - deployStart;
  log(`Deploy completed in ${deployMs}ms`);

  return { verifierAddr, registryAddr, deployerAddr, deployMs };
}

// --- Main ---
async function main() {
  log('=== PA-05 Besu IBFT E2E Validation ===');
  log(`BESU_RPC_URL: ${BESU_RPC_URL}`);
  log(`EVD dir: ${evdDir}`);

  // Check ZK artifacts
  if (!existsSync(WASM_V1)) throw new Error(`WASM missing: ${WASM_V1}`);
  if (!existsSync(ZKEY_V1)) throw new Error(`ZKEY missing: ${ZKEY_V1}`);
  log('ZK artifacts: OK');

  // Load deployer key
  const DEPLOYER_KEY = loadDeployerKey();
  // Never log the key itself — only the derived address
  const provider = new ethers.JsonRpcProvider(BESU_RPC_URL, BESU_CHAIN_ID);
  const deployerWallet = new ethers.Wallet(DEPLOYER_KEY, provider);
  log(`Deployer address: ${deployerWallet.address}`);

  // 1. Verify Besu RPC
  log('Checking Besu RPC...');
  const besuBlockNum = await provider.getBlockNumber();
  const besuNetwork = await provider.getNetwork();
  const besuBlock = await provider.getBlock('latest');
  log(`Besu: chainId=${besuNetwork.chainId} blockNumber=${besuBlockNum} blockTime=${besuBlock?.timestamp}`);

  evdWrite('04_besu_rpc_check.txt', JSON.stringify({
    rpcUrl: BESU_RPC_URL,
    chainId: besuNetwork.chainId.toString(),
    blockNumber: besuBlockNum,
    latestBlockTimestamp: besuBlock?.timestamp,
    deployerAddress: deployerWallet.address,
  }, null, 2));

  // 2. Deploy contracts
  const deployer = new ethers.NonceManager(deployerWallet);
  const { verifierAddr, registryAddr, deployerAddr, deployMs } = await deployContracts(provider, deployer);

  evdWrite('02_deploy_results.txt', [
    `Besu IBFT deploy results — ${new Date().toISOString()}`,
    `chainId: ${besuNetwork.chainId}`,
    `blockNumber at deploy: ${besuBlockNum}`,
    `Groth16Verifier: ${verifierAddr}`,
    `ReceiptRegistry: ${registryAddr}`,
    `trustedSigner: ${deployerAddr}`,
    `deployMs: ${deployMs}`,
  ].join('\n'));

  // 3. Start ProverDaemon pointing to Besu
  log('Starting ProverDaemon (Besu mode)...');
  const proverEnv = {
    ...process.env,
    PROVER_PORT: String(PROVER_PORT),
    PROVER_WASM_V1: WASM_V1,
    PROVER_ZKEY_V1: ZKEY_V1,
    OTK_RPC_URL: BESU_RPC_URL,
    OTK_REGISTRY_ADDRESS: registryAddr,
    OTK_SIGNER_KEY: DEPLOYER_KEY,
    OTK_PROOF_QUEUE_LOG: '',  // in-memory
    PROVER_MAX_ATTEMPTS: '1',
    NODE_ENV: 'test',
  };
  // Never log the key from environment
  proverProc = spawnProc('prover',
    [TSX_CMD, 'src/prover/ProverDaemon.ts'],
    { cwd: ROOT, env: proverEnv },
  );
  const proverReady = await waitForUrl(`http://127.0.0.1:${PROVER_PORT}/health`, 40000);
  if (!proverReady) throw new Error('ProverDaemon failed to start within 40s');
  log('ProverDaemon: ready');

  // 4. Start API server
  log('Starting API server...');
  const apiEnv = {
    ...process.env,
    API_PORT: String(API_PORT),
    PROVER_URL: `http://127.0.0.1:${PROVER_PORT}`,
    OTK_RECEIPT_LOG: '',  // in-memory
    NODE_ENV: 'test',
  };
  delete apiEnv['OTK_TENANTS'];  // open auth for test
  apiProc = spawnProc('api',
    [TSX_CMD, 'src/api/server.ts'],
    { cwd: ROOT, env: apiEnv },
  );
  const apiReady = await waitForUrl(`http://127.0.0.1:${API_PORT}/health`, 20000);
  if (!apiReady) throw new Error('API server failed to start within 20s');
  log('API server: ready');

  evdWrite('03_runtime_commands.txt', [
    `ProverDaemon: tsx src/prover/ProverDaemon.ts`,
    `  OTK_RPC_URL=${BESU_RPC_URL}`,
    `  OTK_REGISTRY_ADDRESS=${registryAddr}`,
    `  OTK_SIGNER_KEY=<REDACTED>`,
    ``,
    `API server: tsx src/api/server.ts`,
    `  API_PORT=${API_PORT}`,
    `  PROVER_URL=http://127.0.0.1:${PROVER_PORT}`,
  ].join('\n'));

  // 5. POST /receipts
  const timestamp = Math.floor(Date.now() / 1000);
  const epoch = Math.floor(timestamp / 3600);
  const payload = {
    requestId: 'pa05-besu-req-001',
    provider: 'openai',
    model: 'gpt-4',
    inputTokens: 100,
    outputTokens: 50,
    costUnits: 150,
    latencyMs: 320,
    timestamp,
    userId: '42',
    nonce: '0',
  };

  log(`POST /receipts: requestId=${payload.requestId} userId=${payload.userId} epoch=${epoch}`);
  const postStart = Date.now();
  const postResp = await fetch(`http://127.0.0.1:${API_PORT}/receipts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const postBody = await postResp.json();
  log(`POST /receipts → status=${postResp.status} body=${JSON.stringify(postBody)}`);

  if (postResp.status !== 201) throw new Error(`POST /receipts failed: ${JSON.stringify(postBody)}`);

  // 6. Poll for proofStatus — Besu has 2s blocks, allow more time
  log('Polling GET /receipts/pa05-besu-req-001 for proofStatus (Besu ~2s blocks)...');
  const pollStart = Date.now();
  let lastGetBody = null;
  let finalStatus = null;

  // Allow 120s for Besu (vs 90s for Hardhat) — ZK proof + block confirmation
  while (Date.now() - pollStart < 120000) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const getResp = await fetch(`http://127.0.0.1:${API_PORT}/receipts/pa05-besu-req-001`);
      lastGetBody = await getResp.json();
      const ps = lastGetBody.proofStatus;
      const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
      log(`[${elapsed}s] proofStatus=${ps} txHash=${lastGetBody.txHash ?? 'N/A'} jobId=${lastGetBody.jobId ?? 'N/A'}`);

      if (ps === 'proved' || ps === 'failed') {
        finalStatus = ps;
        break;
      }
    } catch (e) {
      log(`Poll error: ${e.message}`);
    }
  }

  if (!finalStatus) {
    log('TIMEOUT: proofStatus never reached terminal state within 120s');
    finalStatus = 'timeout';
  }

  const totalMs = Date.now() - postStart;
  log(`Total end-to-end time: ${totalMs}ms`);

  // 7. Verify on-chain event
  let onChainEvent = null;
  let blockNumber = null;
  let submitMs = null;

  const registryArt = JSON.parse(readFileSync(
    path.join(HH_DIR, 'artifacts', 'contracts', 'ReceiptRegistry.sol', 'ReceiptRegistry.json'),
    'utf-8',
  ));

  if (finalStatus === 'proved' && lastGetBody?.txHash) {
    log(`Verifying on-chain tx: ${lastGetBody.txHash}`);
    const txReceiptStart = Date.now();
    const txReceipt = await provider.getTransactionReceipt(lastGetBody.txHash);
    submitMs = Date.now() - txReceiptStart;

    if (txReceipt) {
      blockNumber = txReceipt.blockNumber;
      const iface = new ethers.Interface(registryArt.abi);
      for (const logEntry of txReceipt.logs) {
        try {
          const decoded = iface.parseLog(logEntry);
          if (decoded?.name === 'ReceiptSubmitted') {
            onChainEvent = {
              name: decoded.name,
              userId: decoded.args.userId.toString(),
              costUnits: decoded.args.costUnits.toString(),
              epoch: decoded.args.epoch.toString(),
              submitter: decoded.args.submitter,
            };
            log(`ReceiptSubmitted event: ${JSON.stringify(onChainEvent)}`);
          }
        } catch { /* not this contract's event */ }
      }
      log(`txReceipt: blockNumber=${blockNumber} gasUsed=${txReceipt.gasUsed}`);
    } else {
      log('WARNING: txReceipt not found yet — tx may still be pending');
    }
  }

  // 8. Write EVD files
  const e2eResults = {
    timestamp: new Date().toISOString(),
    network: { rpcUrl: BESU_RPC_URL, chainId: BESU_CHAIN_ID, blockNumberAtStart: besuBlockNum },
    deploy: { verifierAddr, registryAddr, deployerAddr, deployMs },
    post: { status: postResp.status, payload, body: postBody },
    poll: { finalStatus, finalGetBody: lastGetBody, pollElapsedMs: Date.now() - pollStart },
    onChain: { txHash: lastGetBody?.txHash, blockNumber, event: onChainEvent },
    timing: { totalMs, submitMs },
  };

  evdWrite('05_e2e_results.md', [
    `# PA-05 Besu E2E Results`,
    `**Timestamp:** ${new Date().toISOString()}`,
    `**Network:** Besu IBFT chainId=${BESU_CHAIN_ID}`,
    ``,
    `## Deploy`,
    `- Groth16Verifier: ${verifierAddr}`,
    `- ReceiptRegistry: ${registryAddr}`,
    `- trustedSigner: ${deployerAddr}`,
    `- deployMs: ${deployMs}`,
    ``,
    `## E2E Result`,
    `- POST /receipts status: ${postResp.status}`,
    `- proofStatus final: **${finalStatus}**`,
    `- txHash: ${lastGetBody?.txHash ?? 'N/A'}`,
    `- blockNumber: ${blockNumber ?? 'N/A'}`,
    `- ReceiptSubmitted event: ${onChainEvent ? JSON.stringify(onChainEvent) : 'N/A'}`,
    ``,
    `## Timing`,
    `- Total end-to-end: ${totalMs}ms`,
    `- proveMs: ${lastGetBody?.proveMs ?? 'N/A'}`,
  ].join('\n'));

  evdWrite('06_chain_logs.txt', JSON.stringify(e2eResults, null, 2));
  evdWrite('07_prover_logs.txt', logs.prover.join(''));
  evdWrite('08_api_logs.txt', logs.api.join(''));

  // 9. Verdict
  const success = finalStatus === 'proved' &&
    lastGetBody?.txHash?.startsWith('0x') &&
    onChainEvent !== null;

  log(`=== PA-05 VERDICT ===`);
  log(`proofStatus: ${finalStatus}`);
  log(`txHash: ${lastGetBody?.txHash ?? 'N/A'}`);
  log(`blockNumber: ${blockNumber ?? 'N/A'}`);
  log(`ReceiptSubmitted event: ${onChainEvent ? 'PRESENT' : 'ABSENT'}`);
  log(`RESULT: ${success ? '✅ PA-05 CLOSED' : '❌ PA-05 NOT CLOSED'}`);

  return { success, finalStatus, txHash: lastGetBody?.txHash, blockNumber, onChainEvent, totalMs };
}

// --- Entry point ---
main()
  .then(async (result) => {
    await cleanup();
    log(`Exit: success=${result.success}`);
    process.exit(result.success ? 0 : 1);
  })
  .catch(async (err) => {
    console.error('[PA-05] FATAL:', err.message);
    await cleanup();
    process.exit(1);
  });
