/**
 * D1–D8 / C (C3) — durable profile of the proxy, in-process, real PostgreSQL 16, local controllable
 * provider (no network, no paid call). Gates: D7-G02 (app closes before/during/after usage,
 * reopen), D7-G03 (cancel vs upstream failure, limits), D7-G04 (PG down at the end → spool → one
 * settlement), D7-G07 (unknown CU: reservation + settlement), D3-G02/G03/G05/G07 plumbing with
 * explicit doubles of A/B (named *Double*; S4 repeats with the real modules).
 * Hand vectors: gpt-4o/openai weights 1.0 × 1.0 (legacy CU_MODEL_v1): CU = tokens.
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 't1/OPERATOR:tok1,t1/VIEWER:tok1v,t2/OPERATOR:tok2,tq/OPERATOR:tokq,tv3/OPERATOR:tokv3';
process.env['OPENAI_API_KEY'] = 'sk-otkd1d8c-provider-fixture';
process.env['ANTHROPIC_API_KEY'] = 'sk-ant-otkd1d8c-provider-fixture';
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
import { legacyMeasurementPorts, type MeasurementPorts } from '../../src/operations/measurementPorts.js';
import type { CryptoPorts } from '../../src/operations/context.js';
import { canonicalJson, sha256Hex } from '../../src/operations/ids.js';
import type { DurableOperation } from '../../src/types/d1d8/index.js';
import { createReceiptCryptoDouble, createLocalCounterDouble, buildConferenceReportDouble, newCommitmentOpeningDouble } from '../fixtures/d1d8/c/doubles.js';
import { CONFIG } from '../fixtures/d1d8/c/builders.js';

let db: TestDb;
const provider = new ControllableProvider();
const started: Array<{ rt: OperationsRuntime; server: Server }> = [];
let gw: typeof import('../../src/proxy/ProxyGateway.js');

async function startGateway(opts: Partial<Parameters<typeof OperationsRuntime.create>[0]> = {}): Promise<{ rt: OperationsRuntime; base: string }> {
  // RV2-06: the legacy measurement is chosen explicitly (it used to be the runtime's silent default)
  const rt = await OperationsRuntime.create({ dbUrl: db.url, recoveryIntervalMs: 3_600_000, measurement: legacyMeasurementPorts(), ...opts, policy: { leaseMs: 2_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'], ...opts.policy } });
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  started.push({ rt, server });
  return { rt, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

before(async () => {
  db = await createTestDb('proxy');
  // the API's receipt store owns the legacy tables (otk_receipts, otk_proof_jobs); in the
  // entrypoint it initialises before the proxy, here it is created explicitly
  const legacyStore = new PostgresReceiptStore(db.url);
  await legacyStore.init();
  await legacyStore.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  process.env['OTK_PROXY_UPSTREAM_ANTHROPIC'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
});
after(async () => {
  await provider.stop(); // ends every upstream stream first (no handler keeps reading)
  for (const s of started) { s.server.closeAllConnections(); await new Promise<void>((r) => s.server.close(() => r())); await s.rt.stop(); }
  await db.drop();
});

const chatBody = (extra: Record<string, unknown> = {}) => ({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 64, ...extra });
function call(base: string, token: string, opId: string | null, body: unknown, script = 'ok', extraHeaders: Record<string, string> = {}, signal?: AbortSignal) {
  return fetch(`${base}/v1/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-test-script': script, ...(opId ? { 'x-otk-operation-id': opId } : {}), ...extraHeaders },
    body: JSON.stringify(body),
  });
}
async function opRow(rt: OperationsRuntime, tenantId: string, operationId: string): Promise<DurableOperation> {
  const op = await rt.store.get({ tenantId, operationId });
  assert.ok(op, `operation ${tenantId}/${operationId} exists`);
  return op;
}
async function ledger(tenant: string): Promise<{ cu: bigint; entries: number }> {
  const r = await db.pool.query<{ s: string; n: string }>('SELECT COALESCE(sum(units),0)::text AS s, count(*)::text AS n FROM otk_ledger WHERE tenant_id = $1', [tenant]);
  return { cu: BigInt(r.rows[0]!.s) / 1_000_000n, entries: Number(r.rows[0]!.n) };
}
const terminal = (op: DurableOperation | null) => !!op && ['completed', 'cancelled', 'upstream_failed', 'process_lost'].includes(op.execution);

describe('D7-G01/G02 (in-process): admission is durable before the provider; one settlement', () => {
  it('non-stream: operation upstream_started when the provider is reached; settled 150 CU once; provider key, not the OTK token, goes upstream', async () => {
    const { rt, base } = await startGateway();
    let stateAtArrival: string | undefined;
    provider.onArrive = async () => { stateAtArrival = (await rt.store.get({ tenantId: 't1', operationId: 'op-ok' }))?.execution; };
    const r = await call(base, 'tok1', 'op-ok', chatBody());
    provider.onArrive = null;
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('x-otk-operation-id'), 'op-ok');
    await r.text();
    assert.equal(stateAtArrival, 'upstream_started');
    const last = provider.calls.at(-1)!;
    assert.equal(last.authorization, 'Bearer sk-otkd1d8c-provider-fixture');
    assert.equal(last.body['max_tokens'], 64, 'client limit kept');
    // the response is relayed before the settlement transaction commits
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 't1', operationId: 'op-ok' }))));
    const op = await opRow(rt, 't1', 'op-ok');
    assert.deepEqual([op.execution, op.measurement, op.delivery, op.reservation.state], ['completed', 'final', 'delivered', 'settled']);
    assert.deepEqual(op.reservation.cu, { units: 150n, scale: 1n });
    assert.deepEqual(await ledger('t1'), { cu: 150n, entries: 1 });
    await rt.worker.tick();
    const row = await db.pool.query<{ receipt_json: Record<string, unknown> }>("SELECT receipt_json FROM otk_receipts WHERE request_id = 'op:t1:op-ok'");
    assert.equal(row.rows[0]?.receipt_json['costUnits'], 150, 'legacy receipt row without a second debit');
    assert.deepEqual(await ledger('t1'), { cu: 150n, entries: 1 });
  });

  it('reopen with the same operation id: 409 with the stored state, no new generation; different request → conflict', async () => {
    const { base } = await startGateway();
    const n = provider.calls.length;
    const again = await call(base, 'tok1', 'op-ok', chatBody());
    assert.equal(again.status, 409);
    const body = await again.json() as { error: string; operation: { execution: string; reservation: { state: string } } };
    assert.equal(body.error, 'operation_exists');
    assert.equal(body.operation.execution, 'completed');
    const conflict = await call(base, 'tok1', 'op-ok', chatBody({ model: 'gpt-4o-mini' }));
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json() as { error: string }).error, 'operation_conflict');
    assert.equal(provider.calls.length, n, 'provider not called again');
  });

  it('status is tenant-scoped (D3-G03) and carries no text; viewer may read, not cancel', async () => {
    const { base } = await startGateway();
    const mine = await fetch(`${base}/v1/operations/op-ok`, { headers: { authorization: 'Bearer tok1v' } });
    assert.equal(mine.status, 200);
    const text = await mine.text();
    assert.ok(!text.includes('hello') && !text.includes('"hi"'), 'no prompt/response text');
    const v = JSON.parse(text) as { operation: { conference: { state: string; verdict: string } } };
    assert.deepEqual(v.operation.conference, { state: 'not_produced', verdict: 'not_applicable', reason: 'no_local_count' }, 'D3-G05: absent comparison is not "no divergence"');
    assert.equal((await fetch(`${base}/v1/operations/op-ok`, { headers: { authorization: 'Bearer tok2' } })).status, 404);
    assert.equal((await fetch(`${base}/v1/operations/op-ok/cancel`, { method: 'POST', headers: { authorization: 'Bearer tok1v' } })).status, 403);
  });
});

describe('D7-G02: the app closes; the operation continues to its final usage (RV30-06)', () => {
  it('during the stream: delivery client_disconnected, provider stream not cut, settled once (before: upstream cancelled, 0 receipts)', async () => {
    const { rt, base } = await startGateway();
    const fb = new Barrier(); provider.finalBarriers.push(fb);
    const ac = new AbortController();
    const r = await call(base, 'tok1', 'op-mid', chatBody({ stream: true }), 'stream', {}, ac.signal);
    const reader = r.body!.getReader();
    await reader.read();
    ac.abort();
    await eventually(async () => (await rt.store.get({ tenantId: 't1', operationId: 'op-mid' }))?.execution === 'upstream_started', 2000);
    fb.release();
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 't1', operationId: 'op-mid' }))));
    const op = await opRow(rt, 't1', 'op-mid');
    assert.deepEqual([op.execution, op.measurement, op.delivery, op.reservation.state], ['completed', 'final', 'client_disconnected', 'settled']);
    const pc = provider.calls.find((c) => c.script === 'stream' && c.finished);
    assert.ok(pc && !pc.abortedByClient, 'provider stream ran to the end');
    assert.deepEqual(await ledger('t1'), { cu: 300n, entries: 2 });
  });

  it('before the first byte: the client is gone before the response headers; usage still settled', async () => {
    const { rt, base } = await startGateway();
    const hold = new Barrier();
    provider.onArrive = () => hold.promise;
    const ac = new AbortController();
    const arrived = provider.nextArrival();
    const pending = call(base, 'tok1', 'op-before', chatBody({ stream: true }), 'stream', {}, ac.signal).catch(() => null);
    await arrived; // the provider holds the response: nothing reached the client yet
    ac.abort();
    await pending;
    provider.onArrive = null;
    hold.release();
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 't1', operationId: 'op-before' }))));
    const op = await opRow(rt, 't1', 'op-before');
    assert.deepEqual([op.execution, op.measurement, op.delivery, op.reservation.state], ['completed', 'final', 'client_disconnected', 'settled']);
  });

  it('after the usage chunk, before the end of the response: usage kept, settled once', async () => {
    const { rt, base } = await startGateway();
    const db2 = new Barrier(); provider.doneBarriers.push(db2);
    const ac = new AbortController();
    const r = await call(base, 'tok1', 'op-after', chatBody({ stream: true }), 'stream', { 'x-test-tokens': '40,60' }, ac.signal);
    const reader = r.body!.getReader();
    let seen = '';
    while (!seen.includes('"usage"')) { const { value, done } = await reader.read(); if (done) break; seen += Buffer.from(value!).toString(); }
    ac.abort();
    db2.release();
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 't1', operationId: 'op-after' }))));
    const op = await opRow(rt, 't1', 'op-after');
    assert.deepEqual([op.measurement, op.delivery, op.reservation.state], ['final', 'client_disconnected', 'settled']);
    assert.deepEqual(op.reservation.cu, { units: 100n, scale: 1n });
  });
});

describe('D7-G03: explicit cancel ≠ upstream failure; limits stop unbounded continuation', () => {
  it('cancel (any instance): upstream aborted, cancelled + stopped_upstream, exposure kept (held_uncertain)', async () => {
    const a = await startGateway();
    const b = await startGateway(); // the cancel arrives on another instance
    const r = await call(a.base, 'tok1', 'op-cancel', chatBody({ stream: true }), 'endless');
    const reader = r.body!.getReader();
    await reader.read();
    const c = await fetch(`${b.base}/v1/operations/op-cancel/cancel`, { method: 'POST', headers: { authorization: 'Bearer tok1' } });
    assert.equal(c.status, 202);
    assert.ok(await eventually(async () => terminal(await a.rt.store.get({ tenantId: 't1', operationId: 'op-cancel' })), 10_000));
    const op = await opRow(a.rt, 't1', 'op-cancel');
    assert.equal(op.execution, 'cancelled');
    assert.equal(op.cancellation?.result, 'stopped_upstream');
    assert.equal(op.measurement, 'uncertain', 'no usage reported before the stop: uncertain, never zero');
    assert.equal(op.reservation.state, 'held_uncertain');
    assert.ok(await eventually(async () => provider.calls.some((x) => x.script === 'endless' && x.abortedByClient)), 'the provider saw the request cut');
    const again = await fetch(`${b.base}/v1/operations/op-ok/cancel`, { method: 'POST', headers: { authorization: 'Bearer tok1' } });
    assert.equal(again.status, 200);
    assert.equal((await again.json() as { result: string }).result, 'already_finished');
    assert.equal((await opRow(a.rt, 't1', 'op-ok')).reservation.state, 'settled', 'a late cancel does not undo confirmed usage');
  });

  it('upstream cut before the final usage: upstream_failed + uncertain, never re-sent', async () => {
    const { rt, base } = await startGateway();
    const n = provider.calls.length;
    const r = await call(base, 'tok1', 'op-cut', chatBody({ stream: true }), 'cut');
    await r.text().catch(() => '');
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 't1', operationId: 'op-cut' }))));
    const op = await opRow(rt, 't1', 'op-cut');
    assert.deepEqual([op.execution, op.measurement, op.reservation.state], ['upstream_failed', 'uncertain', 'held_uncertain']);
    assert.equal(provider.calls.length, n + 1);
  });

  it('duration limit aborts an endless upstream even with the client gone', async () => {
    const { rt, base } = await startGateway({ policy: { leaseMs: 2_000, cancelPollMs: 100, maxDurationMs: 700n } });
    const ac = new AbortController();
    const r = await call(base, 'tok1', 'op-limit', chatBody({ stream: true }), 'endless', {}, ac.signal);
    await r.body!.getReader().read();
    ac.abort();
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 't1', operationId: 'op-limit' })), 10_000));
    const op = await opRow(rt, 't1', 'op-limit');
    assert.deepEqual([op.execution, op.cancellation?.result, op.reservation.state], ['cancelled', 'stopped_upstream', 'held_uncertain']);
  });

  it('output limit: absent → policy default injected; above the cap → 400 before the provider', async () => {
    const { rt, base } = await startGateway({ policy: { leaseMs: 2_000, cancelPollMs: 100, defaultMaxOutputTokens: 77n, maxOutputTokensCap: 1000n } });
    const r = await call(base, 'tok1', 'op-inject', { model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(r.status, 200);
    await r.text();
    assert.ok(await eventually(async () => terminal(await rt.store.get({ tenantId: 't1', operationId: 'op-inject' }))));
    assert.equal(provider.calls.at(-1)!.body['max_completion_tokens'], 77);
    const n = provider.calls.length;
    const big = await call(base, 'tok1', 'op-big', chatBody({ max_tokens: 5000 }));
    assert.equal(big.status, 400);
    assert.equal(provider.calls.length, n);
  });
});

describe('D7-G07 (proxy, unknown CU): worst-case reservation, then settlement by the final CU', () => {
  it('reservations of 3 000 CU against quota 10 000: 4 admitted out of 20; settled at 150 each frees the rest', async () => {
    const { base } = await startGateway();
    // body bytes + 64 + max_tokens = 3 000 exactly (legacy upper bound, weights 1.0 × 1.0)
    let m = 2000; let body = chatBody({ max_tokens: m });
    for (let i = 0; i < 5; i++) { m = 3000 - 64 - Buffer.byteLength(JSON.stringify(body)); body = chatBody({ max_tokens: m }); }
    assert.equal(Buffer.byteLength(JSON.stringify(body)) + 64 + m, 3000);
    const hold = new Barrier();
    provider.onArrive = () => hold.promise;
    const before = provider.calls.length;
    const decided: number[] = [];
    const res = Promise.all(Array.from({ length: 20 }, (_, i) => call(base, 'tokq', `q-${i}`, body).then(async (r) => { const s = r.status; if (s !== 200) decided.push(s); await r.text(); return s; })));
    assert.ok(await eventually(async () => provider.calls.length - before === 4, 10_000));
    // fechamento pós-S5: the other 16 are decided (refused) WHILE the 4 are held; releasing earlier let late
    // admissions see the quota freed by the settlements (test race, same as d1d8_c_proxy_entry)
    assert.ok(await eventually(async () => decided.length === 16, 30_000), JSON.stringify(decided));
    assert.deepEqual([...new Set(decided)], [429]);
    assert.equal(provider.calls.length - before, 4);
    const held = await db.pool.query<{ h: string }>("SELECT held_units::text AS h FROM otk_quota_usage WHERE tenant_id = 'tq'");
    assert.equal(BigInt(held.rows[0]!.h) / 1_000_000n, 12_000n, 'four holds of 3 000');
    hold.release();
    const st = await res;
    provider.onArrive = null;
    // the response ends before the settlement transaction: wait for the four operations
    assert.ok(await eventually(async () => (await db.pool.query("SELECT 1 FROM otk_operations WHERE tenant_id = 'tq' AND reservation->>'state' = 'settled'")).rowCount === 4, 10_000));
    assert.equal(st.filter((s) => s === 200).length, 4, JSON.stringify(st));
    assert.equal(st.filter((s) => s === 429).length, 16, JSON.stringify(st));
    assert.deepEqual(await ledger('tq'), { cu: 600n, entries: 4 });
    const q = await db.pool.query<{ c: string; h: string }>("SELECT confirmed_units::text AS c, held_units::text AS h FROM otk_quota_usage WHERE tenant_id = 'tq'");
    assert.deepEqual(q.rows[0], { c: (600n * 1_000_000n).toString(), h: '0' });
    const next = await call(base, 'tokq', 'q-after', body);
    assert.equal(next.status, 200, 'after settlement the quota has room again');
    await next.text();
  });
});

describe('D7-G04 (proxy): PostgreSQL down when the final usage arrives → spool → one settlement', () => {
  it('measurement spooled (fsync) while the database is cut, applied once when it returns', async () => {
    const relay = new TcpRelay(new URL(db.url).hostname, Number(new URL(db.url).port));
    await relay.start();
    const spoolDir = mkdtempSync(path.join(tmpdir(), 'otkd1d8c-spool-'));
    const { rt, base } = await startGateway({ dbUrl: relay.via(db.url), spoolDir, instanceId: 'otkd1d8c-spool-test' });
    const fb = new Barrier(); provider.finalBarriers.push(fb);
    const r = await call(base, 'tok2', 'op-spool', chatBody({ stream: true }), 'stream', { 'x-test-tokens': '200,100' });
    const reader = r.body!.getReader();
    await reader.read();
    relay.cut();
    fb.release();
    while (!(await reader.read()).done) { /* drain */ }
    assert.ok(await eventually(async () => rt.spool!.pending().length === 1, 10_000), 'one spooled measurement');
    const inPg = await db.pool.query<{ execution: string }>("SELECT execution FROM otk_operations WHERE tenant_id = 't2' AND operation_id = 'op-spool'");
    assert.equal(inPg.rows[0]!.execution, 'upstream_started', 'not yet written');
    const spooled = JSON.stringify(rt.spool!.pending());
    assert.ok(!spooled.includes('part0'), 'no response text in the spool');
    relay.restore();
    await rt.recoverOnce();
    const op = await opRow(rt, 't2', 'op-spool');
    assert.deepEqual([op.execution, op.measurement, op.reservation.state], ['completed', 'final', 'settled']);
    assert.deepEqual(op.reservation.cu, { units: 300n, scale: 1n });
    assert.equal(rt.spool!.pending().length, 0);
    await rt.recoverOnce();
    assert.deepEqual(await ledger('t2'), { cu: 300n, entries: 1 });
    await relay.stop();
  });
});

describe('D3 storage/runtime with explicit doubles of A and B (S4 repeats with the real modules)', () => {
  it('settled operation → opening first, receipt v3 + conference bound and signed, proof job with frozen target; status shows the conference state', async () => {
    const crypto = createReceiptCryptoDouble();
    const base = legacyMeasurementPorts();
    const measurement: MeasurementPorts = {
      ...base,
      label: 'legacy+counterDouble',
      frozenConfig: (c) => ({ ...base.frozenConfig(c), chain: CONFIG.chain, circuitId: CONFIG.circuitId }),
      createLocalCounter: () => createLocalCounterDouble(),
      buildConferenceReport: buildConferenceReportDouble,
      resolveModelSupport: (p, api, model) => ({ provider: p, api, modelRequested: model, catalogKey: model, support: 'generic_fallback', tokenizer: null, catalogVersion: 'double' }),
      conferenceThreshold: { absoluteTokens: 16n, relative: '0.10', calibrationVersion: null, calibrated: false },
      extractOutputText: (_api, body) => ({ texts: [String(((body as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content) ?? '')], nonText: false }),
    };
    const cryptoPorts: CryptoPorts = {
      receiptCrypto: crypto,
      newOpening: newCommitmentOpeningDouble,
      commitmentOf: async (o) => BigInt(sha256Hex(canonicalJson({ b: o.blinding, u: o.usage }))).toString(10),
      userRefOf: () => '7',
      proofTarget: (cfg) => (cfg.chain ? { chainId: cfg.chain.chainId, registry: cfg.chain.registry, circuitId: cfg.circuitId, schemaVersion: cfg.chain.schemaVersion } : null),
      domain: CONFIG.chain,
    };
    const { rt, base: url } = await startGateway({ measurement, crypto: cryptoPorts });
    const r = await call(url, 'tokv3', 'op-v3', chatBody(), 'ok', { 'x-test-tokens': '100,20' });
    assert.equal(r.status, 200);
    await r.text();
    assert.ok(await eventually(async () => (await rt.store.get({ tenantId: 'tv3', operationId: 'op-v3' }))?.reservation.state === 'settled'));
    await rt.worker.tick();
    const key = { tenantId: 'tv3', operationId: 'op-v3' };
    const op = await opRow(rt, 'tv3', 'op-v3');
    const stored = await rt.receiptsV3.getReceipt(key);
    assert.ok(stored, 'receipt v3 stored');
    assert.equal(op.effects.receiptDigest, stored.digest);
    assert.equal(crypto.verifyReceipt(stored.receipt, stored.envelope).ok, true, 'D3-G07: consumer verifies the delivered signature');
    assert.deepEqual(stored.receipt.cu.cu, { units: 120n, scale: 1n });
    const opening = await rt.openings.get(key);
    assert.ok(opening);
    assert.equal(stored.receipt.publicCommitment, await cryptoPorts.commitmentOf(opening));
    const conf = await rt.receiptsV3.getConference(key);
    assert.ok(conf);
    assert.equal(conf.report.receiptDigest, stored.digest);
    assert.equal(crypto.verifyConference(conf.report, conf.envelope, stored.receipt).ok, true);
    const proof = (await rt.outbox.listFor(key)).find((e) => e.kind === 'enqueue_proof');
    assert.ok(proof, 'proof job enqueued after the opening was stored');
    assert.deepEqual(proof.target, { chainId: CONFIG.chain!.chainId, registry: CONFIG.chain!.registry, circuitId: CONFIG.circuitId, schemaVersion: CONFIG.chain!.schemaVersion });
    assert.ok(!JSON.stringify(proof.payload).includes(opening.blinding), 'no opening secret in the job payload');
    const v = await (await fetch(`${url}/v1/operations/op-v3`, { headers: { authorization: 'Bearer tokv3' } })).json() as { operation: { conference: { state: string; verdict: string; calibrated: boolean } } };
    assert.deepEqual([v.operation.conference.state, v.operation.conference.verdict, v.operation.conference.calibrated], ['incomplete', 'not_applicable', false]);
  });
});
