// SYNTHETIC — OFFLINE. VNEXT-8 (C151): (a) design parameters PER ARM read from the R4 file (converted from ECON-02's h2eval.r4_design_params.v0;
// vendored copy + committed candidate kept in sync by this test); (b) R4 integrity stops: provider stop reason absent => STOP_STOP_REASON_MISSING
// (HALT_ALL, after settlement); HTTP 400 to a thinking-disabled request => STOP_THINKING_DISABLED_REJECTED (ISOLATE_ARM, other arms continue);
// (c) B06 audit of the cycle-2 proposal: R17-C2-1 preflight age judged once at run-authorized start (no STALE mid-campaign), R17-C2-2 H2EVAL_*
// names excluded from the env fingerprint, R17-C2-3 execArgv included, R17-C2-5 own code for a corrupt campaign journal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { runAuthorized, realPreconditions, selectBatch } from '../../../scripts/h2eval/cli/run.js';
import { convertR4DesignV0, loadDesignParams, armOf, R4_V0_VENDORED_FILE, R4_CANDIDATE_FILE, R4_V0_HAIKU55_ARM_THINKING, R4_INPUT_BOUND } from '../../../scripts/h2eval/design/designParams.js';
import { preflightConnectivity, preflightGate, envFingerprint, latestPreflight, campaignJournalPath, CampaignJournalError, type PreflightProbes, type TlsProbeResult } from '../../../scripts/h2eval/cli/preflight.js';
import { openLedger } from '../../../scripts/h2eval/core/ledger.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { syntheticMultiGo } from '../support/gomulti.js';

const SHA = 'c'.repeat(40); const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-vnext8-${p}-`));
const WORK = tmp('work'); const CORPUS = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg\n');
const H55 = 'claude-haiku-5-5'; const H45 = 'claude-haiku-4-5-20251001'; const CAPS = { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } };
let pilot: BatchPlan; let camp: BatchPlan; let pilotFile: string;
const ECON02_V0_SHA256 = 'e03225e266951835f8fef3b10fa51a3cc958cec523f2967d68ccae3b97a1c21a';

test('R4 v0 (ECON-02) vendorizado: sha256 conferido; conversao reproduz o candidato comprometido; bracos T1..T5 com tetos e politica por braco', () => {
  const buf = readFileSync(R4_V0_VENDORED_FILE); assert.equal(createHash('sha256').update(buf).digest('hex'), ECON02_V0_SHA256, 'o arquivo da ECON-02 mudou: refaca o candidato conscientemente');
  const cand = convertR4DesignV0(JSON.parse(buf.toString('utf8')), { v0Sha256: ECON02_V0_SHA256, haiku55ArmThinking: R4_V0_HAIKU55_ARM_THINKING, inputBound: R4_INPUT_BOUND });
  assert.deepEqual(cand, JSON.parse(readFileSync(R4_CANDIDATE_FILE, 'utf8')), 'candidato comprometido == conversao');
  const d = loadDesignParams(R4_CANDIDATE_FILE).params;
  assert.deepEqual(d.perModel[H55].arms!.T1, { maxTokens: 512, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 });
  assert.deepEqual(d.perModel[H55].arms!.T2, { maxTokens: 1024, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0 });
  assert.deepEqual(d.perModel[H55].arms!.T3, { maxTokens: 1024, thinking: { policy: 'ADAPTIVE', effort: 'low' }, reasoningAllowanceTokens: 1024 });
  assert.deepEqual([d.perModel[H55].arms!.T4!.maxTokens, d.perModel[H55].arms!.T5!.maxTokens, d.perModel[H45].arms!.T2!.maxTokens, d.perModel[H45].thinking], [256, 256, 512, { policy: 'OFF' }]);
  assert.deepEqual(d.integrity, { stopReasonRequired: true, thinkingDisabledRejectedStops: true }); assert.match(d.source, /NOT RATIFIED/);
  assert.deepEqual([armOf('S1', 'summary'), armOf('S1', 'code_fix'), armOf('S1', 'code_gen'), armOf('S1', 'analysis'), armOf('S2', 'analysis'), armOf('S3', 'analysis')], ['T1', 'T2', 'T2', 'T3', 'T4', 'T5']);
});

test('setup + plano com o candidato R4: parametros por (modelo, braco) aplicados; T3 do Haiku 5.5 adaptativo com folga 1024 e teto 1024; opsCheck reporta R4 x corpus', { timeout: 300_000 }, () => {
  freezeCorpus({ out: CORPUS, seed: 151008, s2: 2, s3: 3, noRepoScan: true });
  pilot = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-V8', designParamsFile: R4_CANDIDATE_FILE }); pilotFile = path.join(WORK, 'plan.pilot.json'); writePlan(pilot, pilotFile);
  camp = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', unratifiedRehearsal: true, orderBySplit: true, studyId: 'H2EVAL-V8', designParamsFile: R4_CANDIDATE_FILE });
  const b55 = pilot.batches.find((b) => b.model === H55)!;
  const byArm = Object.fromEntries(b55.operations.map((o) => [`${armOf(o.plan.structure, o.plan.task)}`, `${o.plan.params.maxTokens}/${o.plan.params.thinking.mode}/${o.reasoningAllowanceTokens}`]));
  assert.deepEqual(byArm, { T1: '512/none/0', T2: '1024/none/0', T3: '1024/adaptive/1024', T4: '256/none/0', T5: '256/none/0' });
  assert.equal(pilot.policy.design.byModelArm[`${H55}:T3`]!.policy, 'ADAPTIVE:low');
  assert.ok(camp.policy.design.opsCheck.length > 0 && camp.policy.design.opsCheck.every((r) => typeof r.match === 'boolean'), 'relatorio R4 opsPerSplit x corpus presente no plano');
  // cost cap follows the arm: T2 (1024, OFF) and T3 (1024 + 1024 allowance) are above T4 (256)
  const cap = (arm: string) => BigInt(b55.operations.find((o) => armOf(o.plan.structure, o.plan.task) === arm)!.costCapUsdPico);
  assert.ok(cap('T3') > cap('T1'), 'mesmo tamanho S1: T3 (1024 + folga 1024) > T1 (512, sem folga)');
});

test('integridade R4: resposta sem stop_reason => STOP_STOP_REASON_MISSING depois de liquidar (HALT_ALL); 400 a thinking disabled => STOP_THINKING_DISABLED_REJECTED isola o braco e os outros seguem', { timeout: 600_000 }, async () => {
  const ids = pilot.batches.filter((b) => !b.branchLocked).map((b) => b.batchId); // haiku-4-5, haiku-5-5, gpt (plan order)
  const A = tmp('A'); const goA = path.join(WORK, 'go.A.json'); writeFileSync(goA, syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, campaignDir: A }));
  const r = await runAuthorized({ planFile: pilotFile, goFile: goA, campaignDir: A, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, offline: { faults: { 2: 'no_stop_reason' } } });
  assert.deepEqual([r.haltReason, r.executed[0]!.stoppedBy, r.executed[0]!.executed], ['STOP_STOP_REASON_MISSING', 'STOP_STOP_REASON_MISSING', 3]);
  const j = verifyJournalText(readFileSync(path.join(A, 'batches', ids[0]!, 'journal.jsonl'), 'utf8')); const ops = [...new Set(j.map((l) => l.operationId))];
  const third = j.filter((l) => l.operationId === ops[2]).map((l) => l.kind); assert.ok(third.includes('SETTLED') && third.at(-1) === 'STOP_GLOBAL', 'dinheiro liquidado ANTES do stop de integridade');
  assert.equal(openLedger(path.join(A, 'ledger.jsonl'), CAPS).state().providers.anthropic.operations, 3);
  // thinking disabled rejected: the Haiku 5.5 batch's first OFF op is a T1 (512, OFF) => 400 => arm isolated; gpt continues
  const B = tmp('B'); const goB = path.join(WORK, 'go.B.json'); writeFileSync(goB, syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, campaignDir: B }));
  // the simulated provider is created per batch (index restarts): fault 0 hits the first op of every batch, but only an Anthropic body with thinking disabled is rejected
  const rb = await runAuthorized({ planFile: pilotFile, goFile: goB, campaignDir: B, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, offline: { faults: { 0: 'reject_disabled' } } });
  const row = rb.executed.find((e) => e.model === H55)!;
  // VNEXT-F (R17-V-5): the OFF CONDITION of the model is isolated, its ON operations (T3) still run, the other models continue
  assert.deepEqual([row.outcome, row.stoppedBy, row.disposition, rb.isolatedModels, rb.isolatedConditions, rb.haltReason], ['DONE', 'STOP_THINKING_DISABLED_REJECTED', 'ISOLATE_CONDITION', [], [`${H55}|OFF`], null]);
  const j55 = verifyJournalText(readFileSync(path.join(B, 'batches', ids.find((x) => x.includes('haiku-5-5'))!, 'journal.jsonl'), 'utf8'));
  const skipped = j55.filter((l) => l.kind === 'SKIPPED_GATE').length; const sent = j55.filter((l) => l.kind === 'SENT').length;
  assert.ok(skipped > 0 && sent > 1, `OFF ops skipped (${skipped}) and ON ops sent (${sent})`);
  assert.ok(rb.executed.filter((e) => e.model !== H55).every((e) => e.outcome === 'DONE'), 'os outros bracos seguem');
});

test('B06 R17-C2-1/2/3/5: idade do preflight julgada no inicio do processo; H2EVAL_* fora do fingerprint; execArgv dentro; journal de campanha corrompido => CAMPAIGN_JOURNAL_INTEGRITY', async () => {
  const dir = tmp('pf'); const T = Date.parse('2026-11-11T10:00:00.000Z');
  const okTls: TlsProbeResult = { authorized: true, authorizationError: null, issuer: 'CN=WE1', subject: 'CN=api.anthropic.com', fingerprint256: 'AA', validFrom: 'x', validTo: 'y', protocol: 'TLSv1.3' };
  const probes: PreflightProbes = { tls: async () => okTls, http: async () => ({ status: 401 }) };
  const probeEnv = { PATH: 'x', SystemRoot: 'y' } as NodeJS.ProcessEnv; // the probe runs WITHOUT the executor's own variables (launch_env.sh)
  await preflightConnectivity({ campaignDir: dir, provider: 'anthropic', env: probeEnv, probes, now: () => T, nodeVersion: 'v24.22.2', execArgv: [] });
  const ts = Date.parse(latestPreflight(dir, 'anthropic')!.tsUtc);
  const execEnv = { ...probeEnv, H2EVAL_ENV_FILE: 'C:/somewhere/env', H2EVAL_STOP_FILE: 's' } as NodeJS.ProcessEnv;
  assert.equal(envFingerprint(execEnv, 'v24.22.2', []), envFingerprint(probeEnv, 'v24.22.2', []), 'R17-C2-2: os nomes proprios do executor nao mudam o fingerprint');
  assert.notEqual(envFingerprint(probeEnv, 'v24.22.2', ['--use-system-ca']), envFingerprint(probeEnv, 'v24.22.2', []), 'R17-C2-3: flags do Node entram');
  const fp = envFingerprint(probeEnv, 'v24.22.2', []);
  assert.equal(preflightGate(dir, 'anthropic', { envFingerprint: fp, nowMs: ts + 10 * 60_000 }), null);
  assert.equal(preflightGate(dir, 'anthropic', { envFingerprint: fp, nowMs: ts + 3 * 3_600_000 }), 'PREFLIGHT_CONNECTIVITY_STALE');
  // R17-C2-1: realPreconditions judges the age at preflightNowMs (run-authorized start), not at the batch's own nowMs
  const b = selectBatch(pilot, pilot.batches.find((x) => x.provider === 'anthropic')!.batchId);
  const late = realPreconditions(pilot, b, { realFlag: true, executorCodeSha: SHA, env: {}, nowMs: ts + 3 * 3_600_000, campaignDir: dir });
  assert.ok(late.some((c) => c.startsWith('PREFLIGHT_CONNECTIVITY_STALE')), 'sem o instante de inicio, o lote tardio ficaria STALE');
  const judgedAtStart = realPreconditions(pilot, b, { realFlag: true, executorCodeSha: SHA, env: {}, nowMs: ts + 3 * 3_600_000, preflightNowMs: ts + 60_000, campaignDir: dir });
  assert.ok(!judgedAtStart.some((c) => c.startsWith('PREFLIGHT_CONNECTIVITY_STALE')), judgedAtStart.join(';'));
  // R17-C2-5
  writeFileSync(campaignJournalPath(dir), readFileSync(campaignJournalPath(dir), 'utf8') + '{broken');
  assert.throws(() => latestPreflight(dir, 'anthropic'), (e: CampaignJournalError) => e.code === 'CAMPAIGN_JOURNAL_INTEGRITY');
});
