/**
 * D1–D8 / S4 — ABC-04: strict money ceiling through the real gateway (ProxyGateway durable
 * profile), front B's real measurement ports (development-profile weights, explicitly flagged),
 * the official dated Haiku 4.5 price table, real PostgreSQL 16, two gateway instances and two
 * tenants sharing one budget, local controllable provider (synthetic, no paid call).
 *
 *   . scripts/ops/s4_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_s4_money_ceiling.test.ts
 *
 * Hand values. Haiku 4.5 table (US$/MTok): input 1, cache read 0.10, cache write 1.25 (5 min;
 * 1 h writes are refused by the proxy), output 5. Worst case per request (MONEY_BOUND_POLICY v2, RV2-04): input bound =
 * the documented context window of Haiku 4.5 (200 000 tokens), priced at the highest input-side tariff (cache write 5 min,
 * 1.25 µUSD/token), plus max_tokens × 5 µUSD: for max_tokens 64, 250 000 000 000 + 320 000 000 = 250 320 000 000 pico-USD.
 * Settlement of usage 100/50: 100 × 1 + 50 × 5 = 350 µUSD-per-MTok-units → 350 000 000 pico-USD.
 *
 * Module under test: the strict money ceiling in the in-process durable gateway (`src/operations/runtime.ts` and the
 * proxy routes), with the fake provider from `./d1d8_c_provider.ts`.
 *
 * Strategy / scenarios: requests without a defensible cost bound (tools, cache marks, thinking, images, a regional
 * inference setting, unlisted models) refused before the provider; a bounded request reserved at the hand worst case
 * and settled at the quoted total; one ceiling shared by two tenants and two instances (exactly 3 of 8 concurrent
 * requests reach the provider); an upstream cut without usage keeping the worst case held, also after a restart; and
 * a returned model outside the reserved set freezing the budget.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`). Before importing the server it
 * sets fixture values in the test process for the API's variables (tenants, a fake Anthropic key, the upstream
 * override, `PROVER_URL=disabled`). The command above loads the test environment from `scripts/ops/s4_env.sh` first;
 * with the variables already set, `npx tsx --test --test-concurrency=1 test/services/d1d8_s4_money_ceiling.test.ts`
 * runs just this file.
 *
 * @module test/services/d1d8_s4_money_ceiling.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'tA/OPERATOR:tokA,tB/OPERATOR:tokB,tC/OPERATOR:tokC,tU/OPERATOR:tokU,tF/OPERATOR:tokF';
process.env['ANTHROPIC_API_KEY'] = 'sk-ant-otkd1d8s4-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider, Barrier } from './d1d8_c_provider.js';
import { eventually } from './d1d8_c_proc.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';

const P = 1_000_000_000_000n;
const TABLE_FILE = 'scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json';
let db: TestDb;
const provider = new ControllableProvider();
const started: Array<{ rt: OperationsRuntime; server: Server }> = [];
let gw: typeof import('../../src/proxy/ProxyGateway.js');

const ports = () => d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables([TABLE_FILE]) });
async function gateway(instanceId: string): Promise<{ rt: OperationsRuntime; base: string }> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, recoveryIntervalMs: 3_600_000, measurement: ports(), quotaFor: () => null,
    policy: { leaseMs: 2_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] } });
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  started.push({ rt, server });
  return { rt, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

const body = (extra: Record<string, unknown> = {}) => ({ model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Say hello in one word.' }], ...extra });
const worstCase = (b: Record<string, unknown>) => 200_000n * 1_250_000n + BigInt(b['max_tokens'] as number) * 5_000_000n;
function call(base: string, token: string, b: unknown, script = 'ok', extra: Record<string, string> = {}) {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-otk-provider': 'anthropic', 'anthropic-version': '2023-06-01', 'x-test-script': script, ...extra },
    body: JSON.stringify(b),
  });
}
const budget = async (id: string) => (await db.pool.query<{ s: string; h: string; f: string | null }>('SELECT spent_units::text AS s, held_units::text AS h, frozen_reason AS f FROM otk_money_budget WHERE budget_id = $1', [id])).rows[0]!;

before(async () => {
  db = await createTestDb('s4ceiling');
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

describe('S4 ABC-04 — refused before the upstream when the cost has no defensible bound', () => {
  it('tools, cache_control, thinking, images, inference_geo and unlisted models are refused (402) and never reach the provider', async () => {
    const { base } = await gateway('ceil-refuse');
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-C', 'tC', $1::numeric)", [P.toString()]);
    const before = provider.calls.length;
    const cases: Array<[string, Record<string, unknown>]> = [
      ['tools', body({ tools: [{ name: 'x', input_schema: { type: 'object' } }] })],
      ['cache_control', body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral' } }] }] })],
      ['thinking', body({ thinking: { type: 'enabled', budget_tokens: 32 } })],
      ['image', body({ messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] })],
      ['inference_geo', body({ inference_geo: 'us' })],
      ['unlisted model', body({ model: 'claude-sonnet-4-5' })],
    ];
    for (const [name, b] of cases) {
      const r = await call(base, 'tokC', b);
      assert.equal(r.status, 402, name);
      assert.equal(((await r.json()) as { error: string }).error, 'money_bound_unavailable', name);
    }
    // 1-hour cache writes are refused for every tenant (usage does not distinguish their tariff)
    const ttl = await call(base, 'tokC', body({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] }] }));
    assert.equal(ttl.status, 400);
    assert.equal(((await ttl.json()) as { error: string }).error, 'cache_ttl_not_supported');
    assert.equal(provider.calls.length, before, 'no refused request reached the provider');
    assert.deepEqual(await budget('b-C'), { s: '0', h: '0', f: null });
  });

  it('bounded request: reservation = hand worst case; settles at the quoted total, hold returned', async () => {
    const { base, rt } = await gateway('ceil-ok');
    const b = body();
    const r = await call(base, 'tokC', b, 'ok', { 'x-test-tokens': '100,50', 'x-otk-operation-id': 'ok-1' });
    assert.equal(r.status, 200);
    await r.text();
    // the settlement is written after the response ends (the client is not kept waiting)
    assert.ok(await eventually(async () => (await rt.store.get({ tenantId: 'tC', operationId: 'ok-1' }))?.money?.state === 'settled'));
    const op = (await rt.store.get({ tenantId: 'tC', operationId: 'ok-1' }))!;
    assert.equal(op.reservation.money!.units, worstCase(b), 'documented window × 1.25 + max_tokens × 5');
    assert.equal(op.reservation.money!.units, 250_320_000_000n);
    assert.equal(op.limits.moneyBoundPolicy, 'otk.money_bound_policy.v2@2026-10-02');
    assert.deepEqual(op.limits.allowedReturnedModels, ['claude-haiku-4-5', 'claude-haiku-4-5-20251001']);
    assert.equal(op.money!.state, 'settled');
    assert.equal(op.money!.confirmed!.units, 350_000_000n);
    assert.deepEqual(await budget('b-C'), { s: '350000000', h: '0', f: null });
  });
});

describe('S4 ABC-04 — one ceiling shared by two tenants and two instances', () => {
  it('ceiling = 3.5 worst cases: exactly 3 of 8 concurrent requests reach the provider; the rest are 402 before upstream', async () => {
    const g1 = await gateway('ceil-i1'); const g2 = await gateway('ceil-i2');
    const W = worstCase(body());
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('pilot', 'operator', $1::numeric)", [(W * 7n / 2n).toString()]);
    await db.pool.query("INSERT INTO otk_money_budget_members (budget_id, tenant_id) VALUES ('pilot', 'tA'), ('pilot', 'tB')");
    const gate = new Barrier();
    const arrived: string[] = [];
    provider.onArrive = async (c) => { arrived.push(c.script); await gate.promise; };
    const reqs = Array.from({ length: 8 }, (_, i) => call(i % 2 ? g2.base : g1.base, i % 4 < 2 ? 'tokA' : 'tokB', body(), 'ok', { 'x-test-tokens': '100,50' }));
    assert.ok(await eventually(async () => arrived.length >= 3, 15_000));
    await new Promise((r) => setTimeout(r, 300)); // any further admission would have arrived by now
    assert.equal(arrived.length, 3, 'strict_ceiling_worst_case@1: no crossing');
    const held = await budget('pilot');
    assert.equal(BigInt(held.h), 3n * W, 'three worst cases held');
    gate.release();
    provider.onArrive = null;
    const statuses = (await Promise.all(reqs.map(async (p) => { const r = await p; await r.text(); return r.status; }))).sort();
    assert.deepEqual(statuses, [200, 200, 200, 402, 402, 402, 402, 402]);
    assert.ok(await eventually(async () => (await budget('pilot')).h === '0'));
    const after = await budget('pilot');
    assert.deepEqual(after, { s: (3n * 350_000_000n).toString(), h: '0', f: null });
    assert.ok(BigInt(after.s) + BigInt(after.h) <= W * 7n / 2n);
  });
});

describe('S4 ABC-04 — uncertain exposure, restart, unexpected model', () => {
  it('upstream cut without usage: worst case stays held (held_uncertain), also after a restart of the instance', async () => {
    const g = await gateway('ceil-unc');
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-U', 'tU', $1::numeric)", [P.toString()]);
    const b = body({ stream: true });
    const r = await call(g.base, 'tokU', b, 'cut', { 'x-otk-operation-id': 'cut-1' });
    await r.text().catch(() => '');
    assert.ok(await eventually(async () => (await g.rt.store.get({ tenantId: 'tU', operationId: 'cut-1' }))?.money?.state === 'held_uncertain'));
    assert.equal(BigInt((await budget('b-U')).h), worstCase(b));
    const restarted = await gateway('ceil-unc'); // same instance id: restart
    await restarted.rt.recoverOnce();
    assert.equal((await restarted.rt.store.get({ tenantId: 'tU', operationId: 'cut-1' }))!.money!.state, 'held_uncertain');
    assert.equal(BigInt((await budget('b-U')).h), worstCase(b), 'never released by timeout/restart');
  });

  it('provider reports a model outside the reserved set: cost recorded as is, budget frozen, next request refused', async () => {
    const g = await gateway('ceil-unexp');
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-F', 'tF', $1::numeric)", [P.toString()]);
    const r = await call(g.base, 'tokF', body(), 'ok', { 'x-test-model': 'claude-sonnet-4-5', 'x-test-tokens': '100,50', 'x-otk-operation-id': 'unexp-1' });
    assert.equal(r.status, 200); await r.text();
    assert.ok(await eventually(async () => (await g.rt.store.get({ tenantId: 'tF', operationId: 'unexp-1' }))?.measurement === 'final'));
    const d = (await g.rt.store.getDetail({ tenantId: 'tF', operationId: 'unexp-1' }))!;
    assert.equal(d.operation.usage!.modelReturned, 'claude-sonnet-4-5');
    assert.equal(d.settlementNote, 'unexpected_returned_model');
    assert.equal(d.operation.money!.state, 'pending_price', 'not priced by the Haiku table, worst case kept held');
    const bf = await budget('b-F');
    assert.match(String(bf.f), /^unexpected_returned_model:claude-sonnet-4-5:tF\/unexp-1$/);
    const next = await call(g.base, 'tokF', body(), 'ok');
    assert.equal(next.status, 402);
    assert.equal(((await next.json()) as { error: string }).error, 'budget_exceeded');
  });
});
