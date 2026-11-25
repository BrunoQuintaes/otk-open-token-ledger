/**
 * Tests the explicit split plan for corpus freezing and the per-condition operations of the confirmatory phase,
 * including the offline pause at the probe gate.
 *
 * Modules under test: `scripts/h2eval/corpus/split.ts` (`assignSplitsCounts`), `scripts/h2eval/corpus/manifest.ts`
 * (`validateSplitPlan`), `scripts/h2eval/cli/freeze.ts`, `scripts/h2eval/cli/plan.ts`, `scripts/h2eval/cli/run.ts`
 * (`runAuthorized`) and `scripts/h2eval/cli/campaign.ts` (`writeGateP1`, `writeGateG17`).
 *
 * Strategy / partitions: exact, seed-deterministic split counts; a split plan with requested counts per cell and
 * dialog arm (0 means left out), capped repetitions and pilot groups, against no plan (byte-identical corpus); the
 * confirmatory design with two conditions for one arm (one operation per condition, the probe first, an offline run
 * that pauses at the probe gate and continues only after that gate is written) against no conditions (unchanged
 * plan); and golden regressions against earlier plans.
 *
 * Needs: a writable temporary directory; sets `H2EVAL_CONTROL_DIR` to a temporary folder when unset; uses the local
 * text counters. The golden regression tests read files from fixed local folders and are skipped, visibly, when
 * they are absent. No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/cycle2prep2.test.ts`
 *
 * @module test/h2eval/cli/cycle2prep2.test
 */
// SYNTHETIC — OFFLINE. C154 / R5 rev. 3: (1) `freeze-corpus --split-plan`: composicao EXPLICITA por celula e por braco de dialogo (grupos por
// split; celula/braco com soma 0 fora; pilotGroupsPerCell; --repeats-per-cell); sem o plano o corpus e byte-identico ao de antes (corpus_c2_candidate
// gerado por abf16a01). (2) `conditions` do desenho na fase CONFIRMATORY: cada operacao S1 dos bracos listados vai UMA vez por condicao, com
// `condition` e a sonda P1 na primeira da condicao da sonda; o executor (offline) pausa na sonda e so segue com gate-p1; sem conditions nada muda.
// (3) Regressao dourada SC1/P4B/P4C_R2 byte-identica.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { validateSplitPlan } from '../../../scripts/h2eval/corpus/manifest.js';
import { assignSplitsCounts } from '../../../scripts/h2eval/corpus/split.js';
import { runAuthorized, LEDGER_OPENING_FILE } from '../../../scripts/h2eval/cli/run.js';
import { writeGateP1, writeGateG17 } from '../../../scripts/h2eval/cli/campaign.js';
import { loadTextCounters, sha256File } from '../../../scripts/h2eval/cli/common.js';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';
import { syntheticMultiGo } from '../support/gomulti.js';

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-c154b-${p}-`));
const H55 = 'claude-haiku-5-5';
const NUCLEO = { cells: { 'summary-S': { train: 0, validation: 1, holdout: 2 }, 'summary-L': { train: 0, validation: 1, holdout: 2 }, 'code_fix-S': { train: 0, validation: 1, holdout: 2 }, 'code_fix-L': { train: 0, validation: 1, holdout: 2 }, 'code_gen-S': { train: 2, validation: 1, holdout: 2 }, 'code_gen-L': { train: 2, validation: 1, holdout: 2 }, 'analysis-S': { train: 0, validation: 0, holdout: 0 }, 'analysis-L': { train: 0, validation: 0, holdout: 0 } }, dialogs: { S2_NOHIT: { train: 0, validation: 1, holdout: 2 }, S3_HITATTEMPT: { train: 0, validation: 1, holdout: 2 } } };
const T3 = { cells: { 'analysis-S': { train: 2, validation: 0, holdout: 0 }, 'analysis-L': { train: 2, validation: 0, holdout: 0 } }, dialogs: { S2_NOHIT: { train: 0, validation: 0, holdout: 0 }, S3_HITATTEMPT: { train: 0, validation: 0, holdout: 0 } }, pilotGroupsPerCell: 2 };

test('assignSplitsCounts: contagens exatas, deterministico por semente, permutacao', () => {
  const a = assignSplitsCounts(1, 'S1|x', { train: 2, validation: 1, holdout: 3 }); assert.equal(a.length, 6); assert.deepEqual([a.filter((s) => s === 'train').length, a.filter((s) => s === 'validation').length, a.filter((s) => s === 'holdout').length], [2, 1, 3]);
  assert.deepEqual(assignSplitsCounts(1, 'S1|x', { train: 2, validation: 1, holdout: 3 }), a); assert.notDeepEqual(assignSplitsCounts(2, 'S1|x', { train: 2, validation: 1, holdout: 3 }), a);
  assert.deepEqual(assignSplitsCounts(1, 'S1|x', { train: 0, validation: 0, holdout: 0 }), []);
  assert.throws(() => assignSplitsCounts(1, 'S1|x', { train: -1, validation: 0, holdout: 0 }), RangeError);
  assert.throws(() => validateSplitPlan({ cells: { 'nope-S': { train: 1, validation: 0, holdout: 0 } } }), /celula desconhecida/);
  assert.throws(() => validateSplitPlan({ dialogs: { S9: { train: 1, validation: 0, holdout: 0 } } as never }), /braco desconhecido/);
  assert.throws(() => validateSplitPlan({ cells: { 'summary-S': { train: 1.5, validation: 0, holdout: 0 } } }), /inteiro/);
  assert.throws(() => validateSplitPlan({ pilotGroupsPerCell: 0 }), /pilotGroupsPerCell/);
});

test('freeze-corpus --split-plan: celulas e bracos com as contagens pedidas (0 = fora), repeticoes limitadas, pilotGroupsPerCell; manifest.params.splitPlan presente; corpusSha256 muda', { timeout: 600_000 }, () => {
  const WORK = tmp('corpus'); const spN = path.join(WORK, 'sp.nucleo.json'); writeFileSync(spN, JSON.stringify(NUCLEO)); const spT = path.join(WORK, 'sp.t3.json'); writeFileSync(spT, JSON.stringify(T3));
  const n = freezeCorpus({ out: path.join(WORK, 'n'), seed: 154201, noRepoScan: true, allowNotCompared: true, splitPlanFile: spN, repeatsPerCell: 0 });
  const mn = JSON.parse(readFileSync(path.join(WORK, 'n', 'manifest.json'), 'utf8'));
  assert.deepEqual(mn.params.splitPlan, NUCLEO); assert.equal(mn.params.repeatsPerCell, 0); assert.equal(mn.counts.s1Repeats, 0);
  assert.deepEqual(mn.splitSummary.s1GroupsBySplit, { train: 4, validation: 6, holdout: 12 });
  assert.deepEqual(mn.splitSummary.dialogsByArmAndSplit, { S2_NOHIT: { validation: 1, holdout: 2 }, S3_HITATTEMPT: { validation: 1, holdout: 2 } });
  const prompts = readFileSync(path.join(WORK, 'n', 's1_prompts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { cellId: string; phase: string; split: string });
  assert.equal(prompts.filter((p) => p.phase === 'CONFIRMATORY' && p.cellId.startsWith('analysis')).length, 0, 'celulas com soma 0 nao sao geradas');
  assert.equal(prompts.filter((p) => p.phase === 'CONFIRMATORY' && p.split === 'train').length, 4 * 3); assert.equal(prompts.filter((p) => p.phase === 'PILOT').length, 6, 'piloto padrao continua (6 celulas x 1 grupo)');
  const t = freezeCorpus({ out: path.join(WORK, 't'), seed: 154201, noRepoScan: true, allowNotCompared: true, splitPlanFile: spT, repeatsPerCell: 0 });
  const mt = JSON.parse(readFileSync(path.join(WORK, 't', 'manifest.json'), 'utf8'));
  assert.deepEqual(mt.splitSummary.s1GroupsBySplit, { train: 4 }); assert.deepEqual(mt.splitSummary.dialogsByArmAndSplit, {});
  const pt = readFileSync(path.join(WORK, 't', 's1_prompts.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { cellId: string; phase: string; groupId: string });
  assert.ok(pt.filter((p) => p.phase === 'CONFIRMATORY').every((p) => p.cellId.startsWith('analysis'))); assert.equal(pt.filter((p) => p.phase === 'PILOT').length, 12, 'pilotGroupsPerCell 2 x 6 celulas');
  assert.ok(pt.some((p) => p.groupId === 'PILOT-summary-S-g01'));
  assert.notEqual(n.corpusSha256, t.corpusSha256);
  // sem split plan: bytes identicos ao corpus gerado por abf16a01 (quando presente nesta maquina) e sem a chave splitPlan
  const golden = 'C:/otk-h2eval-runs/corpus_c2_candidate';
  const c = freezeCorpus({ out: path.join(WORK, 'c'), seed: 20261112, noRepoScan: true, allowNotCompared: true });
  const mc = JSON.parse(readFileSync(path.join(WORK, 'c', 'manifest.json'), 'utf8')); assert.ok(!('splitPlan' in mc.params));
  if (existsSync(golden)) {
    for (const f of ['s1_prompts.jsonl', 'dialogs.jsonl', 's1_operations.claude-haiku-5-5.jsonl']) assert.equal(sha256File(path.join(WORK, 'c', f)), sha256File(path.join(golden, f)), f);
    assert.equal(c.corpusSha256, JSON.parse(readFileSync(path.join(golden, 'manifest.json'), 'utf8')).corpusSha256); assert.deepEqual(readdirSync(path.join(WORK, 'c', 'content')).sort(), readdirSync(path.join(golden, 'content')).sort());
  }
});

test('conditions na fase CONFIRMATORY: T3 x 2 condicoes num plano unico (cellId~cond, condition, sonda P1 primeira); offline: PAUSE_PROBE_GATE -> gate-p1 -> tudo; sem conditions o plano e o de antes', { timeout: 900_000 }, async () => {
  const WORK = tmp('t3'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg\n');
  const spT = path.join(WORK, 'sp.t3.json'); writeFileSync(spT, JSON.stringify(T3)); const CORPUS = path.join(WORK, 'corpus');
  freezeCorpus({ out: CORPUS, seed: 154301, noRepoScan: true, allowNotCompared: true, splitPlanFile: spT, repeatsPerCell: 0 });
  const base = JSON.parse(readFileSync(path.resolve('scripts/h2eval/design/econ02/R4_DESIGN_R2_CAMPAIGN.v1.json'), 'utf8')) as { designId: string; perModel: Record<string, { arms: Record<string, Record<string, unknown>>; conditions?: unknown }>; expectedOpsPerSplit?: unknown };
  const t3 = JSON.parse(JSON.stringify(base)); t3.designId = 'T3-C154-synthetic'; const h = t3.perModel[H55]!;
  for (const a of ['T1', 'T2', 'T4', 'T5']) h.arms[a] = { ...(h.arms[a] ?? {}), enabled: false };
  h.arms['T3'] = { maxTokens: 2048, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 };
  h.conditions = { appliesToArms: ['T3'], list: [{ conditionId: 'OFF2048', maxTokens: 2048, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 }, { conditionId: 'ONLOW4096', maxTokens: 4096, thinking: { policy: 'ADAPTIVE', effort: 'low' }, reasoningAllowanceTokens: 1024 }], probe: { conditionId: 'OFF2048', rule: 'P1' } };
  t3.expectedOpsPerSplit = { [H55]: { T3: { train: 24 } } };
  const dT3 = path.join(WORK, 'design.t3.json'); writeFileSync(dT3, JSON.stringify(t3));
  const plan = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', unratifiedRehearsal: true, orderBySplit: true, studyId: 'H2EVAL-T3-C154', models: [H55], designParamsFile: dT3 });
  const ops = plan.batches.flatMap((b) => b.operations); assert.equal(ops.length, 24, '4 grupos x 3 variantes x 2 condicoes'); assert.ok(plan.batches.every((b) => b.block === 'train'));
  assert.equal(ops.filter((o) => o.plan.condition === 'OFF2048').length, 12); assert.equal(ops.filter((o) => o.plan.condition === 'ONLOW4096').length, 12);
  assert.ok(ops.every((o) => o.plan.task === 'analysis' && /~(OFF2048|ONLOW4096)$/.test(o.plan.cellId)));
  assert.deepEqual(ops.filter((o) => o.plan.probe === 'P1').map((o) => o.plan.condition), ['OFF2048']); assert.equal(ops[0]!.plan.probe, 'P1', 'a sonda e a primeira operacao');
  assert.equal(ops.find((o) => o.plan.condition === 'ONLOW4096')!.plan.params.maxTokens, 4096); assert.equal(ops.find((o) => o.plan.condition === 'OFF2048')!.plan.params.maxTokens, 2048);
  assert.ok(plan.policy.design.opsCheck.filter((r) => r.model === H55 && r.arm === 'T3').every((r) => r.match), JSON.stringify(plan.policy.design.opsCheck));
  assert.deepEqual(plan.policy.design.conditions[H55], ['OFF2048', 'ONLOW4096']); assert.equal(plan.policy.design.probe?.conditionId, 'OFF2048');
  assert.equal(new Set(ops.map((o) => o.operationId)).size, 24, 'operationIds distintos por condicao');
  // sem conditions: mesmo corpus, so T3, 12 ops sem campo condition (como antes)
  const plain = JSON.parse(JSON.stringify(t3)); delete plain.perModel[H55].conditions; plain.expectedOpsPerSplit = { [H55]: { T3: { train: 12 } } }; const dP = path.join(WORK, 'design.plain.json'); writeFileSync(dP, JSON.stringify(plain));
  const p2 = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', unratifiedRehearsal: true, orderBySplit: true, studyId: 'H2EVAL-T3-C154', models: [H55], designParamsFile: dP });
  const o2 = p2.batches.flatMap((b) => b.operations); assert.equal(o2.length, 12); assert.ok(o2.every((o) => o.plan.condition === undefined && o.plan.probe === undefined)); assert.ok(p2.policy.design.opsCheck.every((r) => r.match));
  // offline: a sonda roda sozinha e pausa; depois do gate-p1 o lote completa (24 - 1)
  process.env['H2EVAL_CONTROL_DIR'] ??= mkdtempSync(path.join(tmpdir(), 'h2eval-c154b-control-'));
  const S = path.join(WORK, 'estudo'); mkdirSync(S, { recursive: true }); const PLAN = path.join(WORK, 'plan.json'); writePlan(plan, PLAN);
  const rest = { schema: 'h2eval.ledger_opening.v1' as const, fromStudy: { label: 'synthetic', ledgerSha256: '7'.repeat(64), closedUtc: '2026-11-11T00:00:00.000Z' }, providers: { anthropic: { settledUsd: '0.1', uncertainUsd: '0' } }, signedBy: 'human:SYNTHETIC' };
  writeFileSync(path.join(S, LEDGER_OPENING_FILE), JSON.stringify({ ...rest, digestSha256: sha256Canon(rest) }));
  const SHA = 'c'.repeat(40); const PH = '1'.repeat(64); const go = path.join(WORK, 'go.json'); writeFileSync(go, syntheticMultiGo(plan, plan.batches.map((b) => b.batchId), { executorCodeSha: SHA, campaignDir: S, nonceSeed: 't3', pilotProtocolHash: PH }));
  writeGateG17(S, { model: H55, verdict: 'PASS', pilotProtocolHash: PH, signedBy: 'human:SYNTHETIC', atUtc: 'x', note: 'synthetic' }); // lotes de campanha exigem G17 + pilot hash (R15-G-3)
  const counters = loadTextCounters()!; const offline = { realism: { inputTokenFactor: 1.5, thinkingConsumesCapOnSingleTurnNoSystem: true }, tokensOf: counters.cl100k_base, outputTokens: 300 };
  const r1 = await runAuthorized({ planFile: PLAN, goFile: go, campaignDir: S, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, offline, pilotProtocolHash: PH });
  assert.deepEqual([r1.haltReason, r1.attemptsThisRun], ['PAUSE_PROBE_GATE', 1]);
  writeGateP1(S, { model: H55, verdict: 'PASS', probeOperationId: plan.policy.design.probe!.operationId, signedBy: 'human:SYNTHETIC', atUtc: 'x' });
  const r2 = await runAuthorized({ planFile: PLAN, goFile: go, campaignDir: S, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, offline, pilotProtocolHash: PH });
  assert.deepEqual([r2.haltReason, r2.attemptsUsed], [null, 24]);
});

const GOLDEN = [
  { label: 'SC1 (plan.sc1.json)', plan: 'C:/otk-h2eval-runs/plan.sc1.json', design: path.resolve('scripts/h2eval/design/R4_R2_SC1.v1.json') },
  { label: 'P4B', plan: 'C:/otk-h2eval-runs/r4_drafts/plan.campaign.haiku55.P4B.DRAFT.json', design: 'C:/dev/otk-round2-orchestrator-20261106/docs/_ops/coordination/academic_20261110/runs/B1/R4/SC2_DESIGNS/R4_CAMPAIGN_P4_OPTB.v1.json' },
  { label: 'P4C_R2', plan: 'C:/otk-h2eval-runs/r4_drafts/plan.campaign.haiku55.P4C_R2.DRAFT.json', design: 'C:/dev/otk-round2-orchestrator-20261106/docs/_ops/coordination/academic_20261110/runs/B1/R4/SC2_DESIGNS/R4_CAMPAIGN_P4_OPTC_R2.v1.json' },
];
const PREREG_DIR = 'C:/dev/otk-round2-orchestrator-20261106/docs/_ops/coordination/academic_20261110/runs/B1/R4';
const strip = (plan: BatchPlan): string => JSON.stringify({ ...plan, generatedUtc: 'X', priceTable: 'IGNORED (golden = table v1; executor delta C157 9.2 = v2; legacy model entries asserted identical in pilot_sonnet_opus.test.ts)' });
for (const g of GOLDEN) {
  test(`golden regression (delta 2): ${g.label}`, { timeout: 600_000 }, (t) => {
    if (!existsSync(g.plan) || !existsSync(g.design)) { t.skip('inputs absent'); return; }
    const golden = JSON.parse(readFileSync(g.plan, 'utf8')) as BatchPlan; const prereg = path.join(PREREG_DIR, golden.preregistration.file);
    if (!existsSync(prereg) || !existsSync(golden.corpus.dir)) { t.skip('prereg/corpus absent'); return; }
    const mine = buildPlan({ corpusDir: golden.corpus.dir, preregFile: prereg, ratifiedSha256: golden.preregistration.ratifiedSha256 ?? undefined, phase: golden.phase, orderBySplit: golden.orderBySplit, models: [H55], studyId: golden.studyId, designParamsFile: g.design, inputBoundFactor: golden.policy.inputBoundFactor, inputBoundExtraTokens: golden.policy.inputBoundExtraTokens });
    assert.equal(mine.protocolHash, golden.protocolHash); assert.equal(strip(mine), strip(golden));
  });
}
