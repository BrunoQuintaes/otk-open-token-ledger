/**
 * D1–D8 / S5 (run 20260930-1625) — regressions for the S5 audit findings on the strict money
 * ceiling (ABC-04 follow-up). Real gateway (durable profile), front B's real measurement ports
 * (development-profile weights, flagged), the candidate's dated Haiku 4.5 table, real PostgreSQL 16,
 * local controllable provider (synthetic, no paid call).
 *
 *   OTK_TEST_PG_URL=… OTK_TEST_REDIS_URL=… npx tsx --test --test-concurrency=1 test/services/d1d8_s5_audit.test.ts
 *
 * AUD-1: the provider reports a model outside the reserved set, then the stream is cut before the
 *   final usage. The partial usage already carries the returned model; the reservation was priced
 *   for Haiku only, so the guarantee of the ceiling no longer holds even though the measurement is
 *   not final. Expected: every budget of the operation frozen (same rule as the final case), the
 *   exposure still held, the next request refused before the upstream.
 * AUD-2: a complete measurement whose quote is partial but whose KNOWN subtotal already exceeds the
 *   reserved worst case. Expected: budgets frozen (money_excess_over_reservation), as when the quote
 *   is complete; the reservation stays held (pending_price), nothing is settled.
 *
 * Module under test: the strict money ceiling in the in-process durable gateway (`src/operations/runtime.ts` and the
 * proxy routes), with the fake provider from `./d1d8_c_provider.ts`.
 *
 * Strategy: one scenario per finding, as described above.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts`; only `OTK_TEST_PG_URL` is read by this file (the
 * Redis URL in the command above is not used here). Before importing the server it sets fixture values in the test
 * process for the API's variables (tenants, a fake Anthropic key, the upstream override, `PROVER_URL=disabled`). The
 * command above runs just this file.
 *
 * @module test/services/d1d8_s5_audit.test
 */
process.env['OTK_DB_URL'] = '';
process.env['OTK_RECEIPT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
process.env['OTK_TENANTS'] = 'tS5u/OPERATOR:tokS5u,tS5x/OPERATOR:tokS5x';
process.env['ANTHROPIC_API_KEY'] = 'sk-ant-otkd1d8s5-provider-fixture';
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
import { admitReq, usage } from '../fixtures/d1d8/c/builders.js';

const P = 1_000_000_000_000n;
const TABLE_FILE = 'scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json';
let db: TestDb;
const provider = new ControllableProvider();
const started: Array<{ rt: OperationsRuntime; server: Server }> = [];
let gw: typeof import('../../src/proxy/ProxyGateway.js');

const ports = () => d1d8MeasurementPorts({ weights: developmentWeights(), prices: loadPriceTables([TABLE_FILE]) });
async function gateway(instanceId: string): Promise<{ rt: OperationsRuntime; base: string }> {
  const rt = await OperationsRuntime.create({ dbUrl: db.url, instanceId, recoveryIntervalMs: 3_600_000, measurement: ports(), quotaFor: () => null,
    policy: { leaseMs: 2_000, cancelPollMs: 100, extraForwardHeaders: ['x-test-script', 'x-test-tokens', 'x-test-model'] } });
  const server = gw.startProxyGateway({ port: 0, operations: rt });
  await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
  started.push({ rt, server });
  return { rt, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const body = (extra: Record<string, unknown> = {}) => ({ model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Say hello in one word.' }], ...extra });
// policy v2 (RV2-04): documented context window 200 000 × 1.25 µUSD (highest input-side tariff) + max_tokens × 5 µUSD
const worstCase = (b: Record<string, unknown>) => 200_000n * 1_250_000n + BigInt(b['max_tokens'] as number) * 5_000_000n;
function call(base: string, token: string, b: unknown, script = 'ok', extra: Record<string, string> = {}) {
  return fetch(`${base}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, 'x-otk-provider': 'anthropic', 'anthropic-version': '2023-06-01', 'x-test-script': script, ...extra },
    body: JSON.stringify(b),
  });
}
const budget = async (id: string) => (await db.pool.query<{ s: string; h: string; f: string | null }>('SELECT spent_units::text AS s, held_units::text AS h, frozen_reason AS f FROM otk_money_budget WHERE budget_id = $1', [id])).rows[0]!;

before(async () => {
  db = await createTestDb('s5audit');
  const legacy = new PostgresReceiptStore(db.url); await legacy.init(); await legacy.close();
  await provider.start();
  process.env['OTK_PROXY_UPSTREAM_ANTHROPIC'] = provider.url;
  gw = await import('../../src/proxy/ProxyGateway.js');
});
after(async () => {
  await provider.stop();
  for (const s of started) { s.server.closeAllConnections(); await new Promise<void>((r) => s.server.close(() => r())); await s.rt.stop(); }
  await db.drop();
});

describe('S5 AUD-1 — unexpected returned model seen in a PARTIAL usage (stream cut) breaks the ceiling guarantee', () => {
  it('budget frozen, worst case still held, next request refused before the upstream', async () => {
    const g = await gateway('s5-unexp-cut');
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-S5u', 'tS5u', $1::numeric)", [P.toString()]);
    const b = body({ stream: true });
    const r = await call(g.base, 'tokS5u', b, 'cut', { 'x-test-model': 'claude-sonnet-4-5', 'x-otk-operation-id': 'cut-unexp-1' });
    await r.text().catch(() => '');
    const key = { tenantId: 'tS5u', operationId: 'cut-unexp-1' };
    assert.ok(await eventually(async () => (await g.rt.store.get(key))?.money?.state === 'held_uncertain'));
    const d = (await g.rt.store.getDetail(key))!;
    assert.equal(d.operation.measurement, 'partial');
    assert.equal(d.operation.usage!.modelReturned, 'claude-sonnet-4-5', 'the partial usage reports the returned model');
    const bf = await budget('b-S5u');
    assert.equal(BigInt(bf.h), worstCase(b), 'exposure kept');
    assert.match(String(bf.f), /^unexpected_returned_model:claude-sonnet-4-5:tS5u\/cut-unexp-1$/, 'the reserved set no longer bounds the cost: budget frozen');
    const before = provider.calls.length;
    const next = await call(g.base, 'tokS5u', body(), 'ok');
    assert.equal(next.status, 402);
    assert.equal(((await next.json()) as { error: string }).error, 'budget_exceeded');
    assert.equal(provider.calls.length, before, 'refused before the upstream');
  });
});

describe('S5 AUD-2 — known partial subtotal above the reserved worst case', () => {
  it('pending_price with knownSubtotal > reserved freezes the budget; nothing is settled', async () => {
    const g = await gateway('s5-excess-partial');
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-S5x', 'tS5x', $1::numeric)", [P.toString()]);
    const key = { tenantId: 'tS5x', operationId: 'excess-partial-1' };
    const reserved = 1_000_000n; // 1 µUSD reserved (hand value)
    const adm = await g.rt.store.admit(admitReq(key, 10n, { money: reserved }));
    assert.equal(adm.outcome, 'admitted');
    const op0 = (await g.rt.store.get(key))!;
    const st = await g.rt.store.transition(key, op0.revision, { execution: 'upstream_started' });
    const tableRef = { version: 'anthropic-haiku45-official-2026-10-01', digest: `0x${'11'.repeat(32)}` as `0x${string}` };
    // complete usage, CU settled; quote partial with a known subtotal of 5 µUSD > 1 µUSD reserved
    await g.rt.store.transition(key, st.revision, {
      execution: 'completed', measurement: 'final', usage: usage(10n, 2n),
      reservation: { ...st.reservation, state: 'settled', basis: 'settled:test' },
      money: { ...st.money!, state: 'pending_price', confirmed: null, knownSubtotal: { units: 5_000_000n, scale: P, currency: 'USD' }, priceStatus: 'partial', priceTable: tableRef },
    });
    const d = (await g.rt.store.getDetail(key))!;
    assert.equal(d.operation.money!.state, 'pending_price', 'a subtotal is never settled');
    const bf = await budget('b-S5x');
    assert.deepEqual([bf.s, bf.h], ['0', reserved.toString()], 'reservation still held, nothing spent');
    assert.match(String(bf.f), /^money_excess_over_reservation:tS5x\/excess-partial-1$/, 'the known part already exceeds the reserved worst case');
    assert.equal(d.settlementNote, 'money_excess_over_reservation');
  });
});
