/**
 * D1–D8 / S4 — D4-G01/G02 (integrated part) and D4-G06 through the composed profile:
 *  - signed v2 weights from a file (bootstrapD1D8 → signedWeightsFromFile): valid table active and
 *    stamped in every operation; tampered table / unauthorized signer refused; restart with the
 *    source unavailable keeps the SAME version from the persisted snapshot;
 *  - auxiliary failure (local counter throws) ≠ essential failure (no valid weights): the first
 *    still delivers and settles the call with the conference marked unavailable, the second refuses
 *    the admission before the provider is called.
 * Real PostgreSQL 16, in-process gateway, synthetic provider.
 *
 *   . scripts/ops/s4_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_s4_d4_integrated.test.ts
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'td/OPERATOR:tokd';
process.env['OPENAI_API_KEY'] = 'sk-otkd1d8s4-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Wallet } from 'ethers';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider } from './d1d8_c_provider.js';
import { eventually } from './d1d8_c_proc.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { d1d8MeasurementPorts, loadPriceTables, signedWeightsFromFile, type WeightsSource } from '../../src/operations/d1d8Ports.js';
import { cuWeightsV2Message, cuWeightsV2ToJson, staticTablesAsV2Body } from '../../src/economics/cuWeightsV2.js';
import type { MeasurementPorts } from '../../src/operations/measurementPorts.js';

let db: TestDb;
const provider = new ControllableProvider();
const live: Array<{ rt: OperationsRuntime; server: Server }> = [];
let gw: typeof import('../../src/proxy/ProxyGateway.js');
const operatorOfWeights = Wallet.createRandom();
const dir = mkdtempSync(path.join(tmpdir(), 'otkd1d8s4-d4-'));
const file = path.join(dir, 'cu_weights_v2.json');
const snap = path.join(dir, 'snapshot');

async function table(version: string, signer = operatorOfWeights) {
  const body = staticTablesAsV2Body({ version, validFrom: '2026-01-01T00:00:00.000Z', validUntil: '2027-12-31T00:00:00.000Z', signedBy: signer.address });
  return cuWeightsV2ToJson({ ...body, signature: await signer.signMessage(cuWeightsV2Message(body)) });
}
async function gateway(measurement: MeasurementPorts): Promise<string> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId: `d4-${live.length}`, recoveryIntervalMs: 3_600_000, quotaFor: () => null, measurement, policy: { extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] } });
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  live.push({ rt, server });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
const ports = (weights: WeightsSource, over: Partial<MeasurementPorts> = {}): MeasurementPorts => ({ ...d1d8MeasurementPorts({ weights, prices: loadPriceTables([]) }), ...over });
const call = (base: string, op: string) => fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tokd', 'x-otk-operation-id': op, 'x-test-script': 'ok', 'x-test-tokens': '100,20', 'x-test-model': 'gpt-4o-mini-2024-07-18' }, body: JSON.stringify({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hello there' }], max_tokens: 32 }) });

before(async () => {
  db = await createTestDb('s4d4');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
});
after(async () => {
  await provider.stop();
  for (const s of live) { s.server.closeAllConnections(); await new Promise<void>((r) => s.server.close(() => r())); await s.rt.stop(); }
  await db.drop();
});

describe('S4 D4-G01/G02 — signed weights in the composed profile', () => {
  it('valid signed table is active and frozen into the operation (version + digest, not development)', async () => {
    writeFileSync(file, JSON.stringify(await table('cw-s4-1')));
    const w = await signedWeightsFromFile({ file, signers: [operatorOfWeights.address], snapshotDir: snap });
    assert.equal(w.status, 'valid');
    const base = await gateway(ports(w));
    const r = await call(base, 'w-1'); assert.equal(r.status, 200); await r.text();
    assert.ok(await eventually(async () => (await live[0]!.rt.store.get({ tenantId: 'td', operationId: 'w-1' }))?.reservation.state === 'settled'));
    const op = (await live[0]!.rt.store.get({ tenantId: 'td', operationId: 'w-1' }))!;
    assert.equal(op.config.cuWeights.version, 'cw-s4-1');
    assert.equal(op.config.developmentProfile, false);
    assert.equal(op.reservation.cu.units, 48_000_000n, '(100 + 20) × 0.400 × 1.000 = 48 CU');
  });

  it('tampered table and unauthorized signer are refused; restart with the source down keeps the same version from the snapshot', async () => {
    const t = await table('cw-s4-2') as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...t, modelWeightsMilli: { ...(t['modelWeightsMilli'] as object), 'gpt-4o-mini': '1' } }));
    const tampered = await signedWeightsFromFile({ file, signers: [operatorOfWeights.address], snapshotDir: snap });
    assert.equal(tampered.active()?.ref.version, 'cw-s4-1', 'rejected table never activated; the snapshot keeps the previous valid one');
    writeFileSync(file, JSON.stringify(await table('cw-s4-3', Wallet.createRandom())));
    const stranger = await signedWeightsFromFile({ file, signers: [operatorOfWeights.address], snapshotDir: snap });
    assert.equal(stranger.active()?.ref.version, 'cw-s4-1');
    rmSync(file);
    const down = await signedWeightsFromFile({ file, signers: [operatorOfWeights.address], snapshotDir: snap });
    assert.equal(down.status, 'source_unavailable_using_snapshot');
    assert.equal(down.active()?.ref.version, 'cw-s4-1');
    const none = await signedWeightsFromFile({ file, signers: [operatorOfWeights.address], snapshotDir: mkdtempSync(path.join(tmpdir(), 'otkd1d8s4-d4-empty-')) });
    assert.equal(none.active(), null, 'no source and no snapshot: nothing active (no silent constants)');
  });
});

describe('S4 D4-G06 — auxiliary failure vs essential failure through the gateway', () => {
  it('local counter throws: the call is delivered and settled; the local count is recorded as failed (B builds an "unavailable" conference from it, never "no divergence")', async () => {
    const w = await signedWeightsFromFile({ file: null, signers: [operatorOfWeights.address], snapshotDir: snap });
    const base = await gateway(ports(w, { createLocalCounter: () => { throw new Error('counter crashed'); } }));
    const r = await call(base, 'aux-1');
    assert.equal(r.status, 200); await r.text();
    const rt = live[live.length - 1]!.rt;
    assert.ok(await eventually(async () => (await rt.store.get({ tenantId: 'td', operationId: 'aux-1' }))?.reservation.state === 'settled'));
    const d = (await rt.store.getDetail({ tenantId: 'td', operationId: 'aux-1' }))!;
    assert.equal(d.localCount?.status, 'failed');
  });

  it('no valid weights: admission refused before the provider (503 cu_config_unavailable)', async () => {
    const none: WeightsSource = { label: 'none', active: () => null, byRef: () => null };
    const base = await gateway(ports(none));
    const n = provider.calls.length;
    const r = await call(base, 'ess-1');
    assert.equal(r.status, 503);
    assert.equal(((await r.json()) as { error: string }).error, 'cu_config_unavailable');
    assert.equal(provider.calls.length, n);
  });
});
