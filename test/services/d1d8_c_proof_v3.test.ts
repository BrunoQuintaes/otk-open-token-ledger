/**
 * D1–D8 / C (C4) — v3 proof and submission pipeline with the destination frozen in the job
 * (D7-G08 destination change, D7 §11, D1-G04 C part: answer lost after mining → no second tx).
 * Real PostgreSQL; A's adapter, authorization builder and the chain are explicit doubles
 * (S4 repeats on Besu with src/zk/v3 and the v3 registry, ROTEIRO_BESU_S4.md of A).
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'tp/OPERATOR:tokp';
process.env['OPENAI_API_KEY'] = 'sk-otkd1d8c-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider } from './d1d8_c_provider.js';
import { eventually } from './d1d8_c_proc.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { legacyMeasurementPorts, type MeasurementPorts } from '../../src/operations/measurementPorts.js';
import type { CryptoPorts } from '../../src/operations/context.js';
import type { ProofPorts, Target } from '../../src/operations/proofPipeline.js';
import { canonicalJson, effectId, sha256Hex } from '../../src/operations/ids.js';
import { createReceiptCryptoDouble, newCommitmentOpeningDouble, createBuildPublicAuthorizationDouble, createProofAdapterDouble, ChainSubmitterDouble } from '../fixtures/d1d8/c/doubles.js';
import { CONFIG } from '../fixtures/d1d8/c/builders.js';

let db: TestDb;
const provider = new ControllableProvider();
const crypto = createReceiptCryptoDouble();
const chain = new ChainSubmitterDouble();
const adapter = createProofAdapterDouble(CONFIG.circuitId);
const TARGET_A: Target = { chainId: CONFIG.chain!.chainId, registry: CONFIG.chain!.registry, circuitId: CONFIG.circuitId, schemaVersion: CONFIG.chain!.schemaVersion };
const TARGET_B: Target = { ...TARGET_A, registry: '0x00000000000000000000000000000000000000bb' };
let configured: Target | null = TARGET_A;
const live: Array<{ rt: OperationsRuntime; server: Server }> = [];
let gw: typeof import('../../src/proxy/ProxyGateway.js');

function ports() {
  const base = legacyMeasurementPorts();
  const measurement: MeasurementPorts = { ...base, label: 'legacy+chainConfig', frozenConfig: (c) => ({ ...base.frozenConfig(c), chain: CONFIG.chain, circuitId: CONFIG.circuitId }) };
  const cryptoPorts: CryptoPorts = {
    receiptCrypto: crypto, newOpening: newCommitmentOpeningDouble,
    commitmentOf: async (o) => BigInt(sha256Hex(canonicalJson({ b: o.blinding, u: o.usage }))).toString(10),
    userRefOf: () => '9',
    proofTarget: (cfg) => (cfg.chain ? { chainId: cfg.chain.chainId, registry: cfg.chain.registry, circuitId: cfg.circuitId, schemaVersion: cfg.chain.schemaVersion } : null),
    domain: CONFIG.chain,
  };
  const proof: ProofPorts = {
    buildPublicAuthorization: createBuildPublicAuthorizationDouble(crypto),
    bucketFor: () => ({ min: 0n, max: 1_000_000_000n, policyVersion: 'otk.public_bucket.fixed@1:width=1000CU:unit=microCU' }),
    adapterFor: (id) => (id === CONFIG.circuitId ? adapter : null),
    currentTarget: () => configured,
    chain,
  };
  return { measurement, crypto: cryptoPorts, proof };
}

async function gateway(): Promise<{ rt: OperationsRuntime; base: string }> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, recoveryIntervalMs: 3_600_000, policy: { leaseMs: 2_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] }, ...ports() });
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  live.push({ rt, server });
  return { rt, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
async function settledOperation(base: string, rt: OperationsRuntime, id: string): Promise<void> {
  const r = await fetch(`${base}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer tokp', 'x-otk-operation-id': id, 'x-test-script': 'ok' }, body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }], max_tokens: 32 }) });
  assert.equal(r.status, 200);
  await r.text();
  assert.ok(await eventually(async () => (await rt.store.get({ tenantId: 'tp', operationId: id }))?.reservation.state === 'settled'));
  await rt.worker.tick(); // persist_receipt: opening → receipt v3 → enqueue_proof (target frozen)
}
const effect = async (kind: string, id: string) => (await db.pool.query<{ state: string; attempts: number; last_error: string | null; payload: Record<string, unknown> | null; target: Record<string, unknown> | null }>('SELECT state, attempts, last_error, payload, target FROM otk_outbox WHERE effect_id = $1', [effectId(kind as 'enqueue_proof', { tenantId: 'tp', operationId: id })])).rows[0];
const readyNow = (kind: string, id: string) => db.pool.query("UPDATE otk_outbox SET next_attempt_at = now() WHERE effect_id = $1 AND state = 'pending'", [effectId(kind as 'enqueue_proof', { tenantId: 'tp', operationId: id })]);

before(async () => {
  db = await createTestDb('proofv3');
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
});
after(async () => {
  await provider.stop();
  for (const s of live) { s.server.closeAllConnections(); await new Promise<void>((r) => s.server.close(() => r())); await s.rt.stop().catch(() => {}); }
  await db.drop();
});

describe('v3 proof pipeline (doubles of A; destination frozen in the job)', () => {
  it('settled operation → proof with the adapter → one transaction to the frozen target', async () => {
    const { rt, base } = await gateway();
    await settledOperation(base, rt, 'p-1');
    assert.deepEqual((await effect('enqueue_proof', 'p-1'))?.target, { chainId: TARGET_A.chainId.toString(), registry: TARGET_A.registry, circuitId: TARGET_A.circuitId, schemaVersion: TARGET_A.schemaVersion });
    await rt.proofWorker.tick(); // prove → submit_onchain
    await rt.proofWorker.tick(); // submit
    assert.equal(chain.txsTo(TARGET_A), 1);
    const sub = await effect('submit_onchain', 'p-1');
    assert.equal(sub?.state, 'done');
    assert.match(String((sub?.payload?.['result'] as Record<string, unknown>)?.['txHash']), /^0x[0-9a-f]{64}$/);
    const opening = await rt.openings.get({ tenantId: 'tp', operationId: 'p-1' });
    assert.ok(opening && !JSON.stringify(sub?.payload).includes(opening.blinding), 'no opening secret in the job');
    assert.equal((await rt.store.get({ tenantId: 'tp', operationId: 'p-1' }))?.effects.proofJobId, effectId('submit_onchain', { tenantId: 'tp', operationId: 'p-1' }));
  });

  it('D1-G04 (C part): the tx was mined but its answer was lost → retry consults the registry, no second tx', async () => {
    const { rt, base } = await gateway();
    await settledOperation(base, rt, 'p-2');
    await rt.proofWorker.tick();
    const before = chain.txsTo(TARGET_A);
    chain.loseNextAnswer = true;
    await rt.proofWorker.tick();
    assert.equal(chain.txsTo(TARGET_A), before + 1);
    assert.equal((await effect('submit_onchain', 'p-2'))?.state, 'pending', 'uncertain outcome kept pending');
    await readyNow('submit_onchain', 'p-2');
    await rt.proofWorker.tick();
    const sub = await effect('submit_onchain', 'p-2');
    assert.equal(sub?.state, 'done');
    assert.equal((sub?.payload?.['result'] as Record<string, unknown>)?.['registration'], 'already_registered');
    assert.equal(chain.txsTo(TARGET_A), before + 1, 'exactly one transaction');
  });

  it('D7-G08: destination changed after the job → never redirected; an instance for the original target sends it after a restart', async () => {
    const first = await gateway();
    await settledOperation(first.base, first.rt, 'p-3');
    await first.rt.proofWorker.tick(); // submit_onchain created for TARGET_A
    configured = TARGET_B; // deployment now points at another registry
    const a0 = chain.txsTo(TARGET_A);
    await first.rt.proofWorker.tick();
    const waiting = await effect('submit_onchain', 'p-3');
    assert.equal(waiting?.state, 'pending');
    assert.match(String(waiting?.last_error), /target_mismatch/);
    assert.equal(chain.txsTo(TARGET_B), 0, 'nothing sent to the new destination');
    assert.equal(chain.txsTo(TARGET_A), a0);
    await first.rt.stop(); // the API/worker restarts
    configured = TARGET_A; // an instance configured for the frozen target
    const second = await gateway();
    await readyNow('submit_onchain', 'p-3');
    await second.rt.proofWorker.tick();
    assert.equal((await effect('submit_onchain', 'p-3'))?.state, 'done');
    assert.equal(chain.txsTo(TARGET_A), a0 + 1);
    assert.equal(chain.txsTo(TARGET_B), 0);
  });
});
