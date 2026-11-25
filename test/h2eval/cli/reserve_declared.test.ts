/**
 * Tests that the declared input-reserve policy is written on every RESERVED journal line of a batch, and that a
 * resume declaring a different policy halts.
 *
 * Module under test: `scripts/h2eval/cli/run.ts` (`runAuthorized`), with the planner, the corpus freeze and the
 * synthetic GO and acknowledgement helpers from `../support/`.
 *
 * Strategy / scenarios: a pilot batch run with a deliberate "none" declaration (present on every reservation); a
 * resume with the same declaration (continues); and a resume with a different declaration (halts with a reserve
 * policy mismatch). Same setup as `reserves.test.ts`.
 *
 * Needs: a writable temporary directory and a synthetic corpus frozen in the `setup` test (allow up to 5 minutes);
 * sets `H2EVAL_CONTROL_DIR` to a temporary folder when unset. No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/cli/reserve_declared.test.ts`
 *
 * @module test/h2eval/cli/reserve_declared.test
 */
// SYNTHETIC — OFFLINE. MET-02 R4(a) (C158 §3.2): the declared input-reserve choice is in EVERY RESERVED line of the batch journal; a resume that declares something different from what the
// earlier operations used halts (RESERVE_POLICY_MISMATCH). Same setup as reserves.test.ts (pilot plan, multi-GO, offline provider).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, type BatchPlan } from '../../../scripts/h2eval/cli/plan.js';
import { runAuthorized } from '../../../scripts/h2eval/cli/run.js';
import { syntheticMultiGo } from '../support/gomulti.js';
import { uncertainAcksIn } from '../support/ack.js';

const SHA = 'c'.repeat(40); const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-resdecl-${p}-`));
const WORK = tmp('work'); const CORPUS = path.join(WORK, 'corpus'); const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# synthetic prereg\n');
let pilot: BatchPlan; let pilotFile: string;
const goFile = (name: string, text: string) => { const p = path.join(WORK, `${name}.json`); writeFileSync(p, text); return p; };
const run = (o: Partial<Parameters<typeof runAuthorized>[0]> & { goFile: string; campaignDir: string; planFile: string }) => runAuthorized({ corpusDir: CORPUS, mode: 'offline', executorCodeSha: SHA, ...o });
const reserved = (dir: string, batchId: string) => readFileSync(path.join(dir, 'batches', batchId, 'journal.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { kind: string; operationId: string; body: Record<string, unknown> }).filter((l) => l.kind === 'RESERVED');

test('setup', { timeout: 300_000 }, () => {
  freezeCorpus({ out: CORPUS, seed: 151003, s2: 2, s3: 3, noRepoScan: true });
  pilot = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-RESDECL' });
  pilotFile = path.join(WORK, 'plan.pilot.json'); writePlan(pilot, pilotFile);
});

test('politica declarada (none deliberado) fica em TODA RESERVED; retomar com a MESMA declaracao segue; retomar com declaracao DIFERENTE da usada antes => HALT RESERVE_POLICY_MISMATCH', { timeout: 900_000 }, async () => {
  const b = pilot.batches.find((x) => x.provider === 'anthropic')!.batchId;
  const F = tmp('F'); const goF = goFile('go.F', syntheticMultiGo(pilot, [b], { executorCodeSha: SHA, campaignDir: F, maxAttempts: 21 }));
  const f1 = await run({ planFile: pilotFile, goFile: goF, campaignDir: F, inputReservePolicy: 'none', offline: { faults: { 0: 'throw' } } }); assert.equal(f1.haltReason, 'STOP_UNCERTAIN');
  assert.ok(reserved(F, b).length >= 1 && reserved(F, b).every((l) => l.body['reservePolicy'] === 'none'), 'cada RESERVED registra a declaracao');
  const f2 = await run({ planFile: pilotFile, goFile: goF, campaignDir: F, inputReservePolicy: 'none', ackUncertain: uncertainAcksIn(F) }); assert.notEqual(f2.haltReason, 'RESERVE_POLICY_MISMATCH');
  assert.ok(reserved(F, b).length > 1 && reserved(F, b).every((l) => l.body['reservePolicy'] === 'none'));
  // inconsistente: 1a execucao SEM declaracao (campo ausente), retomada declarando 'none' => a verificacao pos-lote para
  const G = tmp('G'); const goG = goFile('go.G', syntheticMultiGo(pilot, [b], { executorCodeSha: SHA, campaignDir: G, maxAttempts: 21 }));
  const g1 = await run({ planFile: pilotFile, goFile: goG, campaignDir: G, offline: { faults: { 0: 'throw' } } }); assert.equal(g1.haltReason, 'STOP_UNCERTAIN');
  assert.equal(reserved(G, b).every((l) => l.body['reservePolicy'] === undefined), true);
  const g2 = await run({ planFile: pilotFile, goFile: goG, campaignDir: G, inputReservePolicy: 'none', ackUncertain: uncertainAcksIn(G) });
  assert.equal(g2.haltReason, 'RESERVE_POLICY_MISMATCH'); assert.equal(g2.executed.find((e) => e.batchId === b)!.stoppedBy, 'RESERVE_POLICY_MISMATCH');
});
