/**
 * FECHAMENTO_GEMINI_AD — defects reproduced BEFORE the fix and checked AFTER it, through the real durable gateway
 * (only APIs that exist in both versions, so the same file runs on d574ce3 and on the corrected candidate):
 *  D-GEM-01 the Google key went upstream as `Authorization: Bearer` (Google answers 401);
 *  D-GEM-02 a Gemini stream route without `alt=sse` was forwarded as is (the API then streams a JSON array, not SSE);
 *  D-GEM-03 a missing provider key became an UNCERTAIN exposure although nothing left the gateway;
 *  D-OAI-01 an OpenAI request without service_tier reached the provider without it ("auto": the project's tier);
 *  D-OAI-02 a response served on another tier was settled at the Standard tariff as if confirmed.
 *
 *   . scripts/ops/fps5_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_gem_before_after.test.ts
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'ba/OPERATOR:tokba';
process.env['GEMINI_API_KEY'] = 'AIza-otk-before-after-fixture';
process.env['OPENAI_API_KEY'] = 'sk-otk-before-after-fixture';
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
import type { DurableOperation } from '../../src/types/d1d8/index.js';

let db: TestDb;
const provider = new ControllableProvider();
let rt: OperationsRuntime; let server: Server; let base = '';

before(async () => {
  db = await createTestDb('gembefore');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_GEMINI'] = provider.url;
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  const gw = await import('../../src/proxy/ProxyGateway.js');
  rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId: 'gem-before-after', recoveryIntervalMs: 3_600_000, quotaFor: () => null,
    measurement: d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables(['scripts/pilot/price_table_pilot_v3_20261003.json']) }),
    policy: { leaseMs: 2_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model', 'x-test-openai-tier'] } });
  server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await provider.stop();
  server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rt.stop();
  await db.drop();
});
const terminal = (o: DurableOperation | null) => !!o && ['completed', 'cancelled', 'upstream_failed', 'process_lost'].includes(o.execution) && o.money?.state !== 'held';
async function done(id: string): Promise<DurableOperation> {
  assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 'ba', operationId: id }))), id);
  return (await rt.store.get({ tenantId: 'ba', operationId: id }))!;
}
// gemini-2.0-flash: a model with a weight in both versions (the request is not under a money budget)
const gem = (id: string, verb: string, script: string) => fetch(`${base}/v1beta/models/gemini-2.0-flash:${verb}`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tokba', 'x-otk-provider': 'gemini', 'x-otk-operation-id': id, 'x-test-script': script },
  body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'oi' }] }], generationConfig: { maxOutputTokens: 16 } }),
});
const oai = (id: string, h: Record<string, string> = {}) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tokba', 'x-otk-provider': 'openai', 'x-otk-operation-id': id, 'x-test-script': 'ok', 'x-test-model': 'gpt-4o-mini-2024-07-18', 'x-test-tokens': '100,50', ...h },
  body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 16, messages: [{ role: 'user', content: 'oi' }] }),
});

describe('defects reproduced before the fix', () => {
  it('D-GEM-01: the provider receives the Google key in x-goog-api-key, never as Bearer', async () => {
    const r = await gem('ba-auth', 'generateContent', 'ok');
    await r.text();
    const pc = provider.calls[provider.calls.length - 1]!;
    assert.equal(pc.authorization, undefined, `Authorization upstream: ${pc.authorization ?? ''}`);
    assert.equal(pc.headers['x-goog-api-key'], 'AIza-otk-before-after-fixture');
  });
  it('D-GEM-02: a stream route without alt is sent with alt=sse', async () => {
    const r = await gem('ba-alt', 'streamGenerateContent', 'stream');
    await r.text();
    assert.match(provider.calls[provider.calls.length - 1]!.path, /[?&]alt=sse(&|$)/);
  });
  it('D-GEM-03: provider key missing → certain non-delivery (released), not an uncertain exposure', async () => {
    const saved = process.env['GEMINI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    try {
      const r = await gem('ba-nokey', 'generateContent', 'ok');
      assert.equal(r.status, 502);
      await r.text();
      const o = await done('ba-nokey');
      assert.equal(o.reservation.state, 'released');
    } finally { process.env['GEMINI_API_KEY'] = saved; }
  });
  it('D-OAI-01: an OpenAI request without service_tier reaches the provider asking "default" (Standard)', async () => {
    const r = await oai('ba-tier-inject');
    await r.text();
    assert.equal(provider.calls[provider.calls.length - 1]!.body['service_tier'], 'default');
  });
  it('D-OAI-02: a response served on "priority" is not settled at the Standard tariff', async () => {
    const r = await oai('ba-tier-prio', { 'x-test-openai-tier': 'priority' });
    await r.text();
    const o = await done('ba-tier-prio');
    assert.equal(o.measurement, 'final');
    assert.notEqual(o.money?.state, 'settled', `money ${o.money?.state} confirmed ${String(o.money?.confirmed?.units)}`);
  });
});
