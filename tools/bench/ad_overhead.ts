/**
 * FECHAMENTO_GEMINI_AD / A — overhead of the durable OTK path vs. a direct call to the SAME synthetic upstream,
 * per docs/_ops/EXECUCAO_D1_D8_20260930/runs/20260930-1625/FECHAMENTO_GEMINI_AD/A/PLANO_BENCHMARK.md (frozen before
 * measuring). Three processes: this client, the synthetic upstream (ad_upstream.ts) and the REAL entrypoint
 * (src/api/server.ts, OTK_PROXY_ENABLED=1, D1–D8 profile) on a fresh database of the fps5 PostgreSQL.
 *
 *   . scripts/ops/fps5_env.sh && bash ../control/bin/heavy_lock.sh FPS5 bench-a -- \
 *     node --import tsx tools/bench/ad_overhead.ts --out <dir> [--per-block 34] [--blocks 3] [--warmup 20]
 *
 * Writes <out>/raw.csv (every request, warm-up and failures included), resources.csv, run_manifest.json.
 * No number is computed for the report here: tools/bench/ad_report.mjs derives every table from raw.csv.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const arg = (n: string, d: string) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : d; };
const OUT = path.resolve(arg('out', ''));
const PER_BLOCK = Number(arg('per-block', '34'));
const BLOCKS = Number(arg('blocks', '3'));
const WARMUP = Number(arg('warmup', '20'));
const SEED = 20261003;
const PLAN = path.join(ROOT, 'docs/_ops/EXECUCAO_D1_D8_20260930/runs/20260930-1625/FECHAMENTO_GEMINI_AD/A/PLANO_BENCHMARK.md');
if (!arg('out', '')) { console.error('--out required'); process.exit(4); }
const adminUrl = process.env['OTK_TEST_PG_URL'];
if (!adminUrl) { console.error('OTK_TEST_PG_URL required (. scripts/ops/fps5_env.sh)'); process.exit(5); }

function mulberry32(a: number) { return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(SEED);
const shuffle = <T>(xs: T[]): T[] => { const a = [...xs]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j]!, a[i]!]; } return a; };
const freePort = () => new Promise<number>((res, rej) => { const s = net.createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => res(p)); }); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what: string, fn: () => Promise<boolean>, ms: number): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return; } catch { /* retry */ } await sleep(250); }
  throw new Error(`timeout waiting for ${what}`);
}

type Profile = 'openai' | 'anthropic' | 'gemini';
type Mode = 'json' | 'sse';
type Input = 'curta' | 'media';
interface Cell { id: string; profile: Profile; mode: Mode; input: Input; conc: number }
const PROMPT = {
  curta: { text: 'Resuma em uma frase: o medidor registra unidades por lote sem dados pessoais e sem texto do cliente.', tokens: 60 },
  media: { text: Array.from({ length: 60 }, (_, i) => `Frase ${i + 1}: o medidor registra ${i * 7} unidades no lote ${100 + i}, sem dados pessoais e sem texto do cliente.`).join(' '), tokens: 1500 },
};

function request(c: Cell, target: 'direto' | 'otk', urls: { up: string; otk: string }, token: string, opId: string): { url: string; init: RequestInit } {
  const base = target === 'otk' ? urls.otk : urls.up;
  const text = PROMPT[c.input].text;
  const h: Record<string, string> = { 'content-type': 'application/json', 'x-bench-prompt-tokens': String(PROMPT[c.input].tokens) };
  if (target === 'otk') Object.assign(h, { authorization: `Bearer ${token}`, 'x-otk-provider': c.profile, 'x-otk-operation-id': opId });
  else Object.assign(h, c.profile === 'anthropic' ? { 'x-api-key': 'bench-fixture-key' } : c.profile === 'gemini' ? { 'x-goog-api-key': 'bench-fixture-key' } : { authorization: 'Bearer bench-fixture-key' });
  let p: string; let body: unknown;
  if (c.profile === 'openai') { p = '/v1/chat/completions'; body = { model: 'gpt-4o-mini', max_tokens: 64, messages: [{ role: 'user', content: text }], ...(c.mode === 'sse' ? { stream: true, ...(target === 'direto' ? { stream_options: { include_usage: true } } : {}) } : {}) }; }
  else if (c.profile === 'anthropic') { p = '/v1/messages'; h['anthropic-version'] = '2023-06-01'; body = { model: 'claude-haiku-4-5-20251001', max_tokens: 64, messages: [{ role: 'user', content: text }], ...(c.mode === 'sse' ? { stream: true } : {}) }; }
  else { p = `/v1beta/models/gemini-2.5-flash-lite:${c.mode === 'sse' ? 'streamGenerateContent' : 'generateContent'}${c.mode === 'sse' && target === 'direto' ? '?alt=sse' : ''}`; body = { contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 0 } } }; }
  return { url: `${base}${p}`, init: { method: 'POST', headers: h, body: JSON.stringify(body) } };
}

interface Row { block: number; cell: string; profile: Profile; mode: Mode; input: Input; conc: number; path: string; seq: number; warmup: boolean; status: number | null; ok: boolean; error: string; ttfb_ms: number | null; total_ms: number | null; start_epoch_ms: number; end_epoch_ms: number; bytes: number; op_id: string }
async function one(c: Cell, target: 'direto' | 'otk', urls: { up: string; otk: string }, token: string, opId: string, block: number, seq: number, warmup: boolean): Promise<Row> {
  const { url, init } = request(c, target, urls, token, opId);
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 30_000);
  const startEpoch = Date.now(); const t0 = performance.now();
  const row: Row = { block, cell: c.id, profile: c.profile, mode: c.mode, input: c.input, conc: c.conc, path: target, seq, warmup, status: null, ok: false, error: '', ttfb_ms: null, total_ms: null, start_epoch_ms: startEpoch, end_epoch_ms: 0, bytes: 0, op_id: target === 'otk' ? opId : '' };
  try {
    const r = await fetch(url, { ...init, signal: ac.signal });
    row.status = r.status;
    const reader = r.body!.getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; if (row.ttfb_ms === null) row.ttfb_ms = performance.now() - t0; row.bytes += value!.byteLength; }
    row.total_ms = performance.now() - t0;
    row.ok = r.status === 200;
    if (!row.ok) row.error = `http_${r.status}`;
  } catch (e) { row.error = (e as Error).name === 'AbortError' ? 'timeout_30s' : `${(e as Error).name}:${(e as Error).message}`.slice(0, 120); }
  clearTimeout(timer);
  row.end_epoch_ms = Date.now();
  return row;
}

function procStats(pids: number[]): Record<string, { cpu_s: number; ws_mb: number } | null> {
  const out: Record<string, { cpu_s: number; ws_mb: number } | null> = {};
  try {
    const ps = execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Id) $($_.TotalProcessorTime.TotalSeconds) $($_.WorkingSet64)" }`], { encoding: 'utf8' });
    for (const pid of pids) out[String(pid)] = null;
    for (const line of ps.trim().split(/\r?\n/)) { const [id, cpu, ws] = line.trim().split(/\s+/); if (id) out[id] = { cpu_s: Number(cpu), ws_mb: Number(ws) / 2 ** 20 }; }
  } catch { for (const pid of pids) out[String(pid)] = null; }
  return out;
}
function pgStats(): string {
  try { return execFileSync('docker', ['stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}}', process.env['OTK_TEST_PG_CONTAINER'] ?? 'otk-d1d8-1625-fps5-postgres-1'], { encoding: 'utf8' }).trim(); } catch { return 'unavailable'; }
}

async function main(): Promise<void> {
  fs.mkdirSync(OUT, { recursive: true });
  const git = (a: string[]) => { try { return execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return 'unknown'; } };
  const canary = `bench-canary-${crypto.randomBytes(12).toString('hex')}`;
  const token = crypto.randomBytes(24).toString('hex');
  const adminToken = crypto.randomBytes(24).toString('hex');
  // SEC02-N01: raising a plan needs the platform credential
  const platformKey = crypto.randomBytes(16).toString('hex');
  const [upPort, apiPort, proxyPort] = [await freePort(), await freePort(), await freePort()];
  // child environment: nothing of ours (OTK_*, keys, secrets, the canary) leaks in
  const cleanEnv = (): NodeJS.ProcessEnv => { const e: NodeJS.ProcessEnv = {}; for (const [k, v] of Object.entries(process.env)) if (!/^OTK_|^PROVER_|^BENCH_|_API_KEY$|_SECRET$|_TOKEN$/i.test(k)) e[k] = v; return e; };
  const up = spawn(process.execPath, ['--import', 'tsx', 'tools/bench/ad_upstream.ts', '--port', String(upPort)], { cwd: ROOT, env: { ...cleanEnv(), BENCH_CANARY: canary }, stdio: ['ignore', 'pipe', 'pipe'] });
  const upUrl = `http://127.0.0.1:${upPort}`;
  await waitFor('upstream', async () => (await fetch(`${upUrl}/stats`)).ok, 60_000);
  // positive control of the canary detector, then reset
  await fetch(`${upUrl}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-probe': canary }, body: '{}' });
  const probe = await (await fetch(`${upUrl}/stats`)).json() as { canarySeen: number };
  await fetch(`${upUrl}/reset`, { method: 'POST' });

  const dbName = `otk_bench_a_${new Date().toISOString().replace(/[^0-9]/g, '').slice(0, 14)}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 }); await admin.query(`CREATE DATABASE "${dbName}"`); await admin.end();
  const u = new URL(adminUrl); u.pathname = `/${dbName}`; const dbUrl = String(u);
  const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), 'otk-bench-a-spool-'));
  const otkEnv: NodeJS.ProcessEnv = { ...cleanEnv(),
    // RUN-S (RV-RUNS-05/RV2-RUNS-02): local loopback harness; 'production-bench' behaved as development before (see runPilotV3.ts)
    NODE_ENV: 'development', OTK_PROXY_ENABLED: '1', OTK_DB_URL: dbUrl, OTK_TENANTS: `bench/OPERATOR:${token},bench/ADMIN:${adminToken}`, API_PORT: String(apiPort), OTK_PROXY_PORT: String(proxyPort),
    OTK_ADMIN_KEY: platformKey, PROVER_URL: 'disabled', OTK_RECEIPT_LOG: '', OTK_SPOOL_DIR: spoolDir, OTK_INSTANCE_ID: `${dbName}-i1`,
    OTK_CU_WEIGHTS_PROFILE: 'development-2026-10-03', OTK_PRICE_TABLE_FILES: 'scripts/pilot/price_table_pilot_v3_gemini_20261003.json', OTK_MONEY_BOUND_POLICY: 'otk.money_bound_policy.v4@2026-10-03',
    OTK_V3_OPERATOR_KEY: `0x${crypto.randomBytes(32).toString('hex')}`, OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE: '1', OTK_PROXY_FORWARD_HEADERS: 'x-bench-prompt-tokens',
    OTK_PROXY_UPSTREAM_OPENAI: upUrl, OTK_PROXY_UPSTREAM_ANTHROPIC: upUrl, OTK_PROXY_UPSTREAM_GEMINI: upUrl,
    OPENAI_API_KEY: 'bench-fixture-key', ANTHROPIC_API_KEY: 'bench-fixture-key', GEMINI_API_KEY: 'bench-fixture-key' };
  const canaryInChildEnv = Object.values(otkEnv).some((v) => typeof v === 'string' && v.includes(canary));
  const otk: ChildProcess = spawn(process.execPath, ['--import', 'tsx', 'src/api/server.ts'], { cwd: ROOT, env: otkEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const otkLog: string[] = []; otk.stdout?.on('data', (d) => otkLog.push(String(d))); otk.stderr?.on('data', (d) => otkLog.push(String(d)));
  const otkUrl = `http://127.0.0.1:${proxyPort}`;
  const urls = { up: upUrl, otk: otkUrl };
  const rows: Row[] = []; const res: string[] = ['block,phase,ts_epoch_ms,otk_cpu_s,otk_ws_mb,up_cpu_s,up_ws_mb,pg_docker_stats'];
  const sample = (block: number, phase: string) => { const s = procStats([otk.pid!, up.pid!]); const o = s[String(otk.pid)]; const p = s[String(up.pid)]; res.push([block, phase, Date.now(), o?.cpu_s ?? '', o?.ws_mb?.toFixed(1) ?? '', p?.cpu_s ?? '', p?.ws_mb?.toFixed(1) ?? '', JSON.stringify(pgStats())].join(',')); };
  const manifest: Record<string, unknown> = {
    schema: 'otk.bench_a.v1', startedAt: new Date().toISOString(), commit: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), dirty: git(['status', '--porcelain']).split('\n').filter(Boolean).length,
    planSha256: crypto.createHash('sha256').update(fs.readFileSync(PLAN)).digest('hex'), seed: SEED, perBlock: PER_BLOCK, blocks: BLOCKS, warmup: WARMUP,
    node: process.version, os: `${os.type()} ${os.release()}`, cpu: `${os.cpus().length} × ${os.cpus()[0]!.model}`, memGB: +(os.totalmem() / 2 ** 30).toFixed(1), freeMemGBAtStart: +(os.freemem() / 2 ** 30).toFixed(2),
    docker: (() => { try { return execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' }).trim(); } catch { return 'unknown'; } })(),
    containersRunning: (() => { try { return execFileSync('docker', ['ps', '--format', '{{.Names}}'], { encoding: 'utf8' }).trim().split(/\r?\n/); } catch { return []; } })(),
    database: dbName, otkPid: otk.pid, upstreamPid: up.pid,
    canary: { positiveControlSeen: probe.canarySeen, inChildEnv: canaryInChildEnv },
  };
  try {
    await waitFor('otk proxy health', async () => (await fetch(`${otkUrl}/health`)).ok, 180_000);
    await waitFor('otk api health', async () => (await fetch(`http://127.0.0.1:${apiPort}/health`)).ok, 180_000);
    // plan amendment A-01 (run 1 hit the FREE plan's CU quota and measured 429 refusals): the bench tenant gets the PRO plan
    // (no CU quota) through the real admin endpoint, before any measured request
    const asg = await fetch(`http://127.0.0.1:${apiPort}/admin/plans/assign`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${adminToken}`, 'x-admin-key': platformKey }, body: JSON.stringify({ tenantId: 'bench', tier: 'PRO' }) });
    manifest['planAssignment'] = { status: asg.status, body: await asg.json().catch(() => null) };
    if (asg.status !== 200) throw new Error(`plan assignment failed: ${asg.status}`);
    const pgc = new pg.Pool({ connectionString: dbUrl, max: 2 });
    manifest['postgres'] = (await pgc.query('SELECT version() AS v')).rows[0].v;
    const cells: Cell[] = [];
    for (const profile of ['openai', 'anthropic', 'gemini'] as Profile[]) for (const mode of ['json', 'sse'] as Mode[]) for (const input of ['curta', 'media'] as Input[]) for (const conc of [1, 8]) cells.push({ id: `${profile}-${mode}-${input}-c${conc}`, profile, mode, input, conc });
    // warm-up (excluded, recorded)
    for (const profile of ['openai', 'anthropic', 'gemini'] as Profile[]) for (const mode of ['json', 'sse'] as Mode[]) for (const target of ['direto', 'otk'] as const) {
      const c: Cell = { id: `${profile}-${mode}-curta-c1`, profile, mode, input: 'curta', conc: 1 };
      for (let i = 0; i < WARMUP; i++) rows.push(await one(c, target, urls, token, `w-${c.id}-${target}-${i}`, 0, i, true));
    }
    for (let b = 1; b <= BLOCKS; b++) {
      sample(b, 'start');
      for (const c of shuffle(cells)) {
        const order = rnd() < 0.5 ? (['direto', 'otk'] as const) : (['otk', 'direto'] as const);
        for (const target of order) {
          for (let i = 0; i < PER_BLOCK; i += c.conc) {
            const wave = Array.from({ length: Math.min(c.conc, PER_BLOCK - i) }, (_, k) => one(c, target, urls, token, `b${b}-${c.id}-${i + k}`, b, i + k, false));
            rows.push(...await Promise.all(wave));
          }
        }
      }
      sample(b, 'end');
    }
    // wait for the outbox to drain (receipts of settled operations), then read the persistence timestamps
    await waitFor('receipts', async () => {
      const r = (await pgc.query("SELECT (SELECT count(*) FROM otk_operations WHERE reservation->>'state' = 'settled')::int AS s, (SELECT count(*) FROM otk_receipts_v3)::int AS r")).rows[0];
      return r.s > 0 && r.r >= r.s;
    }, 300_000).catch((e) => { manifest['receiptsWait'] = String(e); });
    const t1 = Date.now(); const clk = Number((await pgc.query('SELECT (extract(epoch from clock_timestamp())*1000)::float8 AS t')).rows[0].t); const t2 = Date.now();
    const skew = clk - (t1 + t2) / 2; manifest['pgClockSkewMs'] = +skew.toFixed(1); manifest['pgClockProbeRttMs'] = t2 - t1;
    const ops = new Map<string, { upd: number; exec: string; meas: string; res: string }>();
    for (const r of (await pgc.query("SELECT operation_id, (extract(epoch from updated_at)*1000)::float8 AS u, execution, measurement, reservation->>'state' AS st FROM otk_operations")).rows) ops.set(r.operation_id, { upd: Number(r.u) - skew, exec: r.execution, meas: r.measurement, res: r.st });
    const rec = new Map<string, number>();
    for (const r of (await pgc.query('SELECT operation_id, (extract(epoch from created_at)*1000)::float8 AS c FROM otk_receipts_v3')).rows) rec.set(r.operation_id, Number(r.c) - skew);
    manifest['otkOperations'] = ops.size; manifest['receiptsV3'] = rec.size;
    manifest['opsNotSettled'] = [...ops.values()].filter((o) => o.res !== 'settled').length;
    const header = 'block,cell,profile,mode,input,conc,path,seq,warmup,status,ok,error,ttfb_ms,total_ms,start_epoch_ms,end_epoch_ms,bytes,op_id,op_execution,op_measurement,op_reservation,final_lag_ms,receipt_lag_ms';
    const lines = rows.map((r) => {
      const o = r.op_id ? ops.get(r.op_id) : undefined; const rc = r.op_id ? rec.get(r.op_id) : undefined;
      return [r.block, r.cell, r.profile, r.mode, r.input, r.conc, r.path, r.seq, r.warmup, r.status ?? '', r.ok, r.error, r.ttfb_ms?.toFixed(3) ?? '', r.total_ms?.toFixed(3) ?? '', r.start_epoch_ms, r.end_epoch_ms, r.bytes, r.op_id,
        o?.exec ?? '', o?.meas ?? '', o?.res ?? '', o ? (o.upd - r.end_epoch_ms).toFixed(1) : '', rc !== undefined ? (rc - r.end_epoch_ms).toFixed(1) : ''].join(',');
    });
    fs.writeFileSync(path.join(OUT, 'raw.csv'), [header, ...lines].join('\n') + '\n');
    fs.writeFileSync(path.join(OUT, 'resources.csv'), res.join('\n') + '\n');
    await pgc.end();
  } finally {
    const stats = await (await fetch(`${upUrl}/stats`).catch(() => null))?.json().catch(() => null) as { requests: number; canarySeen: number } | null;
    (manifest['canary'] as Record<string, unknown>)['seenByUpstreamDuringRun'] = stats?.canarySeen ?? null;
    manifest['upstreamRequests'] = stats?.requests ?? null;
    otk.kill('SIGKILL'); up.kill('SIGKILL');
    manifest['finishedAt'] = new Date().toISOString();
    manifest['otkLogHasToken'] = otkLog.join('').includes(token) || otkLog.join('').includes(adminToken);
    fs.writeFileSync(path.join(OUT, 'otk_entrypoint.log.txt'), otkLog.join('').split(token).join('[REDACTED]').split(adminToken).join('[REDACTED]'));
    fs.writeFileSync(path.join(OUT, 'run_manifest.json'), JSON.stringify(manifest, null, 2));
  }
  const failed = rows.filter((r) => !r.ok).length;
  console.log(JSON.stringify({ rows: rows.length, failed, canary: manifest['canary'] }));
}
main().then(() => process.exit(0), (e) => { console.error(String((e as Error)?.stack ?? e)); process.exit(1); });
