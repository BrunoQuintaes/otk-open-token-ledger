/**
 * Tests that campaign plans for the two newer comparison models resolve their text-corpus operations correctly and
 * that their per-model design entries are validated.
 *
 * Modules under test: `scripts/h2eval/cli/plan.ts` (`buildPlan`, `s1CorpusIdOf`, `capsOfProfile`),
 * `scripts/h2eval/cli/freeze.ts` (`freezeCorpus`) and `scripts/h2eval/design/designParams.ts`.
 *
 * Strategy / partitions: a model without its own corpus id reuses the full list of the older model of the same
 * provider (same operations and splits); a model with neither an id nor an alias yields `null` and an explicit stop
 * code instead of reading a file named after `undefined`; the design model list includes the newer models as
 * optional entries that are validated when declared, while older designs stay valid. Each regression test is
 * labelled with the commit on which it failed before the fix.
 *
 * Needs: a writable temporary directory (a synthetic corpus and preregistration are written there) and the
 * working directory at the repository root (it reads `scripts/h2eval/design/R6_PILOT_DESIGN_PARAMS.json` and the
 * text of `scripts/h2eval/cli/plan.ts`). No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/armCampaignPlan.test.ts`
 *
 * @module test/h2eval/cli/armCampaignPlan.test
 */
// SYNTHETIC — OFFLINE. C160 E3G3 (B1 e B2 do PROTO-GO), sobre o E3G2 5d9dbf88.
// B1: um plano de CAMPANHA para gemini-3.1-flash-lite / gpt-6-luna lia s1_operations.undefined.jsonl (sem alias de corpus). Agora cada modelo do braco usa a
// lista FULL do modelo legado do MESMO provedor (gemini-3.5-flash-lite / gpt-4o-mini); modelo sem id nem alias => STOP explicito S1_CORPUS_ALIAS_MISSING.
// B2: DESIGN_MODELS inclui os dois modelos do braco (opcionais: desenhos antigos seguem validos); quando declarados, sao VALIDADOS (politica do contrato E3G).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, capsOfProfile, s1CorpusIdOf } from '../../../scripts/h2eval/cli/plan.js';
import { DESIGN_MODELS, OPTIONAL_DESIGN_MODELS, loadDesignParams, validateDesignParams } from '../../../scripts/h2eval/design/designParams.js';
import { MATRIX_MODELS } from '../../../scripts/h2eval/index.js';

const WORK = mkdtempSync(path.join(tmpdir(), 'h2eval-armplan-')); const CORPUS = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg');
const BASE = JSON.parse(readFileSync(path.join(process.cwd(), 'scripts/h2eval/design/R6_PILOT_DESIGN_PARAMS.json'), 'utf8'));
const OFF = (r: string) => ({ enabled: false, reason: r });
const ONLY_T1_T3 = { T2: OFF('sintetico: so T1/T3'), T4: OFF('sintetico: so T1/T3'), T5: OFF('sintetico: so T1/T3') };
const GEM = { maxTokens: 1024, thinking: { policy: 'MINIMAL', thinkingLevel: 'minimal' }, reasoningAllowanceTokens: 1024, arms: ONLY_T1_T3 };
const LUNA = { maxTokens: 8192, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0, arms: ONLY_T1_T3 };
function design(extra: Record<string, unknown>): Record<string, unknown> {
  const d = JSON.parse(JSON.stringify(BASE)); d.designId = 'E3G3-SYNTH'; d.perModel['gemini-3.5-flash-lite'].arms = ONLY_T1_T3; d.perModel['gpt-4o-mini-2024-07-18'].arms = ONLY_T1_T3; Object.assign(d.perModel, extra); return d;
}
const designFile = (name: string, d: Record<string, unknown>) => { const f = path.join(WORK, name); writeFileSync(f, JSON.stringify(d)); return f; };
const code = (f: () => unknown): string => { try { f(); return 'OK'; } catch (e) { return String((e as { code?: string }).code ?? e); } };

test('[FALHA NO 5d9dbf88] E3G3 B1: plano de CAMPANHA para gemini-3.1-flash-lite e gpt-6-luna usa a lista do legado do mesmo provedor (mesmas operacoes e splits), cada operacao com o modelo do braco', { timeout: 300_000 }, () => {
  freezeCorpus({ out: CORPUS, seed: 20261116, s2: 2, s3: 3, noRepoScan: true });
  const D = designFile('design_arm.json', design({ 'gemini-3.1-flash-lite': GEM, 'gpt-6-luna': LUNA }));
  const common = { corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY' as const, orderBySplit: true, unratifiedRehearsal: true, studyId: 'H2EVAL-E3G3-PLAN', designParamsFile: D, inputBoundFactor: 1.91, inputBoundExtraTokens: 37, maxCallsPerBatch: 36 };
  const ids = (p: ReturnType<typeof buildPlan>) => p.batches.flatMap((b) => b.operations.map((x) => `${x.plan.promptId}|${x.plan.split}|${x.plan.rep}|${x.plan.cellId}`)).sort();
  for (const [arm, legacy, prof, prov] of [['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'braco_go_google', 'google'], ['gpt-6-luna', 'gpt-4o-mini-2024-07-18', 'braco_go_openai', 'openai']] as const) {
    const a = buildPlan({ ...common, capsUsd: capsOfProfile(prof), models: [arm] }); const l = buildPlan({ ...common, capsUsd: capsOfProfile('ciclo3_c158'), models: [legacy] });
    assert.ok(ids(a).length > 0, arm); assert.deepEqual(ids(a), ids(l), `${arm}: mesma lista de operacoes e splits do ${legacy}`);
    assert.ok(a.batches.every((b) => b.model === arm && b.provider === prov && b.operations.every((x) => x.plan.modelRequested === arm)), arm);
    assert.deepEqual([...new Set(a.batches.map((b) => b.block))].sort(), ['holdout', 'train', 'validation'], arm);
    assert.ok(a.batches.every((b) => b.operations.every((x) => x.plan.task === 'summary' || x.plan.task === 'analysis')), `${arm}: so T1/T3`);
    assert.ok(a.batches.every((b) => b.operations.every((x) => x.plan.params.maxTokens === (arm === 'gpt-6-luna' ? 8192 : 1024))), `${arm}: teto do desenho`);
    assert.equal(buildPlan({ ...common, capsUsd: capsOfProfile(prof), models: [arm] }).protocolHash, a.protocolHash, `${arm}: deterministico`);
  }
});

test('[FALHA NO 5d9dbf88] E3G3 B1: modelo sem id de corpus nem alias => null / STOP explicito S1_CORPUS_ALIAS_MISSING (nunca s1_operations.undefined.jsonl)', () => {
  assert.equal(s1CorpusIdOf('gemini-3.1-flash-lite'), 'gemini-3.5-flash-lite'); assert.equal(s1CorpusIdOf('gpt-6-luna'), 'gpt-4o-mini');
  assert.equal(s1CorpusIdOf('claude-sonnet-5-5'), 'claude-haiku-5-5'); assert.equal(s1CorpusIdOf('claude-opus-5-5'), 'claude-haiku-5-5');
  assert.equal(s1CorpusIdOf('gpt-4o-mini-2024-07-18'), 'gpt-4o-mini'); assert.equal(s1CorpusIdOf('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  for (const m of ['gemini-3.1-flash-lite-preview', 'GPT-6-LUNA', 'undefined', '', 'toString', '__proto__', 'constructor', 'gpt-6']) assert.equal(s1CorpusIdOf(m), null, m);
  for (const m of [...MATRIX_MODELS, 'gemini-3.1-flash-lite', 'gpt-6-luna']) assert.notEqual(s1CorpusIdOf(m), null, m);
  const D = designFile('design_fake.json', design({ 'gemini-3.1-flash-lite': GEM, 'gpt-6-luna': LUNA, 'modelo-sem-alias': LUNA }));
  const r = code(() => buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', orderBySplit: true, unratifiedRehearsal: true, designParamsFile: D, capsUsd: capsOfProfile('braco_go_openai'), models: ['modelo-sem-alias' as never], maxCallsPerBatch: 36 }));
  assert.equal(r, 'S1_CORPUS_ALIAS_MISSING', 'STOP explicito; nunca procurar arquivo com nome inventado (S1_OPERATIONS_MISSING)');
  const src = readFileSync(path.join(process.cwd(), 'scripts/h2eval/cli/plan.ts'), 'utf8'); assert.ok(!/CORPUS_OPS_ALIAS\[model\]!/.test(src), 'sem asserção não-nula sobre o alias');
  assert.ok(/if \(corpusId === null\) throw new CliError\(EXIT\.PLAN_INVALID, 'S1_CORPUS_ALIAS_MISSING'/.test(src), 'STOP explicito antes de montar o caminho');
});

test('[FALHA NO 5d9dbf88] E3G3 B2: DESIGN_MODELS inclui os modelos do braco (opcionais) e o desenho deles e validado; desenhos antigos seguem validos', () => {
  for (const m of ['gemini-3.1-flash-lite', 'gpt-6-luna']) { assert.ok(DESIGN_MODELS.includes(m as never), m); assert.ok((OPTIONAL_DESIGN_MODELS as readonly string[]).includes(m), m); }
  assert.equal(code(() => loadDesignParams(path.join(process.cwd(), 'scripts/h2eval/design/R6_PILOT_DESIGN_PARAMS.json'))), 'OK', 'desenho sem o braco segue valido');
  assert.equal(code(() => validateDesignParams(design({ 'gemini-3.1-flash-lite': GEM, 'gpt-6-luna': LUNA }))), 'OK');
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ['gemini OFF', { 'gemini-3.1-flash-lite': { ...GEM, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0, arms: {} } }, 'DESIGN_THINKING_UNDOCUMENTED'],
    ['gemini MINIMAL/low', { 'gemini-3.1-flash-lite': { ...GEM, thinking: { policy: 'MINIMAL', thinkingLevel: 'low' }, arms: {} } }, 'DESIGN_THINKING_UNDOCUMENTED'],
    ['gemini ADAPTIVE', { 'gemini-3.1-flash-lite': { ...GEM, thinking: { policy: 'ADAPTIVE', effort: 'low' }, arms: {} } }, 'DESIGN_THINKING_UNDOCUMENTED'],
    ['gemini braco T3 OFF', { 'gemini-3.1-flash-lite': { ...GEM, arms: { ...ONLY_T1_T3, T3: { thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 } } } }, 'DESIGN_THINKING_UNDOCUMENTED'],
    ['gemini sem franquia', { 'gemini-3.1-flash-lite': { ...GEM, reasoningAllowanceTokens: 0, arms: {} } }, 'DESIGN_PARAMS_INVALID'],
    ['gemini maxTokens 0', { 'gemini-3.1-flash-lite': { ...GEM, maxTokens: 0 } }, 'DESIGN_PARAMS_INVALID'],
    ['luna ADAPTIVE', { 'gpt-6-luna': { ...LUNA, thinking: { policy: 'ADAPTIVE', effort: 'low' }, reasoningAllowanceTokens: 512, arms: {} } }, 'DESIGN_THINKING_UNDOCUMENTED'],
    ['luna MANUAL', { 'gpt-6-luna': { ...LUNA, thinking: { policy: 'MANUAL', budgetTokens: 2048 }, reasoningAllowanceTokens: 2048, arms: {} } }, 'DESIGN_THINKING_UNDOCUMENTED'],
    ['luna OFF com franquia', { 'gpt-6-luna': { ...LUNA, reasoningAllowanceTokens: 512, arms: {} } }, 'DESIGN_PARAMS_INVALID'],
    ['luna maxTokens 200000', { 'gpt-6-luna': { ...LUNA, maxTokens: 200_000 } }, 'DESIGN_PARAMS_INVALID'],
    ['luna sem thinking', { 'gpt-6-luna': { maxTokens: 8192, reasoningAllowanceTokens: 0 } }, 'DESIGN_PARAMS_INVALID'],
    ['luna braco desconhecido', { 'gpt-6-luna': { ...LUNA, arms: { T9: {} } } }, 'DESIGN_PARAMS_INVALID'],
  ];
  for (const [nome, extra, c] of bad) assert.equal(code(() => validateDesignParams(design(extra))), c, nome);
});
