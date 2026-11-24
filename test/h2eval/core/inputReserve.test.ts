// SYNTHETIC — OFFLINE. C158 §3.2: conservative INPUT RESERVE policy (ECON-02, R-A x1.03 / x1.05) as a configurable PRE-SEND gate. NOT active by default; it can only stop earlier.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { policyBoundTokens, evaluateInputReserve, isPolicyModel } from '../../../scripts/h2eval/core/inputReserve.js';
import { inputReservePolicyFromArgs } from '../../../scripts/h2eval/cli/run.js';
import { loadPriceTable } from '../../../scripts/h2eval/record/prices.js';
import { tmp, writePriceFixture, memoryContentStore, plan, doubleAdapter, bodyOf as rawBodyOf, OFFICIAL_HOST } from '../support/double.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';

process.env['H2EVAL_TEST_KEY'] = 'zq-reserve-canary';
const M55 = 'claude-haiku-5-5';
/** the price fixture re-keyed to a 5.5 model name (synthetic) */
function pricesFor(dir: string, model: string) { const f = writePriceFixture(dir); writeFileSync(f, readFileSync(f, 'utf8').split('sim-haiku').join(model)); return loadPriceTable(f); }
const TEXTS = { a: Array.from({ length: 30 }, (_, i) => `palavra${i} sintetica de teste`).join(' '), tiny: 'oi' };

test('curva: R-A x1.03 e x1.05 em inteiros, piso 37, valores de referencia da ECON-02', () => {
  assert.equal(policyBoundTokens('R-A-1.03', 12), 37, 'ECON-02 §3 regra 2: o valor de R-A x1,03 em L0 = 12 e 37');
  assert.equal(policyBoundTokens('R-A-1.03', 0), 37, 'piso'); assert.equal(policyBoundTokens('R-A-1.03', 420), 800); assert.equal(policyBoundTokens('R-A-1.05', 420), 816);
  assert.equal(policyBoundTokens('R-A-1.03', 1000), Math.ceil(1.03 * (1.815 * 1000 + 14)));
  for (let l = 0; l <= 6000; l += 37) { const exact = (103n * (1815n * BigInt(l) + 14000n) + 99_999n) / 100_000n; assert.equal(policyBoundTokens('R-A-1.03', l), Math.max(37, Number(exact))); assert.ok(policyBoundTokens('R-A-1.05', l) >= policyBoundTokens('R-A-1.03', l)); }
  assert.throws(() => policyBoundTokens('R-A-1.03', -1)); assert.throws(() => policyBoundTokens('R-A-1.03', 1.5));
  assert.deepEqual(['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-4-5-20251001', 'gpt-4o-mini-2024-07-18', 'gemini-3.5-flash-lite'].map(isPolicyModel), [true, true, true, false, false, false]);
});

test('decisao pura: sem politica nao muda nada; 4.5/GPT/Gemini nao se aplicam; ferramentas, L0 desconhecido, fora da faixa e reserva abaixo da politica param', () => {
  const o = (x: Partial<Parameters<typeof evaluateInputReserve>[1]> = {}) => ({ provider: 'anthropic', model: M55, L0: 420 as number | 'UNKNOWN', plannedBound: 800, hasTools: false, ...x });
  const p = { id: 'R-A-1.03' as const };
  assert.deepEqual(evaluateInputReserve(undefined, o({ plannedBound: 1 })), { stop: false, applicable: false });
  for (const [provider, model] of [['anthropic', 'claude-haiku-4-5-20251001'], ['openai', 'gpt-4o-mini-2024-07-18'], ['google', 'gemini-3.5-flash-lite']] as const) assert.deepEqual(evaluateInputReserve(p, o({ provider, model, plannedBound: 1 })), { stop: false, applicable: false }, model);
  const ok = evaluateInputReserve(p, o()); assert.equal(ok.stop, false); assert.equal((ok as { policyBoundTokens: number }).policyBoundTokens, 800);
  assert.equal((evaluateInputReserve(p, o({ plannedBound: 799 })) as { reason: string }).reason, 'RESERVE_BELOW_POLICY');
  assert.equal((evaluateInputReserve(p, o({ hasTools: true })) as { reason: string }).reason, 'TOOLS_PRESENT');
  assert.equal((evaluateInputReserve(p, o({ L0: 'UNKNOWN' })) as { reason: string }).reason, 'L0_UNKNOWN', 'UNKNOWN nunca vira zero');
  assert.equal((evaluateInputReserve(p, o({ L0: 11 })) as { reason: string }).reason, 'OUTSIDE_MEASURED_RANGE');
  assert.equal((evaluateInputReserve(p, o({ model: 'claude-sonnet-5-5', L0: 811, plannedBound: 5000 })) as { reason: string }).reason, 'OUTSIDE_MEASURED_RANGE', 'Sonnet/Opus so ate L0 810');
  const allowed = evaluateInputReserve({ ...p, outsideMeasuredRange: 'ALLOW' }, o({ model: 'claude-sonnet-5-5', L0: 811, plannedBound: 5000 })); assert.equal(allowed.stop, false); assert.equal((allowed as { extrapolated: boolean }).extrapolated, true);
});

test('P09/P15 (BOT-01): com a politica ligada TODO modelo anthropic fora da tabela e da lista explicita de isentos (Haiku 4.5) => STOP; sem a politica nada muda; GPT/Gemini seguem isentos', () => {
  const p = { id: 'R-A-1.03' as const };
  const stops = ['claude-sonnet-5-5-20261001', 'Claude-Sonnet-5-5', 'claude-sonnet-5-5-latest', 'claude-opus-5-6', 'claude-haiku-5', ' claude-haiku-5-5 ', 'claude_sonnet_5_5', 'anthropic/claude-sonnet-5-5', 'claude-fable-5-2', 'claude‑sonnet‑5‑5', 'claude-5-sonnet', 'sonnet-5-5', 'claude-sonnet-4-5', 'sim-haiku', ''];
  for (const model of stops) { const d = evaluateInputReserve(p, { provider: 'anthropic', model, L0: 420, plannedBound: 1, hasTools: false }); assert.equal(d.stop, true, JSON.stringify(model)); assert.equal((d as { reason: string }).reason, 'MODEL_NOT_IN_POLICY_TABLE', JSON.stringify(model)); assert.deepEqual(evaluateInputReserve(undefined, { provider: 'anthropic', model, L0: 420, plannedBound: 1, hasTools: false }), { stop: false, applicable: false }, `${JSON.stringify(model)} sem politica`); }
  for (const [provider, model] of [['anthropic', 'claude-haiku-4-5-20251001'], ['openai', 'gpt-4o-mini-2024-07-18'], ['google', 'gemini-3.5-flash-lite']] as const) assert.deepEqual(evaluateInputReserve(p, { provider, model, L0: 420, plannedBound: 1, hasTools: false }), { stop: false, applicable: false }, model);
});

test('CLI: sem flag a politica NAO esta ativa; id desconhecido e --outside sem politica sao recusados', () => {
  const get = (m: Record<string, string>) => (k: string) => m[k];
  assert.equal(inputReservePolicyFromArgs(get({})), undefined);
  assert.deepEqual(inputReservePolicyFromArgs(get({ 'input-reserve-policy': 'R-A-1.05' })), { id: 'R-A-1.05', outsideMeasuredRange: 'STOP' });
  assert.equal(inputReservePolicyFromArgs(get({ 'input-reserve-policy': 'R-A-1.03', 'input-reserve-outside': 'ALLOW' }))!.outsideMeasuredRange, 'ALLOW');
  for (const bad of [{ 'input-reserve-policy': 'R-A' }, { 'input-reserve-policy': 'R-A-1.5' }, { 'input-reserve-outside': 'ALLOW' }, { 'input-reserve-policy': 'R-A-1.03', 'input-reserve-outside': 'MAYBE' }]) assert.throws(() => inputReservePolicyFromArgs(get(bad)), (e: { code?: string }) => /^INPUT_RESERVE/.test(e.code ?? ''), JSON.stringify(bad));
});

function build(over: { policy?: ExecutorConfig['inputReservePolicy']; bound: (L0: unknown) => number }) {
  const dir = tmp('rsv'); const store = memoryContentStore(TEXTS); const sent: BuiltRequest[] = []; const seenL0: unknown[] = [];
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: pricesFor(dir, M55),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: async (req: BuiltRequest) => { sent.push(req); const r = rawBodyOf({ kind: 'ok', input: 10, output: 5 }); return { httpStatus: r.status, body: r.body }; }, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } },
    capPolicy: { inputUpperBoundTokens: (_p, L0) => { seenL0.push(L0); return over.bound(L0); }, reasoningAllowanceTokens: () => 0 },
    executorCodeSha: 'c'.repeat(40), inputReservePolicy: over.policy,
  };
  return { dir, store, sent, seenL0, ex: createExecutor(cfg) };
}
const P = (store: { sha: Record<string, string> }, n: string, rep = 1) => plan({ promptSha256: store.sha[n]!, promptId: n.toUpperCase(), rep, modelRequested: M55 });
const kinds = (dir: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));

test('gate no executor: reserva planejada abaixo da politica => NADA reservado nem enviado, STOP_INPUT_RESERVE_POLICY (e trava o lote); na politica ou acima => segue', async () => {
  const probe = build({ bound: () => 100000 }); await probe.ex.run(P(probe.store, 'a')); const L0 = probe.seenL0[0] as number; probe.ex.close(); assert.ok(L0 >= 12 && L0 <= 5705, `L0 ${L0} dentro da faixa do Haiku 5.5`);
  const need = policyBoundTokens('R-A-1.03', L0);
  const low = build({ policy: { id: 'R-A-1.03' }, bound: () => need - 1 });
  const r1 = await low.ex.run(P(low.store, 'a')); assert.equal(r1.stop, 'STOP_INPUT_RESERVE_POLICY'); assert.equal(low.sent.length, 0);
  const k = kinds(low.dir).map((l) => l.kind); assert.equal(k.includes('RESERVED'), false); assert.equal(k.includes('SENT'), false);
  const line = kinds(low.dir).find((l) => l.kind === 'STOP_GLOBAL')!.body as Record<string, unknown>; assert.deepEqual([line['reason'], line['gate'], line['policy'], line['policyBoundTokens'], line['plannedInputUpperBoundTokens']], ['STOP_INPUT_RESERVE_POLICY', 'RESERVE_BELOW_POLICY', 'R-A-1.03', need, need - 1]);
  const r2 = await low.ex.run(P(low.store, 'a', 2)); assert.equal(r2.stop, 'STOP_INPUT_RESERVE_POLICY'); assert.equal(low.sent.length, 0, 'trava: nada enviado depois'); low.ex.close();
  const okb = build({ policy: { id: 'R-A-1.03' }, bound: () => need }); const r3 = await okb.ex.run(P(okb.store, 'a')); assert.equal(r3.stop, null); assert.equal(okb.sent.length, 1);
  const res = kinds(okb.dir).find((l) => l.kind === 'RESERVED')!.body as Record<string, unknown>; assert.deepEqual([res['reservePolicy'], res['policyBoundTokens'], res['extrapolated']], ['R-A-1.03', need, false], 'a politica aplicada fica registrada na reserva'); okb.ex.close();
});

test('padrao: SEM politica o executor se comporta como antes (limite L0+1 ja serve; nada de STOP_INPUT_RESERVE_POLICY) e L0 fora da faixa so para COM politica', async () => {
  const off = build({ bound: (L0) => (L0 as number) + 1 }); const r = await off.ex.run(P(off.store, 'a')); assert.equal(r.stop, null); assert.equal(off.sent.length, 1); off.ex.close();
  const tiny = build({ policy: { id: 'R-A-1.03' }, bound: () => 5000 }); const rt = await tiny.ex.run(P(tiny.store, 'tiny')); assert.equal(rt.stop, 'STOP_INPUT_RESERVE_POLICY'); assert.equal(tiny.sent.length, 0);
  assert.equal((kinds(tiny.dir).find((l) => l.kind === 'STOP_GLOBAL')!.body as Record<string, unknown>)['gate'], 'OUTSIDE_MEASURED_RANGE'); tiny.ex.close();
  const tinyAllow = build({ policy: { id: 'R-A-1.03', outsideMeasuredRange: 'ALLOW' }, bound: () => 5000 }); assert.equal((await tinyAllow.ex.run(P(tinyAllow.store, 'tiny'))).stop, null); tinyAllow.ex.close();
});

test('modelo fora da tabela: Haiku 4.5 (lista explicita) segue sem mudanca; modelo anthropic desconhecido (sim-haiku) e BARRADO pela politica (sem RESERVED/SENT); sem politica ambos seguem', async () => {
  const run = async (model: string, policy: ExecutorConfig['inputReservePolicy']) => {
    const dir = tmp('rsv2'); const store = memoryContentStore(TEXTS); const sent: BuiltRequest[] = [];
    const ex = createExecutor({ batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: pricesFor(dir, model), ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
      egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: async (req: BuiltRequest) => { sent.push(req); const r = rawBodyOf({ kind: 'ok', input: 10, output: 5 }); return { httpStatus: r.status, body: r.body }; }, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } },
      capPolicy: { inputUpperBoundTokens: (_p, L0) => (L0 as number) + 1, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40), inputReservePolicy: policy });
    const r = await ex.run(plan({ promptSha256: store.sha['a']!, promptId: 'A', modelRequested: model })); ex.close(); return { r, sent: sent.length, kinds: kinds(dir).map((l) => l.kind) };
  };
  const p45 = await run('claude-haiku-4-5-20251001', { id: 'R-A-1.05' }); assert.deepEqual([p45.r.stop, p45.sent], [null, 1]);
  const unk = await run('sim-haiku', { id: 'R-A-1.05' }); assert.deepEqual([unk.r.stop, unk.sent], ['STOP_INPUT_RESERVE_POLICY', 0]); assert.equal(unk.kinds.includes('RESERVED'), false);
  const off = await run('sim-haiku', undefined); assert.deepEqual([off.r.stop, off.sent], [null, 1]);
});
