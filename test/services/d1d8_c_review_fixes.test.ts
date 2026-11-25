/**
 * D1–D8 / C — regression tests for the findings of the adversarial review of C (two agents,
 * 2026-10-01; see C/REVISAO_ADVERSARIAL_C.md). Each test fails on the code before the fix.
 * Real PostgreSQL; local controllable provider; legacy measurement ports unless stated.
 *
 * Module under test: `src/operations/runtime.ts` (`OperationsRuntime`) through the in-process API proxy routes,
 * with the fake provider from `./d1d8_c_provider.ts`.
 *
 * Strategy / scenarios, one per review finding: a dated model name in the provider answer still settles with the
 * admitted weights; a 4xx without usage releases the hold; requests refused before the provider (no call, no
 * operation) for each refused case in the table; headers allowlisted in both directions; a slow reader and an
 * oversized non-stream body still metered; an exception after the start ends the operation as uncertain without a
 * leftover lease; cancelling an operation that never started releases it at once; and a spool folder without a
 * stable instance id refused.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`) and a writable temporary
 * directory. Before importing the server it sets fixture values in the test process for the API's variables
 * (`OTK_TENANTS`, fake provider keys, upstream overrides, `PROVER_URL=disabled`). No network.
 *
 * Run just this file: `npx tsx --test test/services/d1d8_c_review_fixes.test.ts`
 *
 * @module test/services/d1d8_c_review_fixes.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'rf/OPERATOR:tokrf';
process.env['OPENAI_API_KEY'] = 'sk-otkd1d8c-provider-fixture';
process.env['GEMINI_API_KEY'] = 'gk-otkd1d8c-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider } from './d1d8_c_provider.js';
import { eventually } from './d1d8_c_proc.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { legacyMeasurementPorts } from '../../src/operations/measurementPorts.js';
import type { DurableOperation } from '../../src/types/d1d8/index.js';
import { admitReq } from '../fixtures/d1d8/c/builders.js';

let db: TestDb;
const provider = new ControllableProvider();
const live: Array<{ rt: OperationsRuntime; server: Server }> = [];
let gw: typeof import('../../src/proxy/ProxyGateway.js');

async function gateway(opts: Partial<Parameters<typeof OperationsRuntime.create>[0]> = {}) {
  // RV2-06: the legacy measurement is chosen explicitly (it used to be the runtime's silent default)
  const rt = await OperationsRuntime.create({ dbUrl: db.url, recoveryIntervalMs: 3_600_000, measurement: legacyMeasurementPorts(), ...opts, policy: { leaseMs: 2_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'], ...opts.policy } });
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  live.push({ rt, server });
  return { rt, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const post = (base: string, p: string, id: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${p}`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tokrf', 'x-otk-operation-id': id, ...headers }, body: JSON.stringify(body),
});
const chat = (extra: Record<string, unknown> = {}) => ({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32, ...extra });
const terminal = (op: DurableOperation | null) => !!op && ['completed', 'cancelled', 'upstream_failed', 'process_lost'].includes(op.execution);
async function settle(rt: OperationsRuntime, id: string) {
  assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 'rf', operationId: id }))), `operation ${id} reaches a terminal state`);
  return (await rt.store.get({ tenantId: 'rf', operationId: id }))!;
}

before(async () => {
  db = await createTestDb('review');
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  process.env['OTK_PROXY_UPSTREAM_GEMINI'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
});
after(async () => {
  await provider.stop();
  for (const s of live) { s.server.closeAllConnections(); await new Promise<void>((r) => s.server.close(() => r())); await s.rt.stop().catch(() => {}); }
  await db.drop();
});

describe('review H2: dated returned model settles with the admitted weights', () => {
  it('OpenAI answers model "gpt-4o-2024-08-06" → settled 150 CU, not a plain hold forever', async () => {
    const { rt, base } = await gateway();
    const r = await post(base, '/v1/chat/completions', 'h2', chat(), { 'x-test-script': 'ok', 'x-test-model': 'gpt-4o-2024-08-06' });
    assert.equal(r.status, 200); await r.text();
    const op = await settle(rt, 'h2');
    assert.equal(op.reservation.state, 'settled');
    assert.deepEqual(op.reservation.cu, { units: 150n, scale: 1n });
  });
});

describe('review H3/LOW: provider 4xx without usage releases the hold', () => {
  it('429 → upstream_failed + released, quota hold returned', async () => {
    const { rt, base } = await gateway();
    const r = await post(base, '/v1/chat/completions', 'h3', chat(), { 'x-test-script': 'error429' });
    assert.equal(r.status, 429); await r.text();
    const op = await settle(rt, 'h3');
    assert.deepEqual([op.execution, op.measurement, op.reservation.state], ['upstream_failed', 'none', 'released']);
  });
});

describe('review HIGH-1/H3, HIGH-2, MEDIUM-3, MEDIUM-5: refused before the provider', () => {
  const cases: Array<[string, string, unknown, number, string]> = [
    ['responses', '/v1/responses', { model: 'gpt-4o', input: 'hi', max_output_tokens: 10 }, 404, 'api_not_measurable'],
    ['gemini-model', '/v1beta/models/gemini-ultra:generateContent', { model: 'gemini-2.0-flash', contents: [], generationConfig: { maxOutputTokens: 10 } }, 400, 'model_mismatch'],
    ['n', '/v1/chat/completions', chat({ n: 128 }), 400, 'multiple_completions_not_supported'],
    ['by-ref', '/v1/chat/completions', chat({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.invalid/x.png' } }] }] }), 400, 'input_by_reference_not_supported'],
    ['two-limits', '/v1/chat/completions', chat({ max_completion_tokens: 100, max_tokens: 1000000 }), 400, 'max_output_ambiguous'],
    ['gemini-alias', '/v1beta/models/gemini-pro:generateContent', { contents: [], generation_config: { max_output_tokens: 99999 } }, 400, 'max_output_ambiguous'],
  ];
  for (const [name, p, body, status, error] of cases) {
    it(`${name} → ${status} ${error}, provider not called, no operation`, async () => {
      const { rt, base } = await gateway();
      const n = provider.calls.length;
      const r = await post(base, p, `ref-${name}`, body, { 'x-test-script': 'ok', ...(p.startsWith('/v1beta') ? { 'x-otk-provider': 'gemini' } : {}) });
      assert.equal(r.status, status);
      assert.equal((await r.json() as { error: string }).error, error);
      assert.equal(provider.calls.length, n);
      assert.equal(await rt.store.get({ tenantId: 'rf', operationId: `ref-${name}` }), null);
    });
  }
});

describe('review LOW: headers allowlisted in both directions', () => {
  it('operator headers are not relayed to the tenant; tenant cookies/orgs do not reach the provider', async () => {
    const { rt, base } = await gateway();
    const r = await post(base, '/v1/chat/completions', 'hdr', chat(), { 'x-test-script': 'ok', cookie: 'tenant=1', 'openai-organization': 'org-tenant', 'anthropic-beta': 'x' });
    await r.text();
    assert.equal(r.headers.get('set-cookie'), null);
    assert.equal(r.headers.get('openai-organization'), null);
    assert.equal(r.headers.get('x-ratelimit-remaining-requests'), null);
    const h = provider.calls.at(-1)!.headers;
    assert.equal(h['cookie'], undefined);
    assert.equal(h['openai-organization'], undefined);
    assert.equal(h['anthropic-beta'], undefined);
    await settle(rt, 'hdr');
  });
});

describe('review HIGH-1: no unmetered relay through a slow reader or an oversized body', () => {
  it('client stops reading: treated as gone after the stall bound, upstream read to the end, settled', async () => {
    const { rt, base } = await gateway({ policy: { leaseMs: 2_000, cancelPollMs: 100, clientStallMs: 300 } });
    const r = await post(base, '/v1/chat/completions', 'stall', chat({ stream: true }), { 'x-test-script': 'bigstream' });
    assert.equal(r.status, 200); // never read the body
    const op = await settle(rt, 'stall');
    assert.deepEqual([op.measurement, op.delivery, op.reservation.state], ['final', 'client_disconnected', 'settled']);
    await r.body?.cancel().catch(() => {});
  });
  it('non-stream body above the parse bound: usage read from the tail, settled', async () => {
    const { rt, base } = await gateway({ policy: { leaseMs: 2_000, cancelPollMs: 100, maxResponseBytes: 1_000 } });
    const r = await post(base, '/v1/chat/completions', 'big', chat(), { 'x-test-script': 'bigjson', 'x-test-tokens': '70,30' });
    assert.equal(r.status, 200);
    assert.ok((await r.text()).length > 20_000, 'the whole body was delivered');
    const op = await settle(rt, 'big');
    assert.equal(op.reservation.state, 'settled');
    assert.deepEqual(op.reservation.cu, { units: 100n, scale: 1n });
  });
});

describe('review M1: an exception after the start still ends the operation', () => {
  it('computeCu throws → terminal, exposure kept as uncertain, no lease left behind', async () => {
    const base0 = legacyMeasurementPorts();
    const { rt, base } = await gateway({ measurement: { ...base0, label: 'throwing', computeCu: () => { throw new Error('synthetic failure in measurement code'); } } });
    const r = await post(base, '/v1/chat/completions', 'm1', chat(), { 'x-test-script': 'ok' });
    await r.text().catch(() => '');
    const op = await settle(rt, 'm1');
    assert.equal(op.reservation.state, 'held_uncertain');
    assert.equal(rt.inflight.size, 0);
    const lease = await db.pool.query<{ l: Date | null }>("SELECT lease_until AS l FROM otk_operations WHERE tenant_id = 'rf' AND operation_id = 'm1'");
    assert.ok(!lease.rows[0]!.l || lease.rows[0]!.l.getTime() <= Date.now() + 100, 'lease released');
  });
});

describe('review L2: cancelling an operation that never started releases it at once', () => {
  it('admitted only → POST cancel → cancelled + released (not process_lost/held_uncertain)', async () => {
    const { rt, base } = await gateway();
    assert.equal((await rt.store.admit(admitReq({ tenantId: 'rf', operationId: 'l2' }, 10n))).outcome, 'admitted');
    const c = await fetch(`${base}/v1/operations/l2/cancel`, { method: 'POST', headers: { authorization: 'Bearer tokrf' } });
    assert.equal(c.status, 200);
    assert.equal((await c.json() as { result: string }).result, 'cancelled_before_start');
    const op = (await rt.store.get({ tenantId: 'rf', operationId: 'l2' }))!;
    assert.deepEqual([op.execution, op.reservation.state], ['cancelled', 'released']);
  });
});

describe('review H4: the spool needs a stable instance id', () => {
  it('OTK_SPOOL_DIR without OTK_INSTANCE_ID is refused', async () => {
    await assert.rejects(OperationsRuntime.create({ dbUrl: db.url, measurement: legacyMeasurementPorts(), spoolDir: mkdtempSync(path.join(tmpdir(), 'otkd1d8c-')) }), /stable OTK_INSTANCE_ID/);
  });
});
