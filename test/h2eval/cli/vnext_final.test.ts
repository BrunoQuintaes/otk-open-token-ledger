// SYNTHETIC — OFFLINE. VNEXT-F (C151 final round): the EXACT SC1 of R4 rev. 2 from ONE design file with conditions (33 operations: B1 OFF1024 x6,
// B2 ON1024 x6, B3 ON256 x6, B4 S2 x6, B5 S3 x9), P1 probe first and alone, pause until the signed P1 gate, D7 option A on the 6 eligible B5 calls,
// stop_reason in every record, inherited opening 0.01200928 + 0.003662 (synthetic, signed) pinned in the GO, campaign identity + machine control
// registry + canonical path pinned in the GO. Negatives: OFF rejected at P1 (nothing more sent), stop_reason absent (halt after settlement),
// ON256 consuming the ceiling (recorded, no stop), byte copy of the directory refused, GO with another canonical path refused, MSYSTEM accepted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { runAuthorized, realPreconditions, selectBatch, LEDGER_OPENING_FILE } from '../../../scripts/h2eval/cli/run.js';
import { writeGateP1, canonicalPath } from '../../../scripts/h2eval/cli/campaign.js';
import { exportDataset } from '../../../scripts/h2eval/cli/status.js';
import { loadTextCounters, CliError } from '../../../scripts/h2eval/cli/common.js';
import { openLedger, type LedgerOpening } from '../../../scripts/h2eval/core/ledger.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';
import { readSnapshot } from '../../../scripts/h2eval/record/snapshot.js';
import { loadDesignParams } from '../../../scripts/h2eval/design/designParams.js';
import type { PostcallRecord } from '../../../scripts/h2eval/types.js';
import { syntheticMultiGo } from '../support/gomulti.js';

const require = createRequire(import.meta.url);
const SHA = 'c'.repeat(40); const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-vnext-final-${p}-`));
const WORK = tmp('work'); const CORPUS = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg R4 rev.2 (SYNTHETIC)\n');
const SC1_DESIGN = path.resolve('scripts/h2eval/design/R4_R2_SC1.v1.json'); const H55 = 'claude-haiku-5-5';
const CAPS = { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } };
const counters = loadTextCounters()!; const REAL = { inputTokenFactor: 1.5, thinkingConsumesCapOnSingleTurnNoSystem: true };
const offline = (faults?: Record<number, 'tls' | 'reject_disabled' | 'no_stop_reason'>) => ({ realism: REAL, tokensOf: counters.cl100k_base, ...(faults ? { faults } : {}) });
const sign = (o: Omit<LedgerOpening, 'digestSha256'>): LedgerOpening => ({ ...o, digestSha256: sha256Canon(o) });
const OPENING: LedgerOpening = sign({ schema: 'h2eval.ledger_opening.v1', fromStudy: { label: 'R17 pilot (SYNTHETIC amounts of the real ledger: 0.01200928 settled + 0.003662 uncertain)', ledgerSha256: '6'.repeat(64), closedUtc: '2026-11-11T12:00:00.000Z' }, providers: { anthropic: { settledUsd: '0.01200928', uncertainUsd: '0.003662' } }, signedBy: 'human:SYNTHETIC-AUTHOR' });
let plan: BatchPlan; let planFile: string; let batchId: string;
const records = (dir: string): PostcallRecord[] => { const d = path.join(dir, 'batches', batchId, 'records'); return existsSync(d) ? (require('node:fs').readdirSync(d) as string[]).map((f) => JSON.parse(readFileSync(path.join(d, f), 'utf8')) as PostcallRecord) : []; };
const journal = (dir: string) => verifyJournalText(readFileSync(path.join(dir, 'batches', batchId, 'journal.jsonl'), 'utf8'));
const newStudy = (name: string): string => { const d = tmp(name); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, LEDGER_OPENING_FILE), JSON.stringify(OPENING, null, 1)); return d; };
const goFor = (name: string, dir: string, seed = 'seed') => { const p = path.join(WORK, `${name}.json`); writeFileSync(p, syntheticMultiGo(plan, [batchId], { executorCodeSha: SHA, campaignDir: dir, nonceSeed: seed })); return p; };
const run = (dir: string, go: string, faults?: Parameters<typeof offline>[0]) => runAuthorized({ planFile, goFile: go, campaignDir: dir, corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, offline: offline(faults) });

test('setup: SC1 design (conditions) => ONE pilot plan of the Haiku 5.5 with 33 operations in block order B1..B5; operationIds distinct per condition; P1 = first OFF1024; D7 6 eligible', { timeout: 300_000 }, () => {
  freezeCorpus({ out: CORPUS, seed: 151151, s2: 2, s3: 3, noRepoScan: true });
  const d = loadDesignParams(SC1_DESIGN); assert.equal(d.params.designId, 'H2EVAL-R4-R2-SC1'); assert.match(d.params.source, /NOT RATIFIED/);
  plan = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-SC1', models: [H55], designParamsFile: SC1_DESIGN }); planFile = path.join(WORK, 'plan.sc1.json'); writePlan(plan, planFile);
  assert.equal(plan.batches.length, 1); batchId = plan.batches[0]!.batchId; const ops = plan.batches[0]!.operations; assert.equal(ops.length, 33);
  const blocks = ops.map((o) => o.condition ?? o.plan.structure);
  assert.deepEqual([blocks.slice(0, 6), blocks.slice(6, 12), blocks.slice(12, 18), blocks.slice(18, 24), blocks.slice(24)], [Array(6).fill('OFF1024'), Array(6).fill('ON1024'), Array(6).fill('ON256'), Array(6).fill('S2'), Array(9).fill('S3')]);
  assert.equal(new Set(ops.map((o) => o.operationId)).size, 33, 'operationId distinto por condicao');
  assert.equal(new Set(ops.slice(0, 18).map((o) => o.plan.promptSha256)).size, 6, 'os MESMOS 6 prompts nas 3 condicoes');
  assert.deepEqual([ops[0]!.probe, ops[1]!.probe, plan.policy.design.probe?.operationId, plan.policy.design.conditions[H55]], ['P1', null, ops[0]!.operationId, ['OFF1024', 'ON1024', 'ON256']]);
  assert.deepEqual(ops.slice(0, 6).map((o) => `${o.plan.params.maxTokens}/${o.plan.params.thinking.mode}/${o.reasoningAllowanceTokens}`), Array(6).fill('1024/none/0'));
  assert.deepEqual(ops.slice(6, 12).map((o) => `${o.plan.params.maxTokens}/${o.plan.params.thinking.mode}/${o.reasoningAllowanceTokens}`), Array(6).fill('1024/adaptive/1024'));
  assert.deepEqual(ops.slice(12, 18).map((o) => `${o.plan.params.maxTokens}/${o.plan.params.thinking.mode}`), Array(6).fill('256/adaptive'));
  assert.deepEqual(ops.slice(18).map((o) => `${o.plan.params.maxTokens}/${o.plan.params.thinking.mode}`), Array(15).fill('256/none'));
  assert.equal(ops.filter((o) => o.d7.eligibleForHit).length, 6, 'D7 opcao A: 6 posicoes elegiveis no B5');
});

test('SC1 exata: P1 roda sozinha e a serie PAUSA (PAUSE_PROBE_GATE, 1 envio); gate P1 PASS assinado => retomada 32 envios; stop_reason em 33/33; ON256 truncado registrado sem STOP; D7 6 hits; herdado contado; identidade e caminho canonico pinados', { timeout: 900_000 }, async () => {
  const S = newStudy('sc1'); const go = goFor('go.sc1', S);
  const goJson = JSON.parse(readFileSync(go, 'utf8')) as { campaignDirCanonical: string; ledgerOpeningDigestSha256: string };
  assert.deepEqual([goJson.campaignDirCanonical, goJson.ledgerOpeningDigestSha256], [canonicalPath(S), OPENING.digestSha256]);
  const r1 = await run(S, go);
  assert.deepEqual([r1.haltReason, r1.attemptsThisRun, r1.probe?.gate, r1.executed[0]!.disposition], ['PAUSE_PROBE_GATE', 1, 'MISSING', 'HALT_ALL']);
  const probeId = plan.batches[0]!.operations[0]!.operationId; const probeRec = records(S).find((r) => r.operationId === probeId)!;
  assert.deepEqual([probeRec.completion, probeRec.stopReason, probeRec.usage!.reasoning], ['COMPLETE', 'end_turn', 'NOT_APPLICABLE']);
  const r1b = await run(S, go); assert.deepEqual([r1b.haltReason, r1b.attemptsThisRun], ['PAUSE_PROBE_GATE', 0], 'sem gate nada mais e enviado, mesmo repetindo');
  writeGateP1(S, { model: H55, verdict: 'PASS', probeOperationId: probeId, signedBy: 'human:SYNTHETIC-COORD', atUtc: 'x', note: 'verificacao mecanica delegada pelo autor; SYNTHETIC' });
  const r2 = await run(S, go);
  assert.deepEqual([r2.haltReason, r2.attemptsPrior, r2.attemptsThisRun, r2.attemptsUsed, r2.probe?.gate], [null, 1, 32, 33, 'PASS']);
  const recs = records(S); assert.equal(recs.length, 33); assert.ok(recs.every((r) => r.stopReason !== 'UNKNOWN' && r.completion !== 'UNKNOWN'), 'stop_reason em todas');
  const byCond = (c: string) => plan.batches[0]!.operations.filter((o) => o.condition === c).map((o) => recs.find((r) => r.operationId === o.operationId)!);
  assert.ok(byCond('OFF1024').every((r) => r.completion === 'COMPLETE' && r.usage!.reasoning === 'NOT_APPLICABLE'));
  assert.ok(byCond('ON1024').every((r) => r.completion === 'COMPLETE' && r.usage!.reasoning === 0 || r.completion === 'TRUNCATED_MAX_TOKENS'), 'ON1024: o simulador pensa no S1 (teto 1024)');
  assert.ok(byCond('ON256').every((r) => r.completion === 'TRUNCATED_MAX_TOKENS' && r.usage!.outputVisible === 0 && r.usage!.reasoning === 256), 'B3 replica o R17: truncado, REGISTRADO, sem STOP');
  const s3 = plan.batches[0]!.operations.filter((o) => o.d7.eligibleForHit); assert.equal(s3.filter((o) => recs.find((r) => r.operationId === o.operationId)!.usage!.cacheObserved === 'HIT').length, 6, 'D7: 6 hits nas 6 elegiveis');
  const snap = readSnapshot(path.join(S, 'batches', batchId), plan.batches[0]!.operations[7]!.operationId); assert.equal(snap.condition, 'ON1024');
  const ds = exportDataset(path.join(S, 'batches', batchId)); const rows = readFileSync(ds.file, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { condition: string | null; probe: string | null; declared: { completion: string } });
  assert.equal(rows.filter((r) => r.condition === 'ON256').length, 6); assert.equal(rows.filter((r) => r.probe === 'P1').length, 1);
  const led = openLedger(path.join(S, 'ledger.jsonl'), CAPS, undefined, OPENING).state().providers.anthropic;
  assert.deepEqual([led.inheritedUsd, led.operations], ['15671280000', 33]); assert.ok(readFileSync(path.join(S, 'ledger.jsonl'), 'utf8').startsWith('{"kind":"inherit"'));
  // R17-V-1: a byte copy of the directory is refused by the machine control registry; a GO naming another canonical path is refused by the validator
  const C = tmp('copy'); cpSync(S, C, { recursive: true });
  await assert.rejects(run(C, go), (e: CliError) => e.code === 'GO_CAMPAIGN_DIR_MISMATCH', 'o GO pina o caminho canonico');
  const goC = path.join(WORK, 'go.copy.json'); const g = JSON.parse(readFileSync(go, 'utf8')) as Record<string, unknown>; g['campaignDirCanonical'] = canonicalPath(C); delete g['goDigestSha256']; g['goDigestSha256'] = sha256Canon(g); writeFileSync(goC, JSON.stringify(g));
  await assert.rejects(run(C, goC), (e: CliError) => e.code === 'CAMPAIGN_CONTROL_DIR_MISMATCH', 'mesmo com um GO reescrito, o registro de controle da maquina aponta para a pasta original');
  assert.equal(journal(C).filter((l) => l.kind === 'SENT').length, 33, 'nada enviado na copia');
});

test('negativos: OFF rejeitado na P1 => STOP_THINKING_DISABLED_REJECTED com HALT_ALL (1 envio, nada mais); stop_reason ausente => STOP_STOP_REASON_MISSING apos liquidar; MSYSTEM aceito na allowlist', { timeout: 900_000 }, async () => {
  const A = newStudy('p1-reject'); const goA = goFor('go.p1reject', A, 'a');
  const ra = await run(A, goA, { 0: 'reject_disabled' });
  assert.deepEqual([ra.haltReason, ra.executed[0]!.disposition, ra.attemptsThisRun, ra.isolatedConditions], ['STOP_THINKING_DISABLED_REJECTED', 'HALT_ALL', 1, []]);
  const ra2 = await run(A, goA); assert.deepEqual([ra2.haltReason, ra2.attemptsThisRun], ['PAUSE_PROBE_GATE', 0], 'a sonda e terminal; sem gate (e sem desenho de contingencia) nada mais sai');
  assert.equal(journal(A).filter((l) => l.kind === 'SENT').length, 1);
  const B = newStudy('no-stop'); const goB = goFor('go.nostop', B, 'b');
  writeGateP1(B, { model: H55, verdict: 'PASS', probeOperationId: plan.batches[0]!.operations[0]!.operationId, signedBy: 'human:SYNTHETIC', atUtc: 'x' });
  const rb = await run(B, goB, { 3: 'no_stop_reason' });
  assert.deepEqual([rb.haltReason, rb.attemptsThisRun], ['STOP_STOP_REASON_MISSING', 4]);
  const j = journal(B); const ops = [...new Set(j.map((l) => l.operationId))]; const k = j.filter((l) => l.operationId === ops[3]).map((l) => l.kind);
  assert.ok(k.includes('SETTLED') && k.at(-1) === 'STOP_GLOBAL', 'liquidado antes da parada de integridade');
  const b0 = selectBatch(plan, batchId);
  const env = { PATH: 'x', SystemRoot: 'y', windir: 'w', TEMP: 't', TMP: 't', USERPROFILE: 'u', HOMEDRIVE: 'C:', HOMEPATH: '\\u', APPDATA: 'a', LOCALAPPDATA: 'l', COMSPEC: 'c', PATHEXT: 'p', NODE_EXTRA_CA_CERTS: 'ca.pem', MSYSTEM: 'MINGW64', H2EVAL_ENV_FILE: 'e' };
  assert.ok(!realPreconditions(plan, b0, { realFlag: true, executorCodeSha: SHA, env }).some((c) => c.startsWith('LAUNCH_ENV_UNLISTED')), 'R17-V-4: Git Bash (MSYSTEM) e o shell documentado para sonda e executor');
});
