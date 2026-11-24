// SYNTHETIC — OFFLINE. E1' (C158/C159, 2026-11-12): ensaio com o CAMINHO COMPLETO do executor (freeze -> plan -> runBatch, o mesmo laco de `run`/`run-authorized`, adaptador e ledger reais, provedor SIMULADO)
// reproduzindo o cenario do lote 2 do Haiku: DUAS RECUSAS com usage completo seguidas (indices 7 e 8) NAO param o lote e a operacao seguinte VAI; o lote termina 21/21; as recusas ficam registradas; retomar nao reenvia nada.
// Sem chamada paga, sem rede, sem credencial, sem GO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan } from '../../../scripts/h2eval/cli/plan.js';
import { runBatch } from '../../../scripts/h2eval/cli/run.js';
import { sha256File } from '../../../scripts/h2eval/cli/common.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-e1p-${p}-`));
const WORK = tmp('work'); const SHA = 'c'.repeat(40);
process.env['H2EVAL_ANTHROPIC_API_KEY'] = 'zq-e1p-cli-canary'; // presente no processo; OFFLINE nunca le
const MODEL = 'claude-haiku-5-5';
let planFile = ''; let batchId = '';

test("E1' CLI: plano do Haiku (21 chamadas, 1 lote) sobre corpus sintetico", { timeout: 240_000 }, () => {
  const CORPUS = path.join(WORK, 'corpus'); freezeCorpus({ out: CORPUS, seed: 424242, s2: 2, s3: 3, noRepoScan: true });
  const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# prereg SYNTHETIC e1prime\n'); void sha256File(PREREG);
  const plan = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'PILOT', unratifiedRehearsal: true, studyId: 'H2EVAL-E1PRIME', models: [MODEL], now: () => '2026-11-12T20:00:00.000Z' });
  planFile = path.join(WORK, 'plan.json'); writePlan(plan, planFile); batchId = plan.batches[0]!.batchId; assert.equal(plan.batches[0]!.calls, 21);
});

test("E1' CLI (cenario do lote 2): recusas com usage nas chamadas 7 e 8 NAO param; a 9a vai; 21/21; recusas registradas; retomada nao reenvia", { timeout: 240_000 }, async () => {
  const dir = tmp('run');
  const s = await runBatch({ planFile, batchId, batchDir: dir, mode: 'offline', executorCodeSha: SHA, offline: { faults: { 7: 'refusal_with_usage', 8: 'refusal_with_usage' } } });
  assert.equal(s.stoppedBy, null, 'nenhuma parada (no E1 congelado: STOP_CONSECUTIVE_FAILURES na chamada 9)'); assert.equal(s.executed, 21); assert.equal((s.offlineLog as unknown[]).length, 21, 'as 21 foram ENVIADAS ao provedor simulado');
  assert.equal(s.results[9]!.state, 'COST_COMPUTED', 'a operacao seguinte as duas recusas VAI (indice 9)');
  const recs = readdirSync(path.join(dir, 'records')).map((f) => JSON.parse(readFileSync(path.join(dir, 'records', f), 'utf8')) as { outcome: string; exclusion: string });
  assert.equal(recs.filter((r) => r.outcome === 'REFUSED_WITH_USAGE').length, 2, 'as 2 recusas continuam registradas'); assert.ok(recs.filter((r) => r.outcome === 'REFUSED_WITH_USAGE').every((r) => r.exclusion === 'NONE'));
  assert.equal(verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')).filter((l) => l.kind === 'STOP_GLOBAL').length, 0);
  const again = await runBatch({ planFile, batchId, batchDir: dir, mode: 'offline', executorCodeSha: SHA, offline: { faults: { 7: 'refusal_with_usage', 8: 'refusal_with_usage' } } });
  assert.equal((again.offlineLog as unknown[]).length, 0, 'retomada: nada reenviado'); assert.equal(again.stoppedBy, null);
});

test("E1' CLI: uma recusa SEM usage completo continua falha e para (ERROR_NO_USAGE => UNCERTAIN => STOP_UNCERTAIN)", { timeout: 240_000 }, async () => {
  const s = await runBatch({ planFile, batchId, batchDir: tmp('nousage'), mode: 'offline', executorCodeSha: SHA, offline: { faults: { 3: 'error_no_usage' } } });
  assert.equal(s.stoppedBy, 'STOP_UNCERTAIN'); assert.equal(s.results.length, 4); assert.equal(s.results[3]!.state, 'UNCERTAIN');
});
