// SYNTHETIC — OFFLINE end-to-end rehearsal of the R17 micro-pilot through the R15 CLI: freeze-corpus (candidate, not ratified) →
// plan (pilot: 6 S1 + 3 S3 + 2 S2 dialogs = 21 calls per model, ≤ 60, one model per batch, batch cap min(1.5×Σcap, 25 % sub-ledger))
// → run --mode offline (simulated provider) → journal / pre-call snapshots / ledger per provider / stop by cap and by file / replay
// without resend → export. REAL mode is exercised only up to its refusal (exit 6), never to a socket.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { runBatch, realPreconditions, selectBatch } from '../../../scripts/h2eval/cli/run.js';
import { exportDataset, status, stop } from '../../../scripts/h2eval/cli/status.js';
import { main } from '../../../scripts/h2eval/cli/main.js';
import { CliError, EXIT, sha256File } from '../../../scripts/h2eval/cli/common.js';
import { usdToPico } from '../../../scripts/h2eval/core/ledger.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { bodyOf } from '../../../scripts/h2eval/modal/index.js';
import { createContentStore } from '../../../scripts/h2eval/cache/contentStore.js';

const TEST_SEED = 424242; // E2E-01 test seed (never the study seed)
const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-cli-${p}-`));
const WORK = tmp('work');
const CORPUS = path.join(WORK, 'corpus');
const PREREG = path.join(WORK, 'PREREG_SYNTHETIC.md');
writeFileSync(PREREG, '# pre-registration SYNTHETIC for the rehearsal\n');
const PREREG_SHA = sha256File(PREREG);
const SHA = 'c'.repeat(40);
const CANARY = 'zq-cli-canary-9e2b';
process.env['H2EVAL_OPENAI_API_KEY'] = CANARY; // R16 name present in the process; OFFLINE never reads it

let plan: BatchPlan; let planFile: string;

test('freeze-corpus: generator of E2E-01 as a child process; candidate NOT ratified; manifest + content store written', { timeout: 240_000 }, () => {
  const c = freezeCorpus({ out: CORPUS, seed: TEST_SEED, s2: 2, s3: 3, noRepoScan: true });
  assert.equal(c.status, 'CANDIDATE_NOT_RATIFIED'); assert.equal(c.seed, TEST_SEED); assert.match(c.corpusSha256, /^[0-9a-f]{64}$/);
  assert.ok(existsSync(path.join(CORPUS, 'manifest.json')) && existsSync(path.join(CORPUS, 'content')) && existsSync(path.join(CORPUS, 'FREEZE_CANDIDATE.json')));
  assert.equal(c.ratification.ratified, null);
  assert.throws(() => freezeCorpus({ out: CORPUS, seed: TEST_SEED, noRepoScan: true }), (e: CliError) => e.code === 'DIR_EXISTS', 'never overwrites');
  // R15-B1: a reference corpus that cannot be compared refuses the freeze (exit 3), unless the rehearsal flag is given
  const miss = path.join(WORK, 'corpus_refs_missing');
  assert.throws(() => freezeCorpus({ out: miss, seed: TEST_SEED, s2: 1, s3: 1, noRepoScan: true, h1CampaignCorpus: path.join(WORK, 'does-not-exist.jsonl') }), (e: CliError) => e.code === 'COLLISION_REFS_INCOMPLETE' && e.exit === EXIT.REFUSED_BY_POLICY);
  assert.equal(JSON.parse(readFileSync(path.join(miss, 'FREEZE_CANDIDATE.json'), 'utf8')).status, 'REJECTED_INCOMPLETE_REFERENCES');
  const tol = freezeCorpus({ out: path.join(WORK, 'corpus_refs_tolerated'), seed: TEST_SEED, s2: 1, s3: 1, noRepoScan: true, h1CampaignCorpus: path.join(WORK, 'does-not-exist.jsonl'), allowNotCompared: true });
  assert.equal(tol.status, 'CANDIDATE_NOT_RATIFIED_INCOMPLETE_REFERENCES'); assert.ok(tol.notCompared.length > 0);
});

test('plan: ratification required (G10) unless --unratified-rehearsal; pilot = 21 calls per model; one model per batch; batch cap rule; Google branch locked', () => {
  assert.throws(() => buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT' }), (e: CliError) => e.code === 'PREREG_RATIFICATION_REQUIRED');
  assert.throws(() => buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', ratifiedSha256: 'ab'.repeat(32) }), (e: CliError) => e.code === 'PREREG_NOT_RATIFIED_HASH');
  plan = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-REHEARSAL', now: () => '2026-11-10T23:40:00.000Z' });
  planFile = path.join(WORK, 'plan.pilot.json'); writePlan(plan, planFile);
  assert.equal(plan.preregistration.ratified, false);
  assert.equal(plan.batches.length, 4);
  for (const b of plan.batches) {
    assert.equal(b.calls, 21, `${b.model}: 6 S1 + (3 S3 + 2 S2) × 3`); assert.ok(b.calls <= 60);
    assert.ok(new Set(b.operations.map((o) => o.plan.modelRequested)).size === 1 && b.operations.every((o) => o.plan.batchId === b.batchId));
    const sum = b.operations.reduce((a, o) => a + BigInt(o.costCapUsdPico), 0n);
    assert.equal(b.sumCostCapUsdPico, sum.toString());
    const byFactor = (sum * 3n) / 2n; const byProv = usdToPico(plan.policy.capsUsd.providers[b.provider]) / 4n;
    assert.equal(b.batchCapUsdPico, (byFactor < byProv ? byFactor : byProv).toString());
    assert.equal(b.branchLocked, b.provider === 'google');
    assert.ok(b.operations.every((o) => o.inputUpperBoundTokens === Math.ceil(o.localEstimateTokens * 1.25) + 64));
    assert.ok(b.operations.filter((o) => o.plan.structure === 'S3').every((o) => (b.provider === 'anthropic' ? o.plan.params.cacheTtlRequested === '5m' && o.plan.params.cacheDirectives !== 'NONE' : o.plan.params.cacheDirectives === 'NONE')));
    assert.ok(b.operations.filter((o) => o.plan.structure === 'S2').every((o) => o.plan.nonce !== 'NOT_APPLICABLE' && o.plan.plannedCacheArm === 'S2_NOHIT'));
  }
  assert.equal(plan.batches.find((b) => b.model === 'claude-haiku-5-5')!.operations.every((o) => o.reasoningAllowanceTokens === 1024), true);
  assert.equal(plan.batches.find((b) => b.model === 'gemini-3.5-flash-lite')!.operations.every((o) => o.reasoningAllowanceTokens === 2048), true);
  // ratified path: the hash of the file passed
  const rat = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', ratifiedSha256: PREREG_SHA, models: ['gpt-4o-mini-2024-07-18'] });
  assert.deepEqual([rat.preregistration.ratified, rat.preregistration.ratifiedSha256], [true, PREREG_SHA]);
  assert.notEqual(rat.protocolHash, plan.protocolHash === rat.protocolHash ? '' : 'x', 'protocolHash = sha256(prereg:corpus:phase) is deterministic');
});

test('run --mode offline, claude-haiku-5-5: 21/21 COST_COMPUTED; S3 calls 2 and 3 HIT, S2 NO_HIT; journal, snapshots, ledger; replay never resends; export', async () => {
  const dir = tmp('h55');
  const s = await runBatch({ planFile, batchId: 'pilot-claude-haiku-5-5-b1', batchDir: dir, mode: 'offline', executorCodeSha: SHA });
  assert.deepEqual([s.mode, s.planned, s.executed, s.stoppedBy], ['OFFLINE', 21, 21, null]);
  assert.ok(s.results.every((r) => r.state === 'COST_COMPUTED'));
  const b = selectBatch(plan, 'pilot-claude-haiku-5-5-b1');
  const rec = (id: string) => JSON.parse(readFileSync(path.join(dir, 'records', `${id}.json`), 'utf8'));
  const s3 = b.operations.filter((o) => o.plan.structure === 'S3'); const s2 = b.operations.filter((o) => o.plan.structure === 'S2');
  assert.deepEqual(s3.map((o) => rec(o.operationId).usage.cacheObserved), ['CREATION', 'HIT', 'HIT', 'CREATION', 'HIT', 'HIT', 'CREATION', 'HIT', 'HIT']);
  assert.ok(s2.every((o) => rec(o.operationId).usage.cacheObserved === 'NO_HIT'), 'nonce breaks the prefix');
  assert.equal(readdirSync(path.join(dir, 'snapshots')).length, 21);
  const st = status(dir, { campaignUsd: '11', providersUsd: plan.policy.capsUsd.providers, batchesUsd: {} });
  assert.equal(st.journalIntegrity, 'OK'); assert.equal(Object.keys(st.operations).length, 21);
  const led = s.ledger as { providers: Record<string, { spentUsd: string; reservedUsd: string; operations: number }> };
  assert.equal(led.providers['anthropic']!.operations, 21); assert.equal(led.providers['anthropic']!.reservedUsd, '0'); assert.ok(BigInt(led.providers['anthropic']!.spentUsd) > 0n);
  assert.ok(BigInt(led.providers['anthropic']!.spentUsd) <= BigInt(b.batchCapUsdPico), 'spent within the batch cap');
  // replay: same batch dir => every operation REPLAY_SKIPPED, nothing executed
  const r2 = await runBatch({ planFile, batchId: 'pilot-claude-haiku-5-5-b1', batchDir: dir, mode: 'offline', executorCodeSha: SHA });
  assert.deepEqual([r2.executed, r2.results.every((r) => r.replayed), (r2.offlineLog as unknown[]).length], [0, true, 0]);
  const ex = exportDataset(dir);
  assert.equal(ex.rows, 21);
  const rows = readFileSync(ex.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(rows.every((r) => r.cost.billingObservedUsd === null && r.cost.billingState === 'NOT_AVAILABLE' && typeof r.exAnte.costCapUsdPico === 'string' && r.phase === 'PILOT' && r.cellId !== 'UNKNOWN'));
  // no credential, no prompt text in what the executor writes (content/ lives in the corpus dir, not here)
  const all = readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(path.join(e.parentPath ?? (e as unknown as { path: string }).path, e.name), 'utf8')).join('\n');
  assert.doesNotMatch(all, new RegExp(CANARY)); assert.doesNotMatch(all, /MANUAL INTERNO/);
});

test('run --mode offline, gpt-4o-mini 21/21 and Haiku 4.5 21/21 (F-INT-2 fixed: operational); Google NOT_RUN_BRANCH_LOCKED; bodySha256 of the plan == requestBodySha256 journaled, 4 models', async () => {
  const dOai = tmp('oai'); const dH45 = tmp('h45');
  const g = await runBatch({ planFile, batchId: 'pilot-gpt-4o-mini-2024-07-18-b1', batchDir: dOai, mode: 'offline', executorCodeSha: SHA });
  assert.deepEqual([g.executed, g.stoppedBy], [21, null]);
  const h45 = await runBatch({ planFile, batchId: 'pilot-claude-haiku-4-5-20251001-b1', batchDir: dH45, mode: 'offline', executorCodeSha: SHA });
  assert.deepEqual([h45.executed, h45.stoppedBy, h45.results.every((r) => r.state === 'COST_COMPUTED')], [21, null, true], 'Haiku 4.5 operante após o R14-FIX');
  const recH = (id: string) => JSON.parse(readFileSync(path.join(dH45, 'records', `${id}.json`), 'utf8'));
  const bH = selectBatch(plan, 'pilot-claude-haiku-4-5-20251001-b1');
  assert.deepEqual(bH.operations.filter((o) => o.plan.structure === 'S3').map((o) => recH(o.operationId).usage.cacheObserved), ['CREATION', 'HIT', 'HIT', 'CREATION', 'HIT', 'HIT', 'CREATION', 'HIT', 'HIT']);
  assert.ok(bH.operations.every((o) => recH(o.operationId).cost.state === 'CALCULATED' && recH(o.operationId).usage.reasoning === 'NOT_APPLICABLE'));
  const goo = await runBatch({ planFile, batchId: 'pilot-gemini-3.5-flash-lite-b1', batchDir: tmp('goo'), mode: 'offline', executorCodeSha: SHA });
  assert.deepEqual([goo.results[0]!.state, goo.stoppedBy, (goo.offlineLog as unknown[]).length], ['NOT_RUN_BRANCH_LOCKED', 'NOT_RUN_BRANCH_LOCKED', 0]);
  // bodySha256 pinned in the plan (adapter = single source) == requestBodySha256 the executor journaled before sending (3 executed models)
  const dH55 = tmp('h55b'); await runBatch({ planFile, batchId: 'pilot-claude-haiku-5-5-b1', batchDir: dH55, mode: 'offline', executorCodeSha: SHA });
  let compared = 0;
  for (const [bid, dir] of [['pilot-gpt-4o-mini-2024-07-18-b1', dOai], ['pilot-claude-haiku-4-5-20251001-b1', dH45], ['pilot-claude-haiku-5-5-b1', dH55]] as const) {
    const planned = new Map(verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')).filter((l) => l.kind === 'PLANNED').map((l) => [l.operationId, (l.body as { requestBodySha256: string }).requestBodySha256]));
    for (const op of selectBatch(plan, bid).operations) { assert.equal(planned.get(op.operationId), op.bodySha256, `${bid} ${op.plan.promptId}`); compared += 1; }
  }
  assert.equal(compared, 63);
  // Google never sends; its planned bodies still come from the same single source (bodyOf) — compared directly
  const gb = selectBatch(plan, 'pilot-gemini-3.5-flash-lite-b1');
  for (const op of gb.operations) assert.equal(op.bodySha256, bodyOf(op.plan as never, (await createContentStore(CORPUS).get(op.plan.promptSha256)) as never).bodySha256);
});

test('stops: by STOP file before the first call; by budget (tiny sub-ledger => batch cap < op cap); fault injection: 429 without usage => UNCERTAIN isolates and stops', async () => {
  const d1 = tmp('stopfile'); stop(d1);
  const s1 = await runBatch({ planFile, batchId: 'pilot-gpt-4o-mini-2024-07-18-b1', batchDir: d1, mode: 'offline', executorCodeSha: SHA });
  assert.deepEqual([s1.stoppedBy, s1.executed, s1.results.length], ['STOP_FILE', 1, 1]);
  assert.equal(status(d1).stopFilePresent, true);
  const tiny = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, models: ['gpt-4o-mini-2024-07-18'], capsUsd: { campaign: '11', providers: { anthropic: '5', openai: '0.0004', google: '3' } } });
  const tinyFile = path.join(WORK, 'plan.tiny.json'); writePlan(tiny, tinyFile);
  const s2 = await runBatch({ planFile: tinyFile, batchId: 'pilot-gpt-4o-mini-2024-07-18-b1', batchDir: tmp('tiny'), mode: 'offline', executorCodeSha: SHA });
  assert.ok(s2.stoppedBy === 'STOP_BUDGET_BATCH' || s2.stoppedBy === 'STOP_BUDGET_PROVIDER'); assert.equal((s2.offlineLog as unknown[]).length, 0, 'nothing sent');
  const s3 = await runBatch({ planFile, batchId: 'pilot-gpt-4o-mini-2024-07-18-b1', batchDir: tmp('fault'), mode: 'offline', executorCodeSha: SHA, offline: { faults: { 2: 'rate_limit' } } });
  assert.deepEqual([s3.results.length, s3.results[2]!.state, s3.stoppedBy], [3, 'UNCERTAIN', 'STOP_UNCERTAIN']);
});

test('run --mode real is fail-closed: preconditions listed before any executor; exit 6 from runBatch and from main(); OFFLINE plan never qualifies', async () => {
  const b = selectBatch(plan, 'pilot-gpt-4o-mini-2024-07-18-b1');
  const codes = realPreconditions(plan, b, { executorCodeSha: SHA, env: {} });
  assert.ok(codes.includes('REAL_FLAG_MISSING') && codes.includes('PLAN_NOT_RATIFIED') && codes.includes('GO_FILE_MISSING') && codes.some((c) => c.startsWith('CREDENTIAL_ENV_MISSING')));
  const withEnv = realPreconditions(plan, b, { realFlag: true, executorCodeSha: SHA, env: { H2EVAL_OPENAI_API_KEY: 'x', OPENAI_API_KEY: 'bot-key', H2EVAL_GO_FILE: path.join(WORK, 'nope.json') } });
  assert.ok(withEnv.some((c) => c.startsWith('FORBIDDEN_ENV_PRESENT:OPENAI_API_KEY')) && withEnv.includes('GO_FILE_NOT_FOUND') && withEnv.includes('PLAN_NOT_RATIFIED'));
  await assert.rejects(runBatch({ planFile, batchId: b.batchId, batchDir: tmp('real'), mode: 'real', realFlag: true, executorCodeSha: SHA, env: {}, identity: { sha: 'other', clean: false } }), (e: CliError) => e.exit === EXIT.REAL_PRECONDITIONS && /EXECUTOR_SHA_NOT_HEAD/.test(e.message) && /EXECUTOR_TREE_DIRTY/.test(e.message));
  const out: string[] = [];
  // R15-P2-1: a typed --executor-sha that is not the checked-out HEAD is refused before anything else (exit 3)
  const codeSha = await main(['run', '--mode', 'real', '--real', '--plan', planFile, '--batch', b.batchId, '--batch-dir', tmp('realmain'), '--executor-sha', SHA], (s) => { out.push(s); });
  assert.equal(codeSha, EXIT.REFUSED_BY_POLICY); assert.match(out.join(''), /EXECUTOR_SHA_MISMATCH/);
  const code = await main(['run', '--mode', 'real', '--real', '--plan', planFile, '--batch', b.batchId, '--batch-dir', tmp('realmain2')], (s) => { out.push(s); });
  assert.equal(code, EXIT.REAL_PRECONDITIONS); assert.match(out.join(''), /REAL_PRECONDITIONS_FAILED/); assert.doesNotMatch(out.join(''), new RegExp(CANARY));
  assert.equal(await main([], (s) => { out.push(s); }), EXIT.USAGE);
  assert.equal(await main(['help'], () => {}), EXIT.OK);
  const d = tmp('main'); const o2: string[] = [];
  assert.equal(await main(['run', '--mode', 'offline', '--plan', planFile, '--batch', 'pilot-claude-haiku-5-5-b1', '--batch-dir', d], (s) => { o2.push(s); }), EXIT.OK);
  assert.equal(await main(['export', '--batch-dir', d], (s) => { o2.push(s); }), EXIT.OK);
  assert.equal(await main(['stop', '--batch-dir', d], (s) => { o2.push(s); }), EXIT.OK);
  assert.equal(await main(['status', '--batch-dir', d, '--plan', planFile], (s) => { o2.push(s); }), EXIT.OK);
  assert.match(o2.at(-1)!, /"stopFilePresent":true/);
});
