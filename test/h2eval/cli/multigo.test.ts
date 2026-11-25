/**
 * Tests the multi-batch GO file (one signed go-ahead scope covering several batches) and the execution policy of
 * `runAuthorized`.
 *
 * Modules under test: `scripts/h2eval/core/egress.ts` (`validateGoMultiV1`), `scripts/h2eval/cli/run.ts`
 * (`runAuthorized`, `STOP_POLICY`, `dispositionOf`), `scripts/h2eval/cli/campaign.ts`,
 * `scripts/h2eval/cli/common.ts` (directory lock) and `scripts/h2eval/core/ledger.ts`.
 *
 * Strategy / partitions: invalid GO files (expired, reused nonce, batch outside the plan, wrong executor SHA,
 * wildcard scope, attempt limit above the scope or the global maximum, cap mismatch); a pilot run (batches done,
 * Google skipped without its own gate, a started batch's nonce not reopened by a new GO file, out-of-scope
 * batch refused); a campaign run (per-model gate, where a failing model is skipped and the others continue; the
 * study ledger inherits the pilot spend; the global campaign lock); crossing 80% of a sub-ledger with and without
 * the signed pre-approval up to 100%; the attempt-limit stop; and the stop-policy table. The REAL mode is exercised only up
 * to its refusal.
 *
 * Needs: a writable temporary directory and a synthetic corpus frozen in the `setup` test (allow up to 5 minutes);
 * sets `H2EVAL_CONTROL_DIR` to a temporary folder when unset (through `../support/gomulti.ts`). No network, no
 * credential.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/multigo.test.ts`
 *
 * @module test/h2eval/cli/multigo.test
 */
// SYNTHETIC — OFFLINE. C144: multi-batch GO (h2eval.go.multi.v1) negatives and the execution policy: expired GO, reused nonce, batch outside
// the plan, wrong executor SHA, wildcard scope, maxAttempts above scope / above 1446, caps mismatch; G17 FAIL isolates ONE model and the
// others continue; Google needs G16-GOOGLE + listing; shared study ledger (pilot spend inherited by the campaign); global campaign lock;
// 80 % crossing with and without preAuthorizeTo100pct (future reservations that overflow => stop even when pre-authorised); maxAttempts stop;
// STOP_POLICY table. REAL is exercised only to its refusal. No network, no credential.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { runAuthorized, STOP_POLICY, dispositionOf } from '../../../scripts/h2eval/cli/run.js';
import { writeGateG17, freezeTrain, campaignIdentitySha256 } from '../../../scripts/h2eval/cli/campaign.js';
import { CliError, EXIT, acquireDirLock, DirLockedError } from '../../../scripts/h2eval/cli/common.js';
import { validateGoMultiV1 } from '../../../scripts/h2eval/core/egress.js';
import { openLedger } from '../../../scripts/h2eval/core/ledger.js';
import { syntheticMultiGo, nonceFor } from '../support/gomulti.js';

const TEST_SEED = 424242; const SHA = 'c'.repeat(40);
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-multigo-${p}-`));
const WORK = tmp('work'); const CORPUS = path.join(WORK, 'corpus');
const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg\n');
let pilot: BatchPlan; let camp: BatchPlan; let pilotFile: string; let campFile: string;
const goFile = (name: string, text: string) => { const p = path.join(WORK, `${name}.json`); writeFileSync(p, text); return p; };
const CAPS = { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } };
const allowed = (o: Parameters<typeof runAuthorized>[0]) => runAuthorized(o);

test('setup: corpus + pilot + campaign plans', { timeout: 300_000 }, () => {
  freezeCorpus({ out: CORPUS, seed: TEST_SEED, s2: 2, s3: 3, noRepoScan: true });
  pilot = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-MULTI' });
  camp = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', unratifiedRehearsal: true, orderBySplit: true, studyId: 'H2EVAL-MULTI' });
  pilotFile = path.join(WORK, 'plan.pilot.json'); campFile = path.join(WORK, 'plan.campaign.json'); writePlan(pilot, pilotFile); writePlan(camp, campFile);
  assert.equal(pilot.studyId, camp.studyId);
});

test('piloto via GO multilote: 3 lotes DONE, Google SKIPPED_GATE (sem G16-GOOGLE); nonce de lote iniciado nao reabre por GO novo; lote fora do escopo do GO recusado; trinco de campanha', { timeout: 300_000 }, async () => {
  const dir = path.join(WORK, 'study');
  const ids = pilot.batches.map((b) => b.batchId); // includes Google: it must be SKIPPED_GATE, not run
  const go = goFile('go.pilot', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, providers: ['anthropic', 'openai', 'google'], campaignDir: dir }));
  const r = await allowed({ planFile: pilotFile, goFile: go, campaignDir: dir, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA });
  assert.equal(r.haltedAt, null);
  assert.deepEqual(r.executed.map((e) => e.outcome), ['DONE', 'DONE', 'SKIPPED_GATE', 'DONE'], 'ordem do plano; Google e o 3o');
  assert.ok(r.executed[2]!.reason!.includes('G16-GOOGLE')); assert.deepEqual(r.isolatedModels, ['gemini-3.5-flash-lite']);
  assert.equal(r.attemptsUsed, 63); assert.equal(r.maxAttempts, 84);
  assert.ok(existsSync(path.join(dir, 'ledger.jsonl')) && !existsSync(path.join(dir, 'batches', ids[0]!, 'ledger.jsonl')), 'ledger de estudo compartilhado, nao por lote');
  assert.ok(!existsSync(path.join(dir, '.campaign.lock')), 'trinco liberado');
  // replay under the SAME GO: nothing resent, nonce registry accepts SAME
  const r2 = await allowed({ planFile: pilotFile, goFile: go, campaignDir: dir, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA });
  assert.equal(r2.attemptsThisRun, 0); assert.equal(r2.attemptsUsed, 63, 'R15-G-4: cumulativo = SENT ja presentes no escopo'); assert.ok(r2.executed.filter((e) => e.provider !== 'google').every((e) => e.outcome === 'DONE' && e.executed === 0));
  // a NEW GO (other nonces) for an already started batch is refused: no reopening without the original nonce
  const go2 = goFile('go.pilot.other', syntheticMultiGo(pilot, [ids[0]!], { executorCodeSha: SHA, nonceSeed: 'other', campaignDir: dir }));
  const r3 = await allowed({ planFile: pilotFile, goFile: go2, campaignDir: dir, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA });
  assert.deepEqual([r3.executed[0]!.outcome, r3.executed[0]!.stoppedBy, r3.haltReason], ['STOPPED', 'GO_NONCE_MISMATCH_FOR_STARTED_BATCH', 'GO_NONCE_MISMATCH_FOR_STARTED_BATCH']);
  // the same nonce value used for a DIFFERENT (never started) batch is refused too: fresh study, batch 0 started under nonce n0, then a GO for batch 1 carrying n0
  const dir2 = path.join(WORK, 'study-reuse');
  const first = await allowed({ planFile: pilotFile, goFile: goFile('go.reuse.first', syntheticMultiGo(pilot, [ids[0]!], { executorCodeSha: SHA, campaignDir: dir2 })), campaignDir: dir2, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA });
  assert.equal(first.executed[0]!.outcome, 'DONE');
  const bad = JSON.parse(syntheticMultiGo(pilot, [ids[1]!], { executorCodeSha: SHA, nonceSeed: 'seed', campaignDir: dir2 })); bad.nonces[ids[1]!] = nonceFor('seed', ids[0]!);
  const { sha256Canon } = await import('../../../scripts/h2eval/core/canon.js'); delete bad.goDigestSha256; bad.goDigestSha256 = sha256Canon(bad);
  const r4 = await allowed({ planFile: pilotFile, goFile: goFile('go.pilot.reuse', JSON.stringify(bad)), campaignDir: dir2, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA });
  assert.deepEqual([r4.haltReason, r4.attemptsThisRun], ['GO_NONCE_REUSED', 0]);
  // campaign lock: while held by a live pid, a second runner is refused
  const release = acquireDirLock(dir); writeFileSync(path.join(dir, '.campaign.lock'), JSON.stringify({ pid: process.ppid }));
  assert.throws(() => acquireDirLock(dir), DirLockedError); release();
});

test('campanha via GO multilote: G17 exigido por modelo (FAIL => SKIPPED_GATE, os outros seguem); ledger compartilhado herda o gasto do piloto; trava de validacao faz PARAR e esperar; REAL recusado; STOP_POLICY', { timeout: 600_000 }, async () => {
  const dir = path.join(WORK, 'study');
  const trainIds = camp.batches.filter((b) => (b.block === 'train' || b.block === 'comparative') && !b.branchLocked).map((b) => b.batchId);
  const valIds = camp.batches.filter((b) => b.block === 'validation' && !b.branchLocked).map((b) => b.batchId);
  const go = goFile('go.camp', syntheticMultiGo(camp, [...trainIds, ...valIds], { executorCodeSha: SHA, campaignDir: dir }));
  // no G17 at all => every campaign batch SKIPPED_GATE, nothing sent
  const r0 = await allowed({ planFile: campFile, goFile: go, campaignDir: dir, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, pilotProtocolHash: pilot.protocolHash });
  assert.ok(r0.executed.every((e) => e.outcome === 'SKIPPED_GATE') && r0.attemptsUsed === 0);
  writeGateG17(dir, { model: 'gpt-4o-mini-2024-07-18', verdict: 'PASS', pilotProtocolHash: pilot.protocolHash, signedBy: 'human:SYNTHETIC', atUtc: 'x' });
  writeGateG17(dir, { model: 'claude-haiku-5-5', verdict: 'PASS', pilotProtocolHash: pilot.protocolHash, signedBy: 'human:SYNTHETIC', atUtc: 'x' });
  writeGateG17(dir, { model: 'claude-haiku-4-5-20251001', verdict: 'FAIL', pilotProtocolHash: pilot.protocolHash, signedBy: 'human:SYNTHETIC', atUtc: 'x' });
  assert.throws(() => writeGateG17(dir, { model: 'claude-haiku-5-5', verdict: 'FAIL', pilotProtocolHash: pilot.protocolHash, signedBy: 'human:SYNTHETIC', atUtc: 'x' }), (e: CliError) => e.code === 'GATE_ALREADY_WRITTEN');
  // train runs for the two PASS models; Haiku 4.5 isolated; validation halts at the gate (TRAIN_FROZEN missing) and WAITS
  const r1 = await allowed({ planFile: campFile, goFile: go, campaignDir: dir, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, pilotProtocolHash: pilot.protocolHash });
  const byId = Object.fromEntries(r1.executed.map((e) => [e.batchId, e]));
  assert.ok(trainIds.filter((id) => id.includes('haiku-4-5')).every((id) => byId[id]!.outcome === 'SKIPPED_GATE' && /G17 FAIL|arm isolated/.test(byId[id]!.reason!)));
  assert.ok(trainIds.filter((id) => !id.includes('haiku-4-5')).every((id) => byId[id]!.outcome === 'DONE'));
  assert.equal(r1.haltReason, 'GATE_TRAIN_NOT_FROZEN'); assert.ok(r1.executed.some((e) => e.outcome === 'HALTED_BEFORE'));
  // a wrong pilot protocol hash invalidates the G17 artifacts
  const rw = await allowed({ planFile: campFile, goFile: go, campaignDir: dir, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, pilotProtocolHash: '0'.repeat(64) });
  assert.ok(rw.executed.every((e) => e.outcome === 'SKIPPED_GATE' && /WRONG_PILOT|arm isolated/.test(e.reason ?? '')));
  // shared ledger: pilot spend + campaign spend in ONE ledger; providers aggregated
  const led = openLedger(path.join(dir, 'ledger.jsonl'), CAPS).state();
  assert.ok(BigInt(led.providers.openai.spentUsd) > 0n && BigInt(led.providers.anthropic.spentUsd) > 0n && led.providers.openai.operations > 21, 'piloto (21) + treino do gpt-4o-mini no mesmo sub-ledger');
  // STOP_POLICY: budget/ledger/uncertain halt all; model-specific isolate
  assert.equal(dispositionOf('STOP_BUDGET_PROVIDER'), 'HALT_ALL'); assert.equal(dispositionOf('STOP_UNCERTAIN'), 'HALT_ALL'); assert.equal(dispositionOf('PAUSE_REVIEW_AT_80PCT'), 'HALT_ALL'); assert.equal(dispositionOf('STOP_CAP_VIOLATION'), 'HALT_ALL');
  assert.equal(dispositionOf('STOP_CONSECUTIVE_FAILURES'), 'ISOLATE_ARM'); assert.equal(dispositionOf('STOP_PRICE_UNKNOWN'), 'ISOLATE_ARM'); assert.equal(dispositionOf('SOMETHING_NEW'), 'HALT_ALL', 'na duvida, para tudo');
  assert.equal(Object.keys(STOP_POLICY).length, 25); /* +STOP_INPUT_ABOVE_RESERVATION +STOP_INPUT_RESERVE_POLICY +STOP_MODEL_PROBE_FAILED (C158) */ assert.equal(dispositionOf('STOP_THINKING_DISABLED_REJECTED'), 'ISOLATE_CONDITION'); assert.equal(dispositionOf('PAUSE_PROBE_GATE'), 'HALT_ALL'); assert.equal(dispositionOf('STOP_STOP_REASON_MISSING'), 'HALT_ALL');
  // freeze-train requires EVERY train batch terminal: Haiku 4.5 (isolated, never run) blocks the freeze — its arm must be removed from the plan or run under a later GO
  assert.throws(() => freezeTrain(camp, dir), (e: CliError) => e.code === 'TRAIN_BATCH_NOT_TERMINAL');
  // REAL: refused before any executor, never a socket. An unratified plan has no ratified hash => in REAL the GO is refused (GO_PREREG_UNCONFIGURED), whatever the tree
  await assert.rejects(allowed({ planFile: campFile, goFile: go, campaignDir: dir, corpusDir: CORPUS, mode: 'real', realFlag: true, executorCodeSha: SHA, identity: { sha: SHA, clean: true }, env: {}, pilotProtocolHash: pilot.protocolHash }), (e: CliError) => e.code === 'GO_PREREG_UNCONFIGURED' && e.exit === EXIT.REFUSED_BY_POLICY);
  // the validator itself, with a ratified hash configured, refuses a dirty tree (REAL) and a wrong SHA before anything else
  const vctx = { campaignDirCanonical: null as string | null, campaignIdentitySha256: campaignIdentitySha256(dir), campaign: camp.studyId, preregistrationSha256: camp.preregistration.sha256, executorCodeSha: SHA, treeClean: false as boolean | null, planProtocolHash: camp.protocolHash, planBatchIds: camp.batches.map((b) => b.batchId), plannedOpsInScope: (x: readonly string[]) => camp.batches.filter((b) => x.includes(b.batchId)).reduce((a, b) => a + b.calls, 0), ledgerCaps: CAPS, nowMs: Date.now() };
  assert.equal(validateGoMultiV1(readFileSync(go, 'utf8'), vctx), 'GO_EXECUTOR_TREE_DIRTY');
  assert.equal(validateGoMultiV1(readFileSync(go, 'utf8'), { ...vctx, treeClean: true }), null);
});

// D144-06 (80 % with / without preAuthorizeTo100pct, future reservations overflowing, STOP_MAX_ATTEMPTS) lives in test/h2eval/core/preauth.test.ts:
// a multi GO can only carry the default caps (GO_CAPS_MISMATCH otherwise), so the checkpoint is exercised at the executor level with a shared study ledger.
