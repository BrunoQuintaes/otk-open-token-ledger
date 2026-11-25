/**
 * Tests the preparation of the second evaluation cycle: per-structure prediction profiles, a larger holdout option
 * when freezing the corpus, and byte-identical plans for designs that use neither.
 *
 * Modules under test: `scripts/h2eval/cli/campaign.ts` (`profileParamsProblem`, `predictorFrom`,
 * `selectOnValidation`, `validateValidationSelected`, `PROFILE_METHODS`), `scripts/h2eval/cli/freeze.ts`
 * (`freezeCorpus` with `groupsPerCell`) and `scripts/h2eval/cli/plan.ts`.
 *
 * Strategy / partitions: profile parameter shapes (one triple per model, per-structure triples, wrong keys or
 * values refused); predictor lookup with and without a per-structure entry or operation structure (falls back to the
 * model triple, bit for bit as before); `select` refusing an invalid method or malformed parameters before writing
 * the gate and revalidating the gate on every use; corpus freeze with 12 groups per cell (larger holdout, same
 * cells) against the default (byte-identical corpus); and golden regressions against earlier plans.
 *
 * Needs: a writable temporary directory; allow up to 5 minutes for corpus freezes. The golden regression tests read
 * plan, design and preregistration files from fixed local folders and are skipped, visibly, when they are absent.
 * No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/cycle2prep.test.ts`
 *
 * @module test/h2eval/cli/cycle2prep.test
 */
// SYNTHETIC — OFFLINE. C154 (preparo do ciclo 2): (1) perfil por ESTRUTURA no `select` / predictor: `params[model].byStructure[S1|S2|S3]`
// com fallback no triplo do modelo; method `M1S` aceito; forma validada ao gravar E a cada uso do gate; perfis sem `byStructure` se comportam
// exatamente como antes (mesmo snapshot). (2) `freeze-corpus --groups-per-cell`: variante com holdout maior, mesmo desenho de celulas; sem o
// flag o corpus e byte-identico ao de antes (regressao). (3) Regressao dourada: os planos gerados por a4da8651/abf16a01 nesta maquina
// (SC1, P4B, P4C_R2) continuam byte-identicos salvo generatedUtc.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { selectOnValidation, validateValidationSelected, predictorFrom, profileParamsProblem, PROFILE_METHODS, type ValidationSelected } from '../../../scripts/h2eval/cli/campaign.js';
import { CliError, sha256File, sha256Text } from '../../../scripts/h2eval/cli/common.js';

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-c154-${p}-`));
const H55 = 'claude-haiku-5-5';

test('profileParamsProblem: triplo por modelo (como antes) OK; byStructure com triplos finitos OK; chaves ou valores errados recusados', () => {
  assert.deepEqual(PROFILE_METHODS, ['M0', 'M1', 'M1S', 'M2']);
  assert.equal(profileParamsProblem({ [H55]: { a: 20, b: 1.5, out: 600 } }), null);
  assert.equal(profileParamsProblem({ [H55]: { a: 0, b: 1, out: 0 }, 'gpt-4o-mini-2024-07-18': { a: -10.5, b: 1.2, out: 100 } }), null);
  assert.equal(profileParamsProblem({ [H55]: { a: 20, b: 1.5, out: 600, byStructure: { S1: { a: 10, b: 1.43, out: 500 }, S2: { a: 5, b: 1.58, out: 300 }, S3: { a: 5, b: 1.58, out: 300 } } } }), null);
  assert.equal(profileParamsProblem({ [H55]: { a: 20, b: 1.5, out: 600, byStructure: { S1: { a: 10, b: 1.43, out: 500 } } } }), null, 'subconjunto de estruturas e aceito (as outras caem no triplo do modelo)');
  assert.equal(profileParamsProblem({ [H55]: { a: 20, b: 1.5, out: 600, byStructure: { S4: { a: 1, b: 1, out: 1 } } } }), `${H55}:byStructure_key_S4`);
  assert.equal(profileParamsProblem({ [H55]: { a: 20, b: 1.5, out: 600, byStructure: { S1: { a: 10, b: 1.43 } } } }), `${H55}:byStructure_S1_triple`);
  assert.equal(profileParamsProblem({ [H55]: { a: 20, b: 1.5, out: 600, byStructure: { S1: { a: 10, b: Number.NaN, out: 1 } } } }), `${H55}:byStructure_S1_triple`);
  assert.equal(profileParamsProblem({ [H55]: { a: 'x', b: 1, out: 0 } }), `${H55}:a_not_finite`);
  assert.equal(profileParamsProblem({ [H55]: { a: 1, b: 1, out: 0, byStructure: [] } }), `${H55}:byStructure_not_object`);
  assert.equal(profileParamsProblem([]), 'params_not_object');
});

test('predictorFrom: com byStructure usa o triplo da estrutura da operacao (S1 x S2 x S3); sem ele (ou estrutura ausente) usa o triplo do modelo, bit a bit como antes', () => {
  const mk = (params: ValidationSelected['profile']['params'], method: ValidationSelected['profile']['method'] = 'M1'): ValidationSelected => ({ schema: 'h2eval.gate.validation_selected.v0', protocolHash: 'p', selectedUtc: 'x', trainFrozenSha256: '0'.repeat(64), validationBatches: [], profile: { method, profileId: 'id', paramsSha256: sha256Text(JSON.stringify(params)), trainedOn: 't', params }, selectedBy: 'human:SYNTHETIC', forecastFrozen: null });
  const op = (structure: 'S1' | 'S2' | 'S3') => ({ modelRequested: H55, structure }) as never;
  const micro = { in: 100_000n, out: 500_000n }; // micro-USD por MTok (sintetico)
  const flat = predictorFrom(mk({ [H55]: { a: 20, b: 1.5, out: 600 } }));
  const byS = predictorFrom(mk({ [H55]: { a: 20, b: 1.5, out: 600, byStructure: { S1: { a: 10, b: 1.43, out: 500 }, S2: { a: 5, b: 1.58, out: 300 } } } }, 'M1S'));
  const cost = (inTok: number, outTok: number) => (BigInt(inTok) * micro.in + BigInt(outTok) * micro.out).toString();
  for (const s of ['S1', 'S2', 'S3'] as const) assert.equal(flat(op(s), 1000, micro.in, micro.out).expectedCostUsd, cost(Math.round(20 + 1.5 * 1000), 600), `sem byStructure: ${s} igual ao modelo`);
  assert.equal(byS(op('S1'), 1000, micro.in, micro.out).expectedCostUsd, cost(Math.round(10 + 1.43 * 1000), 500));
  assert.equal(byS(op('S2'), 1000, micro.in, micro.out).expectedCostUsd, cost(Math.round(5 + 1.58 * 1000), 300));
  assert.equal(byS(op('S3'), 1000, micro.in, micro.out).expectedCostUsd, cost(Math.round(20 + 1.5 * 1000), 600), 'S3 ausente em byStructure => triplo do modelo');
  assert.equal(byS(op('S1'), 1000, micro.in, micro.out).profile?.method, 'M1S');
  assert.equal(byS(op('S1'), 'UNKNOWN' as never, micro.in, micro.out).expectedCostUsd, 'UNKNOWN');
});

test('select: method invalido ou params mal formados sao recusados ANTES de gravar o gate; o gate com byStructure e revalidado a cada uso', { timeout: 300_000 }, () => {
  // campanha sintetica minima: um plano CONFIRMATORY e lotes de validacao "terminais" nao sao necessarios para as recusas de forma (elas vem antes)
  const WORK = tmp('sel'); const CORPUS = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg\n');
  freezeCorpus({ out: CORPUS, seed: 154154, s2: 2, s3: 3, noRepoScan: true });
  const plan = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', unratifiedRehearsal: true, orderBySplit: true, studyId: 'H2EVAL-C154', models: [H55] });
  const CAMP = path.join(WORK, 'camp'); const gates = path.join(CAMP, 'gates'); mkdirSync(gates, { recursive: true });
  // TRAIN_FROZEN sintetico (valido o bastante para passar a existencia; as recusas de forma vem antes de qualquer leitura de lote)
  const tfRows = plan.batches.filter((b) => (b.block === 'train' || b.block === 'comparative') && !b.branchLocked).map((b) => ({ batchId: b.batchId, batchDir: path.join(CAMP, 'batches', b.batchId), operations: b.calls, terminal: b.calls, datasetSha256: '1'.repeat(64), summarySha256: '2'.repeat(64) }));
  writeFileSync(path.join(gates, 'TRAIN_FROZEN.json'), JSON.stringify({ schema: 'h2eval.gate.train_frozen.v0', protocolHash: plan.protocolHash, frozenUtc: 'x', batches: tfRows, sha256OfBatchList: sha256Text(JSON.stringify(tfRows)), forecastFrozen: null }));
  const params = { [H55]: { a: 20, b: 1.5, out: 600, byStructure: { S1: { a: 10, b: 1.43, out: 500 }, S4: { a: 1, b: 1, out: 1 } } } } as never;
  const prof = (p: unknown, method: string) => ({ method, profileId: 'c154', paramsSha256: sha256Text(JSON.stringify(p)), trainedOn: 't', params: p }) as ValidationSelected['profile'];
  assert.throws(() => selectOnValidation(plan, CAMP, prof(params, 'M1S'), 'human:SYNTHETIC'), (e: CliError) => e.code === 'PROFILE_PARAMS_INVALID');
  assert.throws(() => selectOnValidation(plan, CAMP, prof({ [H55]: { a: 1, b: 1, out: 1 } }, 'M9'), 'human:SYNTHETIC'), (e: CliError) => e.code === 'PROFILE_METHOD_INVALID');
  assert.ok(!existsSync(path.join(gates, 'VALIDATION_SELECTED.json')), 'nada gravado');
  // gate forjado com byStructure invalido => GATE_PROFILE_INVALID na revalidacao; gate valido com M1S => aceito
  const bad = { schema: 'h2eval.gate.validation_selected.v0', protocolHash: plan.protocolHash, selectedUtc: 'x', trainFrozenSha256: sha256File(path.join(gates, 'TRAIN_FROZEN.json')), validationBatches: plan.batches.filter((b) => b.block === 'validation').map((b) => ({ batchId: b.batchId, datasetSha256: '1'.repeat(64) })), profile: prof(params, 'M1S'), selectedBy: 'human:SYNTHETIC', forecastFrozen: null };
  const gf = path.join(gates, 'VALIDATION_SELECTED.json'); writeFileSync(gf, JSON.stringify(bad));
  assert.equal(validateValidationSelected(plan, gf, path.join(gates, 'TRAIN_FROZEN.json')).code, 'GATE_PROFILE_INVALID');
  const goodParams = { [H55]: { a: 20, b: 1.5, out: 600, byStructure: { S1: { a: 10, b: 1.43, out: 500 }, S2: { a: 5, b: 1.58, out: 300 }, S3: { a: 5, b: 1.58, out: 300 } } } };
  writeFileSync(gf, JSON.stringify({ ...bad, profile: prof(goodParams, 'M1S') }));
  const v = validateValidationSelected(plan, gf, path.join(gates, 'TRAIN_FROZEN.json')); assert.equal(v.code, null); assert.equal(v.art!.profile.method, 'M1S');
  writeFileSync(gf, JSON.stringify({ ...bad, profile: prof({ [H55]: { a: 20, b: 1.5, out: 600 } }, 'M1') }));
  assert.equal(validateValidationSelected(plan, gf, path.join(gates, 'TRAIN_FROZEN.json')).code, null, 'perfil antigo continua aceito');
});

test('freeze-corpus --groups-per-cell: 12 grupos por celula => holdout 6/3/3 por celula (1,5x), mesmas celulas/variantes/repeticoes; sem o flag o corpus e byte-identico ao gerador anterior', { timeout: 600_000 }, () => {
  const WORK = tmp('corpus');
  const a = freezeCorpus({ out: path.join(WORK, 'a'), seed: 154001, s2: 2, s3: 3, noRepoScan: true });
  const b = freezeCorpus({ out: path.join(WORK, 'b'), seed: 154001, s2: 2, s3: 3, noRepoScan: true, groupsPerCell: 12 });
  const ma = JSON.parse(readFileSync(path.join(WORK, 'a', 'manifest.json'), 'utf8')); const mb = JSON.parse(readFileSync(path.join(WORK, 'b', 'manifest.json'), 'utf8'));
  assert.equal(ma.params.groupsPerCell, 8); assert.equal(mb.params.groupsPerCell, 12);
  assert.deepEqual(ma.splitSummary.s1GroupsBySplit, { train: 32, validation: 16, holdout: 16 });
  assert.deepEqual(mb.splitSummary.s1GroupsBySplit, { train: 48, validation: 24, holdout: 24 });
  assert.deepEqual(mb.s1.cells, ma.s1.cells); assert.equal(mb.params.variantsPerGroup, 3); assert.equal(mb.params.repeatsPerCell, 3);
  assert.equal(mb.counts.s1Prompts, 288); assert.equal(ma.counts.s1Prompts, 192);
  assert.notEqual(a.corpusSha256, b.corpusSha256);
  // regressao: o corpus 'a' (sem o flag) tem exatamente os bytes que o gerador anterior produz com a mesma semente (fixture gerada por abf16a01 quando presente)
  const golden = 'C:/otk-h2eval-runs/corpus_c2_candidate';
  if (existsSync(golden)) {
    const c = freezeCorpus({ out: path.join(WORK, 'c'), seed: 20261112, noRepoScan: true, allowNotCompared: true });
    for (const f of ['s1_prompts.jsonl', 'dialogs.jsonl', 's1_operations.claude-haiku-5-5.jsonl', 's1_operations.gpt-4o-mini.jsonl']) assert.equal(sha256File(path.join(WORK, 'c', f)), sha256File(path.join(golden, f)), f);
    assert.equal(c.corpusSha256, JSON.parse(readFileSync(path.join(golden, 'manifest.json'), 'utf8')).corpusSha256, 'corpusSha256 identico ao gerado por abf16a01');
    assert.deepEqual(readdirSync(path.join(WORK, 'c', 'content')).sort(), readdirSync(path.join(golden, 'content')).sort());
  }
});

// Golden regression vs the plans generated by a4da8651 / abf16a01 on this machine (real corpus + ratified prereg; read-only). Skipped explicitly when absent.
const GOLDEN = [
  { label: 'SC1 (plan.sc1.json, pilot, 33 ops)', plan: 'C:/otk-h2eval-runs/plan.sc1.json', design: path.resolve('scripts/h2eval/design/R4_R2_SC1.v1.json'), phase: 'pilot' as const },
  { label: 'P4B (351 ops)', plan: 'C:/otk-h2eval-runs/r4_drafts/plan.campaign.haiku55.P4B.DRAFT.json', design: 'C:/dev/otk-round2-orchestrator-20261106/docs/_ops/coordination/academic_20261110/runs/B1/R4/SC2_DESIGNS/R4_CAMPAIGN_P4_OPTB.v1.json', phase: 'campaign' as const },
  { label: 'P4C_R2 (297 ops, arms.T3.enabled=false)', plan: 'C:/otk-h2eval-runs/r4_drafts/plan.campaign.haiku55.P4C_R2.DRAFT.json', design: 'C:/dev/otk-round2-orchestrator-20261106/docs/_ops/coordination/academic_20261110/runs/B1/R4/SC2_DESIGNS/R4_CAMPAIGN_P4_OPTC_R2.v1.json', phase: 'campaign' as const },
];
const PREREG_DIR = 'C:/dev/otk-round2-orchestrator-20261106/docs/_ops/coordination/academic_20261110/runs/B1/R4';
const strip = (plan: BatchPlan): string => JSON.stringify({ ...plan, generatedUtc: 'X', priceTable: 'IGNORED (golden = table v1; executor delta C157 9.2 = v2; legacy model entries asserted identical in pilot_sonnet_opus.test.ts)' });
for (const g of GOLDEN) {
  test(`golden regression: ${g.label}`, { timeout: 600_000 }, (t) => {
    if (!existsSync(g.plan) || !existsSync(g.design)) { t.skip(`inputs absent: ${g.plan} / ${g.design}`); return; }
    const golden = JSON.parse(readFileSync(g.plan, 'utf8')) as BatchPlan; const prereg = path.join(PREREG_DIR, golden.preregistration.file);
    if (!existsSync(prereg) || !existsSync(golden.corpus.dir)) { t.skip('prereg/corpus absent'); return; }
    const mine = buildPlan({ corpusDir: golden.corpus.dir, preregFile: prereg, ratifiedSha256: golden.preregistration.ratifiedSha256 ?? undefined, phase: golden.phase, orderBySplit: golden.orderBySplit, models: [H55], studyId: golden.studyId, designParamsFile: g.design, inputBoundFactor: golden.policy.inputBoundFactor, inputBoundExtraTokens: golden.policy.inputBoundExtraTokens });
    assert.equal(mine.protocolHash, golden.protocolHash); assert.equal(strip(mine), strip(golden), 'byte-identical apart from generatedUtc');
  });
}
