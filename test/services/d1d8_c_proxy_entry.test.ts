/**
 * D1–D8 / C (C3/C4) — the durable proxy through the documented entrypoint (N9, D7-G01):
 *   OTK_PROXY_ENABLED=1 OTK_DB_URL=… OTK_PROXY_PORT=… tsx src/api/server.ts
 * Real PostgreSQL 16; local controllable provider reached through OTK_PROXY_UPSTREAM_OPENAI with
 * OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE=1 (no network, no paid call; the provider key is a fixture).
 * Also D7-G07 with two proxy processes and D7-G04/INT-04 kill of the streaming process.
 *
 * Modules under test: the API entry point `src/api/server.ts` started as a child process (via `./d1d8_c_proc.ts`)
 * in the durable proxy profile, with the fake provider from `./d1d8_c_provider.ts`.
 *
 * Strategy / scenarios: start-up refusals (proxy enabled without a database URL; without the full durable profile,
 * naming what is missing); HTTP access control (no token, viewer and operator) and a durable, queryable operation;
 * quota contention across two proxy processes (4 of 20 admitted); and a streaming process killed mid-stream, after
 * which another instance marks the operation lost and uncertain once its lease expires, without re-sending.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`), a writable temporary directory,
 * and permission to spawn `tsx` child processes (start-up can take up to the readiness bound of `./d1d8_c_proc.ts`).
 * A throwaway operator key is generated per run. No network.
 *
 * Run just this file: `npx tsx --test test/services/d1d8_c_proxy_entry.test.ts`
 *
 * @module test/services/d1d8_c_proxy_entry.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createTestDb, RUN, type TestDb } from './d1d8_c_env.js';
import { startApi, killProc, eventually, ROOT, READINESS_MS, type Proc } from './d1d8_c_proc.js';
import { ControllableProvider, Barrier } from './d1d8_c_provider.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Wallet } from 'ethers';

let db: TestDb;
const provider = new ControllableProvider();
const procs: Proc[] = [];
const T = `pe${RUN}`;
const TENANTS = `${T}/OPERATOR:tok-op-${RUN},${T}/VIEWER:tok-view-${RUN}`;

/**
 * S4: the delivered durable profile composes the real A/B modules (bootstrapD1D8): it needs a spool
 * dir, a stable instance id, the v3 operator key (a throwaway test key generated per run, never
 * stored) and a weights source (explicit development profile here, flagged in every result).
 */
const OPERATOR_KEY = Wallet.createRandom().privateKey;
let instanceSeq = 0;
function profileEnv(): Record<string, string> {
  return { OTK_SPOOL_DIR: mkdtempSync(path.join(tmpdir(), 'otkd1d8s4-pe-spool-')), OTK_INSTANCE_ID: `pe-${RUN}-${++instanceSeq}`, OTK_V3_OPERATOR_KEY: OPERATOR_KEY, OTK_CU_WEIGHTS_PROFILE: 'development' };
}

async function proxyProc(extra: Record<string, string> = {}): Promise<Proc & { proxy: string }> {
  const p = await startApi({
    ...profileEnv(), OTK_PROXY_ENABLED: '1', OTK_DB_URL: db.url, OTK_TENANTS: TENANTS, OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE: '1',
    OTK_PROXY_UPSTREAM_OPENAI: provider.url, OPENAI_API_KEY: 'sk-otkd1d8c-provider-fixture',
    // OVERNIGHT 20261005 / F-P1-07: was 1 500 ms. Lease renewals on the candidate host took up to 8 s under the services
    // load (probes/p1_inc03, fixed_load); with 1 500 ms a live streaming operation could lose its lease and be
    // recovered as process_lost BEFORE the planned kill (audit 05/10). 10 s stays far below the product default
    // (30 s) and above the measured worst case; the kill test waits for lease expiry + recovery accordingly.
    OTK_OPERATION_LEASE_MS: '10000', OTK_OPERATION_RECOVERY_MS: '400', OTK_PROXY_FORWARD_HEADERS: 'x-test-script,x-test-tokens', ...extra,
  }, { extraPorts: ['OTK_PROXY_PORT'] });
  procs.push(p);
  const proxy = `http://127.0.0.1:${p.extraPorts['OTK_PROXY_PORT']}`;
  // the API port answered (startApi); the proxy listener of the same process follows. Same readiness bound.
  const up = await eventually(async () => { try { return (await fetch(`${proxy}/health`)).ok; } catch { return false; } }, READINESS_MS, 250);
  assert.ok(up, `proxy did not start: ${p.log.join('').slice(-2000)}`);
  return { ...p, proxy };
}
const chat = (proxy: string, token: string | null, opId: string, body: unknown, script = 'ok', signal?: AbortSignal) => fetch(`${proxy}/v1/chat/completions`, {
  method: 'POST', signal,
  headers: { 'content-type': 'application/json', 'x-test-script': script, 'x-otk-operation-id': opId, ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});
const body = (extra: Record<string, unknown> = {}) => ({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, ...extra });
async function op(id: string) {
  const r = await db.pool.query<{ execution: string; measurement: string; delivery: string; st: string }>("SELECT execution, measurement, delivery, reservation->>'state' AS st FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2", [T, id]);
  return r.rows[0] ?? null;
}

before(async () => { db = await createTestDb('proxyentry'); await provider.start(); });
after(async () => {
  await provider.stop();
  for (const p of procs) await killProc(p);
  await db.drop();
});

describe('D7-G01: the entrypoint starts the proxy in the durable profile; auth, tenant, quota by HTTP', () => {
  it('OTK_PROXY_ENABLED=1 without OTK_DB_URL refuses to start (no in-memory durable profile)', () => {
    const isWin = process.platform === 'win32';
    const tsx = path.join(ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');
    const env: NodeJS.ProcessEnv = { ...process.env, OTK_PROXY_ENABLED: '1', NODE_ENV: 'test', API_PORT: '0', OTK_PROXY_PORT: '0', OTK_ADMIN_KEY: 'otkd1d8c-admin-fixture', PROVER_URL: 'disabled' };
    for (const k of ['OTK_DB_URL', 'OTK_REDIS_URL', 'OTK_RECEIPT_LOG', 'OTK_TENANTS']) delete env[k];
    const r = isWin ? spawnSync('cmd.exe', ['/c', tsx, 'src/api/server.ts'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 }) : spawnSync(tsx, ['src/api/server.ts'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 1, r.stderr?.slice(-1000));
    assert.match(String(r.stdout) + String(r.stderr), /requires OTK_DB_URL/);
  });

  it('S4: OTK_PROXY_ENABLED=1 without the D1–D8 profile (spool, instance id, v3 key, weights) refuses to start and names what is missing', () => {
    const isWin = process.platform === 'win32';
    const tsx = path.join(ROOT, 'node_modules', '.bin', isWin ? 'tsx.cmd' : 'tsx');
    const env: NodeJS.ProcessEnv = { ...process.env, OTK_PROXY_ENABLED: '1', OTK_DB_URL: db.url, NODE_ENV: 'test', API_PORT: '0', OTK_PROXY_PORT: '0', OTK_ADMIN_KEY: 'otkd1d8c-admin-fixture', PROVER_URL: 'disabled' };
    for (const k of ['OTK_REDIS_URL', 'OTK_RECEIPT_LOG', 'OTK_TENANTS', 'OTK_SPOOL_DIR', 'OTK_INSTANCE_ID', 'OTK_V3_OPERATOR_KEY', 'OTK_CU_WEIGHTS_PROFILE', 'OTK_CU_WEIGHTS_FILE', 'OTK_CU_WEIGHTS_SIGNERS']) delete env[k];
    const r = isWin ? spawnSync('cmd.exe', ['/c', tsx, 'src/api/server.ts'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 }) : spawnSync(tsx, ['src/api/server.ts'], { cwd: ROOT, env, encoding: 'utf8', timeout: 60_000 });
    assert.equal(r.status, 1, r.stderr?.slice(-1000));
    const out = String(r.stdout) + String(r.stderr);
    for (const name of ['OTK_SPOOL_DIR', 'OTK_INSTANCE_ID', 'OTK_V3_OPERATOR_KEY', 'OTK_CU_WEIGHTS_FILE']) assert.match(out, new RegExp(name));
  });

  it('401 without token, 403 for a viewer, 200 for an operator; operation durable and queryable', async () => {
    const a = await proxyProc();
    const n = provider.calls.length;
    assert.equal((await chat(a.proxy, null, `e-${RUN}-0`, body())).status, 401);
    assert.equal((await chat(a.proxy, `tok-view-${RUN}`, `e-${RUN}-1`, body())).status, 403);
    assert.equal(provider.calls.length, n, 'refused calls never reach the provider');
    const ok = await chat(a.proxy, `tok-op-${RUN}`, `e-${RUN}-2`, body());
    assert.equal(ok.status, 200);
    await ok.text();
    assert.ok(await eventually(async () => (await op(`e-${RUN}-2`))?.st === 'settled'));
    const s = await fetch(`${a.proxy}/v1/operations/e-${RUN}-2`, { headers: { authorization: `Bearer tok-view-${RUN}` } });
    assert.equal(s.status, 200);
    const v = await s.json() as { operation: { execution: string; reservation: { cu: { units: string; scale: string } } } };
    assert.equal(v.operation.execution, 'completed');
    // S4: exact micro-CU of B's formula (100 + 50 tokens × 1.0 × 1.0 = 150 CU = 150 000 000 / 10^6)
    assert.deepEqual(v.operation.reservation.cu, { units: '150000000', scale: '1000000' });
    // S4: the delivered profile writes the signed v3 receipt (A) through the effect worker (no 2nd debit);
    // the tenant exports it with its envelope and the verification result
    assert.ok(await eventually(async () => (await db.pool.query('SELECT 1 FROM otk_receipts_v3 WHERE tenant_id = $1 AND operation_id = $2', [T, `e-${RUN}-2`])).rowCount === 1));
    const x = await fetch(`${a.proxy}/v1/operations/e-${RUN}-2/conference`, { headers: { authorization: `Bearer tok-view-${RUN}` } });
    assert.equal(x.status, 200);
    const exp = await x.json() as { receipt: { payload: { schema: string; source: string } }; verification: { receipt: { ok: boolean } } };
    assert.equal(exp.receipt.payload.schema, 'otk.receipt.v3');
    assert.equal(exp.receipt.payload.source, 'otk_proxy_observed');
    assert.equal(exp.verification.receipt.ok, true);
    assert.equal((await db.pool.query('SELECT 1 FROM otk_openings WHERE tenant_id = $1 AND operation_id = $2', [T, `e-${RUN}-2`])).rowCount, 1, 'opening stored');
    const l = await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM otk_ledger WHERE tenant_id = $1', [T]);
    assert.equal(l.rows[0]!.n, '1');
  });
});

describe('D7-G07 (proxy, two processes): reservations of 3 000 against quota 10 000', () => {
  it('20 concurrent calls split over two proxy processes: 4 admitted, 16 refused', async () => {
    const t2 = `${T}q`;
    const tokens = `${t2}/OPERATOR:tok-q-${RUN}`;
    const a = await proxyProc({ OTK_TENANTS: tokens });
    const b = await proxyProc({ OTK_TENANTS: tokens });
    // S4: B's reservation bound = UTF-8 bytes of the body + max_tokens (legacy added +64); gpt-4o and
    // openai weigh 1.0 each in the development profile, so the reservation is exactly 3 000 CU
    let m = 2000; let b0 = body({ max_tokens: m });
    for (let i = 0; i < 5; i++) { m = 3000 - Buffer.byteLength(JSON.stringify(b0)); b0 = body({ max_tokens: m }); }
    const hold = new Barrier();
    provider.onArrive = () => hold.promise;
    const before = provider.calls.length;
    const decided: number[] = [];
    const all = Promise.all(Array.from({ length: 20 }, (_, i) => chat(i % 2 ? a.proxy : b.proxy, `tok-q-${RUN}`, `q-${RUN}-${i}`, b0).then(async (r) => { const s = r.status; if (s !== 200) decided.push(s); await r.text(); return s; })));
    // OVERNIGHT 20261005 / Phase 1: a failed assertion used to leave the barrier held, provider.onArrive set and
    // both processes alive, so the NEXT test ran against a provider that never answered (audit: its failure
    // was a cascade). Cleanup now runs in finally; the assertions are unchanged.
    try {
      assert.ok(await eventually(async () => provider.calls.length - before === 4, 15_000));
      // fechamento pós-S5: every one of the other 16 is decided (refused) WHILE the 4 are still held; releasing
      // earlier let late admissions see the quota freed by the settlements (a test race, also seen on 12d1bac)
      assert.ok(await eventually(async () => decided.length === 16, 30_000), JSON.stringify(decided));
      assert.deepEqual([...new Set(decided)], [429]);
      assert.equal(provider.calls.length - before, 4);
      const held = await db.pool.query<{ h: string }>('SELECT held_units::text AS h FROM otk_quota_usage WHERE tenant_id = $1', [t2]);
      assert.equal(BigInt(held.rows[0]!.h) / 1_000_000n, 12_000n);
      hold.release();
      const st = await all;
      assert.equal(st.filter((s) => s === 200).length, 4, JSON.stringify(st));
      assert.equal(st.filter((s) => s === 429).length, 16, JSON.stringify(st));
    } finally {
      hold.release();
      provider.onArrive = null;
      await all.catch(() => {});
      await killProc(a); await killProc(b);
    }
  });
});

describe('D7-G04 / INT-04 (proxy): the streaming process is killed; another instance recovers', () => {
  it('kill during the stream → after the lease expires: process_lost + uncertain, exposure kept, never re-sent', async () => {
    const a = await proxyProc();
    const b = await proxyProc();
    const fb = new Barrier(); provider.finalBarriers.push(fb);
    const id = `k-${RUN}`;
    const n = provider.calls.length;
    try {
      const r = await chat(a.proxy, `tok-op-${RUN}`, id, body({ stream: true }), 'stream');
      await r.body!.getReader().read();
      assert.equal((await op(id))?.execution, 'upstream_started');
      await killProc(a);
      assert.ok(await eventually(async () => (await op(id))?.execution === 'process_lost', 40_000), 'recovered by the other instance (after the 10 s lease)');
      const o = (await op(id))!;
      assert.deepEqual([o.measurement, o.st], ['uncertain', 'held_uncertain']);
      fb.release();
      assert.equal(provider.calls.length, n + 1, 'no automatic re-send');
    } finally {
      fb.release();
      await killProc(a); await killProc(b);
    }
  });
});
