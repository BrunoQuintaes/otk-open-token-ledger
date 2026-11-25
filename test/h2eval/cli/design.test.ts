/**
 * Tests that output-token limits and the reasoning ("thinking") policy of each model come from the design-parameters
 * file, reach the request bodies correctly, and change the plan's protocol hash.
 *
 * Modules under test: `scripts/h2eval/design/designParams.ts` (`loadDesignParams`, `thinkingSupport`, the default
 * file), `scripts/h2eval/cli/plan.ts` (`buildPlan`), `scripts/h2eval/cli/freeze.ts`, the per-API adapters in
 * `scripts/h2eval/modal/` and the content store.
 *
 * Strategy / partitions: the default design file reproduces the constants previously hard-coded in the planner,
 * and the support matrix is documented; the default plan's request bodies per model; an alternative design (thinking
 * disabled and a higher output cap) giving a different body, a lower cost cap and a different protocol hash; an
 * undocumented model and policy combination (exit 3) and an invalid file (exit 4); and the usage parser's
 * reasoning count with thinking off or adaptive.
 *
 * Needs: a writable temporary directory and a synthetic corpus frozen in the `setup` test (allow up to 5 minutes).
 * No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/design.test.ts`
 *
 * @module test/h2eval/cli/design.test
 */
// SYNTHETIC — OFFLINE. VNEXT-2 (C151 item 2): maxTokens and the reasoning policy come from a design-parameters file (h2eval.design_params.v1),
// never from constants in plan.ts; the file's sha256 is part of protocolHash. Anthropic: policy OFF on Haiku 5.5 sends thinking: {type: "disabled"}
// (documented in runs/R17_REAL/H2_DIAG/docs/effort.html) and no output_config; ADAPTIVE sends output_config.effort. An undocumented model × policy
// (Gemini OFF, Haiku 4.5 ADAPTIVE, Haiku 5.5 MANUAL) is refused by `plan` with exit 3. VNEXT-6: D7 option A eligible positions are marked in the plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { CliError, EXIT } from '../../../scripts/h2eval/cli/common.js';
import { createContentStore } from '../../../scripts/h2eval/cache/contentStore.js';
import { ADAPTERS } from '../../../scripts/h2eval/modal/index.js';
import { loadDesignParams, thinkingSupport, DEFAULT_DESIGN_PARAMS_FILE, type DesignParams } from '../../../scripts/h2eval/design/designParams.js';

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-design-${p}-`));
const WORK = tmp('work'); const CORPUS = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg\n');
const H55 = 'claude-haiku-5-5'; const H45 = 'claude-haiku-4-5-20251001';
const base = (): DesignParams => JSON.parse(readFileSync(DEFAULT_DESIGN_PARAMS_FILE, 'utf8')) as DesignParams;
const designFile = (name: string, mut: (d: DesignParams) => void): string => { const d = base(); mut(d); const p = path.join(WORK, `${name}.json`); writeFileSync(p, JSON.stringify(d, null, 1)); return p; };
const bodyOfOp = async (plan: BatchPlan, model: string, pick = 0) => { const b = plan.batches.find((x) => x.model === model)!; const op = b.operations[pick]!; const store = createContentStore(CORPUS); return { op, body: ADAPTERS['anthropic.messages']!.buildRequest(op.plan as never, await store.get(op.plan.promptSha256)).body as Record<string, unknown> }; };

test('setup', { timeout: 300_000 }, () => { freezeCorpus({ out: CORPUS, seed: 151151, s2: 2, s3: 3, noRepoScan: true }); });

test('arquivo padrao R3_2 reproduz as constantes do d2c60a98 (256; 5.5 adaptive low/1024; 4.5 OFF/0; gpt OFF/0; gemini minimal/2048); matriz de suporte documentada', () => {
  const d = loadDesignParams();
  assert.equal(d.params.designId, 'R3_2-equivalent'); assert.match(d.sha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(d.params.perModel[H55], { maxTokens: 256, thinking: { policy: 'ADAPTIVE', effort: 'low' }, reasoningAllowanceTokens: 1024 });
  assert.deepEqual(d.params.perModel[H45], { maxTokens: 256, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 });
  assert.deepEqual(d.params.perModel['gemini-3.5-flash-lite'], { maxTokens: 256, thinking: { policy: 'MINIMAL', thinkingLevel: 'minimal' }, reasoningAllowanceTokens: 2048 });
  assert.ok(thinkingSupport(H55, { policy: 'OFF' }).ok && /effort\.html sha256 b069c61b/.test(thinkingSupport(H55, { policy: 'OFF' }).doc));
  assert.ok(thinkingSupport(H55, { policy: 'ADAPTIVE', effort: 'medium' }).ok);
  assert.ok(!thinkingSupport(H55, { policy: 'MANUAL', budgetTokens: 1024 }).ok);
  assert.ok(thinkingSupport(H45, { policy: 'MANUAL', budgetTokens: 1024 }).ok && !thinkingSupport(H45, { policy: 'ADAPTIVE', effort: 'low' }).ok);
  assert.ok(!thinkingSupport('gemini-3.5-flash-lite', { policy: 'OFF' }).ok && !thinkingSupport('gpt-4o-mini-2024-07-18', { policy: 'ADAPTIVE', effort: 'low' }).ok);
});

test('plano padrao: corpo do Haiku 5.5 = R17 (max_tokens 256, output_config effort low, sem thinking); Haiku 4.5 sem thinking nem output_config; D7 opcao A marcado no plano', { timeout: 300_000 }, async () => {
  const plan = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-DESIGN' });
  assert.equal(plan.policy.design.designId, 'R3_2-equivalent'); assert.equal(plan.policy.maxOutputTokensByModel[H55], 256);
  const { body } = await bodyOfOp(plan, H55);
  assert.deepEqual([body['max_tokens'], body['output_config'], 'thinking' in body, body['stream'], body['service_tier']], [256, { effort: 'low' }, false, false, 'standard_only']);
  const h45 = await bodyOfOp(plan, H45); assert.ok(!('thinking' in h45.body) && !('output_config' in h45.body));
  const b55 = plan.batches.find((b) => b.model === H55)!;
  const d7 = b55.operations.map((o) => `${o.plan.structure}:${o.d7.callIndex}:${o.d7.eligibleForHit}`);
  assert.ok(d7.filter((x) => x.startsWith('S1:')).every((x) => x.endsWith(':null:false')));
  assert.ok(d7.filter((x) => x.startsWith('S2:')).every((x) => x.endsWith(':false')));
  assert.deepEqual(d7.filter((x) => x.startsWith('S3:')).map((x) => x.split(':').slice(1).join(':')), ['1:false', '2:true', '3:true', '1:false', '2:true', '3:true', '1:false', '2:true', '3:true']);
  assert.equal(b55.operations.filter((o) => o.d7.eligibleForHit).length, 6, 'D7 opcao A: 6 posicoes elegiveis no piloto');
});

test('desenho OFF para o Haiku 5.5 (e teto 512): corpo com thinking {type: disabled}, sem output_config, max_tokens 512, folga 0 => teto de custo menor; protocolHash muda; CONFIRMATORY aceita 512 (nada hardcoded)', { timeout: 300_000 }, async () => {
  const off = designFile('off55', (d) => { d.designId = 'R4-candidate-OFF'; d.perModel[H55] = { maxTokens: 512, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 }; });
  const ref = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-DESIGN' });
  const plan = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-DESIGN', designParamsFile: off });
  assert.notEqual(plan.protocolHash, ref.protocolHash); assert.equal(plan.policy.design.designId, 'R4-candidate-OFF'); assert.equal(plan.policy.maxOutputTokensByModel[H55], 512);
  const { op, body } = await bodyOfOp(plan, H55);
  assert.deepEqual([body['max_tokens'], body['thinking'], 'output_config' in body], [512, { type: 'disabled' }, false]);
  assert.deepEqual([op.plan.params.thinking, op.plan.params.reasoning, op.reasoningAllowanceTokens], [{ mode: 'none' }, 'NONE', 0]);
  const refOp = ref.batches.find((b) => b.model === H55)!.operations[0]!;
  assert.ok(BigInt(op.costCapUsdPico) < BigInt(refOp.costCapUsdPico), 'teto: (512 + 0) x p_out < (256 + 1024) x p_out');
  assert.notEqual(op.bodySha256, refOp.bodySha256); assert.notEqual(op.operationId, refOp.operationId, 'operationId inclui o protocolHash, que agora inclui o desenho: planos de desenhos diferentes nunca se confundem no replay');
  const camp = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', unratifiedRehearsal: true, orderBySplit: true, studyId: 'H2EVAL-DESIGN', designParamsFile: off });
  assert.equal(camp.batches.find((b) => b.model === H55)!.operations[0]!.plan.params.maxTokens, 512);
  // Haiku 4.5 MANUAL (documented) => thinking enabled with budget
  const man = designFile('man45', (d) => { d.perModel[H45] = { maxTokens: 2048, thinking: { policy: 'MANUAL', budgetTokens: 1024 }, reasoningAllowanceTokens: 1024 }; });
  const pm = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-DESIGN', designParamsFile: man });
  assert.deepEqual((await bodyOfOp(pm, H45)).body['thinking'], { type: 'enabled', budget_tokens: 1024 });
});

test('combinacao modelo x politica nao documentada => plan recusa (exit 3 DESIGN_THINKING_UNDOCUMENTED); arquivo invalido => exit 4', () => {
  const cases: Array<[string, (d: DesignParams) => void, string, number]> = [
    ['gemini OFF', (d) => { d.perModel['gemini-3.5-flash-lite'] = { maxTokens: 256, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 }; }, 'DESIGN_THINKING_UNDOCUMENTED', EXIT.REFUSED_BY_POLICY],
    ['haiku 4.5 ADAPTIVE', (d) => { d.perModel[H45] = { maxTokens: 256, thinking: { policy: 'ADAPTIVE', effort: 'low' }, reasoningAllowanceTokens: 1024 }; }, 'DESIGN_THINKING_UNDOCUMENTED', EXIT.REFUSED_BY_POLICY],
    ['haiku 5.5 MANUAL', (d) => { d.perModel[H55] = { maxTokens: 2048, thinking: { policy: 'MANUAL', budgetTokens: 1024 }, reasoningAllowanceTokens: 1024 }; }, 'DESIGN_THINKING_UNDOCUMENTED', EXIT.REFUSED_BY_POLICY],
    ['gpt ADAPTIVE', (d) => { d.perModel['gpt-4o-mini-2024-07-18'] = { maxTokens: 256, thinking: { policy: 'ADAPTIVE', effort: 'low' }, reasoningAllowanceTokens: 1 }; }, 'DESIGN_THINKING_UNDOCUMENTED', EXIT.REFUSED_BY_POLICY],
    ['MANUAL budget >= maxTokens', (d) => { d.perModel[H45] = { maxTokens: 1024, thinking: { policy: 'MANUAL', budgetTokens: 1024 }, reasoningAllowanceTokens: 1024 }; }, 'DESIGN_PARAMS_INVALID', EXIT.PLAN_INVALID],
    ['OFF com folga != 0', (d) => { d.perModel[H45] = { maxTokens: 256, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 10 }; }, 'DESIGN_PARAMS_INVALID', EXIT.PLAN_INVALID],
    ['ADAPTIVE xhigh (fora do desenho)', (d) => { d.perModel[H55] = { maxTokens: 256, thinking: { policy: 'ADAPTIVE', effort: 'xhigh' as never }, reasoningAllowanceTokens: 1024 }; }, 'DESIGN_PARAMS_INVALID', EXIT.PLAN_INVALID],
    ['modelo ausente', (d) => { delete (d.perModel as Record<string, unknown>)[H45]; }, 'DESIGN_PARAMS_INVALID', EXIT.PLAN_INVALID],
    ['maxTokens 0', (d) => { d.perModel[H55].maxTokens = 0; }, 'DESIGN_PARAMS_INVALID', EXIT.PLAN_INVALID],
    ['d7 errado', (d) => { d.d7 = { option: 'B' as never, eligibleCalls: [2, 3] }; }, 'DESIGN_PARAMS_INVALID', EXIT.PLAN_INVALID],
    ['esquema', (d) => { (d as { schema: string }).schema = 'h2eval.design_params.v0'; }, 'DESIGN_PARAMS_SCHEMA', EXIT.PLAN_INVALID],
  ];
  for (const [name, mut, code, exit] of cases) {
    const f = designFile(`bad-${name.replace(/[^a-z0-9]/gi, '_')}`, mut);
    assert.throws(() => buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, designParamsFile: f }), (e: CliError) => e.code === code && e.exit === exit, name);
  }
});

test('parser: pedido com thinking desligado (thinkingRequested=false) e detalhe ausente => reasoning NOT_APPLICABLE, visivel = output_tokens; pedido adaptativo com detalhe ausente => UNKNOWN', () => {
  const body = { id: 'msg', type: 'message', model: 'claude-haiku-5-5', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, service_tier: 'standard' } };
  const off = ADAPTERS['anthropic.messages']!.parseUsage(body, { thinkingRequested: false }); assert.deepEqual([off.reasoning, off.outputVisible, off.outputTotal, off.completion], ['NOT_APPLICABLE', 40, 40, 'COMPLETE']);
  const on = ADAPTERS['anthropic.messages']!.parseUsage(body, { thinkingRequested: true }); assert.deepEqual([on.reasoning, on.outputVisible], ['UNKNOWN', 'UNKNOWN']);
  const dflt = ADAPTERS['anthropic.messages']!.parseUsage(body); assert.deepEqual([dflt.reasoning, dflt.outputVisible], ['UNKNOWN', 'UNKNOWN'], 'sem contexto, o 5.5 nunca presume desligado');
});
