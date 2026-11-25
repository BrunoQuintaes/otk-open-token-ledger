/**
 * FECHAMENTO_GEMINI_AD — G-OPENAI-TIER: the PRODUCT (not the pilot runner) guarantees the tariff assumption of
 * OpenAI Chat Completions. OpenAI processes an omitted service_tier as "auto" (the project's setting); the frozen
 * table prices Standard ("default"). Real gateway, real measurement ports (historical development weights),
 * pilot v3 price table (gpt-4o-mini Standard), policies v3 and v4, real PostgreSQL 16, synthetic provider.
 *
 *   . scripts/ops/fps5_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_gem_openai_tier.test.ts
 *
 * Hand values: gpt-4o-mini weights 1000 × 400 → 400 000 micro-CU per token; prices (µUSD/MTok) input 150 000,
 * output 600 000. Worst case max_tokens 64: 128 000 × 150 000 + 64 × 600 000 = 19 238 400 000 pico-USD.
 * Usage 100/50: 100 × 150 000 + 50 × 600 000 = 45 000 000 pico-USD.
 *
 * Module under test: the durable gateway (`src/operations/runtime.ts` and the proxy routes) for OpenAI Chat
 * Completions, against the fake provider from `./d1d8_c_provider.ts`.
 *
 * Strategy / partitions: the Standard tier is requested explicitly before any spend (an omitted tier is sent as
 * "default"; strict policies refuse other client tiers before the provider and still inject "default"); and the tier
 * actually served decides the settlement (a JSON answer on another tier, an SSE answer read to the end after the
 * client left, a missing tier that holds the worst case without freezing the budget, and the non-strict mode).
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`); run with
 * `--test-concurrency=1`. Before importing the server it sets fixture values in the test process for the API's
 * variables (tenants, a fake OpenAI key, the upstream override, `PROVER_URL=disabled`). With the variables already
 * set, `npx tsx --test --test-concurrency=1 test/services/d1d8_gem_openai_tier.test.ts` runs just this file.
 *
 * @module test/services/d1d8_gem_openai_tier.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'oN/OPERATOR:tokoN,o4/OPERATOR:toko4,o3/OPERATOR:toko3,oP/OPERATOR:tokoP,oD/OPERATOR:tokoD,oM/OPERATOR:tokoM';
process.env['OPENAI_API_KEY'] = 'sk-otk-openai-tier-provider-fixture';
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
import { MONEY_BOUND_POLICY_V3, MONEY_BOUND_POLICY_V4, type MoneyBoundPolicy } from '../../src/operations/moneyBound.js';
import type { DurableOperation } from '../../src/types/d1d8/index.js';

const P = 1_000_000_000_000n;
const WORST_64 = 19_238_400_000n;
let db: TestDb;
const provider = new ControllableProvider();
const started: Array<{ rt: OperationsRuntime; server: Server }> = [];
let gw: typeof import('../../src/proxy/ProxyGateway.js');

async function gateway(instanceId: string, policy: MoneyBoundPolicy): Promise<{ rt: OperationsRuntime; base: string }> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, recoveryIntervalMs: 3_600_000, quotaFor: () => null, moneyBoundPolicy: policy,
    measurement: d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables(['scripts/pilot/price_table_pilot_v3_20261003.json']) }),
    policy: { leaseMs: 2_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model', 'x-test-openai-cached', 'x-test-openai-tier'] } });
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  started.push({ rt, server });
  return { rt, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const body = (extra: Record<string, unknown> = {}) => ({ model: 'gpt-4o-mini', max_tokens: 64, messages: [{ role: 'user', content: 'Responda ok.' }], ...extra });
function call(base: string, token: string, opId: string, b: unknown, h: Record<string, string> = {}, signal?: AbortSignal) {
  return fetch(`${base}/v1/chat/completions`, { method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-otk-provider': 'openai', 'x-otk-operation-id': opId, 'x-test-script': 'ok', 'x-test-model': 'gpt-4o-mini-2024-07-18', 'x-test-tokens': '100,50', ...h },
    body: JSON.stringify(b) });
}
const terminal = (o: DurableOperation | null) => !!o && ['completed', 'cancelled', 'upstream_failed', 'process_lost'].includes(o.execution) && o.money?.state !== 'held';
const budget = async (id: string) => (await db.pool.query<{ s: string; h: string; f: string | null }>('SELECT spent_units::text AS s, held_units::text AS h, frozen_reason AS f FROM otk_money_budget WHERE budget_id = $1', [id])).rows[0]!;
const addBudget = (id: string, tenant: string, policy: MoneyBoundPolicy) => db.pool.query('INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units, money_policy) VALUES ($1, $2, $3::numeric, $4)', [id, tenant, P.toString(), policy.id]);
async function done(rt: OperationsRuntime, tenantId: string, operationId: string): Promise<DurableOperation> {
  assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId, operationId }))), `${tenantId}/${operationId} terminal`);
  return (await rt.store.get({ tenantId, operationId }))!;
}

before(async () => {
  db = await createTestDb('oaitier');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
});
after(async () => {
  await provider.stop();
  for (const s of started) { s.server.closeAllConnections(); await new Promise<void>((r) => s.server.close(() => r())); await s.rt.stop(); }
  await db.drop();
});

describe('G-OPENAI-TIER — Standard asked explicitly BEFORE the spend', () => {
  it('client omits service_tier: the provider receives service_tier "default" (before the fix it received nothing → "auto")', async () => {
    const { rt, base } = await gateway('oa-inject', MONEY_BOUND_POLICY_V3);
    const r = await call(base, 'tokoN', 'inj-1', body());
    assert.equal(r.status, 200);
    await r.text();
    assert.equal(provider.calls[provider.calls.length - 1]!.body['service_tier'], 'default');
    const o = await done(rt, 'oN', 'inj-1');
    assert.equal(o.usage!.serviceTier, 'default');
  });

  it('v4 strict: a client tier other than default is refused (402) and never reaches the provider; "default" is admitted and settled by hand values', async () => {
    const { rt, base } = await gateway('oa-v4', MONEY_BOUND_POLICY_V4);
    await addBudget('b-o4', 'o4', MONEY_BOUND_POLICY_V4);
    const n = provider.calls.length;
    for (const t of ['priority', 'flex', 'auto', 'scale', 'fast']) {
      const r = await call(base, 'toko4', `v4-${t}`, body({ service_tier: t }));
      assert.equal(r.status, 402, t);
      assert.match(((await r.json()) as { detail: string }).detail, /service_tier/);
    }
    assert.equal(provider.calls.length, n, 'no refused tier reached the provider');
    const ok = await call(base, 'toko4', 'v4-default', body({ service_tier: 'default' }));
    assert.equal(ok.status, 200);
    await ok.text();
    const o = await done(rt, 'o4', 'v4-default');
    assert.equal(o.reservation.money!.units, WORST_64);
    assert.deepEqual(o.limits.pricingTerms, { serviceTier: 'default' });
    assert.equal(o.money!.state, 'settled');
    assert.equal(o.money!.confirmed!.units, 45_000_000n);
    assert.deepEqual(o.reservation.cu, { units: 150n * 400_000n, scale: 1_000_000n });
  });

  it('v3 strict keeps its admission rules (a client service_tier is still refused) and also gets "default" injected', async () => {
    const { rt, base } = await gateway('oa-v3', MONEY_BOUND_POLICY_V3);
    await addBudget('b-o3', 'o3', MONEY_BOUND_POLICY_V3);
    const refused = await call(base, 'toko3', 'v3-client-tier', body({ service_tier: 'default' }));
    assert.equal(refused.status, 402);
    await refused.text();
    const r = await call(base, 'toko3', 'v3-omit', body());
    await r.text();
    assert.equal(provider.calls[provider.calls.length - 1]!.body['service_tier'], 'default');
    const o = await done(rt, 'o3', 'v3-omit');
    assert.equal(o.limits.moneyBoundPolicy, MONEY_BOUND_POLICY_V3.id);
    assert.equal(o.limits.pricingTerms, undefined, 'v3 rules carry no terms (unchanged policy)');
    assert.equal(o.money!.state, 'settled');
  });
});

describe('G-OPENAI-TIER — the tier actually served is observed by the server and decides the settlement', () => {
  it('JSON answered on "priority": price pending (reserve held), budget frozen (unexpected_service_tier)', async () => {
    const { rt, base } = await gateway('oa-prio', MONEY_BOUND_POLICY_V4);
    await addBudget('b-oP', 'oP', MONEY_BOUND_POLICY_V4);
    const r = await call(base, 'tokoP', 'prio-json', body(), { 'x-test-openai-tier': 'priority' });
    await r.text();
    const o = await done(rt, 'oP', 'prio-json');
    assert.equal(o.measurement, 'final');
    assert.equal(o.usage!.serviceTier, 'priority');
    assert.equal(o.money!.state, 'pending_price');
    assert.equal(o.money!.confirmed, null);
    const b = await budget('b-oP');
    assert.ok(b.f?.startsWith('unexpected_service_tier:priority:'), `frozen: ${b.f}`);
    assert.equal(BigInt(b.h), WORST_64);
    const next = await call(base, 'tokoP', 'prio-next', body());
    assert.equal(next.status, 402, 'nothing else admitted until reviewed');
    await next.text();
  });

  it('SSE with the client disconnected after the first chunk: the server still reads the tier ("flex") → pending + frozen', async () => {
    const { rt, base } = await gateway('oa-disc', MONEY_BOUND_POLICY_V4);
    await addBudget('b-oD', 'oD', MONEY_BOUND_POLICY_V4);
    const fb = new Barrier(); provider.finalBarriers.push(fb);
    const ac = new AbortController();
    const r = await call(base, 'tokoD', 'flex-sse', body({ stream: true }), { 'x-test-script': 'stream', 'x-test-openai-tier': 'flex' }, ac.signal);
    await r.body!.getReader().read();
    ac.abort();
    await new Promise((res) => setTimeout(res, 200));
    fb.release();
    const o = await done(rt, 'oD', 'flex-sse');
    assert.equal(o.delivery, 'client_disconnected');
    assert.equal(o.usage!.serviceTier, 'flex');
    assert.equal(o.money!.state, 'pending_price');
    assert.ok((await budget('b-oD')).f?.startsWith('unexpected_service_tier:flex:'));
  });

  it('tier not reported (metadata missing): price pending with the worst case held, budget NOT frozen (unknown ≠ contradicted)', async () => {
    const { rt, base } = await gateway('oa-missing', MONEY_BOUND_POLICY_V4);
    await addBudget('b-oM', 'oM', MONEY_BOUND_POLICY_V4);
    for (const stream of [false, true]) {
      const id = `missing-${stream}`;
      const r = await call(base, 'tokoM', id, body(stream ? { stream: true } : {}), { 'x-test-openai-tier': 'none', ...(stream ? { 'x-test-script': 'stream' } : {}) });
      await r.text();
      const o = await done(rt, 'oM', id);
      assert.equal(o.usage!.serviceTier, null, id);
      assert.equal(o.money!.state, 'pending_price', id);
    }
    const b = await budget('b-oM');
    assert.equal(b.f, null);
    assert.equal(BigInt(b.h), 2n * WORST_64);
  });

  it('outside strict mode a non-Standard tier is not confirmed at the Standard tariff either', async () => {
    const { rt, base } = await gateway('oa-nonstrict', MONEY_BOUND_POLICY_V4);
    const r = await call(base, 'tokoN', 'ns-prio', body(), { 'x-test-openai-tier': 'priority' });
    await r.text();
    const o = await done(rt, 'oN', 'ns-prio');
    assert.equal(o.money!.state, 'pending_price');
  });
});
