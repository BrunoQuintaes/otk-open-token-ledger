// SYNTHETIC — OFFLINE. MET-02 R4(a) (C158 §3.2): a policy that is only an optional flag is silently off when forgotten => in REAL the choice is explicit (a policy or a deliberate `none`)
// and every RESERVED line carries it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { reservePolicyMismatches } from '../../../scripts/h2eval/core/inputReserve.js';
import { inputReservePolicyFromArgs, requireDeclaredReservePolicy } from '../../../scripts/h2eval/cli/run.js';
import { loadPriceTable } from '../../../scripts/h2eval/record/prices.js';
import { tmp, writePriceFixture, memoryContentStore, plan, doubleAdapter, bodyOf as rawBodyOf, OFFICIAL_HOST } from '../support/double.js';

process.env['H2EVAL_TEST_KEY'] = 'zq-reserve-canary';
const M55 = 'claude-haiku-5-5';
function pricesFor(dir: string, model: string) { const f = writePriceFixture(dir); writeFileSync(f, readFileSync(f, 'utf8').split('sim-haiku').join(model)); return loadPriceTable(f); }
const TEXTS = { a: Array.from({ length: 30 }, (_, i) => `palavra${i} sintetica de teste`).join(' ') };
const kinds = (dir: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));

test('declaracao explicita: REAL sem politica (nem none deliberado) e recusado; none e politica passam; CLI aceita none e recusa none com --outside', () => {
  assert.throws(() => requireDeclaredReservePolicy(undefined), (e: { code?: string }) => e.code === 'INPUT_RESERVE_POLICY_UNDECLARED');
  assert.doesNotThrow(() => requireDeclaredReservePolicy('none')); assert.doesNotThrow(() => requireDeclaredReservePolicy({ id: 'R-A-1.03' }));
  const get = (m: Record<string, string>) => (k: string) => m[k];
  assert.equal(inputReservePolicyFromArgs(get({ 'input-reserve-policy': 'none' })), 'none');
  assert.throws(() => inputReservePolicyFromArgs(get({ 'input-reserve-policy': 'none', 'input-reserve-outside': 'ALLOW' })), (e: { code?: string }) => /^INPUT_RESERVE/.test(e.code ?? ''));
});

test('conferencia do RESERVED: none => todas "none"; politica => id nos modelos 5.5 e NOT_APPLICABLE nos isentos; ausencia ou valor errado e apontado', () => {
  const L = (kind: string, operationId: string, body: Record<string, unknown>) => ({ kind, operationId, body });
  const lines = [L('PLANNED', 'a', { modelRequested: 'claude-sonnet-5-5' }), L('RESERVED', 'a', { reservePolicy: 'R-A-1.03' }), L('PLANNED', 'b', { modelRequested: 'claude-haiku-4-5-20251001' }), L('RESERVED', 'b', { reservePolicy: 'NOT_APPLICABLE' })];
  assert.deepEqual(reservePolicyMismatches(lines, { id: 'R-A-1.03' }), []);
  assert.deepEqual(reservePolicyMismatches(lines, { id: 'R-A-1.05' }), ['a'], 'id diferente do declarado');
  assert.deepEqual(reservePolicyMismatches(lines, 'none'), ['a', 'b']);
  assert.deepEqual(reservePolicyMismatches([L('PLANNED', 'c', { modelRequested: 'claude-opus-5-5' }), L('RESERVED', 'c', {})], { id: 'R-A-1.03' }), ['c'], 'campo ausente');
});

test('executor: RESERVED registra reservePolicy: id (5.5), NOT_APPLICABLE (isento), none (declarado), ausente (sem declaracao)', async () => {
  const run1 = async (model: string, policy: ExecutorConfig['inputReservePolicy']) => {
    const dir = tmp('rsv3'); const store = memoryContentStore(TEXTS);
    const ex = createExecutor({ batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: pricesFor(dir, model), ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
      egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: async () => { const r = rawBodyOf({ kind: 'ok', input: 10, output: 5 }); return { httpStatus: r.status, body: r.body }; }, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } },
      capPolicy: { inputUpperBoundTokens: () => 100000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40), inputReservePolicy: policy });
    await ex.run(plan({ promptSha256: store.sha['a']!, promptId: 'A', modelRequested: model })); ex.close();
    return kinds(dir).find((l) => l.kind === 'RESERVED')!.body['reservePolicy'];
  };
  assert.equal(await run1(M55, { id: 'R-A-1.03' }), 'R-A-1.03'); assert.equal(await run1('claude-haiku-4-5-20251001', { id: 'R-A-1.03' }), 'NOT_APPLICABLE');
  assert.equal(await run1(M55, 'none'), 'none'); assert.equal(await run1(M55, undefined), undefined);
});
