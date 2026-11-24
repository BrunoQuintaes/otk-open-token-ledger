/**
 * End-to-end rehearsal on the 7-validator Besu IBFT 2.0 test network (session 2026-09-29/30).
 *
 *   POST /receipts (API, real) → POST /prove (ProverDaemon, real, snarkjs Groth16 with the
 *   MPC key) → submitReceipt on ReceiptRegistryV2 (Besu) → block → event → registry state.
 *
 * Network: infra/test/docker-compose.besu7.yml (fresh data). Contracts deployed by this script
 * from tools/hardhat/artifacts (compile first). A funded genesis account signs the funding
 * transactions; its key file path comes from OTK_BESU_FUNDER_KEY_FILE and is never printed.
 * Operator (trustedSigner) and attacker are fresh random wallets.
 *
 * Cases:
 *   E1  happy path, one receipt, until the event is on chain;
 *   E2  daemon down when the receipt arrives; daemon back; API recovery loop delivers it;
 *   E3  daemon killed right after accepting the job; restarted with the same queue log;
 *   X16 R16 (known, unresolved): attacker replays the operator signature from E1's calldata;
 *   X21 R21 (known, unresolved): forged batch header with the same signature.
 * X16/X21 "succeeding" means the known defect is reproduced on Besu, not that anything is safe.
 *
 *   npx tsx scripts/rehearsal/besu_e2e.ts --out=<dir>
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HH = path.join(ROOT, 'tools', 'hardhat');
const isWin = process.platform === 'win32';
const TSX = path.join(ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');
const RPC = process.env['OTK_TEST_BESU_RPC'] ?? 'http://127.0.0.1:58545';
const FUNDER_KEY_FILE = process.env['OTK_BESU_FUNDER_KEY_FILE'];
const WASM = path.join(ROOT, 'zk/build/metering_v2_js/metering_v2.wasm');
const ZKEY = path.join(ROOT, 'zk/keys/metering_v2_final_mpc.zkey');
const snarkjs = createRequire(import.meta.url)('snarkjs') as {
  groth16: { fullProve: (i: Record<string, string>, w: string, z: string) => Promise<{ proof: { pi_a: string[]; pi_b: string[][]; pi_c: string[] }; publicSignals: string[] }> };
};

const out: Record<string, unknown> = { started: new Date().toISOString(), rpc: RPC, cases: {} as Record<string, unknown> };
const cases = out['cases'] as Record<string, Record<string, unknown>>;
const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const art = (file: string, name: string) => JSON.parse(fs.readFileSync(path.join(HH, 'artifacts', 'contracts', file, `${name}.json`), 'utf8')) as { abi: ethers.InterfaceAbi; bytecode: string };
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('port')))); });
  });
}

interface Proc { p: ChildProcess; log: string[] }
function startTsx(entry: string, env: Record<string, string>): Proc {
  const [cmd, args] = isWin ? ['cmd.exe', ['/c', TSX, entry]] : [TSX, [entry]];
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['OTK_DB_URL', 'OTK_REDIS_URL', 'OTK_RECEIPT_LOG', 'OTK_TENANTS']) delete base[k];
  const p = spawn(cmd, args, { cwd: ROOT, env: { ...base, NODE_ENV: 'test', ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const log: string[] = [];
  p.stdout?.on('data', d => log.push(String(d)));
  p.stderr?.on('data', d => log.push(String(d)));
  return { p, log };
}
async function kill(x: Proc | undefined): Promise<void> {
  if (!x?.p.pid || x.p.exitCode !== null) return;
  const done = new Promise<void>(r => x.p.on('exit', () => r()));
  if (isWin) spawnSync('taskkill', ['/F', '/T', '/PID', String(x.p.pid)], { stdio: 'ignore' }); else x.p.kill('SIGKILL');
  await Promise.race([done, sleep(5000)]);
}
async function waitHttp(url: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if ((await fetch(url, { signal: AbortSignal.timeout(800) })).ok) return; } catch { /* retry */ } await sleep(300); }
  throw new Error(`not healthy: ${url}`);
}

async function main(): Promise<number> {
  const outDir = process.argv.find(a => a.startsWith('--out='))?.slice(6);
  if (!outDir || !FUNDER_KEY_FILE) { console.error('usage: OTK_BESU_FUNDER_KEY_FILE=<file> ... --out=<dir>'); return 2; }
  fs.mkdirSync(outDir, { recursive: true });
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1, pollingInterval: 500 });
  const net_ = await provider.getNetwork();
  const validators = await provider.send('ibft_getValidatorsByBlockNumber', ['latest']);
  out['network'] = { chainId: String(net_.chainId), startBlock: await provider.getBlockNumber(), validators,
    client: await provider.send('web3_clientVersion', []), peers: parseInt(await provider.send('net_peerCount', []), 16) };
  console.log('network', out['network']);

  const funder = new ethers.Wallet(fs.readFileSync(FUNDER_KEY_FILE, 'utf8').trim(), provider);
  const operator = ethers.Wallet.createRandom().connect(provider);
  const attacker = ethers.Wallet.createRandom().connect(provider);
  for (const w of [operator, attacker]) await (await funder.sendTransaction({ to: w.address, value: ethers.parseEther('10') })).wait();

  const deploy = async (file: string, name: string, ...args: unknown[]) => {
    const a = art(file, name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, operator).deploy(...args);
    const rc = await c.deploymentTransaction()!.wait();
    const addr = await c.getAddress();
    const code = await provider.getCode(addr);
    return { c: c as unknown as ethers.Contract, info: { address: addr, deployBlock: rc!.blockNumber, deployGas: String(rc!.gasUsed),
      runtimeCodeKeccak: ethers.keccak256(code), artifactBytecodeKeccak: ethers.keccak256(a.bytecode) } };
  };
  const verifier = await deploy('MeteringVerifierV2MPC.sol', 'MeteringVerifierV2MPC');
  const registry = await deploy('ReceiptRegistryV2.sol', 'ReceiptRegistryV2', verifier.info.address, operator.address);
  const batch = await deploy('BatchReceiptRegistry.sol', 'BatchReceiptRegistry', operator.address);
  out['contracts'] = { MeteringVerifierV2MPC: verifier.info, ReceiptRegistryV2: registry.info, BatchReceiptRegistry: batch.info,
    trustedSigner: operator.address, attacker: attacker.address };
  out['zk'] = { wasm: { path: 'zk/build/metering_v2_js/metering_v2.wasm', sha256: sha(WASM) }, zkey: { path: 'zk/keys/metering_v2_final_mpc.zkey', sha256: sha(ZKEY) },
    vkey: { path: 'zk/keys/metering_v2_vkey_mpc.json', sha256: sha(path.join(ROOT, 'zk/keys/metering_v2_vkey_mpc.json')) } };
  console.log('contracts', out['contracts']);

  const reg = registry.c;
  const eventsFor = async (userId: bigint) => {
    const logs = await provider.getLogs({ address: registry.info.address, fromBlock: registry.info.deployBlock, toBlock: 'latest' });
    return logs.map(l => { try { return { log: l, ev: reg.interface.parseLog(l)! }; } catch { return null; } })
      .filter((x): x is { log: ethers.Log; ev: ethers.LogDescription } => x != null && x.ev.name === 'ReceiptSubmittedV2' && BigInt(x.ev.args['userId']) === userId);
  };

  // Daemon + API
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'otk-besu-e2e-'));
  const proverPort = await freePort();
  const apiPort = await freePort();
  const daemonEnv = { PROVER_PORT: String(proverPort), OTK_RPC_URL: RPC, OTK_SIGNER_KEY: operator.privateKey,
    OTK_REGISTRY_V2_ADDRESS: registry.info.address, OTK_PROOF_QUEUE_LOG: path.join(tmp, 'proof-queue.jsonl'),
    // --daemon-redis: BullMQ queue on the real Redis test service instead of the file queue
    ...(process.argv.includes('--daemon-redis') ? { OTK_REDIS_URL: process.env['OTK_TEST_REDIS_URL'] ?? 'redis://:otk-test-only@127.0.0.1:56379' } : {}) };
  out['daemonQueue'] = process.argv.includes('--daemon-redis') ? 'bullmq-redis' : 'file-log';
  const token = 'besu-e2e-token';
  const apiEnv = { API_PORT: String(apiPort), PROVER_URL: `http://127.0.0.1:${proverPort}`, OTK_CIRCUIT_DEFAULT: '2',
    OTK_RECEIPT_LOG: path.join(tmp, 'receipts.jsonl'), OTK_TENANTS: `besu-tenant/OPERATOR:${token}`, OTK_ADMIN_KEY: 'besu-e2e-admin',
    PROVER_RECOVERY_INTERVAL_MS: '1000', PROVER_CB_THRESHOLD: '2', PROVER_CB_COOLDOWN_MS: '1000' };
  let daemon: Proc | undefined = startTsx('src/prover/ProverDaemon.ts', daemonEnv);
  await waitHttp(`http://127.0.0.1:${proverPort}/health`);
  const api = startTsx('src/api/server.ts', apiEnv);
  await waitHttp(`http://127.0.0.1:${apiPort}/health`);
  const TS = Math.floor(Date.now() / 1000);
  const post = async (requestId: string, userId: number, nonce: number, cu: number) => {
    const r = await fetch(`http://127.0.0.1:${apiPort}/receipts`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ requestId, provider: 'openai', model: 'gpt-4o', inputTokens: 100, outputTokens: 200, costUnits: cu, latencyMs: 5, timestamp: TS, userId: String(userId), nonce: String(nonce) }) });
    return { status: r.status, body: await r.json() as Record<string, unknown> };
  };
  const receiptStatus = async (id: string) => (await (await fetch(`http://127.0.0.1:${apiPort}/receipts/${id}`, { headers: { authorization: `Bearer ${token}` } })).json()) as Record<string, unknown>;
  const waitEvent = async (userId: bigint, nonceCount: number, ms: number) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { const e = await eventsFor(userId); if (e.length >= nonceCount) return e; await sleep(1000); }
    return eventsFor(userId);
  };

  try {
    // E1 — happy path
    {
      const t0 = Date.now();
      const r = await post('besu-e1', 42, 0, 640);
      const evs = await waitEvent(42n, 1, 180_000);
      const e = evs[0];
      const rc = e ? await provider.getTransactionReceipt(e.log.transactionHash) : null;
      const st = await receiptStatus('besu-e1');
      cases['E1'] = {
        description: 'POST /receipts → daemon → proof → ReceiptRegistryV2 on Besu',
        post: r, secondsToEvent: e ? (Date.now() - t0) / 1000 : null, apiProofStatus: st['proofStatus'], apiTxHash: st['txHash'] ?? null,
        tx: e ? { hash: e.log.transactionHash, block: e.log.blockNumber, status: rc?.status, gasUsed: String(rc?.gasUsed), from: (await provider.getTransaction(e.log.transactionHash))?.from } : null,
        event: e ? { userId: String(e.ev.args['userId']), costUnits: String(e.ev.args['costUnits']), epoch: String(e.ev.args['epoch']),
          minUsageBucket: String(e.ev.args['minUsageBucket']), maxUsageBucket: String(e.ev.args['maxUsageBucket']), commitment: e.ev.args['commitment'] } : null,
        registryNonceUser42: String(await reg.getNonce(operator.address, 42n)),
        expected: 'one event for userId 42; nonce 1; tx from trustedSigner',
        matched: evs.length === 1 && rc?.status === 1 && String(await reg.getNonce(operator.address, 42n)) === '1'
          && (await provider.getTransaction(e!.log.transactionHash))?.from.toLowerCase() === operator.address.toLowerCase(),
      };
      console.log('E1', JSON.stringify(cases['E1']));
    }

    // E2 — daemon down when the receipt arrives, then back
    {
      await kill(daemon); daemon = undefined;
      const r = await post('besu-e2', 42, 1, 700);
      await sleep(3000);
      const pending = await receiptStatus('besu-e2');
      daemon = startTsx('src/prover/ProverDaemon.ts', daemonEnv);
      await waitHttp(`http://127.0.0.1:${proverPort}/health`);
      const t0 = Date.now();
      const evs = await waitEvent(42n, 2, 180_000);
      cases['E2'] = {
        description: 'daemon killed; receipt accepted by the API; daemon restarted; no client traffic after that',
        post: r, statusWhileDaemonDown: pending['proofStatus'], secondsFromDaemonBackToEvent: evs.length >= 2 ? (Date.now() - t0) / 1000 : null,
        eventsUser42: evs.length, registryNonceUser42: String(await reg.getNonce(operator.address, 42n)),
        expected: 'exactly 2 events for userId 42 (E1 + E2), nonce 2', matched: evs.length === 2 && String(await reg.getNonce(operator.address, 42n)) === '2',
      };
      console.log('E2', JSON.stringify(cases['E2']));
    }

    // E3 — daemon killed right after it accepted the job; restarted with the same queue log
    {
      const r = await post('besu-e3', 42, 2, 810);
      let accepted: Record<string, unknown> = {};
      const end = Date.now() + 20_000;
      while (Date.now() < end) { accepted = await receiptStatus('besu-e3'); if (accepted['jobId']) break; await sleep(100); }
      await kill(daemon); daemon = undefined;
      const onChainAtKill = (await eventsFor(42n)).length;
      daemon = startTsx('src/prover/ProverDaemon.ts', daemonEnv);
      await waitHttp(`http://127.0.0.1:${proverPort}/health`);
      const evs = await waitEvent(42n, 3, 180_000);
      await sleep(5000);
      const final = await eventsFor(42n);
      cases['E3'] = {
        description: 'daemon killed after accepting the job (jobId known to the API); restarted with the same OTK_PROOF_QUEUE_LOG',
        post: r, jobIdAtKill: accepted['jobId'] ?? null, eventsAtKill: onChainAtKill, eventsAfterRestart: final.length,
        registryNonceUser42: String(await reg.getNonce(operator.address, 42n)), apiProofStatusAfter: (await receiptStatus('besu-e3'))['proofStatus'],
        expected: 'exactly 3 events (the accepted job is resumed once)', matched: final.length === 3 && evs.length === 3,
      };
      console.log('E3', JSON.stringify(cases['E3']));
    }

    // X16 — known defect R16 on Besu: attacker reuses the operator signature from E1 calldata
    {
      const e1 = (cases['E1'] as { tx?: { hash: string } }).tx;
      if (e1) {
        const tx = await provider.getTransaction(e1.hash);
        const decoded = reg.interface.parseTransaction({ data: tx!.data })!;
        const [, rawHash, v, r_, s] = decoded.args;
        const fp = await snarkjs.groth16.fullProve({ userId: '7', usage: '640', nonce: '3', epoch: '812', minUsageBucket: '600', maxUsageBucket: '699' }, WASM, ZKEY);
        const p = fp.proof;
        const proof = { a: [p.pi_a[0], p.pi_a[1]], b: [[p.pi_b[0]![1], p.pi_b[0]![0]], [p.pi_b[1]![1], p.pi_b[1]![0]]], c: [p.pi_c[0], p.pi_c[1]], pubSignals: fp.publicSignals };
        const rawFake = { userId: 999n, nonce: 0n, epoch: 812n, costUnits: 1n };
        try {
          const rc = await (await (reg.connect(attacker) as ethers.Contract)['submitReceipt']!(rawFake, rawHash, v, r_, s, proof)).wait();
          const ev = rc!.logs.map((l: ethers.Log) => { try { return reg.interface.parseLog(l); } catch { return null; } }).find((x: ethers.LogDescription | null) => x?.name === 'ReceiptSubmittedV2');
          cases['X16'] = { knownDefect: 'R16', reproduced: true, submitter: 'attacker (not trustedSigner)', eventUserId: String(ev?.args['userId']), eventCostUnits: String(ev?.args['costUnits']), gasUsed: String(rc!.gasUsed) };
        } catch (e) { cases['X16'] = { knownDefect: 'R16', reproduced: false, error: String((e as { shortMessage?: string }).shortMessage ?? e) }; }
        console.log('X16', JSON.stringify(cases['X16']));

        // X21 — forged batch header with the same signature
        const header = { root: ethers.hexlify(ethers.randomBytes(32)), count: 1_000_000n, totalCUBucket: 10n ** 12n, policyId: 'forged', epoch: 812n, createdAt: 0n };
        try {
          const rc = await (await (batch.c.connect(attacker) as ethers.Contract)['submitBatch']!(header, { rawHash, v, r: r_, s, signer: operator.address })).wait();
          cases['X21'] = { knownDefect: 'R21', reproduced: rc!.status === 1, count: '1000000', gasUsed: String(rc!.gasUsed) };
        } catch (e) { cases['X21'] = { knownDefect: 'R21', reproduced: false, error: String((e as { shortMessage?: string }).shortMessage ?? e) }; }
        console.log('X21', JSON.stringify(cases['X21']));
      }
    }
  } finally {
    await kill(daemon); await kill(api);
    out['finished'] = new Date().toISOString();
    out['endBlock'] = await provider.getBlockNumber().catch(() => null);
    out['daemonLogTail'] = daemon?.log.join('').slice(-3000) ?? null;
    fs.writeFileSync(path.join(outDir, `besu_e2e_${Date.now().toString(36)}.json`), JSON.stringify(out, null, 2));
    provider.destroy();
    await (globalThis as { curve_bn128?: { terminate: () => Promise<void> } }).curve_bn128?.terminate();
  }
  const ok = ['E1', 'E2', 'E3'].every(k => (cases[k] as { matched?: boolean } | undefined)?.matched === true);
  return ok ? 0 : 1;
}

main().then(c => process.exit(c), e => { console.error(e); process.exit(2); });
