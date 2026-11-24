/**
 * D1–D8 / C (C2) — RV30-01, RV30-02, RV30-05 through the API entrypoint (`tsx src/api/server.ts`)
 * with real PostgreSQL and Redis of the C stack. Outages are controlled TCP cuts (TcpRelay), and
 * restarts are abrupt kills. Expected values are hand vectors (gpt-4o/openai weights 1.0 × 1.0:
 * CU = input + output tokens). "Before" observations: C/C2_rv30/before/.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import { createTestDb, requireEnv, RUN, type TestDb } from './d1d8_c_env.js';
import { startApi, killProc, TcpRelay, postJson, getJson, eventually, type Proc } from './d1d8_c_proc.js';
import { deriveEpoch } from '../../src/types/receipt.js';

const TS = Math.floor(Date.now() / 1000);
const EPOCH = String(deriveEpoch(TS));
const body = (requestId: string, tokensIn: number, tokensOut: number, extra: Record<string, unknown> = {}) => ({
  requestId, provider: 'openai', model: 'gpt-4o', inputTokens: tokensIn, outputTokens: tokensOut, latencyMs: 10, timestamp: TS, userId: '1', nonce: '1', ...extra,
});

let db: TestDb;
let redis: Redis;
const procs: Proc[] = [];
const relays: TcpRelay[] = [];
async function api(env: Record<string, string>): Promise<Proc> { const p = await startApi(env); procs.push(p); return p; }
async function relay(url: string): Promise<TcpRelay> { const u = new URL(url); const r = new TcpRelay(u.hostname, Number(u.port)); await r.start(); relays.push(r); return r; }

before(async () => {
  db = await createTestDb('rv30api');
  redis = new Redis(requireEnv('OTK_TEST_REDIS_URL'), { maxRetriesPerRequest: 1 });
});
after(async () => {
  if (process.env['OTK_TEST_DUMP_LOGS'] === '1') for (const p of procs) process.stderr.write(`--- api :${p.port}
${p.log.join('').slice(-6000)}
`);
  for (const p of procs) await killProc(p);
  for (const r of relays) await r.stop();
  redis.disconnect();
  await db.drop();
});

async function ledger(tenant: string): Promise<{ cu: bigint; entries: number }> {
  const r = await db.pool.query<{ s: string; n: string }>('SELECT COALESCE(sum(units),0)::text AS s, count(*)::text AS n FROM otk_ledger WHERE tenant_id = $1 AND epoch_id = $2', [tenant, EPOCH]);
  return { cu: BigInt(r.rows[0]!.s) / 1_000_000n, entries: Number(r.rows[0]!.n) };
}
const redisTotal = async (tenant: string) => (await redis.hget(`otk:tal:${tenant}:${EPOCH}`, 'totalCU')) ?? null;

describe('RV30-01: PostgreSQL configured but down at startup', () => {
  it('no volatile ack (503, not ready); after the database returns the same receipt is stored durably (201)', async () => {
    const tenant = `rv01-${RUN}`; const tok = `tok-${tenant}`;
    const pg = await relay(db.url);
    pg.cut();
    const a = await api({ OTK_DB_URL: pg.via(db.url), OTK_TENANTS: `${tenant}/OPERATOR:${tok}`, OTK_PG_RECONNECT_MS: '300' });
    const first = await postJson(a.port, '/receipts', tok, body(`rv01-${RUN}`, 1000, 2000));
    assert.equal(first.status, 503, `before the fix: 201 memory-only; got ${JSON.stringify(first.body)}`);
    assert.equal((await getJson(a.port, '/readyz', null)).status, 503);
    // the receipt table does not even exist yet: nothing was written anywhere
    assert.equal((await db.pool.query<{ t: string | null }>("SELECT to_regclass('public.otk_receipts')::text AS t")).rows[0]!.t, null);
    pg.restore();
    assert.ok(await eventually(async () => (await getJson(a.port, '/readyz', null)).status === 200, 20_000), 'store reconnects without a restart');
    const second = await postJson(a.port, '/receipts', tok, body(`rv01-${RUN}`, 1000, 2000));
    assert.equal(second.status, 201);
    assert.equal(second.body['costUnits'], 3000);
    assert.equal((await db.pool.query('SELECT 1 FROM otk_receipts WHERE request_id = $1', [`rv01-${RUN}`])).rowCount, 1);
    assert.deepEqual(await ledger(tenant), { cu: 3000n, entries: 1 });
    await killProc(a);
  });

  it('memory mode stays possible when nothing is configured (declared, not durable)', async () => {
    const tenant = `rv01m-${RUN}`; const tok = `tok-${tenant}`;
    const a = await api({ OTK_TENANTS: `${tenant}/OPERATOR:${tok}` });
    assert.equal((await postJson(a.port, '/receipts', tok, body(`rv01m-${RUN}`, 1, 1))).status, 201);
    assert.equal((await getJson(a.port, '/readyz', null)).body['checks'] && ((await getJson(a.port, '/readyz', null)).body['checks'] as Record<string, Record<string, string>>)['persistence']!['mode'], 'memory-only');
    await killProc(a);
  });
});

describe('D5-G04: the client CU does not decide the debit', () => {
  it('costUnits 1 declared for 1000+2000 gpt-4o tokens → stored and debited 3000', async () => {
    const tenant = `d5-${RUN}`; const tok = `tok-${tenant}`;
    const a = await api({ OTK_DB_URL: db.url, OTK_TENANTS: `${tenant}/OPERATOR:${tok}` });
    const r = await postJson(a.port, '/receipts', tok, body(`d5-${RUN}`, 1000, 2000, { costUnits: 1 }));
    assert.equal(r.status, 201);
    assert.equal(r.body['costUnits'], 3000);
    assert.equal(r.body['clientDeclaredCostUnits'], 1);
    assert.deepEqual(await ledger(tenant), { cu: 3000n, entries: 1 });
    const unknown = await postJson(a.port, '/receipts', tok, body(`d5u-${RUN}`, 10, 10, { model: 'model-not-in-catalog', costUnits: 5 }));
    assert.equal(unknown.status, 400, 'unknown model is refused, never debited as 0 or as the client value');
    const squat = await postJson(a.port, '/receipts', tok, body(`op:other-tenant:job-${RUN}`, 10, 10));
    assert.equal(squat.status, 400, 'review MEDIUM-4: the op: prefix of operation receipts is reserved');
    await killProc(a);
  });
});

describe('RV30-05 / D7-G07: quota 10 000 CU, twenty concurrent receipts of 3 000 CU', () => {
  for (const n of [1, 2]) {
    it(`${n} instance(s): 4 admitted (201), 16 refused (429), 12 000 CU confirmed (before: 8 with two)`, async () => {
      const tenant = `q${n}-${RUN}`; const tok = `tok-${tenant}`;
      const env = { OTK_DB_URL: db.url, OTK_TENANTS: `${tenant}/OPERATOR:${tok}` };
      const insts = [await api(env)];
      if (n === 2) insts.push(await api(env));
      const st = await Promise.all(Array.from({ length: 20 }, (_, i) => postJson(insts[i % n]!.port, '/receipts', tok, body(`${tenant}-${i}`, 1000, 2000)).then((r) => r.status)));
      assert.equal(st.filter((s) => s === 201).length, 4, JSON.stringify(st));
      assert.equal(st.filter((s) => s === 429).length, 16, JSON.stringify(st));
      assert.deepEqual(await ledger(tenant), { cu: 12_000n, entries: 4 });
      for (const x of insts) {
        const b = await getJson(x.port, `/accounting/balance?tenantId=${tenant}&epochId=${EPOCH}`, tok);
        assert.equal(b.body['totalCU'], '12000', `instance on port ${x.port}`);
      }
      for (const x of insts) await killProc(x);
    });
  }
});

describe('review H5 and M2 (legacy profile stays correct)', () => {
  it('JSONL + PostgreSQL: balance and quota read the real consumption (not 0)', async () => {
    const tenant = `h5-${RUN}`; const tok = `tok-${tenant}`;
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const path = await import('node:path');
    const log = path.join(mkdtempSync(path.join(tmpdir(), 'otkd1d8c-jsonl-')), 'receipts.jsonl');
    const a = await api({ OTK_DB_URL: db.url, OTK_RECEIPT_LOG: log, OTK_TENANTS: `${tenant}/OPERATOR:${tok}` });
    for (let i = 0; i < 4; i++) assert.equal((await postJson(a.port, '/receipts', tok, body(`h5-${i}-${RUN}`, 1000, 2000))).status, 201);
    const bal = await getJson(a.port, `/accounting/balance?tenantId=${tenant}&epochId=${EPOCH}`, tok);
    assert.equal(bal.body['totalCU'], '12000', 'before the fix the ledger source returned 0 in this mode');
    assert.equal((await postJson(a.port, '/receipts', tok, body(`h5-x-${RUN}`, 1000, 2000))).status, 429, 'quota counts the real consumption');
    await killProc(a);
  });

  it('receipts stored before the ledger existed are backfilled once at startup (balance and quota keep them)', async () => {
    const tenant = `m2-${RUN}`; const tok = `tok-${tenant}`;
    const { PostgresReceiptStore } = await import('../../src/api/PostgresReceiptStore.js');
    const legacy = new PostgresReceiptStore(db.url);
    await legacy.init();
    for (let i = 0; i < 3; i++) {
      await legacy.store({ requestId: `m2-old-${i}-${RUN}`, provider: 'openai', model: 'gpt-4o', inputTokens: 1000, outputTokens: 2000, costUnits: 3000, latencyMs: 1, timestamp: TS, userId: 1n, nonce: BigInt(i), tenantId: tenant });
    }
    await legacy.close();
    const before = await ledger(tenant);
    assert.deepEqual(before, { cu: 0n, entries: 0 }, 'old rows have no ledger entry (pre-upgrade state)');
    const a = await api({ OTK_DB_URL: db.url, OTK_TENANTS: `${tenant}/OPERATOR:${tok}` });
    assert.deepEqual(await ledger(tenant), { cu: 9000n, entries: 3 });
    const st = [];
    for (let i = 0; i < 2; i++) st.push((await postJson(a.port, '/receipts', tok, body(`m2-new-${i}-${RUN}`, 1000, 2000))).status);
    assert.deepEqual(st, [201, 429], '9 000 < 10 000 admits one more, then 12 000 refuses');
    await killProc(a);
    const b = await api({ OTK_DB_URL: db.url, OTK_TENANTS: `${tenant}/OPERATOR:${tok}` });
    assert.deepEqual(await ledger(tenant), { cu: 12000n, entries: 4 }, 'a second startup adds nothing');
    await killProc(b);
  });
});

describe('RV30-02 / D7-G05: Redis fails during the 9 000 write; restart; another instance reads', () => {
  it('9 000 (Redis cut, writer killed) + 3 000 on a new instance → 12 000 in PG, in Redis and on every instance', async () => {
    const tenant = `rv02-${RUN}`; const tok = `tok-${tenant}`;
    const rr = await relay(requireEnv('OTK_TEST_REDIS_URL'));
    const env = (redisUrl: string) => ({ OTK_DB_URL: db.url, OTK_REDIS_URL: redisUrl, OTK_TENANTS: `${tenant}/OPERATOR:${tok}`, PROVER_RECOVERY_INTERVAL_MS: '300' });
    const a = await api(env(rr.via(requireEnv('OTK_TEST_REDIS_URL'))));
    rr.cut();
    const w1 = await postJson(a.port, '/receipts', tok, body(`rv02-a-${RUN}`, 3000, 6000));
    assert.equal(w1.status, 201, 'the durable write does not depend on Redis');
    // wait until A's projection attempt has failed and been rescheduled (not in flight), then crash A
    assert.ok(await eventually(async () => (await db.pool.query("SELECT 1 FROM otk_outbox WHERE tenant_id = $1 AND kind = 'project_redis' AND state = 'pending' AND attempts >= 1", [tenant])).rowCount === 1, 20_000));
    await killProc(a);
    assert.equal(await redisTotal(tenant), null, 'the 9 000 never reached Redis');
    rr.restore();
    const b = await api(env(requireEnv('OTK_TEST_REDIS_URL')));
    assert.equal((await postJson(b.port, '/receipts', tok, body(`rv02-b-${RUN}`, 1000, 2000))).status, 201);
    assert.deepEqual(await ledger(tenant), { cu: 12_000n, entries: 2 });
    // fechamento pós-S5 (S5 OBS-1): A's projection is retried when its exponential backoff schedules it
    // (500 ms × 2^(n−1), ≤ 60 s) or, if A died while holding it ('leased'), when that lease (30 s, heartbeat)
    // expires. The bound is the later of the two, read from the outbox, plus a margin, never below 20 s.
    const due = await db.pool.query<{ ms: string; attempts: number; states: string }>(
      `SELECT GREATEST(0, round(extract(epoch FROM (GREATEST(max(next_attempt_at), max(COALESCE(lease_until, next_attempt_at))) - now())) * 1000))::text AS ms,
              max(attempts) AS attempts, string_agg(state, ',') AS states
         FROM otk_outbox WHERE tenant_id = $1 AND kind = 'project_redis' AND state IN ('pending', 'leased')`, [tenant]);
    const waitMs = Math.max(20_000, Number(due.rows[0]?.ms ?? 0) + 15_000);
    assert.ok(waitMs <= 90_000, `scheduled retry within the 60 s backoff ceiling / 30 s lease (${waitMs} ms; ${due.rows[0]?.states})`);
    assert.ok(await eventually(async () => (await redisTotal(tenant)) === '12000', waitMs),
      `Redis projection converged by the scheduled retry (got ${await redisTotal(tenant)}; attempts ${due.rows[0]?.attempts}, states ${due.rows[0]?.states}, wait ${waitMs} ms)`);
    const c = await api(env(requireEnv('OTK_TEST_REDIS_URL')));
    for (const x of [b, c]) {
      const bal = await getJson(x.port, `/accounting/balance?tenantId=${tenant}&epochId=${EPOCH}`, tok);
      assert.equal(bal.body['totalCU'], '12000');
    }
    // A = 100, B = 200, replay of A → still 300 (identity in the ledger, marker in the aggregate)
    const t2 = `rv04-${RUN}`;
    const tok2 = `tok-${t2}`;
    const d = await api({ ...env(requireEnv('OTK_TEST_REDIS_URL')), OTK_TENANTS: `${t2}/OPERATOR:${tok2}` });
    assert.equal((await postJson(d.port, '/receipts', tok2, body(`rv04-A-${RUN}`, 40, 60))).status, 201);
    assert.equal((await postJson(d.port, '/receipts', tok2, body(`rv04-B-${RUN}`, 80, 120))).status, 201);
    assert.equal((await postJson(d.port, '/receipts', tok2, body(`rv04-A-${RUN}`, 40, 60))).status, 200);
    assert.deepEqual(await ledger(t2), { cu: 300n, entries: 2 });
    assert.ok(await eventually(async () => (await redisTotal(t2)) === '300', 20_000));
    for (const x of [b, c, d]) await killProc(x);
  });

  it('D7-G08: Redis aggregate lost → POST /admin/redis/reproject rebuilds it from the ledger (no double count)', async () => {
    const tenant = `rv08-${RUN}`; const tok = `tok-${tenant}`; const own = `own-${tenant}`;
    const e = await api({ OTK_DB_URL: db.url, OTK_REDIS_URL: requireEnv('OTK_TEST_REDIS_URL'), OTK_TENANTS: `${tenant}/MEMBER:${tok},${tenant}/OWNER:${own}`, PROVER_RECOVERY_INTERVAL_MS: '300' });
    for (const [i, t] of [[1, 500], [2, 700]] as const) assert.equal((await postJson(e.port, '/receipts', tok, body(`rv08-${i}-${RUN}`, t, 0))).status, 201);
    assert.ok(await eventually(async () => (await redisTotal(tenant)) === '1200', 20_000));
    await redis.del(`otk:tal:${tenant}:${EPOCH}`); // Redis lost (or replaced by an empty one)
    assert.equal(await redisTotal(tenant), null);
    assert.equal((await postJson(e.port, '/admin/redis/reproject', tok, { tenantId: tenant })).status, 403, 'a member cannot rebuild projections');
    const rp = await postJson(e.port, '/admin/redis/reproject', own, { tenantId: tenant });
    assert.equal(rp.status, 202);
    assert.equal(rp.body['rearmed'], 2);
    assert.ok(await eventually(async () => (await redisTotal(tenant)) === '1200', 20_000), 'rebuilt from the durable source');
    assert.equal((await postJson(e.port, '/admin/redis/reproject', own, { tenantId: tenant })).status, 202);
    // wait until both re-armed projections ran again (state observed in PostgreSQL, not a sleep)
    assert.ok(await eventually(async () => (await db.pool.query("SELECT 1 FROM otk_outbox WHERE tenant_id = $1 AND kind = 'project_redis' AND state = 'done' AND attempts >= 2", [tenant])).rowCount === 2, 20_000));
    assert.equal(await redisTotal(tenant), '1200', 'replaying again does not double count');
    await killProc(e);
  });
});
