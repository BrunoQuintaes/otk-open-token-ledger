// SYNTHETIC — OFFLINE. VNEXT-3 (C151 item 3): the four reserves of the final G15 on d2c60a98.
//  R15-G-1 the multi GO pins an immutable campaign identity (CAMPAIGN_IDENTITY.json): the same GO in a second directory is refused;
//  R15-G-2 the GO nonce is committed only after the batch's first PLANNED: a batch halted by a split gate leaves no row and runs later under a new GO;
//  R15-G-3 --pilot-protocol-hash is mandatory for any batch outside the pilot block; a GO may pin it and must agree;
//  R15-G-4 maxAttempts is cumulative across processes (SENT lines in the scoped journals).
// VNEXT-4: REAL refuses a launch environment with variable NAMES outside the documented allowlist (values never read).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { uncertainAcksIn } from '../support/ack.js';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { runAuthorized, realPreconditions, selectBatch } from '../../../scripts/h2eval/cli/run.js';
import { initCampaignIdentity, campaignIdentitySha256, writeGateG17, freezeTrain, checkNonce, countSentInScope } from '../../../scripts/h2eval/cli/campaign.js';
import { CliError, EXIT } from '../../../scripts/h2eval/cli/common.js';
import { validateGoMultiV1 } from '../../../scripts/h2eval/core/egress.js';
import { syntheticMultiGo } from '../support/gomulti.js';

const SHA = 'c'.repeat(40); const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-reserves-${p}-`));
const WORK = tmp('work'); const CORPUS = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg\n');
let pilot: BatchPlan; let camp: BatchPlan; let pilotFile: string; let campFile: string;
const goFile = (name: string, text: string) => { const p = path.join(WORK, `${name}.json`); writeFileSync(p, text); return p; };
const nonceRows = (dir: string) => (existsSync(path.join(dir, 'go_nonces.jsonl')) ? readFileSync(path.join(dir, 'go_nonces.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { batchId: string; nonce: string; campaignIdentitySha256: string | null }) : []);
const run = (o: Partial<Parameters<typeof runAuthorized>[0]> & { goFile: string; campaignDir: string; planFile: string }) => runAuthorized({ corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, ...o });

test('setup', { timeout: 300_000 }, () => {
  freezeCorpus({ out: CORPUS, seed: 151003, s2: 2, s3: 3, noRepoScan: true });
  pilot = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-RESERVES' });
  camp = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', unratifiedRehearsal: true, orderBySplit: true, studyId: 'H2EVAL-RESERVES' });
  pilotFile = path.join(WORK, 'plan.pilot.json'); campFile = path.join(WORK, 'plan.campaign.json'); writePlan(pilot, pilotFile); writePlan(camp, campFile);
});

test('R15-G-1: o GO pina a identidade da campanha; mesmo GO em OUTRO diretorio => GO_CAMPAIGN_IDENTITY_MISMATCH (0 execucoes); diretorio sem identidade => MISSING; identidade nunca reescrita', { timeout: 600_000 }, async () => {
  const A = tmp('A'); const ids = pilot.batches.filter((b) => b.provider === 'anthropic').map((b) => b.batchId);
  const go = goFile('go.A', syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, campaignDir: A }));
  const idA = campaignIdentitySha256(A)!; assert.match(idA, /^[0-9a-f]{64}$/);
  assert.equal((JSON.parse(readFileSync(go, 'utf8')) as { campaignIdentitySha256: string }).campaignIdentitySha256, idA);
  const rA = await run({ planFile: pilotFile, goFile: go, campaignDir: A });
  assert.deepEqual([rA.haltReason, rA.campaignIdentitySha256, rA.executed.every((e) => e.outcome === 'DONE')], [null, idA, true]);
  assert.ok(nonceRows(A).every((r) => r.campaignIdentitySha256 === idA), 'linhas de nonce carregam a identidade');
  // a second directory, initialised on its own, has another identity: the SAME GO cannot execute there (the d2c60a98 attack: 126 ops for 63)
  const B = tmp('B'); initCampaignIdentity(B, { studyId: pilot.studyId, corpusSha256: pilot.corpus.corpusSha256, createdBy: 'human:SYNTHETIC' });
  assert.notEqual(campaignIdentitySha256(B), idA);
  await assert.rejects(run({ planFile: pilotFile, goFile: go, campaignDir: B }), (e: CliError) => e.code === 'GO_CAMPAIGN_IDENTITY_MISMATCH' && e.exit === EXIT.REFUSED_BY_POLICY);
  assert.ok(!existsSync(path.join(B, 'ledger.jsonl')) && !existsSync(path.join(B, 'batches')), 'nada executado em B');
  const C = tmp('C'); await assert.rejects(run({ planFile: pilotFile, goFile: go, campaignDir: C }), (e: CliError) => e.code === 'GO_CAMPAIGN_IDENTITY_MISSING');
  // identity is created once; a conflicting init is refused; a repeated init is idempotent
  const again = initCampaignIdentity(A, { studyId: pilot.studyId, corpusSha256: pilot.corpus.corpusSha256 }); assert.deepEqual([again.created, again.sha256], [false, idA]);
  assert.throws(() => initCampaignIdentity(A, { studyId: 'OTHER', corpusSha256: pilot.corpus.corpusSha256 }), (e: CliError) => e.code === 'CAMPAIGN_IDENTITY_MISMATCH');
  // validator: malformed field
  const ctx = { campaign: pilot.studyId, preregistrationSha256: pilot.preregistration.sha256, executorCodeSha: SHA, treeClean: null, planProtocolHash: pilot.protocolHash, planBatchIds: pilot.batches.map((b) => b.batchId), plannedOpsInScope: (x: readonly string[]) => pilot.batches.filter((b) => x.includes(b.batchId)).reduce((a, b) => a + b.calls, 0), ledgerCaps: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } }, nowMs: Date.now(), campaignIdentitySha256: idA, campaignDirCanonical: null as string | null };
  assert.equal(validateGoMultiV1(syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, over: { campaignIdentitySha256: 'zz' } }), ctx), 'GO_CAMPAIGN_IDENTITY_INVALID');
  assert.equal(validateGoMultiV1(syntheticMultiGo(pilot, ids, { executorCodeSha: SHA, campaignDir: A, over: { pilotProtocolHash: 'nothex' } }), ctx), 'GO_PILOT_HASH_INVALID');
});

test('R15-G-2 + R15-G-3: lote de validacao parado em GATE_TRAIN_NOT_FROZEN NAO registra nonce e corre depois sob GO NOVO; nonce so apos PLANNED; --pilot-protocol-hash obrigatorio fora do piloto; pin do GO deve bater', { timeout: 900_000 }, async () => {
  const D = tmp('D'); const models = ['gpt-4o-mini-2024-07-18', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5'];
  for (const m of models) writeGateG17(D, { model: m, verdict: 'PASS', pilotProtocolHash: pilot.protocolHash, signedBy: 'human:SYNTHETIC', atUtc: 'x' });
  const trainIds = camp.batches.filter((b) => (b.block === 'train' || b.block === 'comparative') && !b.branchLocked).map((b) => b.batchId);
  const valIds = camp.batches.filter((b) => b.block === 'validation' && !b.branchLocked).map((b) => b.batchId);
  const go1 = goFile('go.D1', syntheticMultiGo(camp, [...trainIds, ...valIds], { executorCodeSha: SHA, campaignDir: D }));
  // G-3: no pilot hash => refused before the lock
  await assert.rejects(run({ planFile: campFile, goFile: go1, campaignDir: D }), (e: CliError) => e.code === 'PILOT_PROTOCOL_HASH_REQUIRED' && e.exit === EXIT.REFUSED_BY_POLICY);
  const goPinWrong = goFile('go.Dpin', syntheticMultiGo(camp, [...trainIds], { executorCodeSha: SHA, campaignDir: D, pilotProtocolHash: '0'.repeat(64) }));
  await assert.rejects(run({ planFile: campFile, goFile: goPinWrong, campaignDir: D, pilotProtocolHash: pilot.protocolHash }), (e: CliError) => e.code === 'GO_PILOT_HASH_MISMATCH');
  assert.deepEqual(nonceRows(D), [], 'nenhuma linha de nonce antes de qualquer PLANNED');
  // train runs; validation halts at the gate and WAITS
  const r1 = await run({ planFile: campFile, goFile: go1, campaignDir: D, pilotProtocolHash: pilot.protocolHash });
  assert.equal(r1.haltReason, 'GATE_TRAIN_NOT_FROZEN');
  const rows1 = nonceRows(D);
  assert.deepEqual(rows1.map((r) => r.batchId).sort(), trainIds.slice().sort(), 'G-2: so os lotes que tiveram PLANNED tem nonce; a validacao parada no gate NAO tem');
  assert.ok(valIds.every((v) => !rows1.some((r) => r.batchId === v)));
  // the GO expires / is replaced: a NEW GO (other nonces) for the validation batches is accepted because they never started
  freezeTrain(camp, D);
  const go2 = goFile('go.D2', syntheticMultiGo(camp, valIds, { executorCodeSha: SHA, campaignDir: D, nonceSeed: 'second-go' }));
  for (const v of valIds) assert.equal(checkNonce(D, v, 'f'.repeat(32)), 'NEW');
  const r2 = await run({ planFile: campFile, goFile: go2, campaignDir: D, pilotProtocolHash: pilot.protocolHash });
  assert.ok(r2.executed.every((e) => e.outcome === 'DONE'), JSON.stringify(r2.executed));
  assert.equal(nonceRows(D).length, trainIds.length + valIds.length);
  // a started train batch under go1 cannot be reopened by go2's nonce
  const go3 = goFile('go.D3', syntheticMultiGo(camp, [trainIds[0]!], { executorCodeSha: SHA, campaignDir: D, nonceSeed: 'third' }));
  const r3 = await run({ planFile: campFile, goFile: go3, campaignDir: D, pilotProtocolHash: pilot.protocolHash });
  assert.equal(r3.haltReason, 'GO_NONCE_MISMATCH_FOR_STARTED_BATCH');
});

test('R15-G-4: maxAttempts cumulativo entre processos: GO com maxAttempts=2; execucao 1 falha (1 SENT) e para; execucao 2 envia SO 1 e para em STOP_MAX_ATTEMPTS: 2 SENT no total (d2c60a98 fazia 3)', { timeout: 600_000 }, async () => {
  const E = tmp('E'); const b = pilot.batches.find((x) => x.provider === 'anthropic')!.batchId;
  const go = goFile('go.E', syntheticMultiGo(pilot, [b], { executorCodeSha: SHA, campaignDir: E, maxAttempts: 2 }));
  const r1 = await run({ planFile: pilotFile, goFile: go, campaignDir: E, offline: { faults: { 0: 'throw' } } });
  assert.deepEqual([r1.haltReason, r1.attemptsPrior, r1.attemptsThisRun, r1.attemptsUsed], ['STOP_UNCERTAIN', 0, 1, 1]);
  // C158 cycle 2 counterpoint: without the human acknowledgement the resume sends nothing
  const rNo = await run({ planFile: pilotFile, goFile: go, campaignDir: E });
  assert.deepEqual([rNo.haltReason, rNo.attemptsThisRun, countSentInScope(E, [b])], ['STOP_UNCERTAIN', 0, 1]);
  const r2 = await run({ planFile: pilotFile, goFile: go, campaignDir: E, ackUncertain: uncertainAcksIn(E) });
  assert.deepEqual([r2.haltReason, r2.attemptsPrior, r2.attemptsThisRun, r2.attemptsUsed], ['STOP_MAX_ATTEMPTS', 1, 1, 2]);
  assert.equal(countSentInScope(E, [b]), 2);
  const r3 = await run({ planFile: pilotFile, goFile: go, campaignDir: E });
  assert.deepEqual([r3.haltReason, r3.attemptsThisRun, r3.attemptsUsed], ['STOP_MAX_ATTEMPTS', 0, 2]);
});

test('VNEXT-4: ambiente de lancamento: nome fora da lista documentada => LAUNCH_ENV_UNLISTED:<nomes> (case-insensitive; H2EVAL_* permitido; valores nunca lidos); a lista do launch_env.sh passa', () => {
  const b = selectBatch(pilot, pilot.batches[0]!.batchId);
  const bad = realPreconditions(pilot, b, { realFlag: true, executorCodeSha: SHA, env: { PATH: 'x', SystemRoot: 'y', H2EVAL_ENV_FILE: 'z', FOO_BAR: 'secret-value-never-echoed', windir: 'w' } });
  const code = bad.find((c) => c.startsWith('LAUNCH_ENV_UNLISTED'))!;
  assert.equal(code, 'LAUNCH_ENV_UNLISTED:FOO_BAR'); assert.ok(!bad.join(';').includes('secret-value'));
  const ok = realPreconditions(pilot, b, { realFlag: true, executorCodeSha: SHA, env: { PATH: 'x', SystemRoot: 'y', SYSTEMROOT: 'y', windir: 'w', TEMP: 't', TMP: 't', USERPROFILE: 'u', HOMEDRIVE: 'C:', HOMEPATH: '\\u', APPDATA: 'a', LOCALAPPDATA: 'l', COMSPEC: 'c', PATHEXT: 'p', NODE_EXTRA_CA_CERTS: 'ca.pem', H2EVAL_ENV_FILE: 'e', H2EVAL_STOP_FILE: 's' } });
  assert.ok(!ok.some((c) => c.startsWith('LAUNCH_ENV_UNLISTED')), ok.join(';'));
});
