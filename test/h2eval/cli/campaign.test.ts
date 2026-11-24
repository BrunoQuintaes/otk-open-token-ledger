// SYNTHETIC — OFFLINE end-to-end rehearsal of the WHOLE campaign (R18–R20) through the CLI with the simulated provider: plan phase CAMPAIGN
// (train → comparative → validation → holdout, batches ≤ 60, one model per batch), code locks (validation refused before TRAIN_FROZEN,
// holdout refused before VALIDATION_SELECTED), immutable prediction in the holdout snapshots, run-authorized over several batches with
// halt at the first STOP, Google NOT_RUN, worst case per provider against 5/3/3. No network, no credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { runBatch, runAuthorized, selectBatch } from '../../../scripts/h2eval/cli/run.js';
import { syntheticMultiGo } from '../support/gomulti.js';
import { writeGateG17 } from '../../../scripts/h2eval/cli/campaign.js';
import { freezeTrain, selectOnValidation, gateFor } from '../../../scripts/h2eval/cli/campaign.js';
import { CliError, EXIT, sha256File, sha256Text } from '../../../scripts/h2eval/cli/common.js';
import { readSnapshot } from '../../../scripts/h2eval/record/snapshot.js';
import { usdToPico } from '../../../scripts/h2eval/core/ledger.js';

const TEST_SEED = 424242;
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-camp-${p}-`));
const WORK = tmp('work'); const CORPUS = path.join(WORK, 'corpus'); const CAMP = path.join(WORK, 'campaign');
const PREREG = path.join(WORK, 'PREREG_SYNTHETIC.md'); writeFileSync(PREREG, '# pre-registration SYNTHETIC for the campaign rehearsal\n');
const SHA = 'c'.repeat(40);
const PICO = 1_000_000_000_000n;
let plan: BatchPlan; let planFile: string;
const goFor = (name: string, ids: string[], seed = 'seed') => { const p = path.join(WORK, `${name}.go.json`); writeFileSync(p, syntheticMultiGo(plan, ids, { executorCodeSha: SHA, nonceSeed: seed, campaignDir: CAMP })); return p; };
const g17all = () => { for (const m of ['gpt-4o-mini-2024-07-18', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'gemini-3.5-flash-lite']) { try { writeGateG17(CAMP, { model: m, verdict: 'PASS', pilotProtocolHash: 'p'.repeat(64), signedBy: 'human:SYNTHETIC', atUtc: 'x' }); } catch { /* already written */ } } };

test('corpus candidate (small) + plan phase CAMPAIGN: blocks in locked order, batches <= 60, one model and one block per batch, worst case per provider within 5/3/3', { timeout: 300_000 }, () => {
  freezeCorpus({ out: CORPUS, seed: TEST_SEED, s2: 3, s3: 6, noRepoScan: true });
  assert.throws(() => buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', unratifiedRehearsal: true }), (e: CliError) => e.code === 'PLAN_ORDER_BY_SPLIT_REQUIRED', 'E2: a flag e obrigatoria');
  assert.throws(() => buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', unratifiedRehearsal: true, orderBySplit: true, designParamsFile: path.join(WORK, 'no-such-design.json') }), (e: CliError) => e.code === 'DESIGN_PARAMS_MISSING', 'VNEXT-2: o teto vem do arquivo de desenho; sem arquivo nao ha plano');
  plan = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', unratifiedRehearsal: true, orderBySplit: true, studyId: 'H2EVAL-CAMPAIGN-REHEARSAL', now: () => '2026-11-11T00:00:00.000Z' });
  assert.equal(plan.orderBySplit, true); assert.ok(plan.notPlanned.some((x) => x.startsWith('image')) && plan.notPlanned.some((x) => x.startsWith('audio')));
  for (const m of Object.keys(plan.splitBoundaries)) { const sb = plan.splitBoundaries[m]!; assert.ok(sb.train.length > 0 && sb.validation.length > 0 && sb.holdout.length > 0, `${m}: fronteiras por modelo`); }
  assert.equal(plan.pauseForecast.length, 3); for (const pf of plan.pauseForecast) { const first = plan.batches.find((b) => b.provider === pf.provider && b.requiresPauseAckInGo); assert.equal(pf.crossesPauseAt80pct, first !== undefined); assert.equal(pf.firstBatchRequiringPauseAck, first?.batchId ?? null); }
  planFile = path.join(WORK, 'plan.campaign.json'); writePlan(plan, planFile);
  assert.equal(plan.phase, 'CONFIRMATORY');
  const rank = { pilot: 0, train: 1, comparative: 2, validation: 3, holdout: 4 } as const;
  for (let k = 1; k < plan.batches.length; k += 1) assert.ok(rank[plan.batches[k - 1]!.block] <= rank[plan.batches[k]!.block], 'ordem travada');
  for (const b of plan.batches) {
    assert.ok(b.calls <= 60 && b.calls > 0);
    assert.equal(new Set(b.operations.map((o) => o.plan.modelRequested)).size, 1);
    assert.equal(new Set(b.operations.map((o) => (o.plan.phase === 'COMPARATIVE_PAIRED' || o.plan.split === 'COMPARATIVE' ? 'comparative' : o.plan.split))).size, 1, `${b.batchId}: um bloco por lote`);
    assert.ok(BigInt(b.batchCapUsdPico) <= usdToPico(plan.policy.capsUsd.providers[b.provider]) / 4n);
  }
  const totals = plan.totals;
  for (const p of ['anthropic', 'openai', 'google'] as const) assert.ok(BigInt(totals[p].sumCostCapUsdPico) <= usdToPico(plan.policy.capsUsd.providers[p]), `${p}: pior caso ${totals[p].sumCostCapUsdPico} <= sub-ledger`);
  const perModel = Object.fromEntries(['gpt-4o-mini-2024-07-18', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'gemini-3.5-flash-lite'].map((m) => [m, plan.batches.filter((b) => b.model === m).reduce((a, b) => a + b.calls, 0)]));
  assert.ok(perModel['claude-haiku-4-5-20251001']! < perModel['claude-haiku-5-5']!, 'desenho B reduzido do Haiku 4.5');
  assert.ok(plan.batches.some((b) => b.block === 'comparative' && b.model === 'claude-haiku-4-5-20251001'));
  assert.ok(plan.batches.filter((b) => b.model === 'gemini-3.5-flash-lite').every((b) => b.branchLocked));
});

test('code lock: validation refused before TRAIN_FROZEN; holdout refused before VALIDATION_SELECTED; freeze refused while a train batch is not terminal', async () => {
  const val = plan.batches.find((b) => b.block === 'validation' && !b.branchLocked)!; const hold = plan.batches.find((b) => b.block === 'holdout' && !b.branchLocked)!;
  assert.equal(gateFor(plan, val, CAMP).code, 'GATE_TRAIN_NOT_FROZEN'); assert.equal(gateFor(plan, hold, CAMP).code, 'GATE_VALIDATION_NOT_SELECTED');
  await assert.rejects(runBatch({ planFile, batchId: val.batchId, batchDir: path.join(CAMP, 'batches', val.batchId), mode: 'offline', executorCodeSha: SHA, campaignDir: CAMP }), (e: CliError) => e.code === 'GATE_TRAIN_NOT_FROZEN' && e.exit === EXIT.REFUSED_BY_POLICY);
  await assert.rejects(runBatch({ planFile, batchId: hold.batchId, batchDir: path.join(CAMP, 'batches', hold.batchId), mode: 'offline', executorCodeSha: SHA, campaignDir: CAMP }), (e: CliError) => e.code === 'GATE_VALIDATION_NOT_SELECTED');
  await assert.rejects(runBatch({ planFile, batchId: val.batchId, batchDir: tmp('nocamp'), mode: 'offline', executorCodeSha: SHA }), (e: CliError) => e.code === 'CAMPAIGN_DIR_REQUIRED');
  assert.throws(() => freezeTrain(plan, CAMP), (e: CliError) => e.code === 'TRAIN_BATCH_NOT_TERMINAL');
});

test('run-authorized: train + comparative batches of all models from ONE signed scope, in plan order, Google NOT_RUN halts its own scope; then freeze-train', { timeout: 600_000 }, async () => {
  const trainIds = plan.batches.filter((b) => (b.block === 'train' || b.block === 'comparative') && !b.branchLocked).map((b) => b.batchId);
  g17all();
  const scope = goFor('train', [...trainIds].reverse());
  const r = await runAuthorized({ planFile, goFile: scope, campaignDir: CAMP, mode: 'offline', executorCodeSha: SHA, pilotProtocolHash: 'p'.repeat(64) });
  assert.equal(r.haltedAt, null, JSON.stringify(r.executed.filter((e) => e.stoppedBy)));
  assert.deepEqual(r.executed.map((e) => e.batchId), trainIds, 'ordem do plano, nao a do GO');
  assert.ok(r.executed.every((e) => e.executed === e.planned && e.stoppedBy === null && e.outcome === 'DONE'));
  // Google in the GO but without G16-GOOGLE => SKIPPED_GATE, nothing is sent
  const gid = plan.batches.find((b) => b.branchLocked)!.batchId;
  const g = await runAuthorized({ planFile, goFile: goFor('google', [gid], 'g'), campaignDir: CAMP, mode: 'offline', executorCodeSha: SHA, pilotProtocolHash: 'p'.repeat(64) });
  assert.deepEqual([g.haltedAt, g.executed[0]!.outcome, g.attemptsUsed], [null, 'SKIPPED_GATE', 0]);
  // invalid GO: other plan
  const badGo = path.join(WORK, 'bad.go.json'); writeFileSync(badGo, syntheticMultiGo(plan, trainIds, { executorCodeSha: SHA, over: { planProtocolHash: 'x'.repeat(64) }, campaignDir: CAMP }));
  await assert.rejects(runAuthorized({ planFile, goFile: badGo, campaignDir: CAMP, mode: 'offline', executorCodeSha: SHA }), (e: CliError) => e.code === 'GO_PLAN_MISMATCH');
  // REAL with an unratified plan: the multi GO is refused before any executor (no ratified hash => GO_PREREG_UNCONFIGURED, exit 3); never a socket
  await assert.rejects(runAuthorized({ planFile, goFile: scope, campaignDir: CAMP, mode: 'real', realFlag: true, executorCodeSha: SHA, identity: { sha: SHA, clean: true }, env: {} }), (e: CliError) => e.code === 'GO_PREREG_UNCONFIGURED' && e.exit === EXIT.REFUSED_BY_POLICY);
  const frozen = freezeTrain(plan, CAMP, () => '2026-11-11T01:00:00.000Z');
  assert.equal(frozen.batches.length, trainIds.length); assert.ok(existsSync(path.join(CAMP, 'gates', 'TRAIN_FROZEN.json')));
  assert.throws(() => freezeTrain(plan, CAMP), (e: CliError) => e.code === 'TRAIN_ALREADY_FROZEN');
  // a GO naming a batch outside the plan is refused whole
  await assert.rejects(runAuthorized({ planFile, goFile: goFor('unknown', ['nope'], 'u'), campaignDir: CAMP, mode: 'offline', executorCodeSha: SHA }), (e: CliError) => e.code === 'GO_BATCH_NOT_IN_PLAN');
});

test('validation runs after the freeze; select records the profile (paramsSha256) before any holdout; holdout snapshots carry the immutable prediction; replay never resends', { timeout: 600_000 }, async () => {
  const valIds = plan.batches.filter((b) => b.block === 'validation' && !b.branchLocked).map((b) => b.batchId);
  const scope = goFor('validation', valIds, 'v');
  const r = await runAuthorized({ planFile, goFile: scope, campaignDir: CAMP, mode: 'offline', executorCodeSha: SHA, pilotProtocolHash: 'p'.repeat(64) });
  assert.equal(r.haltedAt, null);
  const hold = plan.batches.find((b) => b.block === 'holdout' && !b.branchLocked)!;
  await assert.rejects(runBatch({ planFile, batchId: hold.batchId, batchDir: path.join(CAMP, 'batches', hold.batchId), mode: 'offline', executorCodeSha: SHA, campaignDir: CAMP }), (e: CliError) => e.code === 'GATE_VALIDATION_NOT_SELECTED', 'holdout ainda travado');
  const params = { 'gpt-4o-mini-2024-07-18': { a: 12, b: 1.03, out: 40 }, 'claude-haiku-4-5-20251001': { a: 20, b: 1.1, out: 40 }, 'claude-haiku-5-5': { a: 20, b: 1.1, out: 60 }, 'gemini-3.5-flash-lite': { a: 15, b: 1.05, out: 40 } };
  const profile = { method: 'M1' as const, profileId: 'm1-linear-synthetic-v0', paramsSha256: sha256Text(JSON.stringify(params)), trainedOn: 'train+validation SYNTHETIC', params };
  assert.throws(() => selectOnValidation(plan, CAMP, { ...profile, paramsSha256: '0'.repeat(64) }, 'human:SYNTHETIC'), (e: CliError) => e.code === 'PROFILE_PARAMS_SHA_MISMATCH');
  assert.throws(() => selectOnValidation(plan, CAMP, profile, 'agent:bot'), (e: CliError) => e.code === 'SELECTED_BY_UNSIGNED');
  // E1: a frozen forecast table (ECON-02 shape) travels with the selection; a table that read holdout is refused
  const frozenBad = { schema: 'h2eval.forecast_frozen.v0', holdoutRead: true, perModel: {}, freezeSha256: 'a'.repeat(64) };
  assert.throws(() => selectOnValidation(plan, CAMP, profile, 'human:SYNTHETIC', undefined, frozenBad), (e: CliError) => e.code === 'FORECAST_FROZEN_READ_HOLDOUT');
  const perModel = Object.fromEntries(['gpt-4o-mini-2024-07-18', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'gemini-3.5-flash-lite'].map((m) => [m, { status: 'OK', modelMeanOutput: 24, meanByCell: { 'summary-S': 20 }, ridge: { lambda: 0, weights: [24, 0, 0, 0, 0, 0, 0, 0], features: ['1', 'L0/1000', 'maxTokens/256', 'isL', 'isCode', 'isAnalysis', 'isS2', 'isS3'] }, intervalSimple: { qlo: -0.5, qhi: 0.5, n: 30 }, intervalLearn: null }]));
  const frozen = { schema: 'h2eval.forecast_frozen.v0', holdoutRead: false, perModel, freezeSha256: 'f'.repeat(64) };
  const sel = selectOnValidation(plan, CAMP, profile, 'human:SYNTHETIC', () => '2026-11-11T02:00:00.000Z', frozen);
  assert.equal(sel.trainFrozenSha256, sha256File(path.join(CAMP, 'gates', 'TRAIN_FROZEN.json')));
  const holdIds = plan.batches.filter((b) => b.block === 'holdout' && !b.branchLocked).map((b) => b.batchId);
  const hs = goFor('holdout', holdIds, 'h');
  const h = await runAuthorized({ planFile, goFile: hs, campaignDir: CAMP, mode: 'offline', executorCodeSha: SHA, pilotProtocolHash: 'p'.repeat(64) });
  assert.equal(h.haltedAt, null);
  const b0 = selectBatch(plan, holdIds[0]!); const dir = path.join(CAMP, 'batches', b0.batchId);
  const snap = readSnapshot(dir, b0.operations[0]!.operationId);
  assert.deepEqual([snap.profile?.method, snap.profile?.profileId, snap.profile?.paramsSha256], ['M1', 'm1-linear-synthetic-v0', profile.paramsSha256]);
  assert.match(String(snap.expectedCostUsd), /^\d+$/, 'previsao imutavel gravada antes do envio');
  // E1: forecast block registered pre-call (holdout has the frozen table) with ECON-02 arithmetic; maxTokens copied
  assert.equal(snap.maxTokens, 256);
  assert.deepEqual([snap.forecast.label, snap.forecast.outMax, snap.forecast.frozenSha256, snap.forecast.intervalLearn], ['EX_ANTE_REGISTRADA', 256, 'f'.repeat(64), 'NAO_REGISTRADA']);
  assert.equal(snap.forecast.outMean, b0.operations[0]!.plan.cellId === 'summary-S' ? 20 : 24); assert.equal(snap.forecast.outLearn, 24);
  assert.match(String(snap.forecast.costSimple), /^\d+\.\d{12}$/); assert.match(String(snap.forecast.costMaxOut), /^\d+\.\d{12}$/);
  const iv = snap.forecast.intervalSimple as { lo: string; hi: string }; assert.ok(iv.lo < iv.hi);
  // train snapshots: no table yet => NAO_REGISTRADA for the table-dependent fields, but costMaxOut always derivable
  const t0s = readSnapshot(path.join(CAMP, 'batches', plan.batches.find((b) => b.block === 'train' && !b.branchLocked)!.batchId), plan.batches.find((b) => b.block === 'train' && !b.branchLocked)!.operations[0]!.operationId);
  assert.deepEqual([t0s.forecast.label, t0s.forecast.outMean, t0s.forecast.frozenSha256], ['NAO_REGISTRADA', 'NAO_REGISTRADA', 'NAO_REGISTRADA']); assert.match(String(t0s.forecast.costMaxOut), /^\d+\.\d{12}$/);
  // E3: export carries dataLabel, cacheableTokens, nonceTokensDeclared, exAnte.maxTokens/forecast
  const { exportDataset } = await import('../../../scripts/h2eval/cli/status.js');
  const ex = exportDataset(dir); const rows = readFileSync(ex.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.every((r) => r.dataLabel === 'SYNTHETIC_NOT_EVIDENCE' && r.exAnte.maxTokens === 256 && r.exAnte.forecast.label === 'EX_ANTE_REGISTRADA'));
  const s3row = rows.find((r) => r.structure === 'S3'); const s2row = rows.find((r) => r.structure === 'S2'); const s1row = rows.find((r) => r.structure === 'S1');
  if (s3row) assert.ok(typeof s3row.cacheableTokens === 'number' && s3row.cacheableTokens > 1000 && s3row.nonceTokensDeclared === 'NOT_APPLICABLE');
  if (s2row) assert.ok(typeof s2row.nonceTokensDeclared === 'number' && s2row.nonceTokensDeclared > 0 && s2row.nonceTokensDeclared < 30);
  if (s1row) assert.equal(s1row.cacheableTokens, 'NOT_APPLICABLE');
  // train snapshots carry no prediction (none existed yet)
  const t0 = plan.batches.find((b) => b.block === 'train' && !b.branchLocked)!;
  assert.equal(readSnapshot(path.join(CAMP, 'batches', t0.batchId), t0.operations[0]!.operationId).profile, null);
  // replay of a holdout batch: nothing resent
  const again = await runBatch({ planFile, batchId: b0.batchId, batchDir: dir, mode: 'offline', executorCodeSha: SHA, campaignDir: CAMP });
  assert.deepEqual([again.executed, again.results.every((x) => x.replayed)], [0, true]);
  // whole campaign executed: every non-Google batch terminal, spent within the sub-ledgers
  const summary = { calls: 0, byProvider: { anthropic: 0n, openai: 0n, google: 0n } as Record<string, bigint> };
  for (const b of plan.batches.filter((x) => !x.branchLocked)) { summary.calls += b.calls; }
  const last = JSON.parse(readFileSync(path.join(CAMP, 'ledger.jsonl'), 'utf8').trim().split('\n').at(-1)!) as { kind: string };
  assert.ok(['settle', 'uncertain', 'release'].includes(last.kind), 'ledger unico do estudo em <campaignDir>/ledger.jsonl');
  assert.ok(summary.calls > 100);
  void PICO;
});
