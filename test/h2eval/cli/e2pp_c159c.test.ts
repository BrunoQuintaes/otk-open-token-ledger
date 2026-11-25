/**
 * Tests two fixes in campaign planning and pricing for the larger comparison models: holdout population selection
 * by a corpus mark, and a price table version that adds their cache prices.
 *
 * Modules under test: `scripts/h2eval/cli/plan.ts` (`buildPlan`, `capsOfProfile`), `scripts/h2eval/cli/run.ts`
 * (`runBatch`), `scripts/h2eval/cli/freeze.ts`, `scripts/h2eval/modal/pricing/pricing.ts` (`loadPriceTable`),
 * `priceTableFromModal` from `scripts/h2eval/index.ts` and `scripts/h2eval/record/cost.ts` (`computeCost`).
 *
 * Strategy / partitions: with the `r6mHoldout` mark, the larger models plan the whole training and validation blocks
 * and only the marked holdout units, while the smaller model is unchanged; an unmarked corpus keeps the previous
 * behaviour; negative controls (a unit without the mark, a mark outside the holdout, a manifest that disagrees, an
 * empty mark) make the plan refuse; the new price table equals the previous one plus only the new cache prices;
 * ex-post cost of a 5-minute cache write and a cache read is calculated, while a non-zero count without a price stays
 * `UNKNOWN`; and a full offline training batch with cache operations completes with calculated costs. The plan only
 * identifies holdout operations; nothing is sent.
 *
 * Needs: a writable temporary directory and a synthetic corpus frozen in the `setup` test (allow up to 5 minutes).
 * No paid call, no network, no credential.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/e2pp_c159c.test.ts`
 *
 * @module test/h2eval/cli/e2pp_c159c.test
 */
// SYNTHETIC — OFFLINE. E2'' (C159C Fase 4, Q04, 2026-11-13): testes dos dois defeitos corrigidos sobre o E2' 2ae955f4.
// G-1: o `plan` de CAMPANHA de Sonnet/Opus 5.5 respeita a populacao do R6-M (treino e validacao inteiros; do holdout SO as unidades com r6mHoldout=true no corpus);
//      Haiku nao muda; corpus sem marca = comportamento anterior declarado; marca incompleta, fora do holdout, divergente do manifesto ou vazia = recusa.
//      O plano so IDENTIFICA operacoes do holdout: nada e enviado aqui.
// E-1: tabela de precos v3 (v2 + precos de cache de Sonnet/Opus 5.5 da captura R08 pricing.html 96b086ac); v1/v2 intactas; o braco T5 (S3, cache 5m) passa a ter
//      custo CALCULATED no caminho completo (freeze -> plan -> runBatch offline); preco ausente continua UNKNOWN (parada segura).
// Sem chamada paga, sem rede, sem credencial, sem GO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, capsOfProfile, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { runBatch } from '../../../scripts/h2eval/cli/run.js';
import { CliError, sha256File } from '../../../scripts/h2eval/cli/common.js';
import { loadPriceTable } from '../../../scripts/h2eval/modal/pricing/pricing.js';
import { priceTableFromModal } from '../../../scripts/h2eval/index.js';
import { computeCost } from '../../../scripts/h2eval/record/cost.js';

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-e2pp-${p}-`));
const WORK = tmp('work'); const SHA = 'c'.repeat(40);
const DESIGN = path.join(process.cwd(), 'scripts/h2eval/design/R6_PILOT_DESIGN_PARAMS.json');
const PRICES = path.join(process.cwd(), 'scripts/h2eval/modal/pricing');
const SON = 'claude-sonnet-5-5'; const OPU = 'claude-opus-5-5'; const HAI = 'claude-haiku-5-5';
const BASE = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md');
const common = { preregFile: PREREG, phase: 'CONFIRMATORY' as const, orderBySplit: true, unratifiedRehearsal: true, studyId: 'H2EVAL-E2PP', designParamsFile: DESIGN, capsUsd: capsOfProfile('ciclo3_c158'), inputBoundFactor: 1.91, inputBoundExtraTokens: 37, maxCallsPerBatch: 60, now: () => '2026-11-13T12:00:00.000Z' };
const jl = (f: string) => readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
const wjl = (f: string, rows: unknown[]) => writeFileSync(f, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
type Unit = Record<string, unknown> & { split: string };
/**
 * copy of the synthetic corpus with the R6-M mark written on EVERY unit (jsonl and manifest); `markS1`/`markDlg` choose the r6mHoldout=true units; `tweak` corrupts on purpose
 *
 * @param name - Name of the copy's folder inside the test's temporary work directory.
 * @param markS1 - Decides, for the k-th holdout text prompt, whether it is marked `r6mHoldout: true`; units outside
 *   the holdout are always marked `false`.
 * @param markDlg - Same decision for the k-th holdout dialog.
 * @param tweak - Optional hook that corrupts the marked prompts, dialogs or manifest before they are written.
 * @returns The path of the marked corpus copy.
 */
function marked(name: string, markS1: (u: Unit, k: number) => boolean, markDlg: (u: Unit, k: number) => boolean, tweak?: (c: { s1: Unit[]; dlg: Unit[]; man: { s1: { prompts: Unit[] }; dialogs: Unit[] } }) => void): string {
  const dir = path.join(WORK, name); cpSync(BASE, dir, { recursive: true });
  const s1 = jl(path.join(dir, 's1_prompts.jsonl')) as Unit[]; const dlg = jl(path.join(dir, 'dialogs.jsonl')) as Unit[]; const man = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  let k = 0; const s1Mark = new Map(s1.map((u) => [u['promptId'] as string, u.split === 'holdout' && markS1(u, k++)]));
  let j = 0; const dMark = new Map(dlg.map((u) => [u['dialogId'] as string, u.split === 'holdout' && markDlg(u, j++)]));
  for (const u of s1) u['r6mHoldout'] = s1Mark.get(u['promptId'] as string); for (const u of dlg) u['r6mHoldout'] = dMark.get(u['dialogId'] as string);
  for (const u of man.s1.prompts) u.r6mHoldout = s1Mark.get(u.promptId); for (const u of man.dialogs) u.r6mHoldout = dMark.get(u.dialogId);
  tweak?.({ s1, dlg, man });
  wjl(path.join(dir, 's1_prompts.jsonl'), s1); wjl(path.join(dir, 'dialogs.jsonl'), dlg); writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(man, null, 2));
  return dir;
}
const ids = (p: BatchPlan, block?: string) => p.batches.filter((b) => !block || b.block === block).flatMap((b) => b.operations.map((x) => `${x.plan.promptId}|${x.plan.split}|${x.plan.rep}|${x.plan.structure}`)).sort();
const refusedWith = (code: string) => (e: unknown) => e instanceof CliError && e.code === code;

test('setup: corpus sintetico congelado (freeze) e preregistro sintetico', { timeout: 300_000 }, () => {
  freezeCorpus({ out: BASE, seed: 20261113, s2: 2, s3: 3, noRepoScan: true }); writeFileSync(PREREG, '# prereg SYNTHETIC e2pp\n');
});

test("G-1: com a marca r6mHoldout, Sonnet e Opus planejam treino e validacao INTEIROS e do holdout SO as unidades marcadas; Haiku igual ao do corpus sem marca", { timeout: 300_000 }, () => {
  const M = marked('m1', (_u, k) => k % 4 === 0, (u) => u['arm'] === 'S3_HITATTEMPT');
  const s1 = jl(path.join(M, 's1_prompts.jsonl')) as Unit[]; const dlg = jl(path.join(M, 'dialogs.jsonl')) as Unit[];
  const wantS1 = new Set(s1.filter((u) => u['r6mHoldout'] === true).map((u) => u['promptId'])); const wantD = new Set(dlg.filter((u) => u['r6mHoldout'] === true).map((u) => u['dialogId']));
  assert.ok(wantS1.size > 0 && wantD.size > 0 && wantS1.size < s1.filter((u) => u.split === 'holdout').length, 'marca parcial do holdout');
  const unmarkedHaiku = buildPlan({ ...common, corpusDir: BASE, models: [HAI] });
  for (const m of [SON, OPU] as const) {
    const before = buildPlan({ ...common, corpusDir: BASE, models: [m] }); const after = buildPlan({ ...common, corpusDir: M, models: [m] });
    assert.equal(before.r6mPopulation, undefined, 'corpus sem marca: sem r6mPopulation (comportamento anterior)');
    for (const blk of ['train', 'validation']) assert.deepEqual(ids(after, blk), ids(before, blk), `${m}: ${blk} inteiro e identico`);
    const hold = after.batches.filter((b) => b.block === 'holdout').flatMap((b) => b.operations);
    assert.ok(hold.length > 0 && hold.length < before.batches.filter((b) => b.block === 'holdout').reduce((a, b) => a + b.calls, 0), `${m}: holdout reduzido`);
    assert.ok(hold.every((o) => (o.plan.structure === 'S1' ? wantS1.has(o.plan.promptId) : wantD.has(o.plan.groupId))), `${m}: so unidades marcadas no holdout`);
    assert.deepEqual(new Set(hold.filter((o) => o.plan.structure === 'S1').map((o) => o.plan.promptId)), wantS1, `${m}: TODAS as unidades S1 marcadas`);
    assert.deepEqual(new Set(hold.filter((o) => o.plan.structure !== 'S1').map((o) => o.plan.groupId)), wantD, `${m}: TODOS os dialogos marcados (3 chamadas cada)`);
    assert.equal(hold.filter((o) => o.plan.structure !== 'S1').length, 3 * wantD.size);
    const r = after.r6mPopulation?.[m]; assert.ok(r, 'r6mPopulation registrada'); assert.deepEqual(r.holdoutUnitsPlanned, { s1: wantS1.size, dialogs: wantD.size }); assert.equal(r.holdoutCallsPlanned, hold.length); assert.equal(r.executesNothing, true);
    assert.equal(after.totals.anthropic.calls, ids(after).length);
  }
  const h = buildPlan({ ...common, corpusDir: M, models: [HAI] });
  assert.deepEqual(ids(h), ids(unmarkedHaiku), 'Haiku: mesmas operacoes (todo o holdout do R6-H)'); assert.equal(h.r6mPopulation, undefined);
  const both = buildPlan({ ...common, corpusDir: M, models: [HAI, SON] });
  assert.deepEqual(ids({ ...both, batches: both.batches.filter((b) => b.model === HAI) } as BatchPlan), ids(unmarkedHaiku), 'Haiku planejado junto com Sonnet tambem nao muda'); assert.deepEqual(Object.keys(both.r6mPopulation ?? {}), [SON]);
});

test('G-1: corpus SEM marca = comportamento anterior declarado (Sonnet = Haiku, sem r6mPopulation, byte a byte deterministico)', { timeout: 300_000 }, () => {
  const s = buildPlan({ ...common, corpusDir: BASE, models: [SON] }); const h = buildPlan({ ...common, corpusDir: BASE, models: [HAI] });
  assert.deepEqual(ids(s), ids(h)); assert.equal(s.r6mPopulation, undefined); assert.equal(JSON.stringify(buildPlan({ ...common, corpusDir: BASE, models: [SON] })), JSON.stringify(s));
});

test('G-1 controles negativos: marca faltando numa unidade, marca fora do holdout, manifesto divergente e marca vazia => plano RECUSADO (Sonnet e Opus); Haiku nao le a marca', { timeout: 300_000 }, () => {
  const missing = marked('neg-missing', (_u, k) => k % 3 === 0, () => true, (c) => { delete c.s1[0]!['r6mHoldout']; });
  const outside = marked('neg-outside', (_u, k) => k % 3 === 0, () => true, (c) => { const t = c.s1.find((u) => u.split === 'train')!; t['r6mHoldout'] = true; const mt = c.man.s1.prompts.find((u) => u['promptId'] === t['promptId'])!; mt['r6mHoldout'] = true; });
  const mismatch = marked('neg-mismatch', (_u, k) => k % 3 === 0, () => true, (c) => { const u = c.man.s1.prompts.find((x) => x.split === 'holdout' && x['r6mHoldout'] === false)!; u['r6mHoldout'] = true; });
  const mismatchDlg = marked('neg-mismatch-dlg', (_u, k) => k % 3 === 0, () => true, (c) => { const u = c.man.dialogs.find((x) => x.split === 'holdout')!; u['r6mHoldout'] = !u['r6mHoldout']; });
  const empty = marked('neg-empty', () => false, () => false);
  for (const m of [SON, OPU]) {
    assert.throws(() => buildPlan({ ...common, corpusDir: missing, models: [m] }), refusedWith('R6M_HOLDOUT_MARK_MISSING'));
    assert.throws(() => buildPlan({ ...common, corpusDir: outside, models: [m] }), refusedWith('R6M_HOLDOUT_MARK_OUTSIDE_HOLDOUT'));
    assert.throws(() => buildPlan({ ...common, corpusDir: mismatch, models: [m] }), refusedWith('R6M_HOLDOUT_MARK_MISMATCH'));
    assert.throws(() => buildPlan({ ...common, corpusDir: mismatchDlg, models: [m] }), refusedWith('R6M_HOLDOUT_MARK_MISMATCH'));
    assert.throws(() => buildPlan({ ...common, corpusDir: empty, models: [m] }), refusedWith('R6M_HOLDOUT_EMPTY'));
  }
  for (const d of [missing, outside, mismatch, empty]) assert.doesNotThrow(() => buildPlan({ ...common, corpusDir: d, models: [HAI] }), 'Haiku: a marca nao entra no plano dele');
});

test('E-1: tabela v3 = v2 + SO os precos de cache de Sonnet/Opus 5.5 (R08 pricing.html 96b086ac); v1 e v2 intactas; demais modelos iguais; ativa = v3', () => {
  const v2 = JSON.parse(readFileSync(path.join(PRICES, 'price_table_h2eval_v2.json'), 'utf8')); const v3 = JSON.parse(readFileSync(path.join(PRICES, 'price_table_h2eval_v3.json'), 'utf8'));
  assert.equal(sha256File(path.join(PRICES, 'price_table_h2eval_v1.json')), 'b7a9a2d6f0c55ad6a75d341e1a6cf634ee9d3bc7eb61c9b8130e7751dbeb3a91');
  assert.equal(sha256File(path.join(PRICES, 'price_table_h2eval_v2.json')), '780505d5808da7d226455e4a2aff62931cf600d72d934f18fc4a07f515ff9ca0');
  assert.equal(v3.version, 'h2eval-v3-2026-11-13'); assert.equal(v3.source.v3_delta.base_v2_sha256, '780505d5808da7d226455e4a2aff62931cf600d72d934f18fc4a07f515ff9ca0'); assert.equal(v3.source.v3_delta.evidence.sha256, '96b086acd8827d84b293ab83782d21edbbd9aa6fd3622e13d2a77828a30121ec');
  for (const m of Object.keys(v2.models)) if (m !== SON && m !== OPU) assert.deepEqual(v3.models[m], v2.models[m], `${m} inalterado`);
  const p = (t: typeof v3, m: string) => t.models[m].tiers[0].prices;
  assert.deepEqual([p(v3, SON).cacheWrite5m, p(v3, SON).cacheWrite1h, p(v3, SON).cacheRead], ['2500000', '4000000', '100000'], 'Sonnet 5.5: $2.50 / $4 / $0.10 por MTok');
  assert.deepEqual([p(v3, OPU).cacheWrite5m, p(v3, OPU).cacheWrite1h, p(v3, OPU).cacheRead], ['5000000', '8000000', '200000'], 'Opus 5.5: $5 / $8 / $0.20 por MTok');
  for (const m of [SON, OPU]) {
    assert.equal(v3.models[m].tiers.length, 1, 'sem faixa por comprimento de prompt');
    for (const k of ['input', 'output', 'reasoning']) assert.equal(p(v3, m)[k], p(v2, m)[k], `${m}.${k} inalterado`);
    for (const k of ['cacheWrite', 'imageTokens', 'audioTokens']) assert.equal(p(v3, m)[k], null, `${m}.${k} continua null (nunca inventado nem zero)`);
  }
  assert.equal(loadPriceTable().table.version, 'h2eval-v3-2026-11-13'); assert.equal(priceTableFromModal().id, 'h2eval-v3-2026-11-13');
});

test('E-1: custo ex-post de uma escrita de cache 5m e de uma leitura (Sonnet e Opus) = CALCULATED com o preco documentado; contagem nao-zero sem preco continua UNKNOWN', () => {
  const prices = priceTableFromModal();
  const usage = (o: Partial<Record<string, unknown>>) => ({ schema: 'h2eval.usage.v0', inputUncached: 12, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0, outputVisible: 24, reasoning: 0, imageUnits: 'NOT_APPLICABLE', audioUnits: 'NOT_APPLICABLE', toolTokens: 'NOT_APPLICABLE', U: 0, usageCompleteness: 'COMPLETE', usageSource: 'provider_response', ...o }) as never;
  const cost = (model: string, u: never) => computeCost(prices, { provider: 'anthropic', model, api: 'anthropic.messages', usage: u, atUtc: '2026-11-13T12:00:00.000Z', capUsd: '999999999999999', prefixTokens: 'UNKNOWN', possiblyCharged: false });
  for (const [m, pin, w5, rd, pout] of [[SON, 2_000_000n, 2_500_000n, 100_000n, 10_000_000n], [OPU, 4_000_000n, 5_000_000n, 200_000n, 20_000_000n]] as const) {
    const w = cost(m, usage({ cacheWrite5m: 4789, cacheWrite: 4789, U: 4801 })); assert.equal(w.state, 'CALCULATED', `${m}: escrita`); assert.equal(w.usd, (12n * pin + 4789n * w5 + 24n * pout).toString());
    const r = cost(m, usage({ inputUncached: 40, cacheRead: 4789, U: 4829 })); assert.equal(r.state, 'CALCULATED', `${m}: leitura`); assert.equal(r.usd, (40n * pin + 4789n * rd + 24n * pout).toString());
    const unk = cost(m, usage({ cacheRead: 'UNKNOWN', U: 'UNKNOWN' })); assert.equal(unk.state, 'UNKNOWN', `${m}: contagem UNKNOWN continua UNKNOWN`); assert.equal(unk.usd, 'UNKNOWN');
  }
  const nullPrice = computeCost(prices, { provider: 'openai', model: 'gpt-4o-mini-2024-07-18', api: 'openai.chat_completions', usage: usage({ cacheWrite: 128, cacheWrite5m: 'NOT_APPLICABLE', cacheWrite1h: 'NOT_APPLICABLE' }), atUtc: '2026-11-13T12:00:00.000Z', capUsd: '999999999999999', prefixTokens: 'UNKNOWN', possiblyCharged: true });
  assert.equal(nullPrice.state, 'UNKNOWN', 'preco null (escrita de cache do gpt-4o-mini) com contagem > 0: UNKNOWN, nunca zero');
});

for (const m of [SON, OPU] as const) {
  test(`E-1 caminho completo ${m}: o lote de treino com operacoes T5 (S3, cache 5m) roda inteiro offline; escrita e leituras de cache com custo CALCULATED; nenhuma parada`, { timeout: 300_000 }, async () => {
    const plan = buildPlan({ ...common, corpusDir: BASE, models: [m] }); const planFile = path.join(WORK, `plan-t5-${m}.json`); writePlan(plan, planFile); const camp = tmp(`t5-${m}`);
    const train = plan.batches.filter((b) => b.block === 'train'); const withS3 = train.findIndex((b) => b.operations.some((o) => o.plan.structure === 'S3')); assert.ok(withS3 >= 0, 'ha lote de treino com S3');
    for (const b of train.slice(0, withS3 + 1)) {
      const s = await runBatch({ planFile, batchId: b.batchId, batchDir: path.join(camp, 'batches', b.batchId), mode: 'offline', executorCodeSha: SHA, campaignDir: camp });
      assert.equal(s.stoppedBy, null, `${b.batchId}: sem parada (no E2' a 1a escrita de cache parava com STOP_UNCERTAIN)`); assert.equal(s.executed, b.calls);
    }
    const b = train[withS3]!; const s3 = new Set(b.operations.filter((o) => o.plan.structure === 'S3').map((o) => o.operationId)); const dir = path.join(camp, 'batches', b.batchId, 'records');
    const recs = readdirSync(dir).map((f) => JSON.parse(readFileSync(path.join(dir, f), 'utf8')) as { operationId: string; usage: { cacheWrite5m: number; cacheRead: number }; cost: { state: string; byCategory: Record<string, string> } }).filter((r) => s3.has(r.operationId));
    assert.equal(recs.length, s3.size); assert.ok(recs.every((r) => r.cost.state === 'CALCULATED'), 'todas as operacoes T5 com custo CALCULATED');
    const w5 = m === SON ? 2_500_000n : 5_000_000n; const rd = m === SON ? 100_000n : 200_000n;
    const writes = recs.filter((r) => r.usage.cacheWrite5m > 0); const reads = recs.filter((r) => r.usage.cacheRead > 0);
    assert.ok(writes.length >= 1 && reads.length >= 1, 'houve escrita e leitura de cache simuladas');
    for (const r of writes) assert.equal(r.cost.byCategory['cacheWrite'], (BigInt(r.usage.cacheWrite5m) * w5).toString(), 'escrita 5m ao preco documentado');
    for (const r of reads) assert.equal(r.cost.byCategory['cacheRead'], (BigInt(r.usage.cacheRead) * rd).toString(), 'leitura ao preco documentado');
  });
}
