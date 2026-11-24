/**
 * wait_ready.mjs — readiness check for a fresh Besu IBFT network before any deploy (RUN-M1-24H-20261010, R §6.4).
 *
 * Replaces fixed sleeps and exit-code-only waits. In the RUN-S reproduction (attempt 1, 10/10) the previous inline wait
 * returned exit 0 in 1 s with NO output and the deploy then hit a closed RPC. Root cause not determined (see
 * docs/_ops/RUN_M1_24H_20261010/04_REPRODUCTION.md); this tool closes the class of failure: success is printed
 * evidence, never a bare exit code, and a drained event loop can no longer look like success.
 *
 *   node tools/besu/wait_ready.mjs --rpc http://127.0.0.1:59445 --chain-id 16466 --validators 7 \
 *        [--min-block 5] [--timeout-ms 400000] [--interval-ms 2000] [--request-timeout-ms 5000] [--max-attempts N] [--out f.json]
 *
 * READY only when ALL hold in one observation: eth_chainId == --chain-id; eth_blockNumber >= --min-block; the block
 * number advanced since the PREVIOUS observation (the chain is producing now, not a stale node or a node that restarted
 * from a lower height); ibft validator count == --validators (when given). A malformed hex answer is retried, never read
 * as another chain; net_peerCount is informative only (null when the node does not expose it). Prints exactly one JSON line {status,...} on stdout (and to --out).
 * Exit: 0 READY · 2 TIMEOUT (or max attempts) · 3 WRONG_CHAIN (something else answers on that port) ·
 *       4 EVENT_LOOP_DRAINED (internal guard; never success) · 64 usage error.
 * Callers MUST check status === "READY" in the JSON, not only the exit code.
 */
import fs from 'node:fs';

const arg = (n, d) => { const i = process.argv.indexOf(n); return i !== -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : d; };
const num = (n, d) => { const v = Number(arg(n, d)); if (!Number.isFinite(v) || v < 0) usage(`${n} must be a non-negative number`); return v; };
function usage(msg) { process.stderr.write(`wait_ready: ${msg}\n`); process.exit(64); }

const RPC = arg('--rpc', '');
if (!/^https?:\/\/[^\s]+$/.test(RPC)) usage('--rpc http(s)://host:port is required');
if (arg('--chain-id', '') === '') usage('--chain-id is required');
const CHAIN_ID = num('--chain-id');
const VALIDATORS = arg('--validators', '') === '' ? null : num('--validators');
const MIN_BLOCK = num('--min-block', '5');
const TIMEOUT_MS = num('--timeout-ms', '400000');
const INTERVAL_MS = num('--interval-ms', '2000');
const REQ_TIMEOUT_MS = num('--request-timeout-ms', '5000');
if (REQ_TIMEOUT_MS < 1) usage('--request-timeout-ms must be at least 1'); // ADV-R2-R7: 0 would time out every request
const MAX_ATTEMPTS = arg('--max-attempts', '') === '' ? Infinity : num('--max-attempts');
const OUT = arg('--out', '');

let finished = false;
function finish(code, body) {
  finished = true;
  const line = JSON.stringify({ schema: 'otk.besu_wait_ready.v1', rpc: RPC, expectedChainId: CHAIN_ID, expectedValidators: VALIDATORS, minBlock: MIN_BLOCK, ...body });
  if (OUT) fs.writeFileSync(OUT, line + '\n');
  process.exitCode = code;
  // ADV-R2-R7: exit once the status line is written, even if an abandoned request still holds a handle (a fetch that
  // ignores the abort would otherwise keep the process alive after printing TIMEOUT)
  process.stdout.write(line + '\n', () => process.exit(code));
}
// A pending await whose handles were all released makes Node exit 0 silently. That must never read as READY.
process.on('beforeExit', () => { if (!finished) finish(4, { status: 'EVENT_LOOP_DRAINED' }); });

let id = 0;
// DEMO-02 (RUN-M1-RESUME-R2-20261012): the request deadline is a REF'D timer raced against the request. With
// AbortSignal.timeout() (an unref'd timer) a pending fetch that holds no ref'd handle lets the event loop drain. That
// class was reproduced synthetically (test); in the package demo of 12/10 the wait ended EVENT_LOOP_DRAINED in 1 s, and
// RUN-S saw an unexplained "exit 0 in 1 s" (F-M24-08). Hypothesis, not demonstrated: the Docker port relay accepting
// the connection before Besu listens leaves such a fetch pending. Racing also covers a fetch that ignores the abort.
async function call(method, params = []) {
  const ctrl = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { ctrl.abort(); reject(new Error(`${method}: request timeout after ${REQ_TIMEOUT_MS} ms`)); }, REQ_TIMEOUT_MS);
  });
  try {
    const res = await Promise.race([fetch(RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
      signal: ctrl.signal,
    }), deadline]);
    if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
    const j = await Promise.race([res.json(), deadline]);
    if (j.error) throw new Error(`${method}: RPC error ${j.error.code}`);
    if (j.result === undefined || j.result === null) throw new Error(`${method}: empty result`);
    return j.result;
  } finally {
    clearTimeout(timer);
  }
}
// ADV-M24-14: a non-hex answer (node still starting, proxy page) is an error to retry, not a chain id or a height
function hexInt(method, v) {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]+$/.test(v)) throw new Error(`${method}: malformed quantity`);
  return parseInt(v, 16);
}

const t0 = Date.now();
let attempts = 0; let firstBlock = null; let prevBlock = null; let last = null; let lastError = null;
while (true) {
  attempts++;
  try {
    const chainId = hexInt('eth_chainId', await call('eth_chainId'));
    if (chainId !== CHAIN_ID) { finish(3, { status: 'WRONG_CHAIN', observedChainId: chainId, attempts, elapsedMs: Date.now() - t0 }); break; }
    const block = hexInt('eth_blockNumber', await call('eth_blockNumber'));
    if (firstBlock === null) firstBlock = block;
    let validators = null;
    if (VALIDATORS !== null) validators = (await call('ibft_getValidatorsByBlockNumber', ['latest'])).length;
    let peers = null;
    try { peers = hexInt('net_peerCount', await call('net_peerCount')); } catch { peers = null; }
    last = { chainId, block, previousBlock: prevBlock, firstBlock, validators, peers };
    lastError = null;
    const advancing = prevBlock !== null && block > prevBlock;
    prevBlock = block;
    if (block >= MIN_BLOCK && advancing && (VALIDATORS === null || validators === VALIDATORS)) {
      finish(0, { status: 'READY', attempts, elapsedMs: Date.now() - t0, observation: last });
      break;
    }
  } catch (e) {
    lastError = String(e?.cause?.code ?? e?.name ?? 'error') + ': ' + String(e?.message ?? e).slice(0, 160);
  }
  if (Date.now() - t0 >= TIMEOUT_MS || attempts >= MAX_ATTEMPTS) {
    finish(2, { status: 'TIMEOUT', attempts, elapsedMs: Date.now() - t0, lastObservation: last, lastError });
    break;
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
