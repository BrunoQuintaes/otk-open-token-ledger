/**
 * OVERNIGHT 20261005 / Phase 7 — attribution of operations to projects and tasks, end to end on the durable proxy.
 *
 * Real: gateway, OperationsRuntime, PostgreSQL 16, front B measurement (development weights, NOT calibrated), real v3
 * crypto ports (operator key generated per run, never stored; no chain). Synthetic: the provider (no network, no paid
 * call) and the projects: "otk" stands for the OTK research project; "synthetic-b"/"synthetic-c" are invented.
 *
 * Hand values: gpt-4o-mini, development weights 1.0 (openai) × 0.4 (model) = 0.4 CU per token; usage 100/50 →
 * 150 × 0.4 = 60 CU = 60 000 000 micro-CU per operation.
 *
 *   . docs/_ops/OVERNIGHT_20261005_MASTER/tools/ovn_env.sh && npx tsx --test test/services/d1d8_ovn_attribution.test.ts
 *
 * Modules under test: the project and task attribution of operations in `src/operations/runtime.ts` and the API
 * routes that register projects, record attribution headers and export signed statements, through the in-process
 * API with the fake provider from `./d1d8_c_provider.ts`.
 *
 * Strategy / scenarios: registration by an operator (a viewer cannot); refusals before the upstream (another
 * tenant's project, unknown application, malformed header); attributed and unattributed operations, with the
 * attribution headers never forwarded; retries with the same or a conflicting attribution; the summary invariant
 * (sum over projects plus unattributed equals the canonical ledger); signed statements that verify against their
 * receipts and fail when moved or edited; receipts that carry no project label; totals unchanged after a restart;
 * and a conflicting statement that never blocks the receipt and proof pipeline.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`); an operator key is generated
 * per run and never stored. Before importing the server it sets fixture values in the test process for the API's variables (tenants, a
 * fake OpenAI key, the upstream override, `PROVER_URL=disabled`). The command above first sources an environment
 * script that is not part of this repository; with `OTK_TEST_PG_URL` already set,
 * `npx tsx --test test/services/d1d8_ovn_attribution.test.ts` runs just this file.
 *
 * @module test/services/d1d8_ovn_attribution.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'tA/OPERATOR:tokA,tA/VIEWER:tokAv,tU/OPERATOR:tokU';
process.env['OPENAI_API_KEY'] = 'sk-otk-attribution-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
import type { AttributionStatementV1, SignedEnvelope } from '../../src/types/d1d8/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const PER_OP = 60_000_000n;
let db: TestDb;
const provider = new ControllableProvider();
let rt: OperationsRuntime; let server: Server; let base = '';
let v3: Awaited<ReturnType<typeof createV3Ports>>;
let gw: typeof import('../../src/proxy/ProxyGateway.js');

async function startRuntime(instanceId: string): Promise<void> {
  rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, recoveryIntervalMs: 3_600_000, quotaFor: () => null,
    measurement: d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables(['scripts/pilot/price_table_pilot_v3_20261003.json']), proofConfig: v3.proofConfig }),
    crypto: v3.crypto, proof: v3.proof,
    policy: { leaseMs: 30_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] } });
  server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function stopRuntime(): Promise<void> {
  server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rt.stop();
}

const body = { model: 'gpt-4o-mini', max_tokens: 64, messages: [{ role: 'user', content: 'Responda ok.' }] };
function call(token: string, op: string, attr: Record<string, string> = {}) {
  return fetch(`${base}/v1/chat/completions`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-otk-provider': 'openai', 'x-otk-operation-id': op,
      'x-test-script': 'ok', 'x-test-model': 'gpt-4o-mini-2024-07-18', 'x-test-tokens': '100,50', ...attr },
    body: JSON.stringify(body) });
}
async function ok(token: string, op: string, attr: Record<string, string> = {}): Promise<void> {
  const r = await call(token, op, attr);
  assert.equal(r.status, 200, await r.clone().text());
  await r.text();
  assert.ok(await eventually(async () => (await rt.store.get({ tenantId: token === 'tokU' ? 'tU' : 'tA', operationId: op }))?.reservation.state === 'settled'), `${op} settled`);
}
const register = (token: string, kind: 'projects' | 'applications', id: string, label?: string) => fetch(`${base}/v1/attribution/${kind}`, {
  method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify({ [kind === 'projects' ? 'projectId' : 'applicationId']: id, ...(label ? { label } : {}) }) });
async function summary(token: string): Promise<Record<string, any>> {
  const r = await fetch(`${base}/v1/attribution/summary`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 200);
  return await r.json() as Record<string, any>;
}
const debits = async (tenant: string) => Number((await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM otk_ledger WHERE tenant_id = $1', [tenant])).rows[0]!.n);
async function drainEffects(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await rt.worker.tick();
    const pend = await db.pool.query<{ n: string }>("SELECT count(*)::text AS n FROM otk_outbox WHERE kind = 'persist_receipt' AND state <> 'done'");
    if (pend.rows[0]!.n === '0') return;
  }
  assert.fail('persist_receipt effects not drained');
}

before(async () => {
  db = await createTestDb('ovnattr');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
  v3 = await createV3Ports({ root: ROOT, operatorKey: Wallet.createRandom().privateKey, operatorKeyId: 'ovn-attr-operator', deployment: null, rpcUrl: null, submitterKey: null });
  await startRuntime('ovn-attr-1');
});
after(async () => {
  await provider.stop();
  await stopRuntime();
  await db.drop();
  // the v3 ports keep the bn128 curve worker threads alive (same cleanup as d1d8_s4_int_real)
  v3.destroy();
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } | null }).curve_bn128?.terminate();
});

describe('Phase 7 — registration and admission checks (nothing reaches the provider when refused)', () => {
  it('a tenant registers its projects and applications (operator role); a viewer cannot', async () => {
    for (const p of ['otk', 'synthetic-b', 'synthetic-c']) assert.equal((await register('tokA', 'projects', p, p === 'otk' ? 'Projeto OTK' : 'sintético')).status, 200);
    assert.equal((await register('tokA', 'applications', 'orchestrator')).status, 200);
    assert.equal((await register('tokU', 'projects', 'u-only')).status, 200);
    assert.equal((await register('tokAv', 'projects', 'x')).status, 403);
    assert.equal((await register('tokA', 'projects', 'bad id!')).status, 400);
  });

  it('cross-tenant: tenant U naming tenant A\'s project is refused as unknown; no call, no reservation, no operation', async () => {
    const n = provider.calls.length;
    const r = await call('tokU', 'u-x', { 'x-otk-project': 'otk' });
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { ok: false, error: 'attribution_rejected', detail: 'project_unknown' });
    assert.equal(provider.calls.length, n);
    assert.equal((await db.pool.query("SELECT 1 FROM otk_operations WHERE tenant_id = 'tU' AND operation_id = 'u-x'")).rowCount, 0);
  });

  it('unknown application and malformed header are refused before upstream', async () => {
    const n = provider.calls.length;
    const a = await call('tokA', 'a-badapp', { 'x-otk-project': 'otk', 'x-otk-application': 'nope' });
    assert.equal(((await a.json()) as { detail: string }).detail, 'application_unknown');
    const b = await call('tokA', 'a-badfmt', { 'x-otk-project': 'has space' });
    assert.equal(b.status, 400);
    assert.equal(((await b.json()) as { error: string }).error, 'attribution_invalid');
    assert.equal(provider.calls.length, n);
  });
});

describe('Phase 7 — operations, retries, totals and invariant', () => {
  it('records attributed and unattributed operations; OTK headers never reach the provider', async () => {
    for (let i = 1; i <= 5; i++) await ok('tokA', `otk-run1-${i}`, { 'x-otk-project': 'otk', 'x-otk-task-type': 'summarize', 'x-otk-task-run': 'run-1' });
    for (let i = 1; i <= 2; i++) await ok('tokA', `b-run2-${i}`, { 'x-otk-project': 'synthetic-b', 'x-otk-task-type': 'summarize', 'x-otk-task-run': 'run-2', 'x-otk-application': 'orchestrator' });
    await ok('tokA', 'c-1', { 'x-otk-project': 'synthetic-c', 'x-otk-task-type': 'classify' });
    await ok('tokA', 'un-1'); await ok('tokA', 'un-2');
    await ok('tokU', 'u-1', { 'x-otk-project': 'u-only' });
    for (const c of provider.calls) for (const h of Object.keys(c.headers)) assert.ok(!h.startsWith('x-otk-'), `${h} forwarded upstream`);
  });

  it('retries: same attribution → the same operation; another project under the same id → conflict; no call, no debit', async () => {
    const n = provider.calls.length; const d = await debits('tA');
    const same = await call('tokA', 'otk-run1-1', { 'x-otk-project': 'otk', 'x-otk-task-type': 'summarize', 'x-otk-task-run': 'run-1' });
    assert.equal(((await same.json()) as { error: string }).error, 'operation_exists');
    const other = await call('tokA', 'otk-run1-1', { 'x-otk-project': 'synthetic-b', 'x-otk-task-type': 'summarize', 'x-otk-task-run': 'run-1' });
    assert.equal(((await other.json()) as { error: string }).error, 'operation_conflict');
    const none = await call('tokA', 'otk-run1-1');
    assert.equal(((await none.json()) as { error: string }).error, 'operation_conflict', 'dropping the attribution is also a different request');
    assert.equal(provider.calls.length, n); assert.equal(await debits('tA'), d);
  });

  it('summary: SUM(projects) + unattributed == canonical ledger (CU and money); application/task type are not added', async () => {
    const s = await summary('tokA');
    const p = Object.fromEntries((s['byProject'] as Array<{ projectId: string; cuUnits: string; operations: number }>).map((x) => [x.projectId, x]));
    assert.deepEqual(Object.keys(p).sort(), ['otk', 'synthetic-b', 'synthetic-c'], 'only tenant A projects');
    assert.deepEqual([p['otk']!.cuUnits, p['otk']!.operations], [(5n * PER_OP).toString(), 5]);
    assert.deepEqual([p['synthetic-b']!.cuUnits, p['synthetic-b']!.operations], [(2n * PER_OP).toString(), 2]);
    assert.equal(p['synthetic-c']!.cuUnits, PER_OP.toString());
    assert.equal(s['unattributed'].cuUnits, (2n * PER_OP).toString());
    assert.equal(s['canonical'].cuUnits, (10n * PER_OP).toString());
    assert.deepEqual(s['invariant'], { cu: true, money: true });
    assert.ok(BigInt(s['canonical'].moneyConfirmedUnits) > 0n, 'money settled from the frozen price table');
    // dimensions of the same rows: each sums to the canonical total on its own, never on top of the projects
    const appSum = (s['byApplication'] as Array<{ cuUnits: string }>).reduce((a, x) => a + BigInt(x.cuUnits), 0n);
    const taskSum = (s['byTaskType'] as Array<{ cuUnits: string }>).reduce((a, x) => a + BigInt(x.cuUnits), 0n);
    assert.equal(appSum, BigInt(s['canonical'].cuUnits)); assert.equal(taskSum, BigInt(s['canonical'].cuUnits));
    const summarize = (s['byTaskType'] as Array<{ taskType: string | null; cuUnits: string }>).find((x) => x.taskType === 'summarize')!;
    assert.equal(summarize.cuUnits, (7n * PER_OP).toString(), 'same task type in two projects');
    const u = await summary('tokU');
    assert.deepEqual((u['byProject'] as Array<{ projectId: string }>).map((x) => x.projectId), ['u-only'], 'tenant U sees only its own');
  });

  it('signed statements: export verifies each one against its receipt; a moved or edited statement fails', async () => {
    await drainEffects();
    const r = await fetch(`${base}/v1/attribution/export?projectId=otk`, { headers: { authorization: 'Bearer tokAv' } });
    assert.equal(r.status, 200);
    const ex = await r.json() as { rows: Array<{ operationId: string; attribution: { projectId: string; taskRunId: string }; statement: AttributionStatementV1; envelope: SignedEnvelope; receipt: { digest: string; payload: any }; verification: { ok: boolean } }> };
    assert.equal(ex.rows.length, 5);
    for (const row of ex.rows) {
      assert.equal(row.verification.ok, true, row.operationId);
      assert.equal(row.statement.receiptDigest, row.receipt.digest);
      assert.deepEqual([row.attribution.projectId, row.attribution.taskRunId], ['otk', 'run-1']);
    }
    const rc = v3.crypto.receiptCrypto;
    const [a, b] = ex.rows;
    const edited = { ...a!.statement, attribution: { ...a!.statement.attribution, projectId: 'synthetic-b' } };
    assert.equal(rc.verifyAttribution!(edited, a!.envelope, a!.receipt.payload).ok, false, 'edited project');
    assert.equal(rc.verifyAttribution!(a!.statement, a!.envelope, b!.receipt.payload).ok, false, 'moved to another receipt');
    // unattributed operations have no statement; the receipt v3 shape is unchanged (no attribution field)
    const un = await rt.receiptsV3.getReceipt({ tenantId: 'tA', operationId: 'un-1' });
    assert.ok(un && !('attribution' in un.receipt));
    assert.equal((await db.pool.query("SELECT 1 FROM otk_attribution_statements WHERE tenant_id = 'tA' AND operation_id = 'un-1'")).rowCount, 0);
  });

  it('the receipt v3 itself carries no project/task label (attribution lives only in the private statement)', async () => {
    const rows = await db.pool.query<{ r: unknown }>("SELECT receipt AS r FROM otk_receipts_v3 WHERE tenant_id = 'tA'");
    assert.ok(rows.rows.length >= 10, 'receipts exist');
    for (const x of rows.rows) for (const label of ['synthetic-b', 'run-1', 'summarize', 'orchestrator']) assert.ok(!JSON.stringify(x.r).includes(label), `${label} inside a receipt`);
  });

  it('after a restart the totals are identical (persisted, nothing recomputed from memory)', async () => {
    const before = await summary('tokA');
    await stopRuntime(); await startRuntime('ovn-attr-2');
    const afterRestart = await summary('tokA');
    assert.deepEqual(afterRestart['byProject'], before['byProject']);
    assert.deepEqual(afterRestart['canonical'], before['canonical']);
  });
});

describe('Phase 7 / audit AUD-001 — a conflicting attribution statement never strands the receipt/proof pipeline', () => {
  it('receipt and receipt effects are recorded; the effect goes dead with the reason (visible), nothing overwritten', async () => {
    await ok('tokA', 'conflict-1', { 'x-otk-project': 'otk', 'x-otk-task-type': 'summarize' });
    // an unexpected different statement already stored for this operation (simulated)
    await db.pool.query("INSERT INTO otk_attribution_statements (tenant_id, operation_id, digest, statement, envelope) VALUES ('tA', 'conflict-1', '0xdeadbeef', '{}'::jsonb, '{}'::jsonb)");
    for (let i = 0; i < 10; i++) {
      await rt.worker.tick();
      const st = await db.pool.query<{ state: string }>("SELECT state FROM otk_outbox WHERE tenant_id = 'tA' AND operation_id = 'conflict-1' AND kind = 'persist_receipt'");
      if (st.rows[0]?.state === 'dead') break;
    }
    const eff = await db.pool.query<{ state: string; e: string | null }>("SELECT state, last_error AS e FROM otk_outbox WHERE tenant_id = 'tA' AND operation_id = 'conflict-1' AND kind = 'persist_receipt'");
    assert.equal(eff.rows[0]!.state, 'dead');
    assert.match(eff.rows[0]!.e ?? '', /different attribution statement/);
    assert.equal((await db.pool.query("SELECT 1 FROM otk_receipts_v3 WHERE tenant_id = 'tA' AND operation_id = 'conflict-1'")).rowCount, 1, 'receipt stored');
    const op = await rt.store.get({ tenantId: 'tA', operationId: 'conflict-1' });
    assert.ok(op?.effects.receiptDigest, 'receipt effects recorded before the statement step');
    const stmt = await db.pool.query<{ d: string }>("SELECT digest AS d FROM otk_attribution_statements WHERE tenant_id = 'tA' AND operation_id = 'conflict-1'");
    assert.equal(stmt.rows[0]!.d, '0xdeadbeef', 'the stored statement is not overwritten');
  });
});
