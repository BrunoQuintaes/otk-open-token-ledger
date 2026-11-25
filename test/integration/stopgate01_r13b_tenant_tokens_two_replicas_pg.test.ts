/**
 * STOPGATE-01 P1.1 (R-13b): registry tokens created at runtime (POST/PUT/DELETE /admin/tenants, POST
 * /admin/tenants/reload) on two REAL API server processes over one real, disposable PostgreSQL. Runs only with
 * OTK_TEST_PG_URL; skipped otherwise. Tables live in the schema stopgate01_r13b (dropped and recreated).
 *
 * Before the fix the tenant registry was per process (memory + an optional local JSONL): a token created on A was 401 on
 * B, a token rotated or removed on A kept the state B had, and a reload on A changed A only. The contract checked here:
 * every request that STARTS after the registry change committed sees it on every replica; unknown tokens are never
 * admitted; OTK_TENANTS deployments without registry rows keep working; a store outage never admits a token whose state
 * is unknown on a privileged or spending request.
 *
 * Strategy / scenarios (numbered as in the test names): a tenant created on A is valid on B; rotation on A; tenant
 * deletion on A (and deletion through B of a tenant created on A); unknown and cross-tenant tokens; a reload on A
 * propagating to B while an environment-configured token stays valid; a token already bound to one tenant cannot be
 * bound to another through the other replica; restart of B and a registry store outage on B (fail closed), then
 * recovery. Replica B reaches PostgreSQL through a TCP relay owned by the test so the outage hits B only.
 *
 * Under test: the API server entrypoint `src/api/server.ts` as a black box over HTTP, with its PostgreSQL-backed
 * tenant registry.
 *
 * Needs: `OTK_TEST_PG_URL` (disposable database); two API child processes started with `node_modules/tsx`, each on
 * a free 127.0.0.1 port, with a minimal environment built here (random admin, JWT and token values generated per
 * run; only `PATH`, `HOME` and `SYSTEMROOT` come from the caller's environment); up to 300 s. Optional
 * `SG01_EVIDENCE_OUT`: a file path where the run's measurements are written as JSON.
 *
 * Run just this file: `npx tsx --test test/integration/stopgate01_r13b_tenant_tokens_two_replicas_pg.test.ts`
 *
 * @module test/integration/stopgate01_r13b_tenant_tokens_two_replicas_pg.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PG_URL = process.env['OTK_TEST_PG_URL'];
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

const SCHEMA = 'stopgate01_r13b';
const STATIC = 'sg01-static-owner-token-' + crypto.randomBytes(12).toString('hex');
const ADMIN = 'sg01-admin-key-' + crypto.randomBytes(12).toString('hex');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');
const tok = (p: string) => `sg01-${p}-` + crypto.randomBytes(16).toString('hex');

function relay(target: { host: string; port: number }) {
  let down = false;
  const sockets = new Set<net.Socket>();
  const server = net.createServer((c) => {
    if (down) { c.destroy(); return; }
    const u = net.connect(target.port, target.host);
    sockets.add(c); sockets.add(u);
    c.pipe(u); u.pipe(c);
    const end = () => { c.destroy(); u.destroy(); sockets.delete(c); sockets.delete(u); };
    c.on('error', end); u.on('error', end); c.on('close', end); u.on('close', end);
  });
  return {
    listen: () => new Promise<number>((r) => server.listen(0, '127.0.0.1', () => r((server.address() as net.AddressInfo).port))),
    cut() { down = true; for (const s of sockets) s.destroy(); sockets.clear(); },
    restore() { down = false; },
    close: () => new Promise<void>((r) => { for (const s of sockets) s.destroy(); server.close(() => r()); }),
  };
}

async function freePort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const p = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return p;
}

type Replica = { name: string; port: number; proc: ChildProcess; log: string[] };

async function startReplica(name: string, dbUrl: string): Promise<Replica> {
  const port = await freePort();
  const env: Record<string, string> = {
    PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '/tmp', SYSTEMROOT: process.env['SYSTEMROOT'] ?? '',
    NODE_ENV: 'test', API_PORT: String(port), OTK_DB_URL: dbUrl, OTK_TENANTS: `acme/OWNER:${STATIC}`, OTK_ADMIN_KEY: ADMIN,
    OTK_JWT_SECRET: JWT_SECRET, OTK_SUBJECT_STATUS_TTL_MS: '600000', OTK_LOG_LEVEL: 'warn', OTK_PG_STATEMENT_TIMEOUT_MS: '2000',
  };
  const proc = spawn(process.execPath, [TSX, 'src/api/server.ts'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const log: string[] = [];
  proc.stdout!.on('data', (d) => log.push(String(d)));
  proc.stderr!.on('data', (d) => log.push(String(d)));
  const t0 = Date.now();
  for (;;) {
    try { const r = await fetch(`http://127.0.0.1:${port}/health`); if (r.ok) break; } catch { /* not yet */ }
    if (Date.now() - t0 > 60_000 || proc.exitCode !== null) throw new Error(`${name} did not start: ${log.join('').slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  return { name, port, proc, log };
}

async function stopReplica(r: Replica | undefined): Promise<void> {
  if (!r) return;
  if (r.proc.exitCode === null && r.proc.signalCode === null) {
    await new Promise<void>((res) => { r.proc.once('exit', () => res()); r.proc.kill('SIGKILL'); });
  }
  r.proc.stdout?.destroy(); r.proc.stderr?.destroy(); r.proc.unref();
}

async function call(r: Replica, method: string, p: string, opts: { token?: string; body?: unknown; admin?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (opts.admin) { headers['x-admin-key'] = ADMIN; headers['authorization'] = `Bearer ${STATIC}`; }
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${r.port}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, json };
}

const READ = '/analytics/cu-trend'; // plain read (not strict)
const STRICT = '/keys'; // privileged read (strict)

/* eslint-disable @typescript-eslint/no-explicit-any */
describe(PG_URL ? 'STOPGATE-01 R-13b runtime registry tokens on two replicas (OTK_TEST_PG_URL set)' : 'STOPGATE-01 R-13b runtime registry tokens on two replicas (SKIPPED — set OTK_TEST_PG_URL)', { skip: !PG_URL, timeout: 300_000 }, () => {
  let A: Replica | undefined; let B: Replica | undefined;
  let pool: any;
  let rel: ReturnType<typeof relay>;
  let urlB = '';
  const evidence: Record<string, unknown> = {};

  before(async () => {
    const pg = await import('pg');
    const Pool = (pg as any).default?.Pool ?? (pg as any).Pool;
    const schemaUrl = new URL(PG_URL!); schemaUrl.searchParams.set('options', `-c search_path=${SCHEMA}`);
    pool = new Pool({ connectionString: PG_URL, max: 2 });
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.end();
    pool = new Pool({ connectionString: schemaUrl.toString(), max: 2 });
    const u = new URL(PG_URL!);
    rel = relay({ host: u.hostname, port: Number(u.port || 5432) });
    const relayPort = await rel.listen();
    const ub = new URL(schemaUrl.toString()); ub.hostname = '127.0.0.1'; ub.port = String(relayPort); urlB = ub.toString();
    A = await startReplica('A', schemaUrl.toString());
    B = await startReplica('B', urlB);
  });

  after(async () => {
    await stopReplica(A); await stopReplica(B);
    await rel?.close(); await pool?.end();
    if (process.env['SG01_EVIDENCE_OUT']) {
      const fs = await import('node:fs');
      fs.writeFileSync(process.env['SG01_EVIDENCE_OUT'], JSON.stringify(evidence, null, 2));
    }
  });

  it('1: tenant created on A → its token is valid on B (plain and privileged reads)', async () => {
    const t = tok('t1');
    const c = await call(A!, 'POST', '/admin/tenants', { admin: true, body: { tenantId: 'r13b-one', token: t, role: 'OWNER' } });
    assert.equal(c.status, 201, JSON.stringify(c.json));
    assert.equal((await call(A!, 'GET', READ, { token: t })).status, 200, 'valid on A');
    const onB = await call(B!, 'GET', READ, { token: t });
    evidence['createdOnA_plainReadOnB'] = onB.status;
    assert.equal(onB.status, 200, 'created on A, valid on B');
    assert.equal((await call(B!, 'GET', STRICT, { token: t })).status, 200, 'privileged read on B');
  });

  it('2: rotation on A → old token refused on B at the next request, new token valid on B', async () => {
    const t = tok('t2'); const t2 = tok('t2new');
    assert.equal((await call(A!, 'POST', '/admin/tenants', { admin: true, body: { tenantId: 'r13b-rot', token: t, role: 'OWNER' } })).status, 201);
    assert.equal((await call(B!, 'GET', READ, { token: t })).status, 200, 'B knows the first token');
    const r = await call(A!, 'PUT', '/admin/tenants/r13b-rot', { admin: true, body: { token: t2 } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const old = await call(B!, 'GET', READ, { token: t });
    evidence['rotatedOnA_oldTokenPlainReadOnB'] = old.status;
    assert.equal(old.status, 401, 'old token refused on B (plain read included)');
    assert.equal((await call(B!, 'GET', STRICT, { token: t })).status, 401);
    assert.equal((await call(B!, 'GET', READ, { token: t2 })).status, 200, 'new token valid on B');
  });

  it('3: tenant deleted on A → token refused on B; tenant created on A deleted from B', async () => {
    const t = tok('t3');
    assert.equal((await call(A!, 'POST', '/admin/tenants', { admin: true, body: { tenantId: 'r13b-del', token: t, role: 'OWNER' } })).status, 201);
    assert.equal((await call(B!, 'GET', READ, { token: t })).status, 200);
    assert.equal((await call(A!, 'DELETE', '/admin/tenants/r13b-del', { admin: true })).status, 200);
    assert.equal((await call(B!, 'GET', READ, { token: t })).status, 401, 'deleted on A → refused on B (plain read)');
    assert.equal((await call(B!, 'GET', STRICT, { token: t })).status, 401);
    const t4 = tok('t4');
    assert.equal((await call(A!, 'POST', '/admin/tenants', { admin: true, body: { tenantId: 'r13b-delb', token: t4, role: 'OWNER' } })).status, 201);
    const delB = await call(B!, 'DELETE', '/admin/tenants/r13b-delb', { admin: true });
    evidence['createdOnA_deleteOnB'] = delB.status;
    assert.equal(delB.status, 200, `B can deactivate a tenant created on A (${JSON.stringify(delB.json)})`);
    assert.equal((await call(A!, 'GET', READ, { token: t4 })).status, 401, 'refused on A after B deactivated it');
  });

  it('4: unknown and cross-tenant tokens are never admitted', async () => {
    assert.equal((await call(B!, 'GET', READ, { token: tok('never-registered') })).status, 401);
    const t = tok('t5');
    assert.equal((await call(A!, 'POST', '/admin/tenants', { admin: true, body: { tenantId: 'r13b-x', token: t, role: 'OWNER' } })).status, 201);
    const own = await call(B!, 'GET', '/invoices?tenantId=r13b-x', { token: t });
    assert.equal(own.status, 200, JSON.stringify(own.json));
    const cross = await call(B!, 'GET', '/invoices?tenantId=acme', { token: t });
    assert.equal(cross.status, 403, `cross-tenant read refused on B (${JSON.stringify(cross.json)})`);
    // the registry rows never hold the token itself
    const { rows } = await pool.query('SELECT * FROM otk_tenant_tokens');
    const dump = JSON.stringify(rows);
    assert.ok(!dump.includes(t), 'no plaintext token in the shared table');
  });

  it('5: reload on A propagates to B (added token valid, removed token refused); OTK_TENANTS token still valid', async () => {
    const r = tok('reload');
    let rl = await call(A!, 'POST', '/admin/tenants/reload', { admin: true, body: { tenants: `acme/OWNER:${STATIC},beta/OWNER:${r}` } });
    assert.equal(rl.status, 200, JSON.stringify(rl.json));
    assert.equal((await call(B!, 'GET', READ, { token: r })).status, 200, 'token added by a reload on A is valid on B');
    rl = await call(A!, 'POST', '/admin/tenants/reload', { admin: true, body: { tenants: `acme/OWNER:${STATIC}` } });
    assert.equal(rl.status, 200);
    assert.equal((await call(B!, 'GET', READ, { token: r })).status, 401, 'token removed by a reload on A is refused on B');
    assert.equal((await call(B!, 'GET', READ, { token: STATIC })).status, 200, 'OTK_TENANTS token (no row) keeps working');
    // cycle 2 (review MED-1): a token loaded from OTK_TENANTS and kept by the reload gets no row (the environment keeps
    // deciding it; removing it from OTK_TENANTS later is not overridden by a stale active row)
    const sh = crypto.createHash('sha256').update(STATIC).digest('hex');
    const { rows } = await pool.query('SELECT 1 FROM otk_tenant_tokens WHERE token_hash = $1', [sh]);
    assert.equal(rows.length, 0, 'no row for the OTK_TENANTS token kept by the reload');
  });

  it('7 (cycle 2, review MED-3): a token bound to a tenant on A cannot be bound to another tenant on B', async () => {
    const t = tok('dup');
    assert.equal((await call(A!, 'POST', '/admin/tenants', { admin: true, body: { tenantId: 'r13b-owner', token: t, role: 'VIEWER' } })).status, 201);
    const dup = await call(B!, 'POST', '/admin/tenants', { admin: true, body: { tenantId: 'r13b-thief', token: t, role: 'OWNER' } });
    evidence['crossReplicaDuplicateCreateOnB'] = dup.status;
    assert.equal(dup.status, 409, JSON.stringify(dup.json));
    const own = await call(B!, 'GET', '/invoices?tenantId=r13b-owner', { token: t });
    assert.notEqual(own.status, 401, 'still the original tenant on B');
    assert.equal((await call(B!, 'GET', '/invoices?tenantId=r13b-thief', { token: t })).status, 403, 'never the other tenant');
    const { rows } = await pool.query('SELECT tenant_id, role FROM otk_tenant_tokens WHERE token_hash = $1', [crypto.createHash('sha256').update(t).digest('hex')]);
    assert.deepEqual(rows.map((r: any) => [r.tenant_id, r.role]), [['r13b-owner', 'VIEWER']]);
  });

  it('6: restart of B and registry store failure on B (fail closed), then recovery', async () => {
    const live = tok('live'); const dead = tok('dead');
    assert.equal((await call(A!, 'POST', '/admin/tenants', { admin: true, body: { tenantId: 'r13b-live', token: live, role: 'OWNER' } })).status, 201);
    assert.equal((await call(A!, 'POST', '/admin/tenants', { admin: true, body: { tenantId: 'r13b-dead', token: dead, role: 'OWNER' } })).status, 201);
    assert.equal((await call(A!, 'DELETE', '/admin/tenants/r13b-dead', { admin: true })).status, 200);
    await stopReplica(B); B = await startReplica('B', urlB);
    assert.equal((await call(B!, 'GET', READ, { token: live })).status, 200, 'after restart: live token valid on B');
    assert.equal((await call(B!, 'GET', READ, { token: dead })).status, 401, 'after restart: deleted token refused on B');
    const n = 50; const t0 = performance.now();
    for (let i = 0; i < n; i++) assert.equal((await call(B!, 'GET', READ, { token: live })).status, 200);
    evidence['registryTokenPlainReadMeanMsOnB'] = Number(((performance.now() - t0) / n).toFixed(2));
    const unseen = tok('unseen');
    assert.equal((await call(A!, 'POST', '/admin/tenants', { admin: true, body: { tenantId: 'r13b-unseen', token: unseen, role: 'OWNER' } })).status, 201);
    rel.cut();
    const s1 = await call(B!, 'GET', STRICT, { token: live });
    const s2 = await call(B!, 'GET', READ, { token: unseen });
    const s3 = await call(B!, 'GET', READ, { token: STATIC });
    evidence['outageOnB'] = { learnedTokenPrivileged: s1.status, unseenTokenPlainRead: s2.status, envTokenPlainRead: s3.status };
    assert.equal(s1.status, 503, `privileged request with a registry token whose state is unknown → 503 (${JSON.stringify(s1.json)})`);
    assert.equal(s2.status, 401, 'a token B never saw cannot be learned during the outage → refused');
    assert.equal(s3.status, 200, 'OTK_TENANTS token, plain read: snapshot (documented residual, no spend and no privilege)');
    assert.equal((await call(A!, 'GET', READ, { token: unseen })).status, 200, 'A unaffected');
    rel.restore();
    let rec = 0;
    for (let i = 0; i < 50 && rec !== 200; i++) {
      rec = (await call(B!, 'GET', READ, { token: unseen })).status;
      if (rec !== 200) await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(rec, 200, 'B recovers when the database answers again');
  });
});
