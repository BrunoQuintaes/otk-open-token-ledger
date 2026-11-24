/**
 * FECHAMENTO_GEMINI_AD (author decision 2026-10-04) — gemini-3.5-flash-lite under money policy v5 through the durable gateway,
 * real measurement ports (development-2026-10-04 weights, flagged), combined price table 2026-10-04, real PostgreSQL 16,
 * synthetic Gemini provider. Thinking cannot be turned off on this model: thinkingLevel "minimal" is required and thought
 * tokens are billed as output inside the documented maxOutputTokens cap (no freeze).
 *
 *   . scripts/ops/fps5_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_gem_gemini35.test.ts
 *
 * Hand values: weights 900 × 600 → 540 000 micro-CU/token; prices (µUSD/MTok) input 300 000, cache read 30 000, output 2 500 000.
 *  - worst case maxOutputTokens 64: 1 048 576 × 300 000 + 64 × 2 500 000 = 314 572 800 000 + 160 000 000 = 314 732 800 000 pico;
 *  - usage 100 prompt / 50 candidates / 3 thoughts (total 153): CU 153 × 540 000 = 82 620 000;
 *    cost 100 × 300 000 + (50 + 3) × 2 500 000 = 30 000 000 + 132 500 000 = 162 500 000 pico (US$ 0,0001625).
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'g5/OPERATOR:tokg5';
process.env['GEMINI_API_KEY'] = 'AIza-otk-gemini35-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider } from './d1d8_c_provider.js';
import { eventually } from './d1d8_c_proc.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';
import { MONEY_BOUND_POLICY_V5 } from '../../src/operations/moneyBound.js';
import type { DurableOperation } from '../../src/types/d1d8/index.js';

const P = 1_000_000_000_000n;
const MODEL = 'gemini-3.5-flash-lite';
const WORST_64 = 314_732_800_000n;
let db: TestDb; let rt: OperationsRuntime; let server: Server; let base = '';
const provider = new ControllableProvider();

before(async () => {
  db = await createTestDb('gemini35');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_GEMINI'] = provider.url;
  const gw = await import('../../src/proxy/ProxyGateway.js');
  rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId: 'gem35', recoveryIntervalMs: 3_600_000, quotaFor: () => null, moneyBoundPolicy: MONEY_BOUND_POLICY_V5,
    measurement: d1d8MeasurementPorts({ weights: developmentWeights('development-2026-10-04'), prices: loadPriceTables(['scripts/pilot/price_table_pilot_v3_gemini35_20261004.json']) }),
    policy: { leaseMs: 2_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model', 'x-test-gemini-thoughts', 'x-test-gemini-tier'] } });
  server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await db.pool.query('INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units, money_policy) VALUES ($1, $2, $3::numeric, $4)', ['b-g5', 'g5', P.toString(), MONEY_BOUND_POLICY_V5.id]);
});
after(async () => {
  await provider.stop();
  server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rt.stop();
  await db.drop();
});
const ABSENT = Symbol('absent');
const body = (tc: unknown = { thinkingLevel: 'minimal' }) => ({ contents: [{ role: 'user', parts: [{ text: 'Responda ok.' }] }], generationConfig: { maxOutputTokens: 64, ...(tc === ABSENT ? {} : { thinkingConfig: tc }) } });
const call = (id: string | null, b: unknown, h: Record<string, string> = {}, stream = false) => fetch(`${base}/v1beta/models/${MODEL}:${stream ? 'streamGenerateContent' : 'generateContent'}`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tokg5', 'x-otk-provider': 'gemini', 'x-test-script': stream ? 'stream' : 'ok', ...(id ? { 'x-otk-operation-id': id } : {}), ...h }, body: JSON.stringify(b) });
const done = async (id: string): Promise<DurableOperation> => {
  assert.ok(await eventually(async () => { const o = await rt.store.get({ tenantId: 'g5', operationId: id }); return !!o && o.execution === 'completed' && o.money?.state !== 'held'; }), id);
  return (await rt.store.get({ tenantId: 'g5', operationId: id }))!;
};
const budget = async () => (await db.pool.query<{ s: string; h: string; f: string | null }>("SELECT spent_units::text AS s, held_units::text AS h, frozen_reason AS f FROM otk_money_budget WHERE budget_id = 'b-g5'")).rows[0]!;

describe('policy v5 — gemini-3.5-flash-lite', () => {
  it('thinking must be thinkingLevel "minimal" exactly: absent, thinkingBudget, other levels and includeThoughts are refused before the provider', async () => {
    const n = provider.calls.length;
    for (const tc of [ABSENT, { thinkingBudget: 0 }, { thinkingLevel: 'low' }, { thinkingLevel: 'high' }, { thinkingLevel: 'minimal', includeThoughts: true }, { thinkingLevel: 'minimal', thinkingBudget: 0 }]) {
      const r = await call(null, body(tc));
      assert.equal(r.status, 402, String(JSON.stringify(tc)));
      assert.equal(((await r.json()) as { error: string }).error, 'money_bound_unavailable');
    }
    assert.equal(provider.calls.length, n);
  });
  it('JSON and SSE with 3 thought tokens: reservation, CU and cost by hand; thoughts billed as output; no freeze', async () => {
    for (const stream of [false, true]) {
      const id = `g35-${stream}`;
      const r = await call(id, body(), { 'x-test-tokens': '100,50', 'x-test-gemini-thoughts': '3' }, stream);
      assert.equal(r.status, 200);
      await r.text();
      const o = await done(id);
      assert.equal(o.reservation.money!.units, WORST_64);
      assert.equal(o.limits.moneyBoundPolicy, MONEY_BOUND_POLICY_V5.id);
      assert.deepEqual(o.limits.pricingTerms, { serviceTier: 'standard' });
      assert.equal(o.usage!.categories.find((c) => c.name === 'output_reasoning')?.count, 3n);
      assert.deepEqual(o.reservation.cu, { units: 82_620_000n, scale: 1_000_000n });
      assert.equal(o.money!.state, 'settled');
      assert.equal(o.money!.confirmed!.units, 162_500_000n);
    }
    const b = await budget();
    assert.deepEqual(b, { s: (2n * 162_500_000n).toString(), h: '0', f: null });
  });
  it('the forwarded body keeps thinkingLevel minimal; the Google key goes in x-goog-api-key', async () => {
    const pc = provider.calls[provider.calls.length - 1]!;
    assert.deepEqual((pc.body['generationConfig'] as Record<string, unknown>)['thinkingConfig'], { thinkingLevel: 'minimal' });
    assert.equal(pc.headers['x-goog-api-key'], 'AIza-otk-gemini35-provider-fixture');
  });
});
