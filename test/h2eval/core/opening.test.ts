/**
 * Tests the signed ledger opening file through which a new study inherits, as committed, what a previous study
 * settled or left uncertain.
 *
 * Modules under test: `scripts/h2eval/core/ledger.ts` (`openLedger`, `validateLedgerOpening`, `LedgerOpeningError`,
 * `inheritedPicoOf`), `scripts/h2eval/cli/run.ts` (`runAuthorized`, `readLedgerOpening`, `LEDGER_OPENING_FILE`)
 * and the planner.
 *
 * Strategy / partitions: the opening applied once as the first ledger lines, inherited money counted against the
 * provider and campaign caps, reopening without duplication, and an unchanged ledger without the file; refusals
 * (opening after the ledger started, values different from those already inherited, unsigned, tampered digest,
 * unknown provider, wrong schema); and a run whose inherited amount is above 80% pauses at the first operation. The
 * previous study's directory is never touched.
 *
 * Needs: a writable temporary directory and a synthetic corpus freeze (allow several minutes); sets
 * `H2EVAL_CONTROL_DIR` to a temporary folder when unset. The inherited amounts are synthetic. No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/opening.test.ts`
 *
 * @module test/h2eval/core/opening.test
 */
// SYNTHETIC — OFFLINE. VNEXT-5 (C151 item 5): a NEW study ledger inherits, as committed, what a previous study settled and left uncertain
// (0.01200928 settled + 0.003662 uncertain on Anthropic in R17), through a SIGNED opening file applied once as the first lines of the ledger.
// Inherited money counts against 5/3/3/11 and against the 80 % pause; it is never released; the opening after a started ledger, a mismatch,
// an unsigned or tampered file are refused; journal reconciliation ignores the inherit lines. The previous study's directory is never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openLedger, usdToPico, validateLedgerOpening, LedgerOpeningError, inheritedPicoOf, type LedgerOpening } from '../../../scripts/h2eval/core/ledger.js';
import { sha256Canon } from '../../../scripts/h2eval/core/canon.js';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { runAuthorized, readLedgerOpening, LEDGER_OPENING_FILE } from '../../../scripts/h2eval/cli/run.js';
import { CliError } from '../../../scripts/h2eval/cli/common.js';
import { syntheticMultiGo } from '../support/gomulti.js';

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-opening-${p}-`));
const CAPS = { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } };
const sign = (o: Omit<LedgerOpening, 'digestSha256'> & { digestSha256?: string }): LedgerOpening => { const { digestSha256: _d, ...rest } = o; void _d; return { ...rest, digestSha256: sha256Canon(rest) } as LedgerOpening; };
const R17: LedgerOpening = sign({ schema: 'h2eval.ledger_opening.v1', fromStudy: { label: 'R17 pilot (C:/otk-h2eval-runs/estudo, SYNTHETIC copy of the amounts only)', ledgerSha256: '6'.repeat(64), closedUtc: '2026-11-11T12:00:00.000Z' }, providers: { anthropic: { settledUsd: '0.01200928', uncertainUsd: '0.003662' } }, signedBy: 'human:SYNTHETIC', note: 'R17: 21 Haiku 5.5 ops settled + 1 Haiku 4.5 op uncertain, charge NOT_RECONCILED' });
const lines = (p: string) => readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; provider: string; usd: string; note?: string });

test('abertura assinada aplicada UMA vez como primeiras linhas; herdado conta no comprometido do provedor e da campanha; reabrir nao duplica; sem o arquivo o ledger mantem o herdado', () => {
  const dir = tmp('once'); const p = path.join(dir, 'ledger.jsonl');
  assert.deepEqual(inheritedPicoOf(R17), { anthropic: usdToPico('0.01200928') + usdToPico('0.003662'), openai: 0n, google: 0n });
  const L = openLedger(p, CAPS, undefined, R17);
  assert.deepEqual(lines(p).map((l) => [l.kind, l.provider, l.usd, l.note]), [['inherit', 'anthropic', '15671280000', R17.digestSha256]], 'so o provedor com valor > 0; nota = digest');
  assert.deepEqual([L.state().providers.anthropic.inheritedUsd, L.state().providers.anthropic.spentUsd, L.state().providers.openai.inheritedUsd], ['15671280000', '0', '0']);
  openLedger(p, CAPS, undefined, R17); assert.equal(lines(p).length, 1, 'reabrir com a mesma abertura nao acrescenta linha');
  assert.throws(() => openLedger(p, CAPS), (e: LedgerOpeningError) => e.code === 'LEDGER_OPENING_FILE_MISSING', 'R17-V-3: reabrir SEM o arquivo e recusado (linhas inherit nao sao fonte por si)');
  // headroom: provider cap 0.0157 (< default, allowed) leaves 0.00002872 => a 0.001 reservation is refused; campaign cap likewise
  const tight = openLedger(path.join(dir, 'tight.jsonl'), { campaignUsd: '11', providersUsd: { anthropic: '0.0157', openai: '3', google: '3' } }, undefined, R17);
  assert.throws(() => tight.reserve('op1', 'anthropic', 'b', usdToPico('0.001')), /STOP_BUDGET_PROVIDER/);
  assert.ok(tight.pauseThresholdReached('anthropic', 80), 'herdado ja passa dos 80 %');
  const camp = openLedger(path.join(dir, 'camp.jsonl'), { campaignUsd: '0.0157', providersUsd: { anthropic: '5', openai: '3', google: '3' } }, undefined, R17);
  assert.throws(() => camp.reserve('op1', 'openai', 'b', usdToPico('0.001')), /STOP_BUDGET_CAMPAIGN/, 'o herdado da Anthropic conta no teto global, mesmo para outro provedor');
  // a normal reservation still works and the inherited amount is never released
  const L2 = openLedger(path.join(dir, 'ok.jsonl'), CAPS, undefined, R17); L2.reserve('op1', 'anthropic', 'b', usdToPico('0.01')); L2.release('op1', 'anthropic', 'b');
  assert.deepEqual([L2.state().providers.anthropic.reservedUsd, L2.state().providers.anthropic.inheritedUsd], ['0', '15671280000']);
});

test('recusas: abertura depois de ledger iniciado; valores diferentes dos ja herdados; nao assinado; digest adulterado; provedor desconhecido; esquema', () => {
  const dir = tmp('refuse');
  const started = path.join(dir, 'started.jsonl'); const S = openLedger(started, CAPS); S.reserve('op1', 'anthropic', 'b', usdToPico('0.01'));
  assert.throws(() => openLedger(started, CAPS, undefined, R17), (e: LedgerOpeningError) => e.code === 'LEDGER_OPENING_AFTER_START');
  const p = path.join(dir, 'mismatch.jsonl'); openLedger(p, CAPS, undefined, R17);
  const other2 = sign({ ...R17, providers: { anthropic: { settledUsd: '0.02', uncertainUsd: '0' } } });
  assert.throws(() => openLedger(p, CAPS, undefined, other2), (e: LedgerOpeningError) => e.code === 'LEDGER_OPENING_MISMATCH');
  assert.throws(() => validateLedgerOpening({ ...R17, signedBy: 'agent:bot' }), (e: LedgerOpeningError) => e.code === 'LEDGER_OPENING_UNSIGNED');
  assert.throws(() => validateLedgerOpening({ ...R17, note: 'edited after signing' }), (e: LedgerOpeningError) => e.code === 'LEDGER_OPENING_DIGEST');
  assert.throws(() => validateLedgerOpening(sign({ ...R17, providers: { mistral: { settledUsd: '1', uncertainUsd: '0' } } } as never)), (e: LedgerOpeningError) => e.code === 'LEDGER_OPENING_INVALID');
  assert.throws(() => validateLedgerOpening(sign({ ...R17, providers: { anthropic: { settledUsd: 'abc', uncertainUsd: '0' } } })), (e: LedgerOpeningError) => e.code === 'LEDGER_OPENING_INVALID');
  assert.throws(() => validateLedgerOpening({ ...R17, schema: 'x' }), (e: LedgerOpeningError) => e.code === 'LEDGER_OPENING_SCHEMA');
});

test('run-authorized: LEDGER_OPENING.json no diretorio do estudo NOVO cria o ledger com o herdado; herdado alem de 80 % => PAUSE_REVIEW_AT_80PCT na 1a operacao (HALT_ALL); reconciliacao ignora inherit; arquivo invalido => recusa; estudo anterior intocado', { timeout: 600_000 }, async () => {
  const work = tmp('work'); const corpus = path.join(work, 'corpus'); const prereg = path.join(work, 'PREREG.md'); writeFileSync(prereg, '# synthetic prereg\n');
  freezeCorpus({ out: corpus, seed: 151005, s2: 2, s3: 3, noRepoScan: true });
  const pilot: BatchPlan = buildPlan({ corpusDir: corpus, preregFile: prereg, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-OPENING' });
  const planFile = path.join(work, 'plan.json'); writePlan(pilot, planFile);
  const anth = pilot.batches.filter((b) => b.provider === 'anthropic').map((b) => b.batchId);
  // previous study (its folder is only READ to take the amounts; here synthetic): a new study dir carries the signed opening
  const prev = tmp('previous-study'); writeFileSync(path.join(prev, 'ledger.jsonl'), '{"kind":"settle","operationId":"x","provider":"anthropic","batchId":"b","usd":"12009280000","tsUtc":"t"}\n'); const prevSha = readFileSync(path.join(prev, 'ledger.jsonl'), 'utf8');
  const study = tmp('new-study'); mkdirSync(study, { recursive: true });
  writeFileSync(path.join(study, LEDGER_OPENING_FILE), JSON.stringify(R17, null, 1));
  assert.equal(readLedgerOpening(study)?.digestSha256, R17.digestSha256);
  const go = path.join(work, 'go.json'); writeFileSync(go, syntheticMultiGo(pilot, anth, { executorCodeSha: 'c'.repeat(40), campaignDir: study }));
  const r = await runAuthorized({ planFile, goFile: go, campaignDir: study, corpusDir: corpus, mode: 'offline', executorCodeSha: 'c'.repeat(40) });
  assert.equal(r.haltReason, null);
  const led = openLedger(path.join(study, 'ledger.jsonl'), CAPS, undefined, R17).state().providers.anthropic;
  assert.equal(led.inheritedUsd, '15671280000'); assert.ok(BigInt(led.spentUsd) > 0n); assert.equal(lines(path.join(study, 'ledger.jsonl'))[0]!.kind, 'inherit');
  // second run (replay) reopens the ledger with inherit lines + journals: reconciliation passes, nothing resent
  const r2 = await runAuthorized({ planFile, goFile: go, campaignDir: study, corpusDir: corpus, mode: 'offline', executorCodeSha: 'c'.repeat(40) }); assert.equal(r2.attemptsThisRun, 0);
  assert.equal(readFileSync(path.join(prev, 'ledger.jsonl'), 'utf8'), prevSha, 'estudo anterior intocado');
  // inherited beyond 80 %: 4.5 of 5 => the first anthropic operation pauses for review before any send
  const heavy = tmp('heavy'); writeFileSync(path.join(heavy, LEDGER_OPENING_FILE), JSON.stringify(sign({ ...R17, providers: { anthropic: { settledUsd: '4.5', uncertainUsd: '0' } } }), null, 1));
  const goH = path.join(work, 'go.heavy.json'); writeFileSync(goH, syntheticMultiGo(pilot, [anth[0]!], { executorCodeSha: 'c'.repeat(40), campaignDir: heavy }));
  const rh = await runAuthorized({ planFile, goFile: goH, campaignDir: heavy, corpusDir: corpus, mode: 'offline', executorCodeSha: 'c'.repeat(40) });
  assert.deepEqual([rh.haltReason, rh.attemptsThisRun], ['PAUSE_REVIEW_AT_80PCT', 0]);
  // invalid opening file => refused before any executor
  const bad = tmp('bad'); writeFileSync(path.join(bad, LEDGER_OPENING_FILE), JSON.stringify({ ...R17, signedBy: 'agent:bot' }));
  const goB = path.join(work, 'go.bad.json'); writeFileSync(goB, syntheticMultiGo(pilot, [anth[0]!], { executorCodeSha: 'c'.repeat(40), campaignDir: bad }));
  await assert.rejects(runAuthorized({ planFile, goFile: goB, campaignDir: bad, corpusDir: corpus, mode: 'offline', executorCodeSha: 'c'.repeat(40) }), (e: CliError) => e.code === 'LEDGER_OPENING_UNSIGNED', 'VNEXT-F (R17-V-2): recusado antes do trinco');
  assert.ok(!existsSync(path.join(bad, 'ledger.jsonl')));
  // R17-V-2: a GO that pins NO opening while the file is present, and a GO pinning another digest, are refused before any send
  const goNone = path.join(work, 'go.none.json'); writeFileSync(goNone, syntheticMultiGo(pilot, [anth[0]!], { executorCodeSha: 'c'.repeat(40), campaignDir: study, ledgerOpeningDigest: 'none' }));
  await assert.rejects(runAuthorized({ planFile, goFile: goNone, campaignDir: study, corpusDir: corpus, mode: 'offline', executorCodeSha: 'c'.repeat(40) }), (e: CliError) => e.code === 'LEDGER_OPENING_UNEXPECTED');
  const goOther = path.join(work, 'go.other.json'); writeFileSync(goOther, syntheticMultiGo(pilot, [anth[0]!], { executorCodeSha: 'c'.repeat(40), campaignDir: study, ledgerOpeningDigest: 'f'.repeat(64) }));
  await assert.rejects(runAuthorized({ planFile, goFile: goOther, campaignDir: study, corpusDir: corpus, mode: 'offline', executorCodeSha: 'c'.repeat(40) }), (e: CliError) => e.code === 'LEDGER_OPENING_DIGEST_MISMATCH');
  // R17-V-3: delete the file after the study started and tamper the inherit line => refused
  const tampered = tmp('tampered'); writeFileSync(path.join(tampered, LEDGER_OPENING_FILE), JSON.stringify(R17, null, 1));
  const goT = path.join(work, 'go.t.json'); writeFileSync(goT, syntheticMultiGo(pilot, [anth[0]!], { executorCodeSha: 'c'.repeat(40), campaignDir: tampered }));
  await runAuthorized({ planFile, goFile: goT, campaignDir: tampered, corpusDir: corpus, mode: 'offline', executorCodeSha: 'c'.repeat(40) });
  const { unlinkSync } = await import('node:fs'); unlinkSync(path.join(tampered, LEDGER_OPENING_FILE));
  await assert.rejects(runAuthorized({ planFile, goFile: goT, campaignDir: tampered, corpusDir: corpus, mode: 'offline', executorCodeSha: 'c'.repeat(40) }), (e: CliError) => e.code === 'LEDGER_OPENING_MISSING', 'arquivo apagado: o GO ainda pina o digest');
  assert.throws(() => openLedger(path.join(tampered, 'ledger.jsonl'), CAPS), (e: LedgerOpeningError) => e.code === 'LEDGER_OPENING_FILE_MISSING');
  const lraw = readFileSync(path.join(tampered, 'ledger.jsonl'), 'utf8').split('\n'); lraw[0] = lraw[0]!.replace('"usd":"15671280000"', '"usd":"1"'); writeFileSync(path.join(tampered, 'ledger.jsonl'), lraw.join('\n'));
  writeFileSync(path.join(tampered, LEDGER_OPENING_FILE), JSON.stringify(R17, null, 1));
  assert.throws(() => openLedger(path.join(tampered, 'ledger.jsonl'), CAPS, undefined, R17), (e: LedgerOpeningError) => e.code === 'LEDGER_OPENING_MISMATCH', 'linha inherit adulterada e reconferida contra o arquivo');
  void CliError;
});
