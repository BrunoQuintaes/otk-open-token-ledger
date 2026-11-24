// SYNTHETIC — OFFLINE. E2' (C159-A Q04, 2026-11-13): ensaio com o CAMINHO COMPLETO do executor E2 (freeze -> plan de CAMPANHA -> runBatch, adaptador e ledger reais, provedor SIMULADO) para Sonnet 5.5 e Opus 5.5,
// com o perfil de tetos do E2 (ciclo3_c158: 32/32/0/0), o arquivo de desenho do repositorio e um diretorio de campanha proprio por cenario (1o lote = treino, sem gate): DUAS RECUSAS com usage completo seguidas (indices 7 e 8) NAO param o lote e a operacao seguinte VAI;
// as recusas ficam registradas; retomar nao reenvia nada; uma recusa SEM usage completo continua parando (STOP_UNCERTAIN). Mesmo cenario do e1prime_cli.test.ts (Haiku), aqui nos modelos do E2.
// Sem chamada paga, sem rede, sem credencial, sem GO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { freezeCorpus } from '../../../scripts/h2eval/cli/freeze.js';
import { buildPlan, writePlan, capsOfProfile } from '../../../scripts/h2eval/cli/plan.js';
import { runBatch } from '../../../scripts/h2eval/cli/run.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';

const tmp = (p: string) => mkdtempSync(path.join(tmpdir(), `h2eval-e2p-${p}-`));
const WORK = tmp('work'); const SHA = 'c'.repeat(40);
process.env['H2EVAL_ANTHROPIC_API_KEY'] = 'zq-e2p-cli-canary'; // presente no processo; OFFLINE nunca le
const DESIGN = path.join(process.cwd(), 'scripts/h2eval/design/R6_PILOT_DESIGN_PARAMS.json');
const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5'] as const;
const plans: Record<string, { planFile: string; batchId: string; calls: number }> = {};

test("E2' CLI: planos de campanha de Sonnet e Opus (perfil ciclo3_c158, 1o lote) sobre corpus sintetico", { timeout: 300_000 }, () => {
  const CORPUS = path.join(WORK, 'corpus'); freezeCorpus({ out: CORPUS, seed: 20261113, s2: 2, s3: 3, noRepoScan: true });
  const PREREG = path.join(WORK, 'PREREG.md'); writeFileSync(PREREG, '# prereg SYNTHETIC e2prime\n');
  for (const m of MODELS) {
    const plan = buildPlan({ corpusDir: CORPUS, preregFile: PREREG, phase: 'CONFIRMATORY', orderBySplit: true, unratifiedRehearsal: true, studyId: 'H2EVAL-E2PRIME', designParamsFile: DESIGN, capsUsd: capsOfProfile('ciclo3_c158'), inputBoundFactor: 1.91, inputBoundExtraTokens: 37, maxCallsPerBatch: 50, models: [m], now: () => '2026-11-13T05:00:00.000Z' });
    assert.deepEqual([plan.policy.capsUsd.campaign, plan.policy.capsUsd.providers.anthropic, plan.policy.capsUsd.providers.openai, plan.policy.capsUsd.providers.google], ['32', '32', '0', '0']);
    const b = plan.batches[0]!; assert.equal(b.model, m); assert.equal(b.operations[0]!.plan.split, 'train', 'o 1o lote e de treino (sem gate de validacao/holdout)'); assert.ok(b.calls >= 10, `lote com chamadas suficientes (${b.calls})`);
    const planFile = path.join(WORK, `plan-${m}.json`); writePlan(plan, planFile); plans[m] = { planFile, batchId: b.batchId, calls: b.calls };
  }
});

for (const m of MODELS) {
  test(`E2' CLI ${m}: recusas com usage nas chamadas 7 e 8 NAO param; a 9a vai; lote completo; recusas registradas; retomada nao reenvia`, { timeout: 300_000 }, async () => {
    const { planFile, batchId, calls } = plans[m]!; const camp = tmp(`camp-${m}`); const dir = path.join(camp, 'batches', batchId); const faults = { 7: 'refusal_with_usage', 8: 'refusal_with_usage' } as const;
    const s = await runBatch({ planFile, batchId, batchDir: dir, mode: 'offline', executorCodeSha: SHA, campaignDir: camp, offline: { faults } });
    assert.equal(s.stoppedBy, null, 'nenhuma parada (no E2 congelado: STOP_CONSECUTIVE_FAILURES na chamada 9)'); assert.equal(s.executed, calls); assert.equal((s.offlineLog as unknown[]).length, calls);
    assert.equal(s.results[9]!.state, 'COST_COMPUTED', 'a operacao seguinte as duas recusas VAI (indice 9)');
    const recs = readdirSync(path.join(dir, 'records')).map((f) => JSON.parse(readFileSync(path.join(dir, 'records', f), 'utf8')) as { outcome: string; exclusion: string });
    assert.equal(recs.filter((r) => r.outcome === 'REFUSED_WITH_USAGE').length, 2); assert.ok(recs.filter((r) => r.outcome === 'REFUSED_WITH_USAGE').every((r) => r.exclusion === 'NONE'));
    assert.equal(verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8')).filter((l) => l.kind === 'STOP_GLOBAL').length, 0);
    const again = await runBatch({ planFile, batchId, batchDir: dir, mode: 'offline', executorCodeSha: SHA, campaignDir: camp, offline: { faults } });
    assert.equal((again.offlineLog as unknown[]).length, 0, 'retomada: nada reenviado'); assert.equal(again.stoppedBy, null);
  });

  test(`E2' CLI ${m}: recusa SEM usage completo continua falha e para (ERROR_NO_USAGE => UNCERTAIN => STOP_UNCERTAIN)`, { timeout: 300_000 }, async () => {
    const { planFile, batchId } = plans[m]!; const camp = tmp(`nousage-${m}`);
    const s = await runBatch({ planFile, batchId, batchDir: path.join(camp, 'batches', batchId), mode: 'offline', executorCodeSha: SHA, campaignDir: camp, offline: { faults: { 3: 'error_no_usage' } } });
    assert.equal(s.stoppedBy, 'STOP_UNCERTAIN'); assert.equal(s.results.length, 4); assert.equal(s.results[3]!.state, 'UNCERTAIN');
  });
}
