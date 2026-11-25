/**
 * Fechamento pós-S5 — RV2-01 / AUD-6: the money scope of a tenant (which budgets apply and under
 * which bound policy) is decided atomically with the admission, never by the gateway's earlier
 * read. Real gateway (durable profile), front B's real measurement ports, the dated Haiku 4.5 table,
 * real PostgreSQL 16, two gateway instances, local controllable provider (synthetic, no paid call).
 *
 *   . scripts/ops/fps5_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_fps5_money_admission.test.ts
 *
 * Atomic point: inside the admission transaction, after `otk_money_scope_lock(tenant)` (advisory
 * transaction lock), the budgets of the tenant are read and row-locked. Budget creation and new
 * membership take the same tenant lock in a trigger; a policy change or deletion takes the budget
 * row lock. Whatever commits first is seen by the other: an admission that finds a budget needs a
 * strict reservation under the budget's policy (else `money_policy_required`), and a budget/link
 * whose tenant still has open exposure not covered by it is refused.
 *
 * Module under test: the admission path of `src/operations/runtime.ts` (`OperationsRuntime`) through the in-process
 * gateway, with the database-side tenant lock and triggers from the migrations, and the fake provider from
 * `./d1d8_c_provider.ts`.
 *
 * Strategy / scenarios: a budget created, linked or re-policied between the gateway's early read and the admission
 * (an unbounded request never reaches the provider, a bounded one is re-assessed strictly, a new shared membership
 * and a changed policy are seen by the admission); database guards serializing budget changes with admissions
 * (creation waits for an in-progress admission and refuses uncovered exposure; policy change and deletion refused
 * while an operation under the budget is open; two instances with different bound policies); strict refusals of
 * an unsupported beta header and an output cap above the documented maximum; and cache TTLs other than 5 minutes
 * refused before the upstream.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`); run with
 * `--test-concurrency=1`. Before importing the server it sets fixture values in the test process for the API's
 * variables (tenants, a fake Anthropic key, the upstream override, `PROVER_URL=disabled`). With the variables
 * already set, `npx tsx --test --test-concurrency=1 test/services/d1d8_fps5_money_admission.test.ts` runs just this
 * file.
 *
 * @module test/services/d1d8_fps5_money_admission.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'tN/OPERATOR:tokN,tS/OPERATOR:tokS,tP/OPERATOR:tokP,tL/OPERATOR:tokL,tO/OPERATOR:tokO,tQ/OPERATOR:tokQ';
process.env['ANTHROPIC_API_KEY'] = 'sk-ant-otkd1d8fps5-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import pg from 'pg';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider, Barrier } from './d1d8_c_provider.js';
import { eventually } from './d1d8_c_proc.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';
import { MONEY_BOUND_POLICY, type MoneyBoundPolicy } from '../../src/operations/moneyBound.js';

const P = 1_000_000_000_000n; // US$ 1 in pico-USD
const TABLE_FILE = 'scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json';
let db: TestDb;
const provider = new ControllableProvider();
const started: Array<{ rt: OperationsRuntime; server: Server }> = [];
let gw: typeof import('../../src/proxy/ProxyGateway.js');

const ports = () => d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables([TABLE_FILE]) });
async function gateway(instanceId: string, moneyBoundPolicy?: MoneyBoundPolicy): Promise<{ rt: OperationsRuntime; base: string }> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, recoveryIntervalMs: 3_600_000, measurement: ports(), quotaFor: () => null,
    ...(moneyBoundPolicy ? { moneyBoundPolicy } : {}),
    policy: { leaseMs: 2_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] } });
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  started.push({ rt, server });
  return { rt, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const body = (extra: Record<string, unknown> = {}) => ({ model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Say hello in one word.' }], ...extra });
/** A request that strict mode refuses (tools have no defensible bound): must never reach the provider under a budget. */
const unbounded = () => body({ tools: [{ type: 'web_search_20250305', name: 'web_search' }] });
function call(base: string, token: string, b: unknown, extra: Record<string, string> = {}) {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-otk-provider': 'anthropic', 'anthropic-version': '2023-06-01', 'x-test-script': 'ok', 'x-test-tokens': '10,2', ...extra },
    body: JSON.stringify(b),
  });
}
const budgetRow = async (id: string) => (await db.pool.query<{ s: string; h: string; f: string | null; p: string }>(
  'SELECT spent_units::text AS s, held_units::text AS h, frozen_reason AS f, money_policy AS p FROM otk_money_budget WHERE budget_id = $1', [id])).rows[0]!;
const opRow = async (tenant: string, id: string) => (await db.pool.query<{ budget_ids: string[]; policy: string | null; money: string | null }>(
  "SELECT budget_ids, limits->>'moneyBoundPolicy' AS policy, money->>'state' AS money FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2", [tenant, id])).rows[0];
/**
 * held of a budget = Σ reserved money of its operations whose money axis is still open.
 *
 * @param budgetId - Budget whose stored `held` amount is compared with the sum recomputed from its operations.
 */
async function assertHeldConsistent(budgetId: string): Promise<void> {
  const r = await db.pool.query<{ held: string; open: string }>(
    `SELECT b.held_units::text AS held,
            COALESCE((SELECT sum(o.reserved_money) FROM otk_operations o
                       WHERE $1 = ANY(o.budget_ids) AND o.money->>'state' IN ('held', 'held_uncertain', 'pending_price')), 0)::text AS open
       FROM otk_money_budget b WHERE b.budget_id = $1`, [budgetId]);
  assert.equal(r.rows[0]!.held, r.rows[0]!.open, `budget ${budgetId}: held equals the open reservations`);
}
/**
 * Wrap the gateway's early read so that `act` runs right after it, before the admission transaction.
 *
 * @param rt - Runtime whose early read is wrapped (only for `tenant`).
 * @param tenant - Tenant whose next early read triggers `act`.
 * @param act - Concurrent change to run in that window (for example, creating a budget).
 */
function afterEarlyRead(rt: OperationsRuntime, tenant: string, act: () => Promise<void>): void {
  const original = rt.store.hasMoneyBudget.bind(rt.store);
  let done = false;
  rt.store.hasMoneyBudget = async (t: string) => {
    const seen = await original(t);
    if (t === tenant && !done) { done = true; await act(); }
    return seen;
  };
}
const errorOf = async (r: Response) => ((await r.json()) as { error: string; detail?: string });

before(async () => {
  db = await createTestDb('fps5admit');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_ANTHROPIC'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
});
after(async () => {
  await provider.stop();
  for (const s of started) { s.server.closeAllConnections(); await new Promise<void>((r) => s.server.close(() => r())); await s.rt.stop(); }
  await db.drop();
});

describe('RV2-01 — budget created / linked / re-policied between the early read and the admission', () => {
  it('AUD-6 counterexample: budget inserted after hasMoneyBudget=false; a request with tools never reaches the provider', async () => {
    const { rt, base } = await gateway('adm-new');
    afterEarlyRead(rt, 'tN', async () => {
      await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-new', 'tN', $1::numeric)", [P.toString()]);
    });
    const before = provider.calls.length;
    const r = await call(base, 'tokN', unbounded(), { 'x-otk-operation-id': 'race-new' });
    assert.equal(r.status, 402);
    assert.equal((await errorOf(r)).error, 'money_bound_unavailable');
    assert.equal(provider.calls.length, before, 'refused before the upstream');
    assert.equal(await opRow('tN', 'race-new'), undefined, 'nothing admitted');
    assert.deepEqual(await budgetRow('b-new'), { s: '0', h: '0', f: null, p: MONEY_BOUND_POLICY.id });
  });

  it('same interleaving with a bounded request: re-assessed in strict mode, admitted under the budget and its policy', async () => {
    const { rt, base } = await gateway('adm-new2');
    afterEarlyRead(rt, 'tQ', async () => {
      await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-q', 'tQ', $1::numeric)", [P.toString()]);
    });
    const r = await call(base, 'tokQ', body(), { 'x-otk-operation-id': 'race-ok' });
    assert.equal(r.status, 200);
    await r.text();
    assert.ok(await eventually(async () => (await opRow('tQ', 'race-ok'))?.money === 'settled'));
    const row = (await opRow('tQ', 'race-ok'))!;
    assert.deepEqual(row.budget_ids, ['b-q']);
    assert.equal(row.policy, MONEY_BOUND_POLICY.id);
    assert.equal((await budgetRow('b-q')).h, '0');
    await assertHeldConsistent('b-q');
  });

  it('new shared membership after the early read: refused before the upstream, shared budget untouched', async () => {
    const { rt, base } = await gateway('adm-link');
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-shared', 'operator', $1::numeric)", [P.toString()]);
    afterEarlyRead(rt, 'tS', async () => { await db.pool.query("INSERT INTO otk_money_budget_members (budget_id, tenant_id) VALUES ('b-shared', 'tS')"); });
    const before = provider.calls.length;
    const r = await call(base, 'tokS', unbounded(), { 'x-otk-operation-id': 'race-link' });
    assert.equal(r.status, 402);
    assert.equal(provider.calls.length, before);
    assert.equal(await opRow('tS', 'race-link'), undefined);
    assert.equal((await budgetRow('b-shared')).h, '0');
  });

  it('policy changed after the early read: the admission sees the new policy and refuses (this instance applies another)', async () => {
    const { rt, base } = await gateway('adm-pol');
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-pol', 'tP', $1::numeric)", [P.toString()]);
    afterEarlyRead(rt, 'tP', async () => { await db.pool.query("UPDATE otk_money_budget SET money_policy = 'otk.money_bound_policy.other@test' WHERE budget_id = 'b-pol'"); });
    const before = provider.calls.length;
    const r = await call(base, 'tokP', body(), { 'x-otk-operation-id': 'race-pol' });
    assert.equal(r.status, 402);
    const e = await errorOf(r);
    assert.equal(e.error, 'money_bound_unavailable');
    assert.match(e.detail ?? '', /otk\.money_bound_policy\.other@test/);
    assert.equal(provider.calls.length, before);
    assert.equal(await opRow('tP', 'race-pol'), undefined);
    assert.equal((await budgetRow('b-pol')).h, '0');
  });
});

describe('RV2-01 — budget changes are serialized with admissions (database guards)', () => {
  it('budget creation waits for an in-progress admission of the tenant (two instances) and then refuses the uncovered exposure', async () => {
    const g1 = await gateway('adm-i1'); const g2 = await gateway('adm-i2');
    const gate = new Barrier();
    let arrived = 0;
    provider.onArrive = async () => { arrived++; await gate.promise; };
    try {
      // tenant tL has no budget: admitted in CU-only mode on instance 1, held at the provider
      const inflight = call(g1.base, 'tokL', body(), { 'x-otk-operation-id': 'open-1' });
      assert.ok(await eventually(async () => arrived === 1, 15_000));
      await assert.rejects(
        db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-late', 'tL', $1::numeric)", [P.toString()]),
        /otk_money_scope_open_exposure/,
      );
      await assert.rejects(db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-host', 'operator2', $1::numeric)", [P.toString()])
        .then(() => db.pool.query("INSERT INTO otk_money_budget_members (budget_id, tenant_id) VALUES ('b-host', 'tL')")), /otk_money_scope_open_exposure/);
      // a transaction holding the tenant's scope lock (a budget being created) blocks instance 2's admission until it commits
      const c = new pg.Client({ connectionString: db.url }); await c.connect();
      try {
        gate.release();
        await (await inflight).text();
        assert.ok(await eventually(async () => {
          const r = await db.pool.query("SELECT 1 FROM otk_operations WHERE tenant_id = 'tL' AND reservation->>'state' IN ('held', 'held_uncertain')");
          return r.rowCount === 0;
        }, 15_000));
        await c.query('BEGIN');
        await c.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-late', 'tL', $1::numeric)", [P.toString()]);
        const before = provider.calls.length;
        const pending = call(g2.base, 'tokL', unbounded(), { 'x-otk-operation-id': 'blocked-1' });
        await new Promise((r) => setTimeout(r, 500));
        const waiting = await db.pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted");
        assert.ok((waiting.rows[0] as { n: number }).n >= 1, 'instance 2 waits on the tenant scope lock');
        await c.query('COMMIT');
        const r = await pending;
        assert.equal(r.status, 402, 'instance 2 sees the committed budget');
        assert.equal(provider.calls.length, before);
        assert.equal(await opRow('tL', 'blocked-1'), undefined);
      } finally { await c.end(); }
    } finally { provider.onArrive = null; gate.release(); }
  });

  it('policy change and deletion are refused while an operation reserved under the budget is open; allowed after it settles', async () => {
    const { base } = await gateway('adm-open');
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-o', 'tO', $1::numeric)", [P.toString()]);
    const gate = new Barrier();
    let arrived = 0;
    provider.onArrive = async () => { arrived++; await gate.promise; };
    try {
      const inflight = call(base, 'tokO', body(), { 'x-otk-operation-id': 'o-1' });
      assert.ok(await eventually(async () => arrived === 1, 15_000));
      assert.notEqual((await budgetRow('b-o')).h, '0');
      await assertHeldConsistent('b-o');
      await assert.rejects(db.pool.query("UPDATE otk_money_budget SET money_policy = 'x@test' WHERE budget_id = 'b-o'"), /otk_money_scope_open_exposure/);
      await assert.rejects(db.pool.query("DELETE FROM otk_money_budget WHERE budget_id = 'b-o'"), /otk_money_scope_open_exposure/);
      await assert.rejects(db.pool.query("UPDATE otk_money_budget SET tenant_id = 'someone-else' WHERE budget_id = 'b-o'"), /otk_money_budget_owner_immutable/);
      gate.release();
      assert.equal((await inflight).status, 200);
      assert.ok(await eventually(async () => (await opRow('tO', 'o-1'))?.money === 'settled', 15_000));
    } finally { provider.onArrive = null; gate.release(); }
    await assertHeldConsistent('b-o');
    assert.equal((await budgetRow('b-o')).h, '0');
    await db.pool.query("UPDATE otk_money_budget SET money_policy = 'x@test' WHERE budget_id = 'b-o'");
    // spending stays attached to the budget; the next request is refused under the new policy
    const r = await call(base, 'tokO', body(), { 'x-otk-operation-id': 'o-2' });
    assert.equal(r.status, 402);
    assert.equal(await opRow('tO', 'o-2'), undefined);
  });

  it('two instances with different bound policies: only the one matching the budget admits', async () => {
    const other: MoneyBoundPolicy = { ...MONEY_BOUND_POLICY, id: 'otk.money_bound_policy.test-variant@2026-10-02' };
    const a = await gateway('adm-pa'); const b = await gateway('adm-pb', other);
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-two', 'operator3', $1::numeric)", [P.toString()]);
    // tQ's earlier operation is settled (asserted above), so it has no open exposure to cover
    await db.pool.query("INSERT INTO otk_money_budget_members (budget_id, tenant_id) VALUES ('b-two', 'tQ')");
    const before = provider.calls.length;
    const rb = await call(b.base, 'tokQ', body(), { 'x-otk-operation-id': 'two-b' });
    assert.equal(rb.status, 402);
    assert.match((await errorOf(rb)).detail ?? '', /test-variant/);
    assert.equal(provider.calls.length, before, 'the mismatching instance never calls the provider');
    const ra = await call(a.base, 'tokQ', body(), { 'x-otk-operation-id': 'two-a' });
    assert.equal(ra.status, 200);
    await ra.text();
    assert.ok(await eventually(async () => (await opRow('tQ', 'two-a'))?.money === 'settled', 15_000));
    assert.deepEqual((await opRow('tQ', 'two-a'))!.budget_ids.sort(), ['b-q', 'b-two']);
    await assertHeldConsistent('b-two');
    await assertHeldConsistent('b-q');
  });
});

describe('RV2-04 — strict refusals through the gateway (policy v2)', () => {
  it('a forwarded anthropic-beta header and max_tokens above the documented 64K never reach the provider; the bound is the window', async () => {
    const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId: 'adm-v2', recoveryIntervalMs: 3_600_000, measurement: ports(), quotaFor: () => null,
      policy: { leaseMs: 2_000, cancelPollMs: 100, maxOutputTokensCap: 100_000n, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model', 'anthropic-beta'] } });
    const server = gw.startProxyGateway({ port: 0, operations: rt });
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    started.push({ rt, server });
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    // tenant tN is under budget b-new (first test), created without an explicit policy → default (v2)
    const before = provider.calls.length;
    const beta = await call(base, 'tokN', body(), { 'anthropic-beta': 'context-1m-2025-08-07', 'x-otk-operation-id': 'v2-beta' });
    assert.equal(beta.status, 402);
    assert.match((await errorOf(beta)).detail ?? '', /header anthropic-beta/);
    const big = await call(base, 'tokN', body({ max_tokens: 64_001 }), { 'x-otk-operation-id': 'v2-big' });
    assert.equal(big.status, 402);
    assert.match((await errorOf(big)).detail ?? '', /max output 64001 outside 1\.\.64000/);
    assert.equal(provider.calls.length, before);
    const ok = await call(base, 'tokN', body({ max_tokens: 1024 }), { 'x-otk-operation-id': 'v2-ok' });
    assert.equal(ok.status, 200); await ok.text();
    const op = (await rt.store.get({ tenantId: 'tN', operationId: 'v2-ok' }))!;
    assert.equal(op.reservation.money!.units, 255_120_000_000n, '200 000 × 1.25 µUSD + 1 024 × 5 µUSD (hand value)');
    assert.equal(op.limits.moneyBoundPolicy, MONEY_BOUND_POLICY.id);
  });
});

describe('RV2-07 — cache TTL other than 5 minutes is refused before the upstream (OTK limitation, not the API)', () => {
  it('ttl "1h" at the top level (automatic caching), an unknown ttl, and a body nested beyond the scan depth: 400, provider not called', async () => {
    const { base } = await gateway('adm-ttl');
    const before = provider.calls.length;
    let deep: unknown = { type: 'text', text: 'x', cache_control: { type: 'ephemeral', ttl: '1h' } };
    for (let i = 0; i < 40; i++) deep = [deep];
    const cases: Array<[string, Record<string, unknown>, RegExp]> = [
      ['top-level 1h', body({ cache_control: { type: 'ephemeral', ttl: '1h' } }), /cache_control\.ttl "1h"/],
      ['block 60m', body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '60m' } }] }] }), /cache_control\.ttl "60m"/],
      ['deep', body({ messages: [{ role: 'user', content: deep }] }), /nested beyond the scanned depth/],
    ];
    for (const [name, b, re] of cases) {
      const r = await call(base, 'tokO', b);
      assert.equal(r.status, 400, name);
      const e = await errorOf(r);
      assert.equal(e.error, 'cache_ttl_not_supported', name);
      assert.match(e.detail ?? '', re, name);
      assert.match(e.detail ?? '', /does not normalize the 1-hour breakdown/, name);
    }
    assert.equal(provider.calls.length, before);
  });
});
