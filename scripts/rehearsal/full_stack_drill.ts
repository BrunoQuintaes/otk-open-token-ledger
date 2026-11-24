/**
 * Full-stack recovery drill (session 2026-09-30): PostgreSQL + Redis + API + ProverDaemon
 * (BullMQ on Redis) + ReceiptRegistryV2 on the 7-validator Besu test network.
 *
 *   1. baseline: tenant A 2 receipts, tenant B 1 receipt → 3 events on chain;
 *   2. fault: daemon stopped; A and B send one receipt each (acknowledged, proof pending);
 *      the API process is killed abruptly (crash); the daemon comes back; the API restarts;
 *   3. recovery: no client traffic. Invariants: balances A/B, 5 receipts readable, 5 events on
 *      chain (userId 101: 3, userId 202: 2), no duplicate event.
 * RTO here = time from the API restart until every invariant holds (bounded at 180 s);
 * losses are counted as acknowledged receipts that never reach the chain within the bound.
 * This measures this drill only, not production recovery.
 *
 *   OTK_BESU_FUNDER_KEY_FILE=<file> npx tsx scripts/rehearsal/full_stack_drill.ts --out=<dir>
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const HH = path.join(ROOT, 'tools', 'hardhat');
const isWin = process.platform === 'win32';
const TSX = path.join(ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');
const RPC = process.env['OTK_TEST_BESU_RPC'] ?? 'http://127.0.0.1:58545';
const PG_URL = process.env['OTK_TEST_PG_URL'] ?? 'postgres://otk:otk-test-only@127.0.0.1:55432/otk';
const REDIS_URL = process.env['OTK_TEST_REDIS_URL'] ?? 'redis://:otk-test-only@127.0.0.1:56379';
const RUN = Date.now().toString(36);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const art = (file: string, name: string) => JSON.parse(fs.readFileSync(path.join(HH, 'artifacts', 'contracts', file, `${name}.json`), 'utf8')) as { abi: ethers.InterfaceAbi; bytecode: string };

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
  const funderFile = process.env['OTK_BESU_FUNDER_KEY_FILE'];
  if (!outDir || !funderFile) { console.error('usage: OTK_BESU_FUNDER_KEY_FILE=<file> ... --out=<dir>'); return 2; }
  fs.mkdirSync(outDir, { recursive: true });
  const out: Record<string, unknown> = { run: RUN, started: new Date().toISOString() };
  const provider = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1, pollingInterval: 500 });
  const funder = new ethers.Wallet(fs.readFileSync(funderFile, 'utf8').trim(), provider);
  const operator = ethers.Wallet.createRandom().connect(provider);
  await (await funder.sendTransaction({ to: operator.address, value: ethers.parseEther('10') })).wait();
  const deploy = async (file: string, name: string, ...args: unknown[]) => {
    const a = art(file, name);
    const c = await new ethers.ContractFactory(a.abi, a.bytecode, operator).deploy(...args);
    const rc = await c.deploymentTransaction()!.wait();
    return { c: c as unknown as ethers.Contract, address: await c.getAddress(), block: rc!.blockNumber };
  };
  const verifier = await deploy('MeteringVerifierV2MPC.sol', 'MeteringVerifierV2MPC');
  const registry = await deploy('ReceiptRegistryV2.sol', 'ReceiptRegistryV2', verifier.address, operator.address);
  out['contracts'] = { verifier: verifier.address, registry: registry.address, trustedSigner: operator.address };
  const events = async () => {
    const logs = await provider.getLogs({ address: registry.address, fromBlock: registry.block, toBlock: 'latest' });
    const evs = logs.map(l => { try { return registry.c.interface.parseLog(l); } catch { return null; } }).filter(e => e?.name === 'ReceiptSubmittedV2');
    const by: Record<string, number> = {};
    for (const e of evs) by[String(e!.args['userId'])] = (by[String(e!.args['userId'])] ?? 0) + 1;
    return { total: evs.length, byUser: by };
  };

  // Own database per run: the API restores every receipt of its database at start, and
  // receipts of other rehearsals (stored with the prover disabled, so without a proof job)
  // would be sent for proving to this run's registry.
  const pgMod = await import('pg');
  const admin = new pgMod.default.Pool({ connectionString: PG_URL, max: 1 });
  const db = `otk_drill_${RUN}`;
  await admin.query(`CREATE DATABASE ${db}`);
  await admin.end();
  const DB_URL = PG_URL.replace(/[/][^/]+$/, `/${db}`);
  out['database'] = db;
  const proverPort = await freePort();
  const apiPort = await freePort();
  const tokA = `drill-a-${RUN}`, tokB = `drill-b-${RUN}`;
  const tenA = `drill-a-${RUN}`, tenB = `drill-b-${RUN}`;
  const daemonEnv = { PROVER_PORT: String(proverPort), OTK_RPC_URL: RPC, OTK_SIGNER_KEY: operator.privateKey,
    OTK_REGISTRY_V2_ADDRESS: registry.address, OTK_REDIS_URL: REDIS_URL };
  const apiEnv = { API_PORT: String(apiPort), PROVER_URL: `http://127.0.0.1:${proverPort}`, OTK_CIRCUIT_DEFAULT: '2',
    OTK_DB_URL: DB_URL, OTK_REDIS_URL: REDIS_URL, OTK_TENANTS: `${tenA}/OPERATOR:${tokA},${tenB}/OPERATOR:${tokB}`,
    OTK_ADMIN_KEY: 'drill-admin', PROVER_RECOVERY_INTERVAL_MS: '1000', PROVER_CB_THRESHOLD: '2', PROVER_CB_COOLDOWN_MS: '1000' };
  const TS = Math.floor(Date.now() / 1000);
  const { deriveEpoch } = await import('../../src/types/receipt.js');
  const EPOCH = String(deriveEpoch(TS));
  const post = async (tok: string, id: string, userId: number, nonce: number, cu: number) => {
    const r = await fetch(`http://127.0.0.1:${apiPort}/receipts`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ requestId: id, provider: 'openai', model: 'gpt-4o', inputTokens: 10, outputTokens: 20, costUnits: cu, latencyMs: 1, timestamp: TS, userId: String(userId), nonce: String(nonce) }) });
    await r.text(); return r.status;
  };
  const bal = async (tok: string, ten: string) => {
    try { const r = await fetch(`http://127.0.0.1:${apiPort}/accounting/balance?tenantId=${ten}&epochId=${EPOCH}`, { headers: { authorization: `Bearer ${tok}` } }); return r.ok ? String((await r.json() as Record<string, unknown>)['totalCU']) : `http_${r.status}`; } catch { return 'down'; }
  };
  const readable = async (tok: string, id: string) => { try { return (await fetch(`http://127.0.0.1:${apiPort}/receipts/${id}`, { headers: { authorization: `Bearer ${tok}` } })).status; } catch { return 0; } };

  let daemon: Proc | undefined = startTsx('src/prover/ProverDaemon.ts', daemonEnv);
  await waitHttp(`http://127.0.0.1:${proverPort}/health`);
  let api: Proc | undefined = startTsx('src/api/server.ts', apiEnv);
  await waitHttp(`http://127.0.0.1:${apiPort}/health`);
  try {
    // 1. baseline
    const base = [await post(tokA, `${RUN}-a0`, 101, 0, 1500), await post(tokA, `${RUN}-a1`, 101, 1, 1500), await post(tokB, `${RUN}-b0`, 202, 0, 800)];
    let ev = await events();
    for (let i = 0; i < 120 && ev.total < 3; i++) { await sleep(1000); ev = await events(); }
    out['baseline'] = { acks: base, events: ev, balanceA: await bal(tokA, tenA), balanceB: await bal(tokB, tenB) };
    console.log('baseline', JSON.stringify(out['baseline']));

    // 2. fault
    await kill(daemon); daemon = undefined;
    const faultAcks = [await post(tokA, `${RUN}-a2`, 101, 2, 1500), await post(tokB, `${RUN}-b1`, 202, 1, 800)];
    await sleep(1500);
    await kill(api); api = undefined;
    daemon = startTsx('src/prover/ProverDaemon.ts', daemonEnv);
    await waitHttp(`http://127.0.0.1:${proverPort}/health`);
    const tRestart = Date.now();
    api = startTsx('src/api/server.ts', apiEnv);
    await waitHttp(`http://127.0.0.1:${apiPort}/health`);
    const tHealthy = Date.now();

    // 3. recovery, no client traffic
    const expect = { balanceA: '4500', balanceB: '1600', events: 5, byUser: { '101': 3, '202': 2 } };
    let state: Record<string, unknown> = {};
    let tInvariants: number | null = null;
    while (Date.now() - tRestart < 180_000) {
      const e = await events();
      const rs = [await readable(tokA, `${RUN}-a0`), await readable(tokA, `${RUN}-a1`), await readable(tokA, `${RUN}-a2`), await readable(tokB, `${RUN}-b0`), await readable(tokB, `${RUN}-b1`)];
      state = { balanceA: await bal(tokA, tenA), balanceB: await bal(tokB, tenB), events: e, receiptsReadable: rs };
      if (state['balanceA'] === expect.balanceA && state['balanceB'] === expect.balanceB && rs.every(s => s === 200)
        && e.total === expect.events && e.byUser['101'] === 3 && e.byUser['202'] === 2) { tInvariants = Date.now(); break; }
      await sleep(1000);
    }
    await sleep(5000);
    const finalEvents = await events();
    out['fault'] = { acksWhileDaemonDown: faultAcks };
    out['recovery'] = {
      expected: expect, observed: { ...state, eventsAfterExtra5s: finalEvents },
      secondsRestartToHealthy: (tHealthy - tRestart) / 1000,
      rtoSeconds: tInvariants ? (tInvariants - tRestart) / 1000 : null,
      // per user: a foreign event must not hide a missing one
      proofsLost: Object.entries(expect.byUser).reduce((n, [u, k]) => n + Math.max(0, k - (finalEvents.byUser[u] ?? 0)), 0),
      duplicateEvents: Object.entries(expect.byUser).reduce((n, [u, k]) => n + Math.max(0, (finalEvents.byUser[u] ?? 0) - k), 0),
      foreignEvents: Object.entries(finalEvents.byUser).filter(([u]) => !(u in expect.byUser)).reduce((n, [, k]) => n + k, 0),
      invariantsHeld: tInvariants !== null && finalEvents.total === expect.events,
    };
    console.log('recovery', JSON.stringify(out['recovery']));
  } finally {
    out['apiLogTail'] = api?.log.join('').split('\n').filter(l => /proof|prover|pending|restore|pg_store/i.test(l)).slice(-15);
    await kill(daemon); await kill(api);
    out['finished'] = new Date().toISOString();
    fs.writeFileSync(path.join(outDir, `full_stack_drill_${RUN}.json`), JSON.stringify(out, null, 2));
    provider.destroy();
  }
  return (out['recovery'] as { invariantsHeld?: boolean } | undefined)?.invariantsHeld ? 0 : 1;
}

main().then(c => process.exit(c), e => { console.error(e); process.exit(2); });
