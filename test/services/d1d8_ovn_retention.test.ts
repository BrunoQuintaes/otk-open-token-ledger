/**
 * OVERNIGHT 20261005 / Phase 4 — erasure of v3 data, idempotency after erasure, and backup → erase → restore → replay.
 *
 * Real: gateway, runtime, PostgreSQL 16 (pg_dump / psql through the test container), v3 crypto ports (throwaway key, no
 * chain), front B measurement (development weights). Synthetic: provider. Retention PERIODS used here are test values;
 * the product default keeps everything (RETENTION_POLICY_UNSET, decision of the author).
 *
 *   . docs/_ops/OVERNIGHT_20261005_MASTER/tools/ovn_env.sh && npx tsx --test test/services/d1d8_ovn_retention.test.ts
 *
 * Modules under test: the erasure and retention functions of `src/operations/runtime.ts` and the API's handling of
 * erased operation ids, through the in-process API with the fake provider from `./d1d8_c_provider.ts`.
 *
 * Strategy / scenarios, in order: three settled operations with receipt, opening and conference; the default policy
 * erases nothing; a backup taken before erasure; erasing one operation (private material removed, tombstone and
 * pseudonymous debit kept, totals unchanged); a retry of the erased id answered 410 without any call or debit;
 * restoring the backup brings the data back and replaying the erasure journal erases it again; and an age policy
 * with test periods that never erases an operation with open exposure.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`) and the `docker` command with
 * access to its container (name from `OTK_TEST_PG_CONTAINER`, with a default) for `pg_dump` and `psql`; a
 * throwaway operator key is generated per run. Before importing the server it sets fixture values in the test process for the API's variables (tenants, a
 * fake OpenAI key, the upstream override, `PROVER_URL=disabled`). The command above first sources an environment
 * script that is not part of this repository; with `OTK_TEST_PG_URL` already set,
 * `npx tsx --test test/services/d1d8_ovn_retention.test.ts` runs just this file.
 *
 * @module test/services/d1d8_ovn_retention.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'tR/OPERATOR:tokR';
process.env['OPENAI_API_KEY'] = 'sk-otk-retention-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
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
import { ErasureJournal, RETENTION_POLICY_UNSET, eraseOperation, ledgerPseudonym, reapplyErasures, runRetention } from '../../src/operations/retention.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONTAINER = process.env['OTK_TEST_PG_CONTAINER'] ?? 'otk-ovn-20261005-postgres-1';
const T = 'tR';
let src: TestDb; let dst: TestDb;
const provider = new ControllableProvider();
let v3: Awaited<ReturnType<typeof createV3Ports>>;
let gw: typeof import('../../src/proxy/ProxyGateway.js');
let journal: ErasureJournal;
const live: Array<{ rt: OperationsRuntime; server: Server }> = [];

function docker(args: string[], input?: string): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}
async function gateway(db: TestDb, id: string): Promise<{ rt: OperationsRuntime; base: string }> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId: id, recoveryIntervalMs: 3_600_000, quotaFor: () => null,
    measurement: d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables(['scripts/pilot/price_table_pilot_v3_20261003.json']), proofConfig: v3.proofConfig }),
    crypto: v3.crypto, proof: v3.proof, policy: { leaseMs: 30_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] } });
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  live.push({ rt, server });
  return { rt, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const call = (base: string, op: string) => fetch(`${base}/v1/chat/completions`, { method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer tokR', 'x-otk-provider': 'openai', 'x-otk-operation-id': op, 'x-test-script': 'ok', 'x-test-model': 'gpt-4o-mini-2024-07-18', 'x-test-tokens': '100,50' },
  body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 64, messages: [{ role: 'user', content: 'Responda ok.' }] }) });
const errorOf = async (r: Response) => ((await r.json()) as { error?: string }).error ?? null;
const count = async (db: TestDb, table: string, op: string) => Number((await db.pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ${table} WHERE tenant_id = $1 AND operation_id = $2`, [T, op])).rows[0]!.n);
const ledgerTotal = async (db: TestDb) => (await db.pool.query<{ u: string; n: string }>('SELECT sum(units)::text AS u, count(*)::text AS n FROM otk_ledger WHERE tenant_id = $1', [T])).rows[0]!;
const privateRows = async (db: TestDb, op: string) => {
  const out: Record<string, number> = {};
  for (const t of ['otk_operations', 'otk_openings', 'otk_receipts_v3', 'otk_conferences', 'otk_outbox']) out[t] = await count(db, t, op);
  return out;
};

before(async () => {
  src = await createTestDb('ovnretsrc');
  const legacy = new PostgresReceiptStore(src.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
  v3 = await createV3Ports({ root: ROOT, operatorKey: Wallet.createRandom().privateKey, operatorKeyId: 'ovn-ret-operator', deployment: null, rpcUrl: null, submitterKey: null });
  journal = new ErasureJournal(path.join(mkdtempSync(path.join(tmpdir(), 'otk-erasure-journal-')), 'erasures.jsonl'));
});
after(async () => {
  for (const s of live) { s.server.closeAllConnections(); await new Promise<void>((r) => s.server.close(() => r())); await s.rt.stop(); }
  await provider.stop();
  await src.drop(); if (dst) await dst.drop();
  v3.destroy();
  await (globalThis as { curve_bn128?: { terminate(): Promise<void> } | null }).curve_bn128?.terminate();
});

describe('Phase 4 — erasure, idempotency after erasure, backup → erase → restore → replay', () => {
  let base = ''; let rt: OperationsRuntime;
  let totalBefore: { u: string; n: string };
  let backup = '';

  it('three settled operations with receipt, opening and conference', async () => {
    ({ rt, base } = await gateway(src, 'ret-1'));
    for (const op of ['A', 'B', 'C']) { const r = await call(base, op); assert.equal(r.status, 200); await r.text(); }
    for (const op of ['A', 'B', 'C']) assert.ok(await eventually(async () => (await rt.store.get({ tenantId: T, operationId: op }))?.reservation.state === 'settled'));
    for (let i = 0; i < 10 && (await count(src, 'otk_receipts_v3', 'C')) === 0; i++) await rt.worker.tick();
    const rowsA = await privateRows(src, 'A');
    assert.deepEqual([rowsA['otk_operations'], rowsA['otk_openings'], rowsA['otk_receipts_v3'], rowsA['otk_conferences']], [1, 1, 1, 1]);
    assert.ok(rowsA['otk_outbox']! >= 1, 'settlement effects exist');
    totalBefore = await ledgerTotal(src);
  });

  it('the default policy erases nothing (periods are the author\'s decision)', async () => {
    assert.deepEqual(await runRetention(src.pool, RETENTION_POLICY_UNSET, journal), { erased: 0, skippedNotTerminal: 0, outboxDeleted: 0 });
    assert.equal(journal.entries().length, 0);
  });

  it('backup taken BEFORE the erasure (pg_dump)', () => {
    backup = docker(['exec', CONTAINER, 'pg_dump', '-U', 'otk', '--no-owner', src.name]);
    assert.ok(backup.includes('otk_openings'));
  });

  it('erase A: private material removed, tombstone kept, debit kept under a pseudonym, totals unchanged', async () => {
    assert.equal(await eraseOperation(src.pool, { tenantId: T, operationId: 'A' }, { journal, reason: 'test_request', policyVersion: 'test-0' }), 'erased');
    assert.deepEqual(await privateRows(src, 'A'), { otk_operations: 0, otk_openings: 0, otk_receipts_v3: 0, otk_conferences: 0, otk_outbox: 0 });
    assert.equal((await src.pool.query("SELECT 1 FROM otk_erasure_tombstones WHERE tenant_id = $1 AND operation_id = 'A'", [T])).rowCount, 1);
    assert.equal(await count(src, 'otk_ledger', 'A'), 0, 'no ledger row names the operation');
    assert.equal(await count(src, 'otk_ledger', ledgerPseudonym({ tenantId: T, operationId: 'A' })), 1, 'its debit stays, pseudonymized');
    assert.deepEqual(await ledgerTotal(src), totalBefore, 'tenant total unchanged');
    assert.equal(journal.entries().length, 1, 'journalled before the transaction');
    assert.equal(await eraseOperation(src.pool, { tenantId: T, operationId: 'A' }, { journal, reason: 'again', policyVersion: 'test-0' }), 'already_erased');
    assert.equal(journal.entries().length, 1, 'nothing journalled for an already erased id');
  });

  it('retry of the erased id → 410 operation_erased; no provider call, no debit, no new operation', async () => {
    const n = provider.calls.length; const t = await ledgerTotal(src);
    const r = await call(base, 'A');
    assert.equal(r.status, 410);
    assert.equal(await errorOf(r), 'operation_erased');
    assert.equal(provider.calls.length, n);
    assert.deepEqual(await ledgerTotal(src), t);
    assert.equal(await count(src, 'otk_operations', 'A'), 0);
  });

  it('restore of the earlier backup resurrects A (the risk), and replaying the journal erases it again', async () => {
    dst = await createTestDb('ovnretdst', { schema: false });
    docker(['exec', '-i', CONTAINER, 'psql', '-U', 'otk', '-v', 'ON_ERROR_STOP=1', '-q', dst.name], backup);
    assert.equal(await count(dst, 'otk_openings', 'A'), 1, 'restored backup holds the erased opening');
    const g = await gateway(dst, 'ret-restored');
    const before = await call(g.base, 'A');
    assert.equal(await errorOf(before), 'operation_exists', 'without the replay the restored row answers as live data');
    const res = await reapplyErasures(dst.pool, journal);
    assert.deepEqual([res.reapplied, res.alreadyErased, res.refused.length], [1, 0, 0]);
    assert.deepEqual(await privateRows(dst, 'A'), { otk_operations: 0, otk_openings: 0, otk_receipts_v3: 0, otk_conferences: 0, otk_outbox: 0 });
    const afterReplay = await call(g.base, 'A');
    assert.equal(afterReplay.status, 410);
    assert.equal((await reapplyErasures(dst.pool, journal)).alreadyErased, 1, 'replay is idempotent');
    assert.deepEqual(await ledgerTotal(dst), totalBefore, 'restored totals unchanged by the replay');
  });

  it('age policy (test periods): erases terminal settled operations, never one with open exposure', async () => {
    await src.pool.query(`UPDATE otk_operations SET execution = 'process_lost', measurement = 'uncertain', reservation = jsonb_set(reservation, '{state}', '"held_uncertain"') WHERE tenant_id = $1 AND operation_id = 'C'`, [T]);
    const r = await runRetention(src.pool, { policyVersion: 'test-age-0', operationsMaxAgeDays: 0, outboxDoneMaxAgeDays: 0 }, journal, new Date(Date.now() + 60_000));
    assert.deepEqual([r.erased, r.skippedNotTerminal], [1, 1], JSON.stringify(r));
    assert.equal(await count(src, 'otk_operations', 'B'), 0);
    assert.equal(await count(src, 'otk_operations', 'C'), 1, 'exposure still open: kept');
    assert.ok(!journal.entries().some((e) => e.operationId === 'C'), 'a refused erasure is not journalled (no later replay)');
  });
});
