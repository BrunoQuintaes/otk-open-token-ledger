/**
 * Rehearsal of the API server against real PostgreSQL and Redis (session 2026-09-29/30).
 *
 * Services: infra/test/docker-compose.services.yml (project otk-test, loopback ports).
 * Server: src/api/server.ts in child processes (real bootstrap: secrets, stores, CW runtime).
 * Each scenario uses its own tenants and requestId prefix, so nothing is deleted.
 * Output: JSON with expected vs observed per check, read back from HTTP, PG and Redis.
 *
 *   npx tsx scripts/rehearsal/services_rehearsal.ts --out=<dir> [--only=S1,S3]
 * Exit 0 = every check matched its expectation; 1 = at least one did not; 2 = setup error.
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import IORedis from 'ioredis';
import { deriveEpoch } from '../../src/types/receipt.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const isWin = process.platform === 'win32';
const TSX = path.join(ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');
const PG_URL = process.env['OTK_TEST_PG_URL'] ?? 'postgres://otk:otk-test-only@127.0.0.1:55432/otk';
const REDIS_URL = process.env['OTK_TEST_REDIS_URL'] ?? 'redis://:otk-test-only@127.0.0.1:56379';
const PG_CONTAINER = 'otk-test-postgres-1';
const RUN = Date.now().toString(36);
const TS = Math.floor(Date.now() / 1000);
const EPOCH = String(deriveEpoch(TS));
const ADMIN_KEY = 'rehearsal-admin-fixture';

interface Check { id: string; expected: unknown; observed: unknown; matched: boolean; note?: string }
const results: Record<string, { description: string; checks: Check[]; log: string[] }> = {};
let current = '';
const check = (id: string, expected: unknown, observed: unknown, note?: string) => {
  const matched = JSON.stringify(expected) === JSON.stringify(observed);
  results[current]!.checks.push({ id, expected, observed, matched, note });
  console.log(`  [${matched ? 'match' : 'DIFF '}] ${id}: expected=${JSON.stringify(expected)} observed=${JSON.stringify(observed)}`);
};
const note = (s: string) => { results[current]!.log.push(s); console.log(`  · ${s}`); };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const a = s.address(); s.close(() => (a && typeof a === 'object' ? resolve(a.port) : reject(new Error('port')))); });
  });
}

interface Api { proc: ChildProcess; port: number; stderr: string[] }
async function startApi(env: Record<string, string>): Promise<Api> {
  const port = await freePort();
  const [cmd, args] = isWin ? ['cmd.exe', ['/c', TSX, 'src/api/server.ts']] : [TSX, ['src/api/server.ts']];
  const base: NodeJS.ProcessEnv = { ...process.env };
  for (const k of ['OTK_DB_URL', 'OTK_REDIS_URL', 'OTK_RECEIPT_LOG', 'OTK_TENANTS']) delete base[k];
  const proc = spawn(cmd, args, { cwd: ROOT, env: { ...base, NODE_ENV: 'test', OTK_ADMIN_KEY: ADMIN_KEY, PROVER_URL: 'disabled', ...env, API_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  const stderr: string[] = [];
  proc.stdout?.on('data', d => stderr.push(String(d)));
  proc.stderr?.on('data', d => stderr.push(String(d)));
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(800) }); if (r.ok) return { proc, port, stderr }; } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 300));
  }
  throw new Error(`api did not start: ${stderr.join('').slice(-2000)}`);
}

/** Abrupt stop (no graceful shutdown): what a crash or OOM kill looks like. */
async function killApi(a: Api): Promise<void> {
  if (!a.proc.pid || a.proc.exitCode !== null) return;
  const exited = new Promise<void>(r => a.proc.on('exit', () => r()));
  if (isWin) spawnSync('taskkill', ['/F', '/T', '/PID', String(a.proc.pid)], { stdio: 'ignore' });
  else a.proc.kill('SIGKILL');
  await Promise.race([exited, new Promise(r => setTimeout(r, 5000))]);
}

const receiptBody = (requestId: string, cu: number, userId = 1, nonce = 1) => ({
  requestId, provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 2000,
  costUnits: cu, latencyMs: 10, timestamp: TS, userId: String(userId), nonce: String(nonce),
});
async function postReceipt(a: Api, token: string, body: unknown): Promise<number> {
  const r = await fetch(`http://127.0.0.1:${a.port}/receipts`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
  await r.text();
  return r.status;
}
async function getJson(a: Api, token: string, p: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${a.port}${p}`, { headers: { authorization: `Bearer ${token}` } });
  const t = await r.text();
  let body: Record<string, unknown> = {};
  try { body = JSON.parse(t) as Record<string, unknown>; } catch { body = { raw: t.slice(0, 300) }; }
  return { status: r.status, body };
}
async function balance(a: Api, token: string, tenant: string): Promise<string | null> {
  const r = await getJson(a, token, `/accounting/balance?tenantId=${tenant}&epochId=${EPOCH}`);
  return r.status === 200 ? String(r.body['totalCU']) : `http_${r.status}`;
}

const pool = new pg.Pool({ connectionString: PG_URL, max: 2 });
// Idle clients get an error when PG is stopped on purpose (S2b); keep the rehearsal alive.
pool.on('error', () => {});
const pgRows = async (prefix: string) => (await pool.query('SELECT request_id, receipt_json FROM otk_receipts WHERE request_id LIKE $1 ORDER BY request_id', [`${prefix}%`])).rows as { request_id: string; receipt_json: Record<string, unknown> }[];
const redis = new IORedis(REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 1 });
const redisTal = async (tenant: string) => redis.hgetall(`otk:tal:${tenant}:${EPOCH}`);
const docker = (...args: string[]) => spawnSync('docker', args, { encoding: 'utf8' });

function scenario(id: string, description: string): void {
  current = id;
  results[id] = { description, checks: [], log: [] };
  console.log(`\n${id}: ${description}`);
}

const SCENARIOS: Record<string, () => Promise<void>> = {
  // S1 — PostgreSQL write-behind only (no JSONL, no Redis): restart restores receipts and balances?
  async S1() {
    scenario('S1', 'PG only: 3 receipts tenant A (3000 CU), 1 tenant B (500 CU); crash; restart; receipts, tenant and balance');
    const pre = `s1-${RUN}-`;
    const tokA = `s1a-${RUN}`, tokB = `s1b-${RUN}`;
    const tenants = `s1a-${RUN}/OPERATOR:${tokA},s1b-${RUN}/OPERATOR:${tokB}`;
    const env = { OTK_DB_URL: PG_URL, OTK_TENANTS: tenants };
    let a = await startApi(env);
    const st = [
      await postReceipt(a, tokA, receiptBody(`${pre}a1`, 3000, 1, 1)),
      await postReceipt(a, tokA, receiptBody(`${pre}a2`, 3000, 1, 2)),
      await postReceipt(a, tokA, receiptBody(`${pre}a3`, 3000, 1, 3)),
      await postReceipt(a, tokB, receiptBody(`${pre}b1`, 500, 2, 1)),
    ];
    check('acks', [201, 201, 201, 201], st);
    check('balance A before restart', '9000', await balance(a, tokA, `s1a-${RUN}`));
    await new Promise(r => setTimeout(r, 1500)); // let the write-behind land
    const rows = await pgRows(pre);
    check('PG rows after 1.5 s', 4, rows.length);
    check('PG keeps tenant of a1', `s1a-${RUN}`, rows.find(r => r.request_id === `${pre}a1`)?.receipt_json['tenantId']);
    await killApi(a);
    a = await startApi(env);
    const r1 = await getJson(a, tokA, `/receipts/${pre}a1`);
    check('receipt a1 readable after restart', 200, r1.status);
    check('receipt a1 tenant after restart', `s1a-${RUN}`, (r1.body['receipt'] as Record<string, unknown> | undefined)?.['tenantId'] ?? r1.body['tenantId']);
    check('balance A after restart (should equal before)', '9000', await balance(a, tokA, `s1a-${RUN}`));
    check('balance B after restart', '500', await balance(a, tokB, `s1b-${RUN}`));
    await killApi(a);
  },

  // S2 — PostgreSQL frozen (paused: connection open, no answer) while receipts arrive
  async S2() {
    scenario('S2', 'PG paused: 3 receipts; PG resumed; retry same ids; crash; restart: no false ack, no loss, balance after restart');
    const pre = `s2-${RUN}-`;
    const tok = `s2-${RUN}`;
    const tenant = `s2-${RUN}`;
    const env = { OTK_DB_URL: PG_URL, OTK_TENANTS: `${tenant}/OPERATOR:${tok}` };
    let a = await startApi(env);
    docker('pause', PG_CONTAINER);
    note('docker pause postgres');
    const st: number[] = [];
    const ms: number[] = [];
    try {
      for (let i = 1; i <= 3; i++) {
        const t0 = Date.now();
        st.push(await postReceipt(a, tok, receiptBody(`${pre}${i}`, 1000, 3, i)));
        ms.push(Date.now() - t0);
      }
    } finally {
      docker('unpause', PG_CONTAINER);
      note('docker unpause postgres');
    }
    note(`answer times while PG paused (ms): ${JSON.stringify(ms)}`);
    check('no acknowledgement while PG is frozen (503 within the write timeout)', [503, 503, 503], st);
    await new Promise(r => setTimeout(r, 3000));
    const landed = (await pgRows(pre)).length;
    note(`rows that landed after PG resumed (INSERT sent before the timeout): ${landed}`);
    const retry: number[] = [];
    for (let i = 1; i <= 3; i++) retry.push(await postReceipt(a, tok, receiptBody(`${pre}${i}`, 1000, 3, i)));
    check('client retry with the same ids: duplicate (200) if the row landed, new (201) otherwise', [1, 2, 3].map(i => (i <= landed ? 200 : 201)), retry);
    check('every receipt is in PG after the retry', 3, (await pgRows(pre)).length);
    check('balance before restart counts the rows that landed late', String(landed * 1000), await balance(a, tok, tenant));
    await killApi(a);
    a = await startApi(env);
    check('balance after restart = all 3 receipts', '3000', await balance(a, tok, tenant));
    await killApi(a);
  },

  // S2b — PostgreSQL stopped (connection refused) while the API acknowledges receipts
  async S2b() {
    scenario('S2b', 'PG stopped 15 s: 3 receipts acknowledged; PG started; wait; crash; restart: acknowledged receipts?');
    const pre = `s2b-${RUN}-`;
    const tok = `s2b-${RUN}`;
    const env = { OTK_DB_URL: PG_URL, OTK_TENANTS: `s2b-${RUN}/OPERATOR:${tok}` };
    let a = await startApi(env);
    docker('stop', PG_CONTAINER);
    note('docker stop postgres (data volume kept)');
    const st: number[] = [];
    try {
      for (let i = 1; i <= 3; i++) st.push(await postReceipt(a, tok, receiptBody(`${pre}${i}`, 1000, 7, i)));
      await new Promise(r => setTimeout(r, 15_000));
    } finally {
      docker('start', PG_CONTAINER);
      note('docker start postgres');
    }
    note(`acks while PG stopped: ${JSON.stringify(st)}`);
    for (let i = 0; i < 40; i++) { try { await pool.query('SELECT 1'); break; } catch { await new Promise(r => setTimeout(r, 500)); } }
    await new Promise(r => setTimeout(r, 5000));
    const failures = a.stderr.join('').split('\n').filter(l => l.includes('pg_receipt_write_failed')).length;
    note(`pg_receipt_write_failed events logged: ${failures}`);
    check('PG rows for acknowledged receipts after PG is back (5 s)', st.filter(s => s === 201).length, (await pgRows(pre)).length);
    await killApi(a);
    a = await startApi(env);
    const found: number[] = [];
    for (let i = 1; i <= 3; i++) found.push((await getJson(a, tok, `/receipts/${pre}${i}`)).status);
    check('acknowledged receipts readable after restart', st.map(s => (s === 201 ? 200 : 404)), found);
    await killApi(a);
  },

  // S3 — Redis TAL across a restart: quota and balance
  async S3() {
    scenario('S3', 'Redis TAL + JSONL off + PG off: FREE quota 10000 CU; 4×3000 CU; restart; 5th receipt');
    const pre = `s3-${RUN}-`;
    const tok = `s3-${RUN}`;
    const tenant = `s3-${RUN}`;
    const env = { OTK_REDIS_URL: REDIS_URL, OTK_TENANTS: `${tenant}/OPERATOR:${tok}` };
    await redis.connect().catch(() => {});
    let a = await startApi(env);
    const st: number[] = [];
    for (let i = 1; i <= 5; i++) st.push(await postReceipt(a, tok, receiptBody(`${pre}${i}`, 3000, 4, i)));
    check('single instance: 4 admitted, 5th refused by quota (429)', [201, 201, 201, 201, 429], st);
    await new Promise(r => setTimeout(r, 500));
    const h = await redisTal(tenant);
    check('Redis TAL totalCU', '12000', h['totalCU'] ?? null);
    await killApi(a);
    a = await startApi(env);
    check('balance after restart (Redis holds 12000)', '12000', await balance(a, tok, tenant));
    check('receipt after restart with quota already exceeded → 429', 429, await postReceipt(a, tok, receiptBody(`${pre}6`, 3000, 4, 6)));
    await new Promise(r => setTimeout(r, 500));
    note(`Redis TAL after restart: ${JSON.stringify(await redisTal(tenant))}`);
    await killApi(a);
  },

  // S4 — two instances sharing Redis (and PG): quota
  async S4() {
    scenario('S4', 'two API instances sharing Redis+PG, same tenant, FREE quota 10000 CU, receipts of 3000 CU alternating');
    const pre = `s4-${RUN}-`;
    const tok = `s4-${RUN}`;
    const tenant = `s4-${RUN}`;
    const env = { OTK_REDIS_URL: REDIS_URL, OTK_DB_URL: PG_URL, OTK_TENANTS: `${tenant}/OPERATOR:${tok}` };
    await redis.connect().catch(() => {});
    const a = await startApi(env);
    const b = await startApi(env);
    const st: string[] = [];
    for (let i = 1; i <= 8; i++) {
      const inst = i % 2 ? a : b;
      st.push(`${i % 2 ? 'A' : 'B'}:${await postReceipt(inst, tok, receiptBody(`${pre}${i}`, 3000, 5, i))}`);
    }
    note(`sequence: ${st.join(' ')}`);
    const admitted = st.filter(s => s.endsWith('201')).length;
    check('receipts admitted across two instances (one instance admits 4)', 4, admitted);
    await new Promise(r => setTimeout(r, 800));
    check('balance seen by A = balance seen by B', await balance(a, tok, tenant), await balance(b, tok, tenant));
    note(`Redis TAL: ${JSON.stringify(await redisTal(tenant))}`);
    note(`balance A=${await balance(a, tok, tenant)} B=${await balance(b, tok, tenant)}`);
    check('receipt written by A readable on B', 200, (await getJson(b, tok, `/receipts/${pre}1`)).status);
    await killApi(a); await killApi(b);
  },

  // S6 — RedisTAL debit against real Redis: idempotency and concurrency (atomic script)
  async S6() {
    scenario('S6', 'RedisTAL on real Redis: same requestId twice; 50 concurrent distinct debits; 50 concurrent copies of one id');
    const { RedisTAL } = await import('../../src/security/RedisTAL.js');
    await redis.connect().catch(() => {});
    const tal = new RedisTAL(redis, { fallbackOnError: false });
    const t = `s6-${RUN}`;
    const e = (id: string, cu: bigint) => ({ tenantId: t, epochId: EPOCH, requestId: id, provider: 'openai', model: 'gpt-4o', cu, ts: Date.now() });
    await tal.debitAsync(e('dup', 100n));
    await tal.debitAsync(e('dup', 100n));
    check('same requestId twice → counted once', { totalCU: '100', entryCount: '1' }, await redisTal(t));
    await Promise.all(Array.from({ length: 50 }, (_, i) => tal.debitAsync(e(`c${i}`, 10n))));
    check('50 concurrent distinct debits of 10 CU', { totalCU: '600', entryCount: '51' }, await redisTal(t));
    await Promise.all(Array.from({ length: 50 }, () => tal.debitAsync(e('same', 7n))));
    check('50 concurrent copies of one requestId → one debit', { totalCU: '607', entryCount: '52' }, await redisTal(t));
    check('shared balance read by a fresh instance (restart)', '607', String((await new RedisTAL(redis).balanceAsync(t, EPOCH)).totalCU));
  },

  // S7 — known residual: concurrent requests near the quota on two instances (measured, not fixed)
  async S7() {
    scenario('S7', 'two instances, FREE quota 10000 CU, 20 simultaneous receipts of 3000 CU (10 per instance)');
    const tok = `s7-${RUN}`;
    const tenant = `s7-${RUN}`;
    const env = { OTK_REDIS_URL: REDIS_URL, OTK_DB_URL: PG_URL, OTK_TENANTS: `${tenant}/OPERATOR:${tok}` };
    await redis.connect().catch(() => {});
    const a = await startApi(env);
    const b = await startApi(env);
    const st = await Promise.all(Array.from({ length: 20 }, (_, i) => postReceipt(i % 2 ? a : b, tok, receiptBody(`s7-${RUN}-${i}`, 3000, 8, i))));
    const admitted = st.filter(x => x === 201).length;
    note(`statuses: ${JSON.stringify(st)}`);
    await new Promise(r => setTimeout(r, 800));
    note(`Redis TAL: ${JSON.stringify(await redisTal(tenant))}`);
    // Sequentially 4 are admitted (quota is checked before the CU of the request is known).
    // This check documents the residual race; its expectation is the sequential behaviour.
    check('admitted under concurrency (sequential behaviour: 4)', 4, admitted, 'residual race between check and debit, not fixed');
    await killApi(a); await killApi(b);
  },

  // S7b — same race with a single instance (memory TAL, no Redis/PG)
  async S7b() {
    scenario('S7b', 'one instance, memory TAL, FREE quota 10000 CU, 20 simultaneous receipts of 3000 CU');
    const tok = `s7b-${RUN}`;
    const a = await startApi({ OTK_TENANTS: `s7b-${RUN}/OPERATOR:${tok}` });
    const st = await Promise.all(Array.from({ length: 20 }, (_, i) => postReceipt(a, tok, receiptBody(`s7b-${RUN}-${i}`, 3000, 9, i))));
    note(`statuses: ${JSON.stringify(st)}`);
    check('admitted under concurrency, single instance (sequential behaviour: 4)', 4, st.filter(x => x === 201).length, 'residual race, not fixed');
    await killApi(a);
  },

  // S7c — same race, one instance, Redis TAL + PG durable write
  async S7c() {
    scenario('S7c', 'one instance with Redis+PG, FREE quota 10000 CU, 20 simultaneous receipts of 3000 CU');
    const tok = `s7c-${RUN}`;
    const a = await startApi({ OTK_REDIS_URL: REDIS_URL, OTK_DB_URL: PG_URL, OTK_TENANTS: `s7c-${RUN}/OPERATOR:${tok}` });
    const st = await Promise.all(Array.from({ length: 20 }, (_, i) => postReceipt(a, tok, receiptBody(`s7c-${RUN}-${i}`, 3000, 10, i))));
    note(`statuses: ${JSON.stringify(st)}`);
    check('admitted under concurrency, one instance Redis+PG (sequential behaviour: 4)', 4, st.filter(x => x === 201).length, 'residual race, not fixed');
    await killApi(a);
  },

  // S8 — N14 proof-job table: receipts older than the table are marked legacy-unknown once,
  //      atomically, even when two instances initialise at the same time (fresh database)
  async S8() {
    scenario('S8', 'fresh database with 25 receipts and no otk_proof_jobs; two PostgresReceiptStore.init() at once');
    const db = `otk_s8_${RUN}`;
    await pool.query(`CREATE DATABASE ${db}`);
    note(`created test database ${db} (kept for inspection)`);
    const url = PG_URL.replace(/\/otk$/, `/${db}`);
    const p2 = new pg.Pool({ connectionString: url, max: 2 });
    p2.on('error', () => {});
    try {
      await p2.query('CREATE TABLE otk_receipts (request_id TEXT PRIMARY KEY, receipt_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
      for (let i = 0; i < 25; i++) await p2.query('INSERT INTO otk_receipts (request_id, receipt_json) VALUES ($1, $2)', [`old-${i}`, JSON.stringify({ requestId: `old-${i}` })]);
      const { PostgresReceiptStore } = await import('../../src/api/PostgresReceiptStore.js');
      const a = new PostgresReceiptStore(url), b = new PostgresReceiptStore(url);
      const r = await Promise.allSettled([a.init(), b.init()]);
      check('both inits succeed', ['fulfilled', 'fulfilled'], r.map(x => x.status));
      check('legacy rows marked exactly once in total', 25, a.legacyMarked + b.legacyMarked);
      const rows = (await p2.query("SELECT count(*)::int AS n FROM otk_proof_jobs WHERE job_id = 'legacy-unknown'")).rows[0] as { n: number };
      check('otk_proof_jobs legacy rows', 25, rows.n);
      await a.close(); await b.close();
    } finally {
      await p2.end();
    }
  },

  // S5 — plan assignment persisted in PG (R07) across restart and replicas
  async S5() {
    scenario('S5', 'PG plan store: assign PRO on instance A; restart; second instance B');
    const tok = `s5-${RUN}`;
    const tenant = `s5-${RUN}`;
    const env = { OTK_DB_URL: PG_URL, OTK_TENANTS: `${tenant}/OWNER:${tok}` };
    let a = await startApi(env);
    const r = await fetch(`http://127.0.0.1:${a.port}/admin/plans/assign`, { method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, 'x-admin-key': ADMIN_KEY }, body: JSON.stringify({ tenantId: tenant, tier: 'PRO' }) });
    const assignBody = await r.text();
    check('assign PRO', 200, r.status, assignBody.slice(0, 200));
    await new Promise(r2 => setTimeout(r2, 800));
    const pgPlan = await pool.query("SELECT to_regclass('public.otk_plan_assignments') AS t").catch(() => ({ rows: [] }));
    note(`plan table: ${JSON.stringify(pgPlan.rows)}`);
    const tier = async (x: Api) => {
      const g = await getJson(x, tok, '/admin/plans/assignments');
      const list = (g.body['assignments'] ?? []) as { tenantId: string; tier: string }[];
      return Array.isArray(list) ? (list.find(e => e.tenantId === tenant)?.tier ?? null) : g.body;
    };
    check('tier on A', 'PRO', await tier(a));
    const b = await startApi(env);
    check('tier on B started after the assignment', 'PRO', await tier(b));
    await killApi(a);
    a = await startApi(env);
    check('tier on A after restart', 'PRO', await tier(a));
    // quota behaviour follows the plan: PRO has no hard CU limit
    const st: number[] = [];
    for (let i = 1; i <= 5; i++) st.push(await postReceipt(a, tok, receiptBody(`s5-${RUN}-${i}`, 3000, 6, i)));
    check('PRO after restart: 5×3000 CU admitted (FREE would refuse the 5th)', [201, 201, 201, 201, 201], st);
    await killApi(a); await killApi(b);
  },
};

async function main(): Promise<number> {
  const out = process.argv.find(x => x.startsWith('--out='))?.slice(6);
  const only = process.argv.find(x => x.startsWith('--only='))?.slice(7)?.split(',');
  if (!out) { console.error('usage: --out=<dir> [--only=S1,S2]'); return 2; }
  fs.mkdirSync(out, { recursive: true });
  try { await pool.query('SELECT 1'); } catch (e) { console.error(`PG unreachable: ${(e as Error).message}`); return 2; }
  const started = new Date().toISOString();
  // S7 measures a known residual (race between replicas); it runs only when named in --only
  const MEASUREMENTS = new Set(['S7']);
  for (const [id, fn] of Object.entries(SCENARIOS)) {
    if (only ? !only.includes(id) : MEASUREMENTS.has(id)) continue;
    try { await fn(); } catch (e) {
      results[current] ??= { description: id, checks: [], log: [] };
      results[current]!.log.push(`ERROR ${(e as Error).message}`);
      console.log(`  ERROR ${(e as Error).message}`);
      docker('unpause', PG_CONTAINER);
    }
  }
  const file = path.join(out, `services_rehearsal_${RUN}.json`);
  const images = docker('ps', '--filter', 'name=otk-test-', '--format', '{{.Names}} {{.Image}} {{.Status}}').stdout.trim();
  fs.writeFileSync(file, JSON.stringify({ started, finished: new Date().toISOString(), run: RUN, epoch: EPOCH, pg: PG_URL.replace(/:[^:@/]+@/, ':***@'), redis: REDIS_URL.replace(/:[^:@/]*@/, ':***@'), containers: images, results }, null, 2));
  console.log(`\nevidence: ${file}`);
  await pool.end(); redis.disconnect();
  const all = Object.values(results).flatMap(r => r.checks);
  return all.length > 0 && all.every(c => c.matched) && Object.values(results).every(r => !r.log.some(l => l.startsWith('ERROR'))) ? 0 : 1;
}

main().then(c => process.exit(c), e => { console.error(e); process.exit(2); });
