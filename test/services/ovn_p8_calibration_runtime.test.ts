/**
 * OVERNIGHT 20261005 / Phase 8 — the durable runtime selects a calibration profile at conference time and records
 * it in the signed conference report; restart reloads the same profiles from files.
 *
 * Real: gateway, OperationsRuntime, PostgreSQL 16, front B measurement (development weights), real v3 crypto
 * ports (operator key generated per run, never stored; no chain). Synthetic: the provider (no network, no paid
 * call) and the calibrated profile (SYNTHETIC test fixture; target = a synthetic rule, not Anthropic usage).
 *
 *   OTK_TEST_PG_URL=... OTK_TEST_REDIS_URL=... node node_modules/tsx/dist/cli.mjs --test test/services/ovn_p8_calibration_runtime.test.ts
 *
 * Modules under test: the calibration-profile selection of the conference step in `src/operations/runtime.ts`, the
 * profile files it loads at start-up, and the signed conference report, through the in-process API with the fake
 * provider from `./d1d8_c_provider.ts`.
 *
 * Strategy / scenarios: provider usage equal to the adjusted expectation is compared and within the threshold, and
 * the report names the profile while keeping the raw local count; an inflated provider count is divergent under the
 * calibrated threshold; a restarted runtime reloads the same files and reaches the same outcome without changing
 * earlier reports; and without profiles, or with the bootstrap's refusal of synthetic profiles, the heuristic is used
 * with no verdict and a log event.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts`; only `OTK_TEST_PG_URL` is read by this file (the
 * Redis URL in the command above is not used here); a writable temporary directory; an operator key generated per
 * run. Before importing the server it sets fixture values in the test process for the API's variables (tenants, a
 * fake Anthropic key, the upstream override, `PROVER_URL=disabled`). The command above runs just this file.
 *
 * @module test/services/ovn_p8_calibration_runtime.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'tA/OPERATOR:tokA';
process.env['ANTHROPIC_API_KEY'] = 'sk-ant-otk-p8-calibration-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Wallet } from 'ethers';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider } from './d1d8_c_provider.js';
import { eventually } from './d1d8_c_proc.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';
import { createV3Ports } from '../../src/operations/d1d8ProofPorts.js';
import { emptyCalibrationRegistry, expectedTokens, loadCalibrationProfilesFromDir, type CalibrationProfileV1, type CalibrationRegistry } from '../../src/tokenization/calibrationProfile.js';
import { createLocalCounter } from '../../src/tokenization/localCounter.js';
import { resolveModelSupport } from '../../src/providers/catalog/modelCatalog.js';
import { HEURISTIC_THRESHOLD_V0 } from '../../src/tokenization/conferenceReport.js';
import type { ConferenceReport } from '../../src/types/d1d8/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SYN_FILE = 'test/fixtures/calibration/synthetic_test_profile_anthropic_haiku45.json';
const syn = JSON.parse(readFileSync(SYN_FILE, 'utf8')) as CalibrationProfileV1;
const MODEL = 'claude-haiku-4-5-20251001';
const TEXT = 'Resuma em uma frase curta: o medidor registra unidades por lote, a equipe confere o recibo e a prova é publicada na cadeia sem dados pessoais.';
const body = { model: MODEL, max_tokens: 64, messages: [{ role: 'user', content: TEXT }] };

let db: TestDb;
const provider = new ControllableProvider();
let rt: OperationsRuntime; let server: Server; let base = '';
let v3: Awaited<ReturnType<typeof createV3Ports>>;
let gw: typeof import('../../src/proxy/ProxyGateway.js');
let profilesDir = '';
const events: Array<{ event: string; fields: Record<string, unknown> }> = [];

// raw local count of this request by the runtime's own counter, and the profile's expectation from it
const support = resolveModelSupport('anthropic', 'anthropic.messages', MODEL);
const counter = createLocalCounter(support, { maxTextBytes: 1 << 20 });
counter.observeInput({ api: 'anthropic.messages', body });
const LOCAL = Number(counter.finish().counts.find((c) => c.category === 'input')!.count);
const EXPECTED = Number(expectedTokens(syn.parameters.categories.input!, BigInt(LOCAL)));

async function startRuntime(instanceId: string, calibration: CalibrationRegistry): Promise<void> {
  rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, recoveryIntervalMs: 3_600_000, quotaFor: () => null,
    measurement: d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables(['scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json']), proofConfig: v3.proofConfig, calibration }),
    crypto: v3.crypto, proof: v3.proof,
    policy: { leaseMs: 30_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] } });
  const log = rt.log.bind(rt);
  rt.log = (event: string, fields: Record<string, unknown>) => { events.push({ event, fields }); log(event, fields); };
  server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function stopRuntime(): Promise<void> {
  server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rt.stop();
}
async function drainEffects(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await rt.worker.tick();
    const pend = await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM otk_outbox WHERE kind = 'persist_receipt' AND state <> 'done'");
    if (pend.rows[0]!.n === '0') return;
  }
  assert.fail('persist_receipt effects not drained');
}
async function run(op: string, providerInput: number): Promise<ConferenceReport> {
  const r = await fetch(`${base}/v1/messages`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer tokA', 'x-otk-provider': 'anthropic', 'anthropic-version': '2023-06-01', 'x-otk-operation-id': op,
      'x-test-script': 'ok', 'x-test-model': MODEL, 'x-test-tokens': `${providerInput},2` },
    body: JSON.stringify(body) });
  assert.equal(r.status, 200, await r.clone().text());
  await r.text();
  const key = { tenantId: 'tA', operationId: op };
  assert.ok(await eventually(async () => (await rt.store.get(key))?.reservation.state === 'settled'), `${op} settled`);
  await drainEffects();
  const stored = await rt.receiptsV3.getConference(key);
  assert.ok(stored, `${op}: conference report stored`);
  assert.equal(v3.crypto.receiptCrypto.digestConference(stored.report), stored.digest, 'stored report re-digests to its digest');
  return stored.report;
}

before(async () => {
  db = await createTestDb('ovnp8cal');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_ANTHROPIC'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
  v3 = await createV3Ports({ root: ROOT, operatorKey: Wallet.createRandom().privateKey, operatorKeyId: 'ovn-p8-operator', deployment: null, rpcUrl: null, submitterKey: null });
  profilesDir = mkdtempSync(path.join(tmpdir(), 'otk-p8-profiles-'));
  copyFileSync(SYN_FILE, path.join(profilesDir, 'synthetic.json'));
  // profiles are read from files at startup (synthetic allowed only because this is a test)
  await startRuntime('ovn-p8-1', loadCalibrationProfilesFromDir(profilesDir, { allowSynthetic: true }));
});
after(async () => {
  await provider.stop();
  await stopRuntime();
  await db.drop();
  rmSync(profilesDir, { recursive: true, force: true });
  v3.destroy();
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } | null }).curve_bn128?.terminate();
});

describe('Phase 8 — runtime conference with a compatible calibrated profile', () => {
  let first: ConferenceReport;
  it('provider = adjusted expectation → compared/within_threshold; report names the profile; raw local kept', async () => {
    first = await run('p8-within', EXPECTED);
    assert.equal(first.state, 'compared');
    assert.equal(first.verdict, 'within_threshold');
    assert.equal(first.threshold.calibrated, true);
    assert.equal(first.threshold.calibrationVersion, syn.profileId);
    assert.deepEqual(first.calibration, { state: 'COMPATIBLE', profileId: syn.profileId, evidenceHash: syn.evidenceHash, reason: null });
    const c = first.comparisons.find((x) => x.category === 'input')!;
    assert.equal(c.local, BigInt(LOCAL));
    assert.equal(c.provider, BigInt(EXPECTED));
    assert.equal(c.absoluteDelta, BigInt(EXPECTED - LOCAL));
    assert.equal(c.adjusted!.expected, BigInt(EXPECTED));
    assert.equal(c.adjusted!.absoluteDelta, 0n);
    // provider usage in the operation is untouched by the calibration
    const op = await rt.store.get({ tenantId: 'tA', operationId: 'p8-within' });
    assert.equal(op!.usage!.tIn, BigInt(EXPECTED));
  });
  it('provider inflated far above the expectation → divergent under the calibrated threshold', async () => {
    const inflated = EXPECTED + Number(syn.thresholdPolicy.absoluteTokens) + Math.ceil(EXPECTED * 2);
    const rep = await run('p8-divergent', inflated);
    assert.equal(rep.verdict, 'divergent');
    assert.equal(rep.calibration!.profileId, syn.profileId);
  });
  it('restart: a new runtime reloads the same files and reaches the same outcome; earlier reports are unchanged', async () => {
    await stopRuntime();
    await startRuntime('ovn-p8-2', loadCalibrationProfilesFromDir(profilesDir, { allowSynthetic: true }));
    const rep = await run('p8-after-restart', EXPECTED);
    assert.equal(rep.verdict, 'within_threshold');
    assert.deepEqual(rep.calibration, first.calibration);
    assert.deepEqual(rep.threshold, first.threshold);
    const old = await rt.receiptsV3.getConference({ tenantId: 'tA', operationId: 'p8-within' });
    assert.deepEqual(old!.report, first);
  });
  it('without profiles (ABSENT) and with the same files loaded as bootstrap does (synthetic refused): heuristic, no verdict, log event', async () => {
    await stopRuntime();
    await startRuntime('ovn-p8-3', emptyCalibrationRegistry());
    const absent = await run('p8-absent', EXPECTED);
    assert.deepEqual([absent.state, absent.verdict], ['incomplete', 'not_applicable']);
    assert.deepEqual(absent.threshold, { ...HEURISTIC_THRESHOLD_V0 });
    assert.equal(absent.calibration!.state, 'ABSENT');
    assert.ok(absent.comparisons.every((c) => c.adjusted === undefined));
    assert.ok(events.some((e) => e.event === 'conference_calibration_not_applied' && e.fields['state'] === 'ABSENT'));
    await stopRuntime();
    await startRuntime('ovn-p8-4', loadCalibrationProfilesFromDir(profilesDir));
    const refused = await run('p8-synthetic-refused', EXPECTED);
    assert.deepEqual([refused.state, refused.calibration!.state, refused.calibration!.reason], ['incomplete', 'INCOMPATIBLE', 'synthetic_profile_not_allowed']);
    assert.equal(refused.threshold.calibrated, false);
    assert.ok(events.some((e) => e.event === 'conference_calibration_not_applied' && e.fields['reason'] === 'synthetic_profile_not_allowed'));
  });
});
