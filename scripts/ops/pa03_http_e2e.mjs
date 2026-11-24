/**
 * PA-03O — Full HTTP Loop E2E Validation Script
 *
 * Orchestrates the complete PA-03 loop with real processes:
 *   1. Hardhat node (external JSON-RPC)
 *   2. Contract deployment (MeteringVerifier + ReceiptRegistry)
 *   3. ProverDaemon (real ZK proof generation + on-chain submission)
 *   4. API server (real HTTP)
 *   5. POST /receipts → poll GET /receipts/:id → proofStatus=proved + txHash
 *
 * Usage:
 *   node scripts/ops/pa03_http_e2e.mjs [evdDir]
 *
 * @since PA-03O (2026-03-12)
 */

import { ethers } from '../../node_modules/ethers/lib.esm/index.js';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const HH_DIR = path.join(ROOT, 'tools', 'hardhat');

// --- Ports ---
const HH_PORT = 8545;
const PROVER_PORT = 3001;
const API_PORT = 8787;

// --- ZK artifacts ---
const WASM_V1 = path.join(ROOT, 'zk', 'build', 'metering_v1_js', 'metering_v1.wasm');
const ZKEY_V1 = path.join(ROOT, 'zk', 'build', 'metering_v1_final.zkey');

// --- Deterministic test signer (no hardcoded private key) ---
// Derived from seed — same pattern as OnChainPubSignalsBinding.test.js
const SIGNER_KEY = ethers.keccak256(ethers.toUtf8Bytes('pa03o-closeout-signer-2026'));
const signerWallet = new ethers.Wallet(SIGNER_KEY);
const SIGNER_ADDR = signerWallet.address;

// --- EVD directory ---
const evdDir = process.argv[2] ?? path.join(ROOT, 'docs', '_ops', 'startup', `PA03O_HTTP_${Date.now()}`);

// --- Process handles ---
let hhProc = null;
let proverProc = null;
let apiProc = null;

// --- Log buffers ---
const logs = { hh: [], prover: [], api: [] };

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function evdWrite(filename, content) {
  if (!existsSync(evdDir)) mkdirSync(evdDir, { recursive: true });
  writeFileSync(path.join(evdDir, filename), content, 'utf-8');
  log(`EVD: wrote ${filename}`);
}

// --- Fetch with retry (poll until ready) ---
async function waitForUrl(url, maxMs = 30000, interval = 400) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(800) });
      if (r.ok) return true;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, interval));
  }
  return false;
}

// --- Windows-compatible binary paths ---
const IS_WIN = process.platform === 'win32';
const NPX_CMD = IS_WIN
  ? path.join(ROOT, 'node_modules', '.bin', 'npx.cmd')
  : 'npx';
const TSX_CMD = IS_WIN
  ? path.join(ROOT, 'node_modules', '.bin', 'tsx.cmd')
  : path.join(ROOT, 'node_modules', '.bin', 'tsx');
const HH_NPX_CMD = IS_WIN
  ? path.join(HH_DIR, 'node_modules', '.bin', 'hardhat.cmd')
  : path.join(HH_DIR, 'node_modules', '.bin', 'hardhat');

// --- Spawn helper with log capture ---
function spawnProc(name, cmdArgs, options) {
  // cmdArgs[0] = executable, cmdArgs[1..] = arguments
  // On Windows, wrap .cmd files via cmd.exe /c
  let spawnCmd, spawnArgs;
  if (IS_WIN) {
    spawnCmd = 'cmd.exe';
    spawnArgs = ['/c', ...cmdArgs];
  } else {
    [spawnCmd, ...spawnArgs] = cmdArgs;
  }
  log(`Spawning [${name}]: ${cmdArgs.join(' ')}`);
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

// --- Kill all child processes ---
async function cleanup() {
  log('Cleanup: killing child processes...');
  for (const [name, proc] of [['api', apiProc], ['prover', proverProc], ['hh', hhProc]]) {
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
  await new Promise(r => setTimeout(r, 1500));
}

// --- Deploy contracts to running Hardhat node ---
async function deployContracts() {
  log('Deploying contracts to Hardhat node...');
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${HH_PORT}`);

  // Fund signer wallet via hardhat_setBalance (100 ETH)
  await provider.send('hardhat_setBalance', [SIGNER_ADDR, '0x56BC75E2D63100000']);
  log(`Funded signer ${SIGNER_ADDR} with 100 ETH`);

  // NonceManager auto-increments nonce for sequential txs (avoids Hardhat automining stale-nonce)
  const deployer = new ethers.NonceManager(new ethers.Wallet(SIGNER_KEY, provider));

  // Load compiled artifacts
  const verifierArt = JSON.parse(readFileSync(
    path.join(HH_DIR, 'artifacts', 'contracts', 'MeteringVerifier.sol', 'Groth16Verifier.json'),
    'utf-8',
  ));
  const registryArt = JSON.parse(readFileSync(
    path.join(HH_DIR, 'artifacts', 'contracts', 'ReceiptRegistry.sol', 'ReceiptRegistry.json'),
    'utf-8',
  ));

  // Deploy Groth16Verifier
  const VerifierFactory = new ethers.ContractFactory(verifierArt.abi, verifierArt.bytecode, deployer);
  const verifier = await VerifierFactory.deploy();
  await verifier.waitForDeployment();
  const verifierAddr = await verifier.getAddress();
  log(`Groth16Verifier deployed: ${verifierAddr}`);

  // Deploy ReceiptRegistry (trustedSigner = SIGNER_ADDR = same as ProverDaemon wallet)
  const RegistryFactory = new ethers.ContractFactory(registryArt.abi, registryArt.bytecode, deployer);
  const registry = await RegistryFactory.deploy(verifierAddr, SIGNER_ADDR);
  await registry.waitForDeployment();
  const registryAddr = await registry.getAddress();
  log(`ReceiptRegistry deployed: ${registryAddr} (trustedSigner=${SIGNER_ADDR})`);

  return { provider, registry, verifierAddr, registryAddr };
}

// --- Main ---
async function main() {
  log('=== PA-03O Full HTTP Loop E2E ===');
  log(`EVD dir: ${evdDir}`);
  log(`Signer: ${SIGNER_ADDR} (derived from seed, not stored)`);

  // Check ZK artifacts
  if (!existsSync(WASM_V1)) throw new Error(`WASM missing: ${WASM_V1}`);
  if (!existsSync(ZKEY_V1)) throw new Error(`ZKEY missing: ${ZKEY_V1}`);
  log('ZK artifacts: OK');

  // 1. Start Hardhat node
  log('Starting Hardhat node...');
  hhProc = spawnProc('hh',
    [HH_NPX_CMD, 'node', '--port', String(HH_PORT)],
    { cwd: HH_DIR },
  );
  const hhReady = await waitForUrl(`http://127.0.0.1:${HH_PORT}`, 30000);
  if (!hhReady) throw new Error('Hardhat node failed to start');
  log('Hardhat node: ready');

  // 2. Deploy contracts
  const { provider, registry, registryAddr } = await deployContracts();

  // 3. Start ProverDaemon with real chain config
  log('Starting ProverDaemon...');
  const proverEnv = {
    ...process.env,
    PROVER_PORT: String(PROVER_PORT),
    PROVER_WASM_V1: WASM_V1,
    PROVER_ZKEY_V1: ZKEY_V1,
    OTK_RPC_URL: `http://127.0.0.1:${HH_PORT}`,
    OTK_REGISTRY_ADDRESS: registryAddr,
    OTK_SIGNER_KEY: SIGNER_KEY,
    OTK_PROOF_QUEUE_LOG: '',  // in-memory
    PROVER_MAX_ATTEMPTS: '1', // fail fast for test
    NODE_ENV: 'test',
  };
  proverProc = spawnProc('prover',
    [TSX_CMD, 'src/prover/ProverDaemon.ts'],
    { cwd: ROOT, env: proverEnv },
  );
  const proverReady = await waitForUrl(`http://127.0.0.1:${PROVER_PORT}/health`, 30000);
  if (!proverReady) throw new Error('ProverDaemon failed to start');
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
  if (!apiReady) throw new Error('API server failed to start');
  log('API server: ready');

  // 5. POST /receipts
  const timestamp = Math.floor(Date.now() / 1000);
  const epoch = Math.floor(timestamp / 3600);
  const payload = {
    requestId: 'pa03o-req-001',
    provider: 'openai',
    model: 'gpt-4',
    inputTokens: 100,
    outputTokens: 50,
    costUnits: 150,
    latencyMs: 320,
    timestamp,
    userId: '42',
    nonce: '0',  // must match ReceiptRegistry.nonces[proverWallet][42] = 0
  };

  log(`POST /receipts payload: requestId=${payload.requestId} userId=${payload.userId} costUnits=${payload.costUnits} epoch=${epoch}`);
  const postResp = await fetch(`http://127.0.0.1:${API_PORT}/receipts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const postBody = await postResp.json();
  log(`POST /receipts → status=${postResp.status} body=${JSON.stringify(postBody)}`);

  if (postResp.status !== 201) throw new Error(`POST /receipts failed: ${JSON.stringify(postBody)}`);

  // 6. Poll GET /receipts/:id until proofStatus terminal or 90s timeout
  log('Polling GET /receipts/pa03o-req-001 for proofStatus...');
  const pollStart = Date.now();
  let lastGetBody = null;
  let finalStatus = null;

  while (Date.now() - pollStart < 90000) {
    await new Promise(r => setTimeout(r, 1000));
    const getResp = await fetch(`http://127.0.0.1:${API_PORT}/receipts/pa03o-req-001`);
    lastGetBody = await getResp.json();
    const ps = lastGetBody.proofStatus;
    const elapsed = ((Date.now() - pollStart) / 1000).toFixed(1);
    log(`[${elapsed}s] proofStatus=${ps} txHash=${lastGetBody.txHash ?? 'N/A'} jobId=${lastGetBody.jobId ?? 'N/A'}`);

    if (ps === 'proved' || ps === 'failed') {
      finalStatus = ps;
      break;
    }
  }

  if (!finalStatus) {
    log('TIMEOUT: proofStatus never reached terminal state within 90s');
    finalStatus = 'timeout';
  }

  // 7. Verify on-chain event (if proved)
  let onChainEvent = null;
  let blockNumber = null;
  if (finalStatus === 'proved' && lastGetBody.txHash) {
    log(`Verifying on-chain tx: ${lastGetBody.txHash}`);
    const txReceipt = await provider.getTransactionReceipt(lastGetBody.txHash);
    if (txReceipt) {
      blockNumber = txReceipt.blockNumber;
      const registryArt = JSON.parse(readFileSync(
        path.join(HH_DIR, 'artifacts', 'contracts', 'ReceiptRegistry.sol', 'ReceiptRegistry.json'),
        'utf-8',
      ));
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
    }
  }

  // 8. Write EVD files
  const httpFlow = {
    timestamp: new Date().toISOString(),
    post: {
      url: `http://127.0.0.1:${API_PORT}/receipts`,
      payload,
      status: postResp.status,
      body: postBody,
    },
    poll: {
      finalGetBody: lastGetBody,
      finalStatus,
      pollElapsedMs: Date.now() - pollStart,
    },
    onChain: {
      txHash: lastGetBody?.txHash,
      blockNumber,
      event: onChainEvent,
    },
  };

  evdWrite('07_http_flow.txt', JSON.stringify(httpFlow, null, 2));
  evdWrite('04_api_logs.txt', logs.api.join(''));
  evdWrite('05_prover_logs.txt', logs.prover.join(''));

  const chainResults = [
    `PA-03O HTTP Loop Results`,
    `Timestamp: ${new Date().toISOString()}`,
    ``,
    `=== POST /receipts ===`,
    `Status: ${postResp.status}`,
    `RequestId: ${postBody.requestId}`,
    ``,
    `=== Proof Status ===`,
    `Final: ${finalStatus}`,
    `txHash: ${lastGetBody?.txHash ?? 'N/A'}`,
    `jobId: ${lastGetBody?.jobId ?? 'N/A'}`,
    ``,
    `=== On-Chain ===`,
    `blockNumber: ${blockNumber ?? 'N/A'}`,
    `event: ${onChainEvent ? JSON.stringify(onChainEvent) : 'N/A'}`,
  ].join('\n');

  evdWrite('06_chain_results.txt', chainResults);

  // 9. Determine verdict
  const success = finalStatus === 'proved' &&
    lastGetBody?.txHash &&
    lastGetBody?.txHash.startsWith('0x') &&
    onChainEvent !== null;

  log(`=== VERDICT ===`);
  log(`proofStatus: ${finalStatus}`);
  log(`txHash: ${lastGetBody?.txHash ?? 'N/A'}`);
  log(`onChainEvent: ${onChainEvent ? 'PRESENT' : 'ABSENT'}`);
  log(`RESULT: ${success ? '✅ CLOSED' : '❌ NOT CLOSED'}`);

  return { success, finalStatus, txHash: lastGetBody?.txHash, onChainEvent };
}

// --- Entry point ---
main()
  .then(async (result) => {
    await cleanup();
    if (!result.success) {
      log(`FAILED: ${result.finalStatus}`);
      process.exit(1);
    }
    log('PA-03O HTTP loop: CLOSED');
    process.exit(0);
  })
  .catch(async (err) => {
    log(`ERROR: ${err.message}`);
    console.error(err);
    // Write logs even on error
    if (existsSync(evdDir) || true) {
      try {
        mkdirSync(evdDir, { recursive: true });
        writeFileSync(path.join(evdDir, '04_api_logs.txt'), logs.api.join(''), 'utf-8');
        writeFileSync(path.join(evdDir, '05_prover_logs.txt'), logs.prover.join(''), 'utf-8');
        writeFileSync(path.join(evdDir, 'error.txt'), err.stack ?? err.message, 'utf-8');
      } catch { /* best effort */ }
    }
    await cleanup();
    process.exit(2);
  });
