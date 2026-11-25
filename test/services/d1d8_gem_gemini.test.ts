/**
 * FECHAMENTO_GEMINI_AD — Gemini through the durable gateway (ProxyGateway + OperationsRuntime), front B's real
 * measurement ports (versioned development weights `development-2026-10-03`, explicitly flagged), the combined
 * price table with gemini-2.5-flash-lite, money policy v4, real PostgreSQL 16, local controllable provider in the
 * Gemini wire format (synthetic, no paid call). Gates G-GEM-AUTH, G-GEM-MONEY, G-GEM-USAGE, G-GEM-RECOVERY.
 *
 *   . scripts/ops/fps5_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_gem_gemini.test.ts
 *
 * Hand values (computed here, not by the code under test):
 *  - weights: provider gemini 900 milli × model gemini-2.5-flash-lite 600 milli → 540 000 micro-CU per token;
 *  - prices (µUSD/MTok): input 100 000, cache read 10 000, output 400 000 (fontes/pricing.md, 2026-10-03);
 *  - worst case for maxOutputTokens 64: 1 048 576 × 100 000 + 64 × 400 000 = 104 883 200 000 pico-USD (US$ 0,1048832);
 *  - JSON 100/50: CU 150 × 540 000 = 81 000 000 micro; cost 100 × 100 000 + 50 × 400 000 = 30 000 000 pico (US$ 0,00003);
 *  - cache 3000 prompt (2048 cached) / 40 out: CU 3040 × 540 000 = 1 641 600 000; cost 952 × 100 000 + 2048 × 10 000
 *    + 40 × 400 000 = 95 200 000 + 20 480 000 + 16 000 000 = 131 680 000 pico (cache is inside the prompt: never added twice);
 *  - thinking 7 on 20/5: total 32; CU 32 × 540 000 = 17 280 000; cost 20 × 100 000 + (5 + 7) × 400 000 = 6 800 000 pico;
 *  - blocked prompt 30: CU 30 × 540 000 = 16 200 000; cost 3 000 000 pico.
 *
 * Module under test: the durable gateway (`src/operations/runtime.ts` and the proxy routes) for the Gemini API,
 * against the fake provider from `./d1d8_c_provider.ts` in Gemini wire format and a TCP relay from `./d1d8_c_proc.ts`.
 *
 * Strategy / partitions: credentials (only the operator key reaches the provider, in its own header; client tokens
 * and URL keys never do; provider 401 and 403; missing provider key as certain non-delivery); money (refusals of
 * unbounded or ambiguous requests before the upstream; reservation, CU and cost equal to the hand values; implicit
 * cache as a subset of the prompt; unexpected thinking; a non-standard tier; an unexpected returned model; a budget
 * shared by two instances); review fixes (response masks, other parameter spellings and routing parameters never
 * forwarded); usage parsing (JSON and SSE with cumulative usage, blocked prompts, output limit, omitted zero
 * counts); and recovery (client disconnect, upstream cut, cancel from another instance, idempotent reopen, PostgreSQL
 * down at the end with spool and restart).
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`) and a writable temporary
 * directory; run with `--test-concurrency=1`. Before importing the server it sets fixture values in the test process
 * for the API's variables (tenants, a fake Gemini key, the upstream override, `PROVER_URL=disabled`). With the
 * variables already set, `npx tsx --test --test-concurrency=1 test/services/d1d8_gem_gemini.test.ts` runs just this
 * file.
 *
 * @module test/services/d1d8_gem_gemini.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'gA/OPERATOR:tokgA,gB/OPERATOR:tokgB,gS/OPERATOR:tokgS,gF/OPERATOR:tokgF,gR/OPERATOR:tokgR,gH/OPERATOR:tokgH';
process.env['GEMINI_API_KEY'] = 'AIza-otk-gemini-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider, Barrier } from './d1d8_c_provider.js';
import { TcpRelay, eventually } from './d1d8_c_proc.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';
import { MONEY_BOUND_POLICY_V4 } from '../../src/operations/moneyBound.js';
import type { DurableOperation } from '../../src/types/d1d8/index.js';

const P = 1_000_000_000_000n;
const TABLE_FILE = 'scripts/pilot/price_table_pilot_v3_gemini_20261003.json';
const MODEL = 'gemini-2.5-flash-lite';
const WORST_64 = 104_883_200_000n;
let db: TestDb;
const provider = new ControllableProvider();
const started: Array<{ rt: OperationsRuntime; server: Server }> = [];
let gw: typeof import('../../src/proxy/ProxyGateway.js');

const ports = () => d1d8MeasurementPorts({ weights: developmentWeights('development-2026-10-03'), prices: loadPriceTables([TABLE_FILE]) });
async function gateway(instanceId: string, opts: Partial<Parameters<typeof OperationsRuntime.create>[0]> = {}): Promise<{ rt: OperationsRuntime; base: string; server: Server }> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, recoveryIntervalMs: 3_600_000, measurement: ports(), quotaFor: () => null, moneyBoundPolicy: MONEY_BOUND_POLICY_V4, ...opts,
    policy: { leaseMs: 2_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model', 'x-test-gemini-cached', 'x-test-gemini-thoughts', 'x-test-gemini-tier', 'x-test-gemini-omit-candidates-count'], ...opts.policy } });
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  started.push({ rt, server });
  return { rt, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}

const gbody = (extra: Record<string, unknown> = {}, gc: Record<string, unknown> = {}) => ({
  contents: [{ role: 'user', parts: [{ text: 'Responda apenas com a palavra ok.' }] }],
  generationConfig: { maxOutputTokens: 64, thinkingConfig: { thinkingBudget: 0 }, ...gc },
  ...extra,
});
function call(base: string, auth: Record<string, string>, opId: string | null, b: unknown, o: { stream?: boolean; script?: string; headers?: Record<string, string>; query?: string; signal?: AbortSignal } = {}) {
  const verb = o.stream ? 'streamGenerateContent' : 'generateContent';
  return fetch(`${base}/v1beta/models/${MODEL}:${verb}${o.query ?? ''}`, {
    method: 'POST', signal: o.signal,
    headers: { 'content-type': 'application/json', 'x-otk-provider': 'gemini', 'x-test-script': o.script ?? (o.stream ? 'stream' : 'ok'), ...(opId ? { 'x-otk-operation-id': opId } : {}), ...auth, ...(o.headers ?? {}) },
    body: JSON.stringify(b),
  });
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
async function op(rt: OperationsRuntime, tenantId: string, operationId: string): Promise<DurableOperation> {
  const v = await rt.store.get({ tenantId, operationId });
  assert.ok(v, `operation ${tenantId}/${operationId}`);
  return v;
}
const terminal = (o: DurableOperation | null) => !!o && ['completed', 'cancelled', 'upstream_failed', 'process_lost'].includes(o.execution);
const settledMoney = (o: DurableOperation | null) => !!o && terminal(o) && o.money?.state !== 'held';
const budget = async (id: string) => (await db.pool.query<{ s: string; h: string; f: string | null }>('SELECT spent_units::text AS s, held_units::text AS h, frozen_reason AS f FROM otk_money_budget WHERE budget_id = $1', [id])).rows[0]!;
const debits = async (tenant: string, opId: string) => Number((await db.pool.query('SELECT count(*)::int AS n FROM otk_ledger WHERE tenant_id = $1 AND operation_id = $2', [tenant, opId])).rows[0].n);
const cat = (o: DurableOperation, name: string) => o.usage?.categories.find((c) => c.name === name)?.count ?? null;

before(async () => {
  db = await createTestDb('gemini');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_GEMINI'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
});
after(async () => {
  await provider.stop();
  for (const s of started) { s.server.closeAllConnections(); await new Promise<void>((r) => s.server.close(() => r())); await s.rt.stop(); }
  await db.drop();
});

describe('G-GEM-AUTH — Developer API key in x-goog-api-key; client credentials never reach the provider', () => {
  it('Bearer OTK token + ?key=/?KEY= from the client: provider sees only x-goog-api-key with the operator key, no OTK token, no key in the URL', async () => {
    const { rt, base } = await gateway('gem-auth-1');
    const before = provider.calls.length;
    const r = await call(base, bearer('tokgA'), 'auth-1', gbody(), { query: '?key=tokgA&KEY=tokgA&access_token=tokgA', headers: { 'x-test-tokens': '100,50' } });
    assert.equal(r.status, 200);
    await r.text();
    assert.equal(provider.calls.length, before + 1);
    const pc = provider.calls[provider.calls.length - 1]!;
    assert.equal(pc.headers['x-goog-api-key'], 'AIza-otk-gemini-provider-fixture');
    assert.equal(pc.authorization, undefined, 'no Authorization header upstream');
    assert.ok(!JSON.stringify(pc.headers).includes('tokgA'), 'no OTK token in any upstream header');
    assert.ok(!pc.path.toLowerCase().includes('key='), `no credential in the upstream URL: ${pc.path}`);
    assert.ok(!pc.path.includes('access_token'), 'no access_token in the upstream URL');
    assert.ok(await eventually(async () => settledMoney(await rt.store.get({ tenantId: 'gA', operationId: 'auth-1' }))));
  });

  it('OTK token in x-goog-api-key (unmodified Google SDK pointed at the OTK) is accepted and replaced upstream', async () => {
    const { base } = await gateway('gem-auth-2');
    const r = await call(base, { 'x-goog-api-key': 'tokgA' }, 'auth-2', gbody());
    assert.equal(r.status, 200);
    await r.text();
    const pc = provider.calls[provider.calls.length - 1]!;
    assert.equal(pc.headers['x-goog-api-key'], 'AIza-otk-gemini-provider-fixture');
    const bad = await call(base, { 'x-goog-api-key': 'not-a-token' }, 'auth-2b', gbody());
    assert.equal(bad.status, 401, 'unknown OTK token refused before any effect');
  });

  it('provider 401 / 403: relayed as such, no success, reservation released, no debit and no receipt', async () => {
    const { rt, base } = await gateway('gem-auth-3');
    for (const [script, code] of [['error401', 401], ['error403', 403]] as const) {
      const id = `auth-${script}`;
      const r = await call(base, bearer('tokgA'), id, gbody(), { script });
      assert.equal(r.status, code);
      await r.text();
      assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 'gA', operationId: id }))));
      const o = await op(rt, 'gA', id);
      assert.deepEqual([o.execution, o.measurement, o.reservation.state], ['upstream_failed', 'none', 'released']);
      assert.equal(await debits('gA', id), 0);
    }
  });

  it('provider key missing: 502 upstream_key_unavailable, provider never called, reservation released (certain non-delivery, not uncertain)', async () => {
    const { rt, base } = await gateway('gem-auth-4');
    const saved = process.env['GEMINI_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    try {
      const before = provider.calls.length;
      const r = await call(base, bearer('tokgA'), 'auth-nokey', gbody());
      assert.equal(r.status, 502);
      assert.equal(((await r.json()) as { error: string }).error, 'upstream_key_unavailable');
      assert.equal(provider.calls.length, before);
      assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 'gA', operationId: 'auth-nokey' }))));
      const o = await op(rt, 'gA', 'auth-nokey');
      assert.deepEqual([o.execution, o.measurement, o.reservation.state], ['upstream_failed', 'none', 'released']);
    } finally { process.env['GEMINI_API_KEY'] = saved; }
  });
});

describe('G-GEM-MONEY — policy v4: bound, nested refusals before the upstream, settlement by hand values', () => {
  it('refusals (402/400) of every unbounded or ambiguous request; none reaches the provider; budget untouched', async () => {
    const { base } = await gateway('gem-refuse');
    await db.pool.query('INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units, money_policy) VALUES ($1, $2, $3::numeric, $4)', ['b-gS', 'gS', P.toString(), MONEY_BOUND_POLICY_V4.id]);
    const before = provider.calls.length;
    const base402: Array<[string, unknown]> = [
      ['thinking absent', { contents: gbody().contents, generationConfig: { maxOutputTokens: 64 } }],
      ['thinking budget 512', gbody({}, { thinkingConfig: { thinkingBudget: 512 } })],
      ['dynamic thinking', gbody({}, { thinkingConfig: { thinkingBudget: -1 } })],
      ['includeThoughts', gbody({}, { thinkingConfig: { thinkingBudget: 0, includeThoughts: true } })],
      ['inlineData part', { ...gbody(), contents: [{ role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AA==' } }] }] }],
      ['text + fileData', { ...gbody(), contents: [{ role: 'user', parts: [{ text: 'x' }, { fileData: { fileUri: 'gs://x', mimeType: 'text/plain' } }] }] }],
      ['functionCall part', { ...gbody(), contents: [{ role: 'model', parts: [{ functionCall: { name: 'f', args: {} } }] }] }],
      ['thoughtSignature', { ...gbody(), contents: [{ role: 'model', parts: [{ text: 'x', thoughtSignature: 'AA' }] }] }],
      ['systemInstruction with media', gbody({ systemInstruction: { parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AA==' } }] } })],
      ['tools', gbody({ tools: [{ googleSearch: {} }] })],
      ['toolConfig', gbody({ toolConfig: {} })],
      ['cachedContent', gbody({ cachedContent: 'cachedContents/abc' })],
      ['serviceTier', gbody({ serviceTier: 'priority' })],
      ['safetySettings', gbody({ safetySettings: [] })],
      ['responseMimeType', gbody({}, { responseMimeType: 'application/json' })],
      ['responseModalities', gbody({}, { responseModalities: ['AUDIO'] })],
      ['unknown role', { ...gbody(), contents: [{ role: 'tool', parts: [{ text: 'x' }] }] }],
      ['maxOutputTokens above documented 65536', gbody({}, { maxOutputTokens: 70_000 })],
    ];
    for (const [name, b] of base402) {
      const r = await call(base, bearer('tokgS'), null, b);
      const j = (await r.json()) as { error: string; detail?: string };
      assert.ok(r.status === 402 || r.status === 400, `${name}: ${r.status} ${JSON.stringify(j)}`);
      // fileData and cachedContent are refused one gate earlier (input fetched by reference has no byte bound, any tenant)
      const expected = name === 'text + fileData' || name === 'cachedContent' ? 'input_by_reference_not_supported' : name.startsWith('maxOutputTokens') ? null : 'money_bound_unavailable';
      if (expected) assert.equal(j.error, expected, name);
    }
    const unlisted = await fetch(`${base}/v1beta/models/gemini-2.5-flash:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-otk-provider': 'gemini', ...bearer('tokgS') }, body: JSON.stringify(gbody()) });
    assert.equal(unlisted.status, 402, 'unlisted model refused');
    await unlisted.text();
    const r400: Array<[string, unknown, { stream?: boolean; query?: string }, string]> = [
      ['candidateCount 2', gbody({}, { candidateCount: 2 }), {}, 'multiple_completions_not_supported'],
      ['snake alias', { ...gbody(), generation_config: { max_output_tokens: 8 } }, {}, 'max_output_ambiguous'],
      ['body stream field', gbody({ stream: true }), {}, 'field_not_supported'],
      ['alt=json on the stream route', gbody(), { stream: true, query: '?alt=json' }, 'stream_format_not_supported'],
      ['alt=sse on the JSON route', gbody(), { query: '?alt=sse' }, 'stream_format_not_supported'],
    ];
    for (const [name, b, o, err] of r400) {
      const r = await call(base, bearer('tokgS'), null, b, o);
      assert.equal(r.status, 400, name);
      assert.equal(((await r.json()) as { error: string }).error, err, name);
    }
    assert.equal(provider.calls.length, before, 'no refused request reached the provider');
    assert.deepEqual(await budget('b-gS'), { s: '0', h: '0', f: null });
  });

  it('bounded JSON request: reservation = hand worst case; settled CU and cost by hand; terms frozen in the operation', async () => {
    const { rt, base } = await gateway('gem-ok');
    const r = await call(base, bearer('tokgS'), 'm-ok', gbody(), { headers: { 'x-test-tokens': '100,50' } });
    assert.equal(r.status, 200);
    await r.text();
    assert.ok(await eventually(async () => (await rt.store.get({ tenantId: 'gS', operationId: 'm-ok' }))?.money?.state === 'settled'));
    const o = await op(rt, 'gS', 'm-ok');
    assert.equal(o.reservation.money!.units, WORST_64);
    assert.equal(o.limits.moneyBoundPolicy, MONEY_BOUND_POLICY_V4.id);
    assert.deepEqual(o.limits.allowedReturnedModels, ['gemini-2.5-flash-lite']);
    assert.deepEqual(o.limits.pricingTerms, { serviceTier: 'standard', thinking: 'off' });
    assert.deepEqual(o.reservation.cu, { units: 81_000_000n, scale: 1_000_000n });
    assert.equal(o.money!.confirmed!.units, 30_000_000n);
    assert.equal(o.usage!.modelReturned, MODEL);
    assert.equal(o.usage!.providerRequestId, 'gem-resp-test');
    assert.equal(o.usage!.finishReason, 'STOP');
    assert.equal(o.usage!.serviceTier, null, 'not reported: Standard derived from the documented default (request without serviceTier)');
    assert.equal(o.config.developmentProfile, true);
    assert.equal(o.config.cuWeights.version, 'dev-static-from-CostUnits.ts+gemini-2.5-flash-lite@2026-10-03');
    assert.deepEqual(await budget('b-gS'), { s: '30000000', h: '0', f: null });
  });

  it('implicit cache: cached tokens are a subset of the prompt, priced at the cache tariff, never added twice', async () => {
    const { rt, base } = await gateway('gem-cache');
    const r = await call(base, bearer('tokgS'), 'm-cache', gbody(), { stream: true, headers: { 'x-test-tokens': '3000,40', 'x-test-gemini-cached': '2048', 'x-test-gemini-tier': 'standard' } });
    assert.equal(r.status, 200);
    await r.text();
    assert.ok(await eventually(async () => (await rt.store.get({ tenantId: 'gS', operationId: 'm-cache' }))?.money?.state === 'settled'));
    const o = await op(rt, 'gS', 'm-cache');
    assert.equal(cat(o, 'input'), 3000n);
    assert.equal(cat(o, 'input_cache_read'), 2048n);
    assert.deepEqual(o.reservation.cu, { units: 1_641_600_000n, scale: 1_000_000n });
    assert.equal(o.money!.confirmed!.units, 131_680_000n);
    assert.equal(o.usage!.serviceTier, 'standard');
  });

  it('unexpected thinking: cost includes thoughts as output (documented), budget frozen (unexpected_thinking)', async () => {
    const { rt, base } = await gateway('gem-think');
    await db.pool.query('INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units, money_policy) VALUES ($1, $2, $3::numeric, $4)', ['b-gF', 'gF', P.toString(), MONEY_BOUND_POLICY_V4.id]);
    const r = await call(base, bearer('tokgF'), 'm-think', gbody(), { headers: { 'x-test-tokens': '20,5', 'x-test-gemini-thoughts': '7' } });
    await r.text();
    assert.ok(await eventually(async () => settledMoney(await rt.store.get({ tenantId: 'gF', operationId: 'm-think' }))));
    const o = await op(rt, 'gF', 'm-think');
    assert.equal(cat(o, 'output_reasoning'), 7n);
    assert.deepEqual(o.reservation.cu, { units: 17_280_000n, scale: 1_000_000n });
    assert.equal(o.money!.confirmed!.units, 6_800_000n);
    const b = await budget('b-gF');
    assert.ok(b.f?.startsWith('unexpected_thinking:7:'), `frozen: ${b.f}`);
    const next = await call(base, bearer('tokgF'), 'm-think-2', gbody());
    assert.equal(next.status, 402, 'a frozen budget admits nothing');
    await next.text();
  });

  it('reported tier other than standard: price pending (reserve kept), budget frozen; tier STANDARD/unspecified accepted', async () => {
    const { rt, base } = await gateway('gem-tier');
    await db.pool.query('INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units, money_policy) VALUES ($1, $2, $3::numeric, $4)', ['b-gR', 'gR', P.toString(), MONEY_BOUND_POLICY_V4.id]);
    for (const [id, tier] of [['t-upper', 'STANDARD'], ['t-unspec', 'unspecified']]) {
      const r = await call(base, bearer('tokgR'), id, gbody(), { headers: { 'x-test-gemini-tier': tier! } });
      await r.text();
      assert.ok(await eventually(async () => (await rt.store.get({ tenantId: 'gR', operationId: id! }))?.money?.state === 'settled'), id);
    }
    const r = await call(base, bearer('tokgR'), 't-prio', gbody(), { headers: { 'x-test-tokens': '100,50', 'x-test-gemini-tier': 'priority' } });
    await r.text();
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 'gR', operationId: 't-prio' }))));
    const o = await op(rt, 'gR', 't-prio');
    assert.equal(o.measurement, 'final');
    assert.equal(o.money!.state, 'pending_price', 'not settled at the Standard tariff');
    assert.equal(o.money!.confirmed, null);
    const b = await budget('b-gR');
    assert.ok(b.f?.startsWith('unexpected_service_tier:priority:'), `frozen: ${b.f}`);
    assert.equal(BigInt(b.h), WORST_64, 'the worst case stays held');
  });

  it('returned model outside the admitted set: budget frozen (unexpected_returned_model)', async () => {
    const { rt, base } = await gateway('gem-model');
    await db.pool.query('INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units, money_policy) VALUES ($1, $2, $3::numeric, $4)', ['b-gB', 'gB', P.toString(), MONEY_BOUND_POLICY_V4.id]);
    const r = await call(base, bearer('tokgB'), 'm-model', gbody(), { headers: { 'x-test-model': 'gemini-2.5-pro' } });
    await r.text();
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 'gB', operationId: 'm-model' }))));
    assert.ok((await budget('b-gB')).f?.startsWith('unexpected_returned_model:gemini-2.5-pro'));
  });

  it('two instances, one shared budget of 2.5 worst cases: exactly 2 of 6 concurrent requests reach the provider', async () => {
    const a = await gateway('gem-share-a');
    const b = await gateway('gem-share-b');
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units, money_policy) VALUES ('b-share', 'gH', $1::numeric, $2)", [(WORST_64 * 5n / 2n).toString(), MONEY_BOUND_POLICY_V4.id]);
    const hold = new Barrier();
    provider.onArrive = () => hold.promise;
    const before = provider.calls.length;
    const reqs = Array.from({ length: 6 }, (_, i) => call(i % 2 ? b.base : a.base, bearer('tokgH'), `share-${i}`, gbody()).then(async (r) => { await r.text(); return r.status; }));
    assert.ok(await eventually(async () => provider.calls.length - before >= 2, 10_000));
    await new Promise((r) => setTimeout(r, 500));
    const arrived = provider.calls.length - before;
    provider.onArrive = null;
    hold.release();
    const statuses = await Promise.all(reqs);
    assert.equal(arrived, 2, 'only two fit under the shared ceiling');
    assert.deepEqual(statuses.filter((s) => s === 200).length, 2);
    assert.deepEqual(statuses.filter((s) => s === 402).length, 4);
    assert.ok(await eventually(async () => (await budget('b-share')).h === '0'));
    assert.equal((await budget('b-share')).s, (30_000_000n * 2n).toString());
  });
});

describe('review fixes (H1, M1, M2, L1): masks, other spellings and routing parameters never reach a metered Gemini route', () => {
  it('H1: ?fields= / ?$fields= / ?$alt= / ?callback= refused (400) before the provider, in any mode; ?provider= (OTK routing) is not forwarded', async () => {
    const { base } = await gateway('gem-h1');
    const n = provider.calls.length;
    for (const q of ['?fields=candidates', '?%24fields=usageMetadata.promptTokenCount', '?%24alt=json', '?callback=x', '?alt=sse&fields=a']) {
      const r = await call(base, bearer('tokgA'), null, gbody(), { stream: q.includes('alt=sse'), query: q });
      assert.equal(r.status, 400, q);
      assert.equal(((await r.json()) as { error: string }).error, 'query_parameter_not_supported', q);
    }
    assert.equal(provider.calls.length, n, 'no masked request reached the provider');
    const ok = await fetch(`${base}/v1beta/models/${MODEL}:generateContent?provider=gemini`, { method: 'POST', headers: { 'content-type': 'application/json', ...bearer('tokgA') }, body: JSON.stringify(gbody()) });
    assert.equal(ok.status, 200);
    await ok.text();
    assert.ok(!provider.calls[provider.calls.length - 1]!.path.includes('provider='), 'routing parameter not forwarded');
  });
  it('M2: candidateCount 1 with candidate_count 4 is refused', async () => {
    const { base } = await gateway('gem-m2');
    const r = await call(base, bearer('tokgA'), null, { ...gbody(), generationConfig: { maxOutputTokens: 8, candidateCount: 1, candidate_count: 4 } });
    assert.equal(r.status, 400);
    assert.equal(((await r.json()) as { error: string }).error, 'multiple_completions_not_supported');
  });
  it('M1: a tier asked as service_tier (snake case) outside strict mode is not settled at Standard when the response omits the tier', async () => {
    const { rt, base } = await gateway('gem-m1');
    const r = await call(base, bearer('tokgA'), 'm1-snake', gbody({ service_tier: 'priority' }));
    await r.text();
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 'gA', operationId: 'm1-snake' }))));
    assert.equal((await op(rt, 'gA', 'm1-snake')).money?.state, 'pending_price');
  });
  it('L1: another case of the method name is not a metered Gemini API (404 before the provider)', async () => {
    const { base } = await gateway('gem-l1');
    const n = provider.calls.length;
    const r = await fetch(`${base}/v1beta/models/${MODEL}:streamgenerateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-otk-provider': 'gemini', ...bearer('tokgA') }, body: JSON.stringify(gbody()) });
    assert.equal(r.status, 404);
    await r.text();
    assert.equal(provider.calls.length, n);
  });
});

describe('G-GEM-USAGE — JSON and SSE (CRLF, split events and UTF-8, cumulative usage), blocked, MAX_TOKENS, omitted zero', () => {
  it('SSE: cumulative usage replaced (not summed), final at finishReason, same CU/cost as JSON', async () => {
    const { rt, base } = await gateway('gem-sse');
    const r = await call(base, bearer('tokgA'), 'u-sse', gbody(), { stream: true, headers: { 'x-test-tokens': '100,50' } });
    assert.equal(r.headers.get('content-type'), 'text/event-stream');
    const text = await r.text();
    assert.ok(text.includes('✓'), 'UTF-8 split across writes relayed intact');
    assert.ok(!text.includes('[DONE]'));
    assert.ok(await eventually(async () => (await rt.store.get({ tenantId: 'gA', operationId: 'u-sse' }))?.reservation.state === 'settled'));
    const o = await op(rt, 'gA', 'u-sse');
    assert.equal(cat(o, 'output'), 50n, 'final cumulative count, not 1 + 49 + 50');
    assert.deepEqual(o.reservation.cu, { units: 81_000_000n, scale: 1_000_000n });
    assert.equal(provider.calls[provider.calls.length - 1]!.path.includes('alt=sse'), true, 'alt=sse added when absent');
  });

  it('blocked prompt (JSON and SSE): final usage of the prompt only, finishReason blocked:SAFETY, settled (HTTP 200 is not zero cost)', async () => {
    const { rt, base } = await gateway('gem-block');
    for (const stream of [false, true]) {
      const id = `u-block-${stream}`;
      const r = await call(base, bearer('tokgA'), id, gbody(), { stream, script: 'blocked', headers: { 'x-test-tokens': '30,0' } });
      assert.equal(r.status, 200);
      await r.text();
      assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 'gA', operationId: id }))), id);
      const o = await op(rt, 'gA', id);
      assert.deepEqual([o.measurement, o.reservation.state, o.usage?.finishReason], ['final', 'settled', 'blocked:SAFETY'], id);
      assert.equal(cat(o, 'output'), 0n, 'output derived from the total (30 − 30)');
      assert.deepEqual(o.reservation.cu, { units: 16_200_000n, scale: 1_000_000n });
    }
  });

  it('MAX_TOKENS finish is recorded; omitted candidatesTokenCount derived from the documented total', async () => {
    const { rt, base } = await gateway('gem-max');
    const r = await call(base, bearer('tokgA'), 'u-max', gbody(), { script: 'maxtokens', headers: { 'x-test-tokens': '10,64', 'x-test-gemini-omit-candidates-count': '1' } });
    await r.text();
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 'gA', operationId: 'u-max' }))));
    const o = await op(rt, 'gA', 'u-max');
    assert.equal(o.usage!.finishReason, 'MAX_TOKENS');
    assert.equal(cat(o, 'output'), 64n);
    assert.ok(o.usage!.issues?.some((i) => i.kind === 'derived_from_total'), 'the derivation is recorded');
    assert.equal(o.reservation.state, 'settled');
  });
});

describe('G-GEM-RECOVERY — disconnect, cancel, cut, idempotency, PostgreSQL down at the end, restart', () => {
  it('client disconnects mid-stream: the server reads to the final usage; delivered=client_disconnected, settled once', async () => {
    const { rt, base } = await gateway('gem-disc');
    const fb = new Barrier(); provider.finalBarriers.push(fb);
    const ac = new AbortController();
    const r = await call(base, bearer('tokgA'), 'r-disc', gbody(), { stream: true, signal: ac.signal, headers: { 'x-test-tokens': '30,120' } });
    await r.body!.getReader().read();
    ac.abort();
    await new Promise((res) => setTimeout(res, 200));
    fb.release();
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 'gA', operationId: 'r-disc' }))));
    const o = await op(rt, 'gA', 'r-disc');
    assert.deepEqual([o.execution, o.measurement, o.delivery, o.reservation.state], ['completed', 'final', 'client_disconnected', 'settled']);
    assert.deepEqual(o.reservation.cu, { units: 150n * 540_000n, scale: 1_000_000n });
    assert.equal(await debits('gA', 'r-disc'), 1);
  });

  it('upstream cut before the final usage: uncertain (partial usage kept, never final), exposure held, never re-sent', async () => {
    const { rt, base } = await gateway('gem-cut');
    const n = provider.calls.length;
    const r = await call(base, bearer('tokgA'), 'r-cut', gbody(), { stream: true, script: 'cut' });
    await r.text().catch(() => '');
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 'gA', operationId: 'r-cut' }))));
    const o = await op(rt, 'gA', 'r-cut');
    assert.equal(o.execution, 'upstream_failed');
    assert.equal(o.measurement, 'partial', 'cumulative usage seen before the finish is partial, never final');
    assert.equal(o.reservation.state, 'held_uncertain');
    assert.equal(await debits('gA', 'r-cut'), 0);
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(provider.calls.length, n + 1, 'not re-sent');
  });

  it('explicit cancel from another instance: cancelled/stopped_upstream; partial kept uncertain', async () => {
    const a = await gateway('gem-cancel-a');
    const b = await gateway('gem-cancel-b');
    const fb = new Barrier(); provider.finalBarriers.push(fb);
    const r = await call(a.base, bearer('tokgA'), 'r-cancel', gbody(), { stream: true });
    await r.body!.getReader().read();
    const c = await fetch(`${b.base}/v1/operations/r-cancel/cancel`, { method: 'POST', headers: bearer('tokgA') });
    assert.equal(c.status, 202);
    assert.ok(await eventually(async () => terminal(await a.rt.store.get({ tenantId: 'gA', operationId: 'r-cancel' })), 10_000));
    fb.release();
    const o = await op(a.rt, 'gA', 'r-cancel');
    assert.deepEqual([o.execution, o.cancellation?.result, o.reservation.state], ['cancelled', 'stopped_upstream', 'held_uncertain']);
    assert.notEqual(o.measurement, 'final');
  });

  it('same operation id again: 409 with the stored operation, the provider is not called again', async () => {
    const { base } = await gateway('gem-idem');
    const first = await call(base, bearer('tokgA'), 'r-idem', gbody());
    await first.text();
    const n = provider.calls.length;
    const again = await call(base, bearer('tokgA'), 'r-idem', gbody());
    assert.equal(again.status, 409);
    await again.text();
    assert.equal(provider.calls.length, n);
  });

  it('PostgreSQL down when the final usage arrives → spool → applied once; a restart of the same instance applies nothing twice', async () => {
    const relay = new TcpRelay(new URL(db.url).hostname, Number(new URL(db.url).port));
    await relay.start();
    const spoolDir = mkdtempSync(path.join(tmpdir(), 'otkgem-spool-'));
    const g = await gateway('gem-spool', { dbUrl: relay.via(db.url), spoolDir });
    const fb = new Barrier(); provider.finalBarriers.push(fb);
    const r = await call(g.base, bearer('tokgA'), 'r-spool', gbody(), { stream: true, headers: { 'x-test-tokens': '200,100' } });
    const reader = r.body!.getReader();
    await reader.read();
    relay.cut();
    fb.release();
    while (!(await reader.read()).done) { /* drain */ }
    assert.ok(await eventually(async () => g.rt.spool!.pending().length === 1, 10_000), 'one spooled measurement');
    assert.ok(!JSON.stringify(g.rt.spool!.pending()).includes('mundo'), 'no response text in the spool');
    relay.restore();
    await g.rt.recoverOnce();
    const o = await op(g.rt, 'gA', 'r-spool');
    assert.deepEqual([o.execution, o.measurement, o.reservation.state], ['completed', 'final', 'settled']);
    assert.deepEqual(o.reservation.cu, { units: 300n * 540_000n, scale: 1_000_000n });
    // restart: a new runtime with the same instance id and spool re-runs recovery; nothing changes
    g.server.closeAllConnections(); await new Promise<void>((res) => g.server.close(() => res())); await g.rt.stop();
    started.splice(started.findIndex((x) => x.server === g.server), 1);
    const calls0 = provider.calls.length;
    const rt2 = await OperationsRuntime.create({ dbUrl: db.url, instanceId: 'gem-spool', spoolDir, recoveryIntervalMs: 3_600_000, measurement: ports(), quotaFor: () => null, moneyBoundPolicy: MONEY_BOUND_POLICY_V4 });
    await rt2.recoverOnce(); await rt2.recoverOnce();
    assert.equal(await debits('gA', 'r-spool'), 1, 'one debit after restart');
    assert.equal(provider.calls.length, calls0, 'nothing re-sent');
    assert.equal(rt2.spool!.pending().length, 0);
    await rt2.stop();
    await relay.stop();
  });
});
