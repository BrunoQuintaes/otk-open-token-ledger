/**
 * OVERNIGHT 20261005 / P0 identity across versions — request digest v2 and recognition of v1 rows.
 *
 * Defect (audit 05/10, 03_P0_TECNICO §3): request digest v1 hashes the byte length of the body the OTK
 * FORWARDS, which includes the OTK's own injections. Since 58609db the OTK injects service_tier "default" into
 * OpenAI Chat Completions, so a client retry of an operation admitted before that release got 409
 * operation_conflict although it is the same request.
 * Fix: v2 digests the request as the client sent it; rows recorded as v1 are recognized only through the
 * enumerated v1 representations of the same request (forwarded body with / without the injected tier).
 *
 * Old rows are reproduced here by writing the exact v1 digest the earlier releases computed (same function,
 * unchanged since 3d26015) and a NULL version column, as a database migrated by 153 holds them. The cross-binary
 * run (58609db^ → c6937c7 → fix) is docs/_ops/OVERNIGHT_20261005_MASTER/probes/p3_upgrade.
 *
 *   . docs/_ops/OVERNIGHT_20261005_MASTER/tools/ovn_env.sh && npx tsx --test test/services/d1d8_ovn_digest_versions.test.ts
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'dv/OPERATOR:tokdv';
process.env['OPENAI_API_KEY'] = 'sk-otk-digest-versions-provider-fixture';
process.env['OTK_PROXY_ALLOW_UPSTREAM_OVERRIDE'] = '1';

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { ControllableProvider } from './d1d8_c_provider.js';
import { eventually } from './d1d8_c_proc.js';
import { OperationsRuntime } from '../../src/operations/runtime.js';
import { PostgresReceiptStore } from '../../src/api/PostgresReceiptStore.js';
import { d1d8MeasurementPorts, developmentWeights, loadPriceTables } from '../../src/operations/d1d8Ports.js';
import { requestDigest } from '../../src/operations/ids.js';

const T = 'dv';
let db: TestDb;
const provider = new ControllableProvider();
let rt: OperationsRuntime; let server: Server; let base = '';
let gw: typeof import('../../src/proxy/ProxyGateway.js');

const clientBody = (extra: Record<string, unknown> = {}) => ({ model: 'gpt-4o-mini', max_tokens: 64, messages: [{ role: 'user', content: 'Responda ok.' }], ...extra });
const call = (opId: string, b: unknown) => fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer tokdv', 'x-otk-provider': 'openai', 'x-otk-operation-id': opId, 'x-test-script': 'ok', 'x-test-model': 'gpt-4o-mini-2024-07-18', 'x-test-tokens': '100,50' },
  body: JSON.stringify(b),
});
/** v1 exactly as earlier releases computed it for a non-stream OpenAI chat request with max_tokens 64. */
const v1Of = (forwarded: Record<string, unknown>) => requestDigest({
  provider: 'openai', api: 'openai.chat_completions', path: '/v1/chat/completions', modelRequested: 'gpt-4o-mini',
  maxOutputTokens: 64n, stream: false, bodyBytes: Buffer.byteLength(JSON.stringify(forwarded)),
});
const row = async (op: string) => (await db.pool.query<{ d: string; v: string | null; ex: string }>(
  'SELECT request_digest AS d, request_digest_version AS v, execution AS ex FROM otk_operations WHERE tenant_id = $1 AND operation_id = $2', [T, op])).rows[0]!;
const ledger = async (op: string) => Number((await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM otk_ledger WHERE tenant_id = $1 AND operation_id = $2', [T, op])).rows[0]!.n);
async function settled(op: string): Promise<void> {
  assert.ok(await eventually(async () => (await rt.store.get({ tenantId: T, operationId: op }))?.reservation.state === 'settled'), `${op} settled`);
}
/** Turn an operation admitted now into what an earlier release left in the table. */
const makeV1Row = (op: string, digest: string) => db.pool.query(
  'UPDATE otk_operations SET request_digest = $3, request_digest_version = NULL WHERE tenant_id = $1 AND operation_id = $2', [T, op, digest]);

before(async () => {
  db = await createTestDb('ovndigest');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_OPENAI'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
  rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId: 'ovn-digest', recoveryIntervalMs: 3_600_000, quotaFor: () => null,
    measurement: d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables(['scripts/pilot/price_table_pilot_v3_20261003.json']) }),
    policy: { leaseMs: 30_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] } });
  server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => {
  await provider.stop();
  server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rt.stop();
  await db.drop();
});

describe('request digest v2 — new operations', () => {
  it('a new operation is recorded as v2 and its identical retry is the same operation (no 2nd call, no 2nd debit)', async () => {
    const n = provider.calls.length;
    const r = await call('v2-a', clientBody()); assert.equal(r.status, 200); await r.text();
    await settled('v2-a');
    assert.equal((await row('v2-a')).v, 'otk.request_digest.v2');
    const again = await call('v2-a', clientBody());
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, 'operation_exists');
    assert.equal(provider.calls.length - n, 1, 'one provider call');
    assert.equal(await ledger('v2-a'), 1, 'one debit');
  });

  it('the v2 identity does not depend on the OTK injection: the forwarded body carries service_tier, the digest does not', async () => {
    const r = await call('v2-b', clientBody()); await r.text(); await settled('v2-b');
    assert.equal(provider.calls.at(-1)!.body['service_tier'], 'default', 'the OTK still asks Standard explicitly');
    assert.notEqual((await row('v2-b')).d, v1Of({ ...clientBody(), service_tier: 'default' }));
  });

  it('a really different request under the same id is a conflict (different max_tokens)', async () => {
    const n = provider.calls.length;
    const r = await call('v2-a', clientBody({ max_tokens: 65 }));
    assert.equal(r.status, 409);
    assert.equal(((await r.json()) as { error: string }).error, 'operation_conflict');
    assert.equal(provider.calls.length, n);
  });
});

describe('rows left by earlier releases (v1) — upgrade compatibility', () => {
  it('row admitted by c6937c7 (v1 over the forwarded body WITH the injected tier): identical retry → existing', async () => {
    const r = await call('v1-tier', clientBody()); await r.text(); await settled('v1-tier');
    const old = v1Of({ ...clientBody(), service_tier: 'default' });
    await makeV1Row('v1-tier', old);
    const n = provider.calls.length;
    const again = await call('v1-tier', clientBody());
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as { error: string }).error, 'operation_exists', 'before the fix: operation_conflict');
    assert.equal(provider.calls.length, n, 'no new provider call');
    assert.equal(await ledger('v1-tier'), 1, 'no new debit');
    const after = await row('v1-tier');
    assert.deepEqual([after.d, after.v], [old, null], 'the stored digest and its (absent) version are never rewritten');
  });

  it('row admitted before 58609db (v1 over the forwarded body WITHOUT service_tier): identical retry → existing', async () => {
    const r = await call('v1-pre', clientBody()); await r.text(); await settled('v1-pre');
    await makeV1Row('v1-pre', v1Of(clientBody()));
    const n = provider.calls.length;
    const again = await call('v1-pre', clientBody());
    assert.equal(((await again.json()) as { error: string }).error, 'operation_exists');
    assert.equal(provider.calls.length, n);
    assert.equal(await ledger('v1-pre'), 1);
  });

  it('a v1 row and a different request (max_tokens 65) → conflict; no call, no debit', async () => {
    const n = provider.calls.length;
    const r = await call('v1-tier', clientBody({ max_tokens: 65 }));
    assert.equal(((await r.json()) as { error: string }).error, 'operation_conflict');
    assert.equal(provider.calls.length, n);
    assert.equal(await ledger('v1-tier'), 1);
  });

  it('narrow: a v1 digest value stored on a row recorded as v2 is NOT accepted (version decides the comparison)', async () => {
    const r = await call('v2-tamper', clientBody()); await r.text(); await settled('v2-tamper');
    await db.pool.query("UPDATE otk_operations SET request_digest = $3 WHERE tenant_id = $1 AND operation_id = $2", [T, 'v2-tamper', v1Of({ ...clientBody(), service_tier: 'default' })]);
    const again = await call('v2-tamper', clientBody());
    assert.equal(((await again.json()) as { error: string }).error, 'operation_conflict');
  });

  it('10 concurrent identical retries of a v1 row: all existing, still one call and one debit', async () => {
    const n = provider.calls.length;
    const answers = await Promise.all(Array.from({ length: 10 }, async () => { const r = await call('v1-tier', clientBody()); return ((await r.json()) as { error: string }).error; }));
    assert.deepEqual([...new Set(answers)], ['operation_exists']);
    assert.equal(provider.calls.length, n);
    assert.equal(await ledger('v1-tier'), 1);
  });

  it('after a restart of the runtime the v1 row is still recognized', async () => {
    server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); await rt.stop();
    rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId: 'ovn-digest-2', recoveryIntervalMs: 3_600_000, quotaFor: () => null,
      measurement: d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables(['scripts/pilot/price_table_pilot_v3_20261003.json']) }),
      policy: { leaseMs: 30_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] } });
    server = gw.startProxyGateway({ port: 0, operations: rt });
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const n = provider.calls.length;
    const again = await call('v1-pre', clientBody());
    assert.equal(((await again.json()) as { error: string }).error, 'operation_exists');
    assert.equal(provider.calls.length, n);
  });
});

describe('migration 153 on a database that already had every D1–D8 relation', () => {
  it('boot (ensureD1D8Schema) adds the column although no relation is missing; old rows read as v1', async () => {
    const { ensureD1D8Schema } = await import('../../src/operations/schema.js');
    const old = await createTestDb('ovndigest_old');
    try {
      await old.pool.query('ALTER TABLE otk_operations DROP COLUMN request_digest_version'); // what c6937c7 left
      await ensureD1D8Schema(old.pool);
      const c = await old.pool.query("SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'otk_operations' AND column_name = 'request_digest_version'");
      assert.equal(c.rowCount, 1);
      await ensureD1D8Schema(old.pool); // idempotent
    } finally { await old.drop(); }
  });
});
