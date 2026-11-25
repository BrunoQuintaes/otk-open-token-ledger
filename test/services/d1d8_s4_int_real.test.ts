/**
 * D1–D8 / S4 — INT-04, INT-06, INT-07, INT-08 with the REAL modules (front B measurement, front A
 * signing/opening/authorization/proof, C runtime) on PostgreSQL 16 and the isolated Besu network.
 * The provider is the local controllable one (synthetic). In-process gateways (ProxyGateway with
 * OperationsRuntime) so faults can be injected at exact points; the process-kill case of INT-04
 * runs through the real entrypoint in d1d8_c_proxy_entry.test.ts (now with the D1–D8 profile).
 *
 *   . scripts/ops/s4_env.sh && OTK_S4_BESU_DIR=… npx tsx --test --test-concurrency=1 test/services/d1d8_s4_int_real.test.ts
 *
 * Modules under test: the real measurement, signing, opening, proof and runtime modules composed in in-process
 * gateways, with the fake provider from `./d1d8_c_provider.ts` and the local Besu network.
 *
 * Strategy / scenarios: client closing before usage, idempotent reopen, cancel from another instance and an upstream
 * cut (usage final once, partial usage never final, never re-sent); a proof job frozen to its registry and submitted
 * once, also with a timeout after mining; negatives (cross-tenant read or export refused, no opening material or
 * operator key in answers or outbox payloads, a revoked signer refused by the registry and re-enabled afterwards);
 * and backup and restore with `pg_dump`/`psql` keeping openings, receipts and their cryptographic links.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`), the `docker` command with
 * access to its container (`OTK_TEST_PG_CONTAINER`, with a default), and the local Besu network described by
 * `OTK_S4_BESU_DIR`. Before importing the server it sets fixture values in the test process for the API's variables
 * (tenants, a fake OpenAI key, the upstream override, `PROVER_URL=disabled`). The command above shows how to run just
 * this file.
 *
 * @module test/services/d1d8_s4_int_real.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'ta/OPERATOR:toka,tb/OPERATOR:tokb';
process.env['OPENAI_API_KEY'] = 'sk-otkd1d8s4-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ethers } from 'ethers';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider, Barrier } from './d1d8_c_provider.js';
import { eventually } from './d1d8_c_proc.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';
import { createV3Ports, readDeployment, type V3Ports } from '../../src/operations/d1d8ProofPorts.js';
import { PgOpeningStore } from '../../src/operations/PgOpeningStore.js';
import { PgReceiptV3Store } from '../../src/operations/receiptV3Store.js';
import { commitmentOf } from '../../src/zk/v3/index.js';
import { effectId } from '../../src/operations/ids.js';
import type { ProofPorts } from '../../src/operations/proofPipeline.js';

const BESU = process.env['OTK_S4_BESU_DIR'];
if (!BESU) throw new Error('OTK_S4_BESU_DIR is required');
const ROOT = process.cwd();
const net = JSON.parse(readFileSync(path.join(BESU, 'network.json'), 'utf8')) as { rpc: string };
const deployment = readDeployment(path.join(BESU, 'deploy_v3_besu.json'));
const devKey = (n: string) => `0x${readFileSync(path.join(BESU, 'dev', `${n}.key`), 'utf8').trim()}`;
const CONTAINER = process.env['OTK_TEST_PG_CONTAINER'] ?? 'otk-d1d8-1625-s4-postgres-1';
const rpc = new ethers.JsonRpcProvider(net.rpc, undefined, { staticNetwork: true });

let db: TestDb;
const provider = new ControllableProvider();
const live: Array<{ rt: OperationsRuntime; server: Server }> = [];
let gw: typeof import('../../src/proxy/ProxyGateway.js');
let v3: V3Ports;

async function gateway(instanceId: string, o: { proof?: ProofPorts | null } = {}): Promise<{ rt: OperationsRuntime; base: string }> {
  const measurement = d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables(['test/fixtures/d1d8/b/price_table_illustrative_v1.json']), proofConfig: v3.proofConfig });
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, recoveryIntervalMs: 3_600_000, quotaFor: () => null, measurement, crypto: v3.crypto, proof: o.proof === undefined ? v3.proof : o.proof,
    policy: { leaseMs: 2_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] } });
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  live.push({ rt, server });
  return { rt, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const chat = (base: string, tok: string, op: string, body: Record<string, unknown>, script: string, extra: Record<string, string> = {}, signal?: AbortSignal) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST', signal, headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, 'x-otk-operation-id': op, 'x-test-script': script, 'x-test-model': 'gpt-4o-mini-2024-07-18', ...extra },
  body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello' }], max_tokens: 64, ...body }),
});
const op = async (rt: OperationsRuntime, t: string, id: string) => (await rt.store.get({ tenantId: t, operationId: id }))!;
const readyNow = (kind: string, t: string, id: string) => db.pool.query("UPDATE otk_outbox SET next_attempt_at = now(), lease_until = NULL WHERE effect_id = $1 AND state <> 'done'", [effectId(kind as 'enqueue_proof', { tenantId: t, operationId: id })]);
const effectRow = async (kind: string, t: string, id: string) => (await db.pool.query<{ state: string; attempts: number; last_error: string | null; payload: { result?: { txHash?: string; registration?: string } } | null; target: { registry: string } | null }>('SELECT state, attempts, last_error, payload, target FROM otk_outbox WHERE effect_id = $1', [effectId(kind as 'enqueue_proof', { tenantId: t, operationId: id })])).rows[0];

before(async () => {
  db = await createTestDb('s4intreal');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
  v3 = await createV3Ports({ root: ROOT, operatorKey: devKey('operator'), operatorKeyId: 'otk-v3-operator-1', deployment, rpcUrl: net.rpc, submitterKey: devKey('submitter') });
});
after(async () => {
  await provider.stop();
  for (const s of live) { s.server.closeAllConnections(); await new Promise<void>((r) => s.server.close(() => r())); await s.rt.stop(); }
  await db.drop();
  v3.destroy();
  rpc.destroy();
  // snarkjs/ffjavascript keep a bn128 worker pool in a global after an in-process proof
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } | null }).curve_bn128?.terminate();
});

describe('S4 INT-04 — app closes, explicit cancel, upstream failure, reopen (real B + A)', () => {
  it('client closes before the usage arrives: upstream read to the end, usage final once, delivery client_disconnected, receipt v3', async () => {
    const g = await gateway('int-a');
    const fb = new Barrier(); provider.finalBarriers.push(fb);
    const ac = new AbortController();
    const n = provider.calls.length;
    const r = await chat(g.base, 'toka', 'close-1', { stream: true }, 'stream', { 'x-test-tokens': '100,20' }, ac.signal);
    await r.body!.getReader().read();
    ac.abort(); // the app goes away mid-stream
    fb.release(); // the provider sends the usage afterwards
    assert.ok(await eventually(async () => (await op(g.rt, 'ta', 'close-1')).reservation.state === 'settled', 20_000));
    const o = await op(g.rt, 'ta', 'close-1');
    assert.deepEqual([o.execution, o.measurement, o.delivery], ['completed', 'final', 'client_disconnected']);
    assert.equal(o.reservation.cu.units, 48_000_000n, '(100 + 20) × 0.4 × 1.0 = 48 CU');
    await g.rt.worker.tick();
    assert.ok(await eventually(async () => (await g.rt.receiptsV3.getReceipt({ tenantId: 'ta', operationId: 'close-1' })) !== null));
    assert.equal(provider.calls.length, n + 1);
  });

  it('reopen with the same operation id: 409 with the stored state, no new generation', async () => {
    const g = live[0]!;
    const n = provider.calls.length;
    const r = await chat(`http://127.0.0.1:${(g.server.address() as AddressInfo).port}`, 'toka', 'close-1', { stream: true }, 'stream');
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { error: string }).error, 'operation_exists');
    assert.equal(provider.calls.length, n);
  });

  it('explicit cancel from ANOTHER instance stops the upstream; partial usage is never final; exposure kept', async () => {
    const a = await gateway('int-b1'); const b = await gateway('int-b2');
    const r = await chat(a.base, 'toka', 'cancel-1', { stream: true }, 'endless');
    await r.body!.getReader().read();
    const c = await fetch(`${b.base}/v1/operations/cancel-1/cancel`, { method: 'POST', headers: { authorization: 'Bearer toka' } });
    assert.equal(c.status, 202);
    assert.ok(await eventually(async () => (await op(a.rt, 'ta', 'cancel-1')).execution === 'cancelled', 20_000));
    const o = await op(a.rt, 'ta', 'cancel-1');
    assert.notEqual(o.measurement, 'final');
    assert.equal(o.reservation.state, 'held_uncertain');
    assert.equal(o.cancellation?.result, 'stopped_upstream');
    assert.ok(provider.calls.some((x) => x.abortedByClient), 'upstream aborted by the gateway');
  });

  it('upstream cut before the usage: upstream_failed + uncertain, never re-sent', async () => {
    const g = live[0]!;
    const base = `http://127.0.0.1:${(g.server.address() as AddressInfo).port}`;
    const n = provider.calls.length;
    const r = await chat(base, 'toka', 'cut-1', { stream: true }, 'cut');
    await r.text().catch(() => '');
    assert.ok(await eventually(async () => (await op(g.rt, 'ta', 'cut-1')).execution === 'upstream_failed', 20_000));
    const o = await op(g.rt, 'ta', 'cut-1');
    assert.deepEqual([o.measurement, o.reservation.state], ['uncertain', 'held_uncertain']);
    await g.rt.recoverOnce();
    assert.equal(provider.calls.length, n + 1);
  });
});

describe('S4 INT-06 / D1-G04 — proof destination frozen, timeout after mining, no duplicate effect', () => {
  it('instance without submitter keeps the job waiting (visible); the configured one submits to the FROZEN registry once', async () => {
    const noChain = await gateway('int-c1', { proof: { ...v3.proof, currentTarget: () => null } });
    const r = await chat(noChain.base, 'toka', 'proof-1', {}, 'ok', { 'x-test-tokens': '100,20' });
    assert.equal(r.status, 200); await r.text();
    assert.ok(await eventually(async () => (await op(noChain.rt, 'ta', 'proof-1')).reservation.state === 'settled'));
    await noChain.rt.worker.tick();
    assert.ok(await eventually(async () => { await noChain.rt.proofWorker.tick(); return (await effectRow('submit_onchain', 'ta', 'proof-1')) !== undefined; }, 120_000, 500));
    await noChain.rt.proofWorker.tick();
    const waiting = (await effectRow('submit_onchain', 'ta', 'proof-1'))!;
    assert.notEqual(waiting.state, 'done');
    assert.match(String(waiting.last_error), /target_mismatch/);
    assert.equal(waiting.target!.registry.toLowerCase(), deployment.domain.registry.toLowerCase(), 'destination frozen at job creation');
    // a timeout AFTER the transaction was mined: the first attempt sends, waits for mining, then fails
    const submitter = new ethers.Wallet(devKey('submitter'), rpc);
    const nonce0 = await rpc.getTransactionCount(submitter.address);
    let timeouts = 0;
    const flaky: ProofPorts = { ...v3.proof, chain: { ...v3.proof.chain, async submit(t, call) { const out = await v3.proof.chain.submit(t, call); if (timeouts++ === 0) throw new Error(`timeout after mining ${out.txHash}`); return out; } } };
    const g = await gateway('int-c2', { proof: flaky });
    await readyNow('submit_onchain', 'ta', 'proof-1');
    await g.rt.proofWorker.tick();
    const afterTimeout = (await effectRow('submit_onchain', 'ta', 'proof-1'))!;
    assert.notEqual(afterTimeout.state, 'done', 'the lost answer is not taken as success');
    await readyNow('submit_onchain', 'ta', 'proof-1');
    await g.rt.proofWorker.tick();
    const done = (await effectRow('submit_onchain', 'ta', 'proof-1'))!;
    assert.equal(done.state, 'done');
    assert.equal(done.payload?.result?.registration, 'already_registered', 'recognised on chain, no second transaction');
    assert.equal(await rpc.getTransactionCount(submitter.address), nonce0 + 1, 'exactly one transaction');
  });
});

describe('S4 INT-07 — negatives on the real path', () => {
  it('tenant B cannot read or export tenant A operations', async () => {
    const base = `http://127.0.0.1:${(live[0]!.server.address() as AddressInfo).port}`;
    for (const p of ['/v1/operations/proof-1', '/v1/operations/proof-1/conference']) {
      const r = await fetch(`${base}${p}`, { headers: { authorization: 'Bearer tokb' } });
      assert.equal(r.status, 404, p);
    }
  });

  it('status/export answers and the outbox payloads never carry the opening (blinding/salt) or the operator key', async () => {
    const base = `http://127.0.0.1:${(live[0]!.server.address() as AddressInfo).port}`;
    const opening = (await new PgOpeningStore(db.pool).get({ tenantId: 'ta', operationId: 'proof-1' }))!;
    const texts = [await (await fetch(`${base}/v1/operations/proof-1`, { headers: { authorization: 'Bearer toka' } })).text(),
      await (await fetch(`${base}/v1/operations/proof-1/conference`, { headers: { authorization: 'Bearer toka' } })).text(),
      JSON.stringify((await db.pool.query('SELECT payload FROM otk_outbox')).rows)];
    for (const t of texts) {
      assert.ok(!t.includes(String(opening.blinding)), 'no blinding');
      assert.ok(!t.includes(devKey('operator').slice(2)), 'no operator key');
    }
  });

  it('revoked signer on chain: the next submission is refused by the registry (UnauthorizedSigner); re-enabled afterwards', async () => {
    const owner = new ethers.Wallet(devKey('deployer'), rpc);
    const signerSet = new ethers.Contract(deployment.domain.registry, ['function setSigner(address,bool)'], owner);
    await (await signerSet.getFunction('setSigner')(new ethers.Wallet(devKey('operator')).address, false)).wait();
    try {
      const g = await gateway('int-d1');
      const r = await chat(g.base, 'toka', 'revoked-1', {}, 'ok', { 'x-test-tokens': '100,20' });
      await r.text();
      assert.ok(await eventually(async () => (await op(g.rt, 'ta', 'revoked-1')).reservation.state === 'settled'));
      await g.rt.worker.tick();
      assert.ok(await eventually(async () => { await g.rt.proofWorker.tick(); return (await effectRow('submit_onchain', 'ta', 'revoked-1'))?.attempts !== undefined && (await effectRow('submit_onchain', 'ta', 'revoked-1'))!.attempts > 0; }, 120_000, 500));
      const e = (await effectRow('submit_onchain', 'ta', 'revoked-1'))!;
      assert.notEqual(e.state, 'done');
      assert.match(String(e.last_error), /UnauthorizedSigner|revert|execution reverted|0x/i);
    } finally {
      await (await signerSet.getFunction('setSigner')(new ethers.Wallet(devKey('operator')).address, true)).wait();
    }
  });
});

describe('S4 INT-08 — backup/restore keeps real openings, receipts and their cryptographic links', () => {
  it('pg_dump/psql of the D1–D8 tables: opening reopens to the receipt commitment; envelopes verify with A', async () => {
    const dump = spawnSync('docker', ['exec', CONTAINER, 'pg_dump', '-U', 'otk', '--no-owner', ...['otk_operations', 'otk_openings', 'otk_receipts_v3', 'otk_conferences', 'otk_ledger', 'otk_money_ledger'].flatMap((t) => ['-t', t]), db.name], { encoding: 'utf8', maxBuffer: 64 << 20 });
    assert.equal(dump.status, 0, dump.stderr);
    const dst = await createTestDb('s4intreal_restore', { schema: false });
    try {
      const rs = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', '-U', 'otk', '-v', 'ON_ERROR_STOP=1', '-q', dst.name], { input: dump.stdout, encoding: 'utf8', maxBuffer: 64 << 20 });
      assert.equal(rs.status, 0, rs.stderr);
      const key = { tenantId: 'ta', operationId: 'proof-1' };
      const opening = (await new PgOpeningStore(dst.pool).get(key))!;
      const rec = (await new PgReceiptV3Store(dst.pool).getReceipt(key))!;
      assert.equal(String(await commitmentOf(opening)), rec.receipt.publicCommitment, 'restored opening still opens the signed commitment');
      assert.equal(v3.crypto.receiptCrypto.verifyReceipt(rec.receipt, rec.envelope).ok, true);
      assert.equal(await new PgOpeningStore(dst.pool).get({ tenantId: 'tb', operationId: 'proof-1' }), null, 'tenant scoping survives restore');
    } finally { await dst.drop(); }
  });
});
