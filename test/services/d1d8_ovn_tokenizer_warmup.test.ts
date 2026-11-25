/**
 * OVERNIGHT 20261005 / Phase 1 — a cold tokenizer load must not orphan OTHER live operations of the process.
 *
 * FPS5-F01 renewed the lease of the request that loads the tokenizer. But the load is synchronous (0.9–2.5 s
 * measured on the candidate host, more under load) and freezes the whole process: every other live operation
 * stops renewing its lease meanwhile, and another instance may declare it process_lost while its call is still
 * running (audit 05/10: process_lost before the planned kill; 503 when a held admission lost its lease).
 * Fix: the runtime loads the tokenizers at startup (MeasurementPorts.warmUp), before the server is ready.
 *
 * Deterministic reproduction: instance A streams operation Y (held at the provider by a barrier, lease renewed
 * every 300 ms); then request X needs a cold encoding whose first load blocks for 2 × lease. Instance B, a
 * separate process, runs recovery every 100 ms. Without warm-up Y is declared process_lost while live; with
 * warm-up (the same block happens in create, before any request) Y completes and settles.
 *
 *   . docs/_ops/OVERNIGHT_20261005_MASTER/tools/ovn_env.sh && npx tsx --test test/services/d1d8_ovn_tokenizer_warmup.test.ts
 *
 * Modules under test: the tokenizer warm-up of the measurement ports (`warmUp`) and the lease and recovery logic of
 * `src/operations/runtime.ts`, with instance A in process and instance B started as a child process from
 * `./d1d8_ovn_recovery_child.ts`, the fake provider from `./d1d8_c_provider.ts` and a local-counter double.
 *
 * Strategy / scenarios: without warm-up the blocking load orphans the other live operation (B declares it lost
 * while its call runs); with warm-up at creation the same block happens before serving and the live operation
 * settles; and the product ports warm every local encoding, so the first count afterwards loads nothing.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`) and permission to spawn a Node
 * child process with `tsx`. Before importing the server it sets fixture values in the test process for the API's variables (tenants, a
 * fake OpenAI key, the upstream override, `PROVER_URL=disabled`). The command above first sources an environment
 * script that is not part of this repository; with `OTK_TEST_PG_URL` already set,
 * `npx tsx --test test/services/d1d8_ovn_tokenizer_warmup.test.ts` runs just this file.
 *
 * @module test/services/d1d8_ovn_tokenizer_warmup.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'tW/OPERATOR:tokW';
process.env['OPENAI_API_KEY'] = 'sk-otk-warmup-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider, Barrier } from './d1d8_c_provider.js';
import { eventually } from './d1d8_c_proc.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { legacyMeasurementPorts, type MeasurementPorts } from '../../src/operations/measurementPorts.js';
import { createLocalCounterDouble } from '../fixtures/d1d8/c/doubles.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';
import { loadEncoding, warmEncodings } from '../../src/tokenization/tokenizerIdentity.js';

const LEASE_MS = 1_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));
let db: TestDb;
const provider = new ControllableProvider();
let recovery: ChildProcess | null = null;

/**
 * Two "encodings": 'warm' is cheap; 'cold' blocks the event loop for 2 × lease on its first load.
 *
 * @param withWarmUp - When true, the ports expose a warm-up step that performs the blocking load at runtime
 *   creation, before any request.
 */
function measurement(withWarmUp: boolean): MeasurementPorts {
  let coldLoaded = false;
  const loadCold = () => { if (!coldLoaded) { const end = Date.now() + 2 * LEASE_MS; while (Date.now() < end) { /* synchronous, like a rank file parse */ } coldLoaded = true; } };
  return {
    ...legacyMeasurementPorts(),
    label: `legacy+two-encodings${withWarmUp ? '+warmup' : ''}`,
    resolveModelSupport: (p, api, model) => ({ provider: p, api, modelRequested: model, catalogKey: model, support: 'generic_fallback', tokenizer: null, catalogVersion: model === 'gpt-4o' ? 'cold' : 'warm' }),
    createLocalCounter: (support) => { if (support.catalogVersion === 'cold') loadCold(); return createLocalCounterDouble(); },
    ...(withWarmUp ? { warmUp: () => { const t0 = Date.now(); loadCold(); return [{ encoding: 'cold', ms: Date.now() - t0 }]; } } : {}),
  };
}

async function gateway(instanceId: string, m: MeasurementPorts): Promise<{ rt: OperationsRuntime; server: Server; base: string }> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, recoveryIntervalMs: 3_600_000, quotaFor: () => null, measurement: m,
    policy: { leaseMs: LEASE_MS, cancelPollMs: 300, extraForwardHeaders: ['x-test-script', 'x-test-tokens'] } });
  const gw = await import('../../src/proxy/ProxyGateway.js');
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  return { rt, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const call = (base: string, op: string, model: string, script: string) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer tokW', 'x-otk-provider': 'openai', 'x-otk-operation-id': op, 'x-test-script': script, 'x-test-tokens': '10,2' },
  body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'hi' }], ...(script === 'stream' ? { stream: true } : {}) }),
});
const exec = async (op: string) => (await db.pool.query<{ e: string; st: string }>("SELECT execution AS e, reservation->>'state' AS st FROM otk_operations WHERE tenant_id = 'tW' AND operation_id = $1", [op])).rows[0] ?? null;

/**
 * Y streams and is held at the provider; then X triggers the cold load in the same process.
 *
 * @param base - Base URL of instance A's in-process API.
 * @param tag - Label that makes the operation ids of this scenario unique.
 */
async function scenario(base: string, tag: string): Promise<{ y: { e: string; st: string } | null; x: number }> {
  const fb = new Barrier(); provider.finalBarriers.push(fb);
  try {
    const y = await call(base, `y-${tag}`, 'gpt-4o-mini', 'stream');
    const reader = y.body!.getReader();
    await reader.read(); // Y is live: upstream_started, lease renewed by A
    assert.equal((await exec(`y-${tag}`))?.e, 'upstream_started');
    const x = await call(base, `x-${tag}`, 'gpt-4o', 'ok'); // cold load inside A (2 × lease) unless warmed up
    await x.text();
    await new Promise((r) => setTimeout(r, 400)); // a few recovery passes of B after the stall
    const atRelease = await exec(`y-${tag}`);
    fb.release();
    while (!(await reader.read()).done) { /* drain */ }
    return { y: atRelease, x: x.status };
  } finally { fb.release(); }
}

before(async () => {
  db = await createTestDb('ovnwarm');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  recovery = spawn(process.execPath, ['--import', 'tsx', path.join(HERE, 'd1d8_ovn_recovery_child.ts'), db.url, 'warm-B', String(LEASE_MS), '100'], { cwd: path.resolve(HERE, '..', '..'), stdio: ['ignore', 'pipe', 'pipe'] });
  const out: string[] = [];
  recovery.stdout!.on('data', (d) => out.push(String(d))); recovery.stderr!.on('data', (d) => out.push(String(d)));
  assert.ok(await eventually(async () => out.join('').includes('ready'), 120_000, 200), `recovery instance did not start: ${out.join('').slice(-1500)}`);
});
after(async () => {
  recovery?.kill();
  await provider.stop();
  await db.drop();
});

describe('cold tokenizer load vs the leases of other live operations (two instances)', () => {
  it('BEFORE (no warm-up): the stall orphans the other live operation — B declares it process_lost while its call runs', async () => {
    const { rt, server, base } = await gateway('warm-A0', measurement(false));
    try {
      const r = await scenario(base, 'before');
      assert.equal(r.y?.e, 'process_lost', 'documents the defect the warm-up removes');
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rt.stop(); }
  });

  it('AFTER (warm-up at create): the same stall happens before serving; the live operation completes and settles', async () => {
    const t0 = Date.now();
    const { rt, server, base } = await gateway('warm-A1', measurement(true));
    assert.ok(Date.now() - t0 >= 2 * LEASE_MS, 'the cold load ran inside create');
    try {
      const r = await scenario(base, 'after');
      assert.equal(r.x, 200);
      assert.equal(r.y?.e, 'upstream_started', 'still live when the provider releases it');
      assert.ok(await eventually(async () => (await exec('y-after'))?.st === 'settled', 15_000), 'Y settled');
    } finally { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rt.stop(); }
  });

  it('the product ports warm every local encoding: after warm-up the first counter does not load anything', () => {
    const ports = d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables(['scripts/pilot/price_table_pilot_v3_20261003.json']) });
    assert.ok(ports.warmUp, 'front B ports expose warmUp');
    const loaded = ports.warmUp!();
    assert.deepEqual(loaded.map((l) => l.encoding).sort(), ['cl100k_base', 'o200k_base']);
    for (const l of warmEncodings()) assert.ok(l.ms < 50, `${l.encoding} cached (${l.ms} ms)`);
    assert.ok(loadEncoding('o200k_base').encoder);
  });
});
