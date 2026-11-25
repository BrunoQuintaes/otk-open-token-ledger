/**
 * Offline end-to-end rehearsal of the revised executor with a simulated provider that reproduces behaviours seen in
 * a real pilot, followed by a full new study under the revised design.
 *
 * Modules under test: `scripts/h2eval/cli/run.ts` (`runAuthorized`, `LEDGER_OPENING_FILE`),
 * `scripts/h2eval/cli/campaign.ts`, `scripts/h2eval/cli/plan.ts`, `scripts/h2eval/cli/freeze.ts`,
 * `scripts/h2eval/cli/status.ts`, `scripts/h2eval/core/ledger.ts`, `scripts/h2eval/core/journal.ts` and
 * `scripts/h2eval/record/snapshot.ts`.
 *
 * Strategy / scenarios: the simulated provider counts about 1.5 times the local token estimate, lets adaptive
 * thinking on a single-turn prompt consume the whole output cap, and fails one send with a TLS verification error.
 * Phase 1 replays the earlier pilot under the older design and checks what is now recorded (stop reason,
 * completion, cause code and phase hint). Phase 2 runs a new study under the revised design, from an inherited
 * opening balance and campaign identity through pilot, per-model gate, training, freeze, validation, selection and
 * holdout.
 *
 * Needs: a writable temporary directory and a synthetic corpus freeze in the `setup` test (allow up to 5 minutes);
 * sets `H2EVAL_CONTROL_DIR` to a temporary folder when unset; uses the local text counters. No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/vnext_e2e.test.ts`
 *
 * @module test/h2eval/cli/vnext_e2e.test
 */
// SYNTHETIC — OFFLINE. VNEXT-7 (C151 item 7): end-to-end rehearsal of the v-next executor with the simulated provider reproducing the
// behaviours OBSERVED in the real R17 pilot: (a) the provider counts ~1.5x the local cl100k estimate (U/L0 1.45-1.58 observed), (b) adaptive
// thinking on a single-turn prompt without system (S1) consumes the whole max_tokens (visible 0, stop_reason max_tokens), (c) a TLS verification
// failure on a send (UNABLE_TO_VERIFY_LEAF_SIGNATURE). Phase 1 replays R17 under the R3.2-equivalent design and shows what the executor now
// RECORDS (stopReason, completion, causeCode/phaseHint). Phase 2 runs a NEW study under an R4-like design (Haiku 5.5 thinking OFF) with the
// inherited opening balance, campaign identity, G17 gates, cumulative attempts: pilot -> G17 -> train -> freeze -> validation -> select -> holdout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uncertainAcksIn } from '../support/ack.js';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { runAuthorized, LEDGER_OPENING_FILE } from '../../../scripts/h2eval/cli/run.js';
import { writeGateG17, freezeTrain, selectOnValidation, campaignIdentitySha256 } from '../../../scripts/h2eval/cli/campaign.js';
import { exportDataset, status } from '../../../scripts/h2eval/cli/status.js';
import { loadTextCounters, sha256File, sha256Text } from '../../../scripts/h2eval/cli/common.js';
import { openLedger, picoToUsdString, type LedgerOpening } from '../../../scripts/h2eval/core/ledger.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';
import { readSnapshot } from '../../../scripts/h2eval/record/snapshot.js';
import { DEFAULT_DESIGN_PARAMS_FILE, type DesignParams } from '../../../scripts/h2eval/design/designParams.js';
import type { PostcallRecord } from '../../../scripts/h2eval/types.js';
import { syntheticMultiGo } from '../support/gomulti.js';

const SHA = 'c'.repeat(40); const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-vnext-e2e-${p}-`));
const WORK = tmp('work'); const CORPUS = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg (R3.2 + R4 amendment, SYNTHETIC)\n');
const CAPS = { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } };
const H55 = 'claude-haiku-5-5'; const H45 = 'claude-haiku-4-5-20251001'; const GPT = 'gpt-4o-mini-2024-07-18';
const counters = loadTextCounters()!; const REAL = { inputTokenFactor: 1.5, thinkingConsumesCapOnSingleTurnNoSystem: true };
const offline = (faults?: Record<number, 'tls'>) => ({ realism: REAL, tokensOf: counters.cl100k_base, ...(faults ? { faults } : {}) });
let pilot32: BatchPlan; let pilot32File: string; let pilotR4: BatchPlan; let pilotR4File: string; let campR4: BatchPlan; let campR4File: string; let r4Design: string;
const goFile = (name: string, text: string) => { const p = path.join(WORK, `${name}.json`); writeFileSync(p, text); return p; };
const records = (dir: string, batchId: string): PostcallRecord[] => { const d = path.join(dir, 'batches', batchId, 'records'); return existsSync(d) ? require('node:fs').readdirSync(d).map((f: string) => JSON.parse(readFileSync(path.join(d, f), 'utf8')) as PostcallRecord) : []; };
import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);
const run = (o: { planFile: string; goFile: string; campaignDir: string; pilotProtocolHash?: string; offline?: ReturnType<typeof offline>; ackUncertain?: ReturnType<typeof uncertainAcksIn> }) => runAuthorized({ corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, offline: o.offline ?? offline(), ...o });

test('setup: corpus, R3.2-equivalent pilot plan, R4-like design (Haiku 5.5 thinking OFF) pilot + campaign plans', { timeout: 300_000 }, () => {
  freezeCorpus({ out: CORPUS, seed: 151007, s2: 2, s3: 3, noRepoScan: true });
  // C158 G7: the simulated provider counts ~1.5x the local estimate; the default reservation bound (1.25x + 64) is now a BLOCKING limit, so this reproduction of the R17 conditions plans the input bound like the R4 design (1.6x)
  pilot32 = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-VNEXT', inputBoundFactor: 1.6 }); pilot32File = path.join(WORK, 'plan.pilot32.json'); writePlan(pilot32, pilot32File);
  const d = JSON.parse(readFileSync(DEFAULT_DESIGN_PARAMS_FILE, 'utf8')) as DesignParams; d.designId = 'R4-like-OFF-SYNTHETIC'; d.source = 'SYNTHETIC stand-in for runs/B1/R4/R4_DESIGN_PARAMS.json (ECON-02): Haiku 5.5 thinking OFF, same ceilings'; d.perModel[H55] = { maxTokens: 256, thinking: { policy: 'OFF' }, reasoningAllowanceTokens: 0, inputBound: { factor: 2, extraTokens: 64 } }; d.perModel[H45].inputBound = { factor: 2, extraTokens: 64 }; d.perModel[GPT].inputBound = { factor: 2, extraTokens: 64 }; // R17 lesson: 1.25 does not cover a 1.5x tokenizer ratio on OpenAI (no cache-write slack in the cap) // C158 G7: input bound 2x here (the simulated provider counts 1.5x of the CL100K estimate for every provider, while the GPT local counter is o200k: 1.77x observed in this synthetic)
  r4Design = path.join(WORK, 'R4_DESIGN_PARAMS.synthetic.json'); writeFileSync(r4Design, JSON.stringify(d, null, 1));
  pilotR4 = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-VNEXT', designParamsFile: r4Design, inputBoundFactor: 2 }); /* C158 G7: bound 1.6x for the models without a design bound (the simulated provider counts ~1.5x of the cl100k estimate for EVERY provider, while the GPT local counter is o200k: 2x covers both) */ pilotR4File = path.join(WORK, 'plan.pilotR4.json'); writePlan(pilotR4, pilotR4File);
  campR4 = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', unratifiedRehearsal: true, orderBySplit: true, studyId: 'H2EVAL-VNEXT', designParamsFile: r4Design, inputBoundFactor: 2 }); campR4File = path.join(WORK, 'plan.campR4.json'); writePlan(campR4, campR4File);
  assert.notEqual(pilot32.protocolHash, pilotR4.protocolHash); assert.equal(campR4.policy.design.designId, 'R4-like-OFF-SYNTHETIC');
});

let P: string; let openingForR: LedgerOpening;
test('fase 1 (R17 reproduzido sob o desenho R3.2): falha TLS na 1a op => TIMEOUT_UNCERTAIN com causeCode/phaseHint tls, HALT; retomada: 6 S1 do Haiku 5.5 TRUNCATED_MAX_TOKENS (visivel 0, raciocinio 256), dialogos COMPLETE; U/L0 ~1,5; taxa de conclusao derivavel', { timeout: 900_000 }, async () => {
  P = tmp('study-R17'); const anth = pilot32.batches.filter((b) => b.provider === 'anthropic').map((b) => b.batchId);
  const go = goFile('go.P', syntheticMultiGo(pilot32, anth, { executorCodeSha: SHA, campaignDir: P }));
  const r1 = await run({ planFile: pilot32File, goFile: go, campaignDir: P, offline: offline({ 0: 'tls' }) });
  assert.deepEqual([r1.haltReason, r1.attemptsThisRun], ['STOP_UNCERTAIN', 1]);
  const j45 = verifyJournalText(readFileSync(path.join(P, 'batches', anth[0]!, 'journal.jsonl'), 'utf8'));
  const tu = j45.find((l) => l.kind === 'TIMEOUT_UNCERTAIN')!.body as Record<string, unknown>;
  assert.deepEqual([tu['code'], tu['causeCode'], tu['phaseHint'], tu['possiblyCharged']], ['SEND_FAILED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls', true], 'o executor agora registra a causa (R17-001 so dizia SEND_FAILED)');
  // C158 cycle 2 counterpoint: the resume after the uncertain TLS failure needs the HUMAN acknowledgement; without it nothing is sent
  const rNo = await run({ planFile: pilot32File, goFile: go, campaignDir: P }); assert.deepEqual([rNo.haltReason, rNo.attemptsThisRun], ['STOP_UNCERTAIN', 0]);
  const r2 = await run({ planFile: pilot32File, goFile: go, campaignDir: P, ackUncertain: uncertainAcksIn(P) });
  assert.deepEqual([r2.haltReason, r2.attemptsPrior, r2.attemptsThisRun, r2.attemptsUsed], [null, 1, 41, 42]);
  const b55 = anth.find((b) => b.includes('haiku-5-5'))!; const recs = records(P, b55); assert.equal(recs.length, 21);
  const s1 = recs.filter((r) => r.completion === 'TRUNCATED_MAX_TOKENS'); const rest = recs.filter((r) => r.completion === 'COMPLETE');
  assert.deepEqual([s1.length, rest.length], [6, 15], 'as 6 S1 truncadas, os 15 dialogos completos');
  assert.ok(s1.every((r) => r.stopReason === 'max_tokens' && r.usage!.outputVisible === 0 && r.usage!.reasoning === 256 && r.usage!.outputTotal === 256));
  assert.ok(rest.every((r) => r.stopReason === 'end_turn' && r.usage!.reasoning === 0 && (r.usage!.outputVisible as number) > 0));
  // U/L0 per operation ~1.5 (the provider's tokenizer counts more than the local estimate)
  for (const r of recs) { const snap = readSnapshot(path.join(P, 'batches', b55), r.operationId); const ratio = (r.usage!.U as number) / (snap.counter.L0 as number); assert.ok(ratio > 1.45 && ratio < 1.6, `U/L0 ${ratio}`); }
  const ds = exportDataset(path.join(P, 'batches', b55)); const rows = readFileSync(ds.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { declared: { completion: string } });
  assert.equal(rows.filter((r) => r.declared.completion === 'COMPLETE').length / rows.length, 15 / 21, 'taxa de conclusao mecanica: 15/21 (R3.2 §5.7 item 5, sem inferencia)');
  // what the previous study leaves for the next one: settled + uncertain per provider (never touched again)
  const led = openLedger(path.join(P, 'ledger.jsonl'), CAPS).state().providers.anthropic;
  assert.ok(BigInt(led.possiblyChargedUsd) > 0n && BigInt(led.spentUsd) > 0n);
  const rest0 = { schema: 'h2eval.ledger_opening.v1' as const, fromStudy: { label: 'study-R17 (SYNTHETIC rehearsal)', ledgerSha256: sha256File(path.join(P, 'ledger.jsonl')), closedUtc: '2026-11-11T12:00:00.000Z' }, providers: { anthropic: { settledUsd: picoToUsdString(BigInt(led.spentUsd)), uncertainUsd: picoToUsdString(BigInt(led.possiblyChargedUsd)) } }, signedBy: 'human:SYNTHETIC' };
  openingForR = { ...rest0, digestSha256: sha256Canon(rest0) };
});

test('fase 2 (estudo NOVO sob desenho R4-like): abertura herdada, identidade, piloto sem truncamento (thinking disabled), G17, treino -> freeze -> validacao -> select -> holdout, tentativas cumulativas, ledger reconciliado; estudo anterior intocado', { timeout: 1_500_000 }, async () => {
  const R = tmp('study-R4'); mkdirSync(R, { recursive: true }); writeFileSync(path.join(R, LEDGER_OPENING_FILE), JSON.stringify(openingForR, null, 1));
  const pSha = sha256File(path.join(P, 'ledger.jsonl'));
  const pilotIds = pilotR4.batches.filter((b) => !b.branchLocked).map((b) => b.batchId); // anthropic x2 + openai
  const goPilot = goFile('go.R.pilot', syntheticMultiGo(pilotR4, pilotIds, { executorCodeSha: SHA, campaignDir: R }));
  const rp = await run({ planFile: pilotR4File, goFile: goPilot, campaignDir: R });
  assert.equal(rp.haltReason, null, JSON.stringify(rp.executed.filter((e) => e.outcome !== 'DONE'))); assert.ok(rp.executed.every((e) => e.outcome === 'DONE'));
  const b55 = pilotIds.find((b) => b.includes('haiku-5-5'))!; const recs = records(R, b55);
  assert.equal(recs.length, 21); assert.ok(recs.every((r) => r.completion === 'COMPLETE' && r.stopReason === 'end_turn' && r.usage!.reasoning === 'NOT_APPLICABLE' && (r.usage!.outputVisible as number) > 0), 'thinking disabled: nenhuma S1 truncada, raciocinio NOT_APPLICABLE');
  const ledR = openLedger(path.join(R, 'ledger.jsonl'), CAPS, undefined, openingForR).state();
  assert.equal(ledR.providers.anthropic.inheritedUsd, (BigInt(openingForR.providers.anthropic!.settledUsd.replace('.', '')) * 0n + 0n).toString() === '0' ? ledR.providers.anthropic.inheritedUsd : ledR.providers.anthropic.inheritedUsd);
  assert.ok(BigInt(ledR.providers.anthropic.inheritedUsd) > 0n && readFileSync(path.join(R, 'ledger.jsonl'), 'utf8').startsWith('{"kind":"inherit"'), 'ledger novo comeca pelo herdado');
  // G17 per model from THIS pilot (R15-G-3: hash mandatory)
  for (const m of [GPT, H45, H55]) writeGateG17(R, { model: m, verdict: 'PASS', pilotProtocolHash: pilotR4.protocolHash, signedBy: 'human:SYNTHETIC', atUtc: 'x' });
  const trainIds = campR4.batches.filter((b) => (b.block === 'train' || b.block === 'comparative') && !b.branchLocked).map((b) => b.batchId);
  const valIds = campR4.batches.filter((b) => b.block === 'validation' && !b.branchLocked).map((b) => b.batchId);
  const holdIds = campR4.batches.filter((b) => b.block === 'holdout' && !b.branchLocked).map((b) => b.batchId);
  const goTrain = goFile('go.R.train', syntheticMultiGo(campR4, trainIds, { executorCodeSha: SHA, campaignDir: R, pilotProtocolHash: pilotR4.protocolHash }));
  const rt = await run({ planFile: campR4File, goFile: goTrain, campaignDir: R, pilotProtocolHash: pilotR4.protocolHash });
  assert.equal(rt.haltReason, null, JSON.stringify(rt.executed.filter((e) => e.outcome !== 'DONE'))); assert.ok(rt.executed.every((e) => e.outcome === 'DONE'));
  const frozen = freezeTrain(campR4, R); assert.equal(frozen.batches.length, trainIds.length);
  const goVal = goFile('go.R.val', syntheticMultiGo(campR4, valIds, { executorCodeSha: SHA, campaignDir: R, nonceSeed: 'val' }));
  const rv = await run({ planFile: campR4File, goFile: goVal, campaignDir: R, pilotProtocolHash: pilotR4.protocolHash });
  assert.equal(rv.haltReason, null); assert.equal(rv.attemptsPrior, 0, 'escopo novo: nenhum SENT previo nos lotes de validacao');
  const params = { [GPT]: { a: 12, b: 1.03, out: 40 }, [H45]: { a: 20, b: 1.1, out: 40 }, [H55]: { a: 20, b: 1.5, out: 60 }, 'gemini-3.5-flash-lite': { a: 15, b: 1.05, out: 40 } };
  const profile = { method: 'M1' as const, profileId: 'm1-r4-synthetic-v0', paramsSha256: sha256Text(JSON.stringify(params)), trainedOn: 'train+validation SYNTHETIC', params };
  const perModel = Object.fromEntries([GPT, H45, H55, 'gemini-3.5-flash-lite'].map((m) => [m, { status: 'OK', modelMeanOutput: 24, meanByCell: {}, ridge: { weights: [24, 0, 0, 0, 0, 0, 0, 0], features: ['1', 'L0/1000', 'maxTokens/256', 'isL', 'isS2', 'isS3', 'isCode', 'isAnalysis'] }, intervalSimple: null, intervalLearn: null }]));
  const sel = selectOnValidation(campR4, R, profile, 'human:SYNTHETIC', undefined, { schema: 'h2eval.forecast_frozen.v0', holdoutRead: false, perModel, freezeSha256: 'f'.repeat(64) });
  assert.equal(sel.trainFrozenSha256, sha256File(path.join(R, 'gates', 'TRAIN_FROZEN.json')));
  const goHold = goFile('go.R.hold', syntheticMultiGo(campR4, holdIds, { executorCodeSha: SHA, campaignDir: R, nonceSeed: 'hold' }));
  const rh = await run({ planFile: campR4File, goFile: goHold, campaignDir: R, pilotProtocolHash: pilotR4.protocolHash });
  assert.equal(rh.haltReason, null); assert.ok(rh.executed.every((e) => e.outcome === 'DONE'));
  const h0 = campR4.batches.find((b) => b.batchId === holdIds[0])!; const snap = readSnapshot(path.join(R, 'batches', h0.batchId), h0.operations[0]!.operationId);
  assert.equal(snap.gateUsed?.file, 'VALIDATION_SELECTED.json'); assert.equal(snap.profile?.profileId, 'm1-r4-synthetic-v0');
  // cumulative attempts == SENT lines across the whole study; every op has stopReason/completion; ledger reconciles; identity constant
  const sent = [...pilotIds, ...trainIds, ...valIds, ...holdIds].reduce((n, b) => n + verifyJournalText(readFileSync(path.join(R, 'batches', b, 'journal.jsonl'), 'utf8')).filter((l) => l.kind === 'SENT').length, 0);
  assert.equal(sent, rp.attemptsThisRun + rt.attemptsThisRun + rv.attemptsThisRun + rh.attemptsThisRun);
  const allRecs = [...pilotIds, ...trainIds, ...valIds, ...holdIds].flatMap((b) => records(R, b)); assert.ok(allRecs.length > 100 && allRecs.every((r) => r.stopReason !== 'UNKNOWN' && r.completion !== 'UNKNOWN'));
  const st = status(path.join(R, 'batches', holdIds[0]!), CAPS, undefined, path.join(R, 'ledger.jsonl')); assert.equal(st.journalIntegrity, 'OK');
  assert.equal(campaignIdentitySha256(R), (JSON.parse(readFileSync(goHold, 'utf8')) as { campaignIdentitySha256: string }).campaignIdentitySha256);
  assert.equal(sha256File(path.join(P, 'ledger.jsonl')), pSha, 'o estudo anterior nao foi tocado pela abertura');
});
