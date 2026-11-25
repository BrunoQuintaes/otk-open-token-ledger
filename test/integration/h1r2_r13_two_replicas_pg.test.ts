/**
 * H1R2 R-13 / R-14 / A3 (H1 final closure run): two REAL API server processes (replicas A and B) over one real,
 * disposable PostgreSQL. Runs only with OTK_TEST_PG_URL (tables otk_* are dropped first); skipped otherwise.
 *
 * Tables live in the schema h1r2_r13_replicas (dropped and recreated), never in the shared default schema.
 * Replica B reaches PostgreSQL through a TCP relay owned by the test, so the database can be cut for B alone (store
 * outage) without touching A or other users of the server. The subject-status TTL is 10 minutes on both replicas: a
 * pass here cannot come from the periodic snapshot, only from the per-request authority.
 *
 * Scenario (prompt H1 final closure, A1 minimum test): create on A → valid on B; revoke on A → refused on B without
 * restart; rotation; tenant (a /signup organization, R-14) deactivated on A; SCIM-deprovisioned author; restart of B;
 * database failure on B (fail closed) and recovery. Also measures the per-request lookup cost and the revocation window.
 *
 * In plain terms: a revocation, rotation, tenant deactivation or user deprovisioning done through one API replica
 * must be enforced by the other replica on its very next request, and a replica that loses its database must refuse
 * credentials instead of trusting a stale cache. Two extra cases cover an open event stream that must close after
 * its key is revoked elsewhere, and a user without any membership who must get no token.
 *
 * Under test: the API server entrypoint `src/api/server.ts` as a black box over HTTP (signup, login, key
 * management, admin tenant deactivation, SCIM deprovisioning), backed by its PostgreSQL stores.
 *
 * Needs: `OTK_TEST_PG_URL` (disposable database; the test creates and drops its own schema); two API child
 * processes started with `node_modules/tsx`, each on a free 127.0.0.1 port, with a minimal environment built here
 * (random admin, SCIM, JWT and static tenant credentials generated per run; no value comes from the caller's
 * environment except `PATH` and `HOME`); up to 240 s; some fixed waits of about 1 s. Optional `H1R2_EVIDENCE_OUT`:
 * a file path where the measured timings are written as JSON after the run.
 *
 * Run just this file: `npx tsx --test test/integration/h1r2_r13_two_replicas_pg.test.ts`
 *
 * @module test/integration/h1r2_r13_two_replicas_pg.test
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

const SCHEMA = 'h1r2_r13_replicas';
const STATIC = 'h1r2-static-owner-token-' + crypto.randomBytes(12).toString('hex');
const ADMIN = 'h1r2-admin-key-' + crypto.randomBytes(12).toString('hex');
const SCIM = 'h1r2-scim-bearer-' + crypto.randomBytes(12).toString('hex');
const JWT_SECRET = crypto.randomBytes(32).toString('hex');

/**
 * TCP relay that can refuse/cut every connection (database outage seen by one replica only).
 *
 * @param target - Host and port of the real PostgreSQL server.
 * @returns Controls: `listen` (resolves the relay's 127.0.0.1 port), `cut`, `restore` and `close`.
 */
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
    PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '/tmp', NODE_ENV: 'test',
    API_PORT: String(port), OTK_DB_URL: dbUrl, OTK_TENANTS: `acme/OWNER:${STATIC}`, OTK_ADMIN_KEY: ADMIN,
    OTK_JWT_SECRET: JWT_SECRET, OTK_SCIM_BEARER_TOKEN: SCIM, OTK_SUBJECT_STATUS_TTL_MS: '600000', OTK_SSE_REAUTH_MS: '300',
    OTK_LOG_LEVEL: 'warn', OTK_PG_STATEMENT_TIMEOUT_MS: '2000',
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

async function call(r: Replica, method: string, p: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.token) headers['authorization'] = `Bearer ${opts.token}`;
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${r.port}${p}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text); } catch { /* html or empty */ }
  return { status: res.status, json };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
describe(PG_URL ? 'H1R2 R-13 two replicas on PostgreSQL (OTK_TEST_PG_URL set)' : 'H1R2 R-13 two replicas on PostgreSQL (SKIPPED — set OTK_TEST_PG_URL)', { skip: !PG_URL, timeout: 240_000 }, () => {
  let A: Replica | undefined; let B: Replica | undefined;
  let pool: any;
  let rel: ReturnType<typeof relay>;
  let urlB = '';
  const evidence: Record<string, unknown> = {};

  async function signupVerified(email: string) {
    const s = await call(A!, 'POST', '/signup', { body: { email, password: 'Str0ng-pass-h1r2!', name: 'R2 Test', orgName: `org ${email}` } });
    assert.equal(s.status, 201, JSON.stringify(s.json));
    await pool.query('UPDATE otk_users SET email_verified = TRUE WHERE id = $1', [s.json['userId']]); // fixture: e-mail verified
    await new Promise((r) => setTimeout(r, 1100)); // the login JWT must be issued after the signup second
    const l = await call(A!, 'POST', '/login', { body: { email, password: 'Str0ng-pass-h1r2!' } });
    assert.equal(l.status, 200, JSON.stringify(l.json));
    return { userId: String(s.json['userId']), orgId: String(s.json['orgId']), jwt: String(l.json['token']) };
  }
  async function mintKey(r: Replica, token: string) {
    const k = await call(r, 'POST', '/keys', { token, body: { label: 'r2', role: 'OWNER' } });
    assert.equal(k.status, 201, JSON.stringify(k.json));
    return k.json['key'] as { keyId: string; rawKey: string };
  }

  before(async () => {
    const pg = await import('pg');
    const Pool = (pg as any).default?.Pool ?? (pg as any).Pool;
    // own schema: the replicas create their tables there, so other PostgreSQL-gated suites sharing the database (and
    // running concurrently) are not touched, and this suite does not depend on their tables
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
    if (process.env['H1R2_EVIDENCE_OUT']) {
      const fs = await import('node:fs');
      fs.writeFileSync(process.env['H1R2_EVIDENCE_OUT'], JSON.stringify(evidence, null, 2));
    }
  });

  it('1-6: key created on A is valid on B; revoked on A → refused on B at the next request (no restart)', async () => {
    const u = await signupVerified(`r2-a-${Date.now()}@example.test`);
    const k = await mintKey(A!, u.jwt);
    assert.equal((await call(B!, 'GET', '/keys', { token: k.rawKey })).status, 200, 'created on A, valid on B');
    assert.equal((await call(B!, 'GET', '/analytics/cu-trend', { token: k.rawKey })).status, 200, 'non-strict read on B');
    const t0 = Date.now();
    assert.equal((await call(A!, 'DELETE', `/keys/${k.keyId}`, { token: u.jwt })).status, 200);
    const tRevoked = Date.now();
    const first = await call(B!, 'GET', '/keys', { token: k.rawKey });
    evidence['revocationWindow'] = { revokeMs: tRevoked - t0, firstRequestOnBAfterRevokeStatus: first.status, requestsAdmittedOnBAfterRevoke: first.status === 200 ? 1 : 0 };
    assert.equal(first.status, 401, 'refused on B at the first request after the revocation committed');
    assert.equal((await call(B!, 'GET', '/analytics/cu-trend', { token: k.rawKey })).status, 401, 'read-only route refused too');
  });

  it('7: rotation on A → old key refused on B, new key valid on B', async () => {
    const u = await signupVerified(`r2-rot-${Date.now()}@example.test`);
    const k = await mintKey(A!, u.jwt);
    assert.equal((await call(B!, 'GET', '/keys', { token: k.rawKey })).status, 200);
    const rot = await call(A!, 'POST', `/keys/${k.keyId}/rotate`, { token: u.jwt });
    assert.equal(rot.status, 200, JSON.stringify(rot.json));
    const fresh = (rot.json['key'] as { rawKey: string }).rawKey;
    assert.equal((await call(B!, 'GET', '/keys', { token: k.rawKey })).status, 401);
    assert.equal((await call(B!, 'GET', '/keys', { token: fresh })).status, 200);
  });

  it('8 + R-14: /signup organization deactivated on A (DELETE /admin/tenants/:org) → its key and JWT refused on B; reactivation keeps old keys refused', async () => {
    const u = await signupVerified(`r2-org-${Date.now()}@example.test`);
    const k = await mintKey(A!, u.jwt);
    assert.equal((await call(B!, 'GET', '/keys', { token: k.rawKey })).status, 200);
    const del = await call(A!, 'DELETE', `/admin/tenants/${encodeURIComponent(u.orgId)}`, { headers: { 'x-admin-key': ADMIN }, token: STATIC });
    assert.equal(del.status, 200, `R-14: a /signup org can be deactivated (${JSON.stringify(del.json)})`);
    assert.equal((await call(B!, 'GET', '/keys', { token: k.rawKey })).status, 401, 'key of the deactivated org refused on B');
    assert.equal((await call(B!, 'POST', '/keys', { token: u.jwt, body: { label: 'x', role: 'OWNER' } })).status, 401, 'JWT refused on B (strict)');
    // identity unchanged: no registry record was created for the org
    assert.equal((await call(A!, 'GET', `/admin/tenants/${encodeURIComponent(u.orgId)}`, { headers: { 'x-admin-key': ADMIN }, token: STATIC })).status, 404);
    const re = await call(A!, 'PUT', `/admin/tenants/${encodeURIComponent(u.orgId)}`, { headers: { 'x-admin-key': ADMIN }, token: STATIC, body: { active: true } });
    assert.equal(re.status, 200, JSON.stringify(re.json));
    assert.equal((await call(B!, 'GET', '/keys', { token: k.rawKey })).status, 401, 'D4 default: the old key is not restored');
    // a non-existing tenant is still 404
    assert.equal((await call(A!, 'DELETE', '/admin/tenants/org_does_not_exist', { headers: { 'x-admin-key': ADMIN }, token: STATIC })).status, 404);
  });

  it('9: author deprovisioned by SCIM on A → the author\'s key and JWT refused on B', async () => {
    const u = await signupVerified(`r2-scim-${Date.now()}@example.test`);
    const k = await mintKey(A!, u.jwt);
    assert.equal((await call(B!, 'GET', '/keys', { token: k.rawKey })).status, 200);
    const d = await call(A!, 'DELETE', `/scim/v2/Users/${encodeURIComponent(u.userId)}`, { token: SCIM });
    assert.ok(d.status === 204 || d.status === 200, `SCIM DELETE ${d.status} ${JSON.stringify(d.json)}`);
    assert.equal((await call(B!, 'GET', '/keys', { token: k.rawKey })).status, 401);
    assert.equal((await call(B!, 'GET', '/keys', { token: u.jwt })).status, 401);
  });

  it('review MED-2: an SSE stream opened on B with a key closes after the key is revoked on A', async () => {
    const u = await signupVerified(`r2-sse-${Date.now()}@example.test`);
    const k = await mintKey(A!, u.jwt);
    const ctrl = new AbortController();
    const res = await fetch(`http://127.0.0.1:${B!.port}/v1/stream`, { headers: { authorization: `Bearer ${k.rawKey}` }, signal: ctrl.signal });
    assert.equal(res.status, 200);
    const reader = res.body!.getReader();
    const ended = (async () => { for (;;) { const { done } = await reader.read(); if (done) return Date.now(); } })();
    await new Promise((r) => setTimeout(r, 400));
    const t0 = Date.now();
    assert.equal((await call(A!, 'DELETE', `/keys/${k.keyId}`, { token: u.jwt })).status, 200);
    const closedAt = await Promise.race([ended, new Promise<number>((r) => setTimeout(() => r(-1), 5000))]);
    ctrl.abort();
    evidence['sseClosedAfterRevocationMs'] = closedAt < 0 ? 'not closed within 5000 ms' : closedAt - t0;
    assert.ok(closedAt > 0, 'the stream must close after the revocation');
  });

  it('review H1: a user without membership gets no token (was a JWT for tenant "default")', async () => {
    const u = await signupVerified(`r2-nomember-${Date.now()}@example.test`);
    await pool.query('DELETE FROM otk_memberships WHERE user_id = $1', [u.userId]);
    const { rows } = await pool.query('SELECT email FROM otk_users WHERE id = $1', [u.userId]);
    const l2 = await call(B!, 'POST', '/login', { body: { email: rows[0].email, password: 'Str0ng-pass-h1r2!' } });
    assert.equal(l2.status, 401, JSON.stringify(l2.json));
    assert.equal(l2.json['token'], undefined);
  });

  it('10: restart of B and database failure on B (fail closed), then recovery', async () => {
    const u = await signupVerified(`r2-rst-${Date.now()}@example.test`);
    const live = await mintKey(A!, u.jwt);
    const dead = await mintKey(A!, u.jwt);
    assert.equal((await call(A!, 'DELETE', `/keys/${dead.keyId}`, { token: u.jwt })).status, 200);
    await stopReplica(B); B = await startReplica('B', urlB);
    assert.equal((await call(B!, 'GET', '/keys', { token: live.rawKey })).status, 200, 'after restart: live key valid');
    assert.equal((await call(B!, 'GET', '/keys', { token: dead.rawKey })).status, 401, 'after restart: revoked key refused');
    // per-request authority cost on B (healthy database, sequential requests)
    const n = 100; const t0 = performance.now();
    for (let i = 0; i < n; i++) assert.equal((await call(B!, 'GET', '/keys', { token: live.rawKey })).status, 200);
    evidence['strictKeyRequestMeanMsOnB'] = Number(((performance.now() - t0) / n).toFixed(2));
    // database cut for B only
    rel.cut();
    const k503 = await call(B!, 'GET', '/keys', { token: live.rawKey });
    assert.equal(k503.status, 503, `dynamic key with unknown state → 503 (${JSON.stringify(k503.json)})`);
    assert.equal(k503.json['error'], 'credential_status_unavailable');
    assert.equal((await call(B!, 'GET', '/analytics/cu-trend', { token: live.rawKey })).status, 503, 'dynamic key: fail closed on reads too');
    const jStrict = await call(B!, 'POST', '/keys', { token: u.jwt, body: { label: 'x', role: 'OWNER' } });
    assert.equal(jStrict.status, 503, 'A3: privileged request of a subject never seen inactive → 503 while the status store is down');
    const sStrict = await call(B!, 'GET', '/keys', { token: STATIC });
    assert.equal(sStrict.status, 503, 'A3: registry token, privileged read → 503');
    const jRead = await call(B!, 'GET', '/analytics/cu-trend', { token: u.jwt });
    evidence['outage'] = { dynamicKeyStrict: k503.status, jwtPrivileged: jStrict.status, staticPrivilegedRead: sStrict.status, jwtPlainRead: jRead.status };
    assert.equal(jRead.status, 200, 'plain read with a JWT keeps the snapshot (documented residual: no spend, no privilege)');
    assert.equal((await call(A!, 'GET', '/keys', { token: live.rawKey })).status, 200, 'A unaffected');
    rel.restore();
    let recovered = 0;
    for (let i = 0; i < 50 && recovered !== 200; i++) {
      recovered = (await call(B!, 'GET', '/keys', { token: live.rawKey })).status;
      if (recovered !== 200) await new Promise((r) => setTimeout(r, 200));
    }
    assert.equal(recovered, 200, 'B recovers when the database answers again');
  });
});
