/**
 * Tests that a refusal with complete usage does not count as a consecutive failure, while real failures still stop
 * the batch.
 *
 * Module under test: `scripts/h2eval/core/runner.ts` (`createExecutor`, consecutive-failure stop), with the journal
 * verifier and the doubles in `../support/double.ts`.
 *
 * Strategy / scenarios: two refusals with usage in a row do not stop the batch and the next operation is sent and
 * settled; refusals stay recorded (journal, record with calculated cost, per-batch refusal count); a burst of five
 * refusals does not stop the batch by this counter; two served-model mismatches stop the batch before the third
 * send; a refusal with a mismatched served model counts as a failure; and an error without usage still stops at
 * the first occurrence as uncertain.
 *
 * Needs: a writable temporary directory. It sets `H2EVAL_TEST_KEY` to a fake canary value. Doubles only: no network,
 * no credential, no GO file.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/e1prime_refusal.test.ts`
 *
 * @module test/h2eval/core/e1prime_refusal.test
 */
// SYNTHETIC — OFFLINE. E1' (C158, 2026-11-12): RECUSA com usage completo (stop_reason=refusal, REFUSED_WITH_USAGE, exclusion NONE) NAO conta como falha consecutiva.
// Mostra: (1) 2 recusas seguidas nao disparam STOP_CONSECUTIVE_FAILURES e a operacao seguinte e enviada; (2) a recusa continua no journal, no registro (outcome REFUSED_WITH_USAGE, exclusion NONE, custo CALCULATED) e no total de recusas do lote;
// (3) falhas REAIS continuam disparando: modelServed fora dos aceitos x2 => STOP_CONSECUTIVE_FAILURES; erro sem usage => STOP_UNCERTAIN na 1a; recusa com modelServed fora dos aceitos CONTA;
// (4) todas as outras paradas intactas (G7 e teto de custo, ver g7.test.ts / runner.test.ts). Doubles apenas; sem rede, sem credencial, sem GO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, scriptedDouble, OFFICIAL_HOST } from '../support/double.js';

process.env['H2EVAL_TEST_KEY'] = 'zq-e1p-canary';
const TEXTS = { p1: 'Resuma este texto sintético sobre medição de tokens em três frases curtas.', p2: 'Outro texto sintético, diferente, para a segunda operação.', p3: 'Um terceiro texto sintético para a terceira operação do lote.', p4: 'Quarto texto sintético para a quarta operação.', p5: 'Quinto texto sintético para a quinta operação.', p6: 'Sexto texto sintético para a sexta operação.' };

function build(steps: Parameters<typeof scriptedDouble>[0], over: { accepted?: readonly string[] } = {}) {
  const dir = tmp('e1p'); const store = memoryContentStore(TEXTS); const sd = scriptedDouble(steps);
  const modelo = plan({ promptSha256: store.sha['p1']! }).modelRequested;
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir, {}),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: sd.double, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40),
    consecutiveFailureStop: 2, // o valor de producao (cli/run.ts)
    ...(over.accepted ? { acceptedModelsServed: { [modelo]: over.accepted } } : {}),
  };
  return { dir, store, sd, ex: createExecutor(cfg) };
}
const P = (store: { sha: Record<string, string> }, n: string) => plan({ promptSha256: store.sha[n]!, promptId: n.toUpperCase() });
const lines = (dir: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));
const records = (dir: string) => readdirSync(path.join(dir, 'records')).map((f) => JSON.parse(readFileSync(path.join(dir, 'records', f), 'utf8')) as { outcome: string; exclusion: string; cost: { state: string }; refusal: { code?: string } | null });

test("E1': 2 recusas COM usage seguidas NAO disparam STOP_CONSECUTIVE_FAILURES: a 3a operacao e enviada e liquidada", async () => {
  const b = build([{ kind: 'refuse_with_usage', input: 10 }, { kind: 'refuse_with_usage', input: 10 }, { kind: 'ok', input: 10, output: 5 }]);
  const rs = []; for (const n of ['p1', 'p2', 'p3']) rs.push(await b.ex.run(P(b.store, n)));
  assert.deepEqual(rs.map((r) => r.stop), [null, null, null], 'nenhuma parada');
  assert.equal(b.sd.seen.length, 3, 'as 3 operacoes foram ENVIADAS (no E1 congelado a 3a seria ABORTED_BEFORE_SEND/STOP_CONSECUTIVE_FAILURES)');
  assert.equal(lines(b.dir).filter((l) => l.kind === 'STOP_GLOBAL').length, 0);
});

test("E1': a recusa continua registrada: journal completo, registro REFUSED_WITH_USAGE/exclusion NONE/custo CALCULADO e contagem de recusas do lote = 2", async () => {
  const b = build([{ kind: 'refuse_with_usage', input: 10 }, { kind: 'refuse_with_usage', input: 10 }, { kind: 'ok', input: 10, output: 5 }]);
  for (const n of ['p1', 'p2', 'p3']) await b.ex.run(P(b.store, n));
  const k1 = lines(b.dir).filter((l) => l.operationId === operationIdOf(P(b.store, 'p1'))).map((l) => l.kind);
  assert.ok(['SENT', 'USAGE_PARSED', 'COST_COMPUTED', 'SETTLED'].every((x) => k1.includes(x)), `journal da recusa completo: ${k1.join(',')}`);
  const rec = records(b.dir); const rf = rec.filter((r) => r.outcome === 'REFUSED_WITH_USAGE');
  assert.equal(rf.length, 2, 'contador de recusas do lote (derivado dos registros) = 2'); assert.ok(rf.every((r) => r.exclusion === 'NONE' && r.cost.state === 'CALCULATED' && r.refusal !== null));
  assert.equal(rec.filter((r) => r.outcome === 'OK').length, 1);
});

test("E1': tempestade de recusas (5 seguidas) nao para o lote por este contador (limite de custo/ledger e G7 continuam); registra as 5", async () => {
  const b = build([1, 2, 3, 4, 5].map(() => ({ kind: 'refuse_with_usage' as const, input: 10 })).concat([{ kind: 'refuse_with_usage', input: 10 }]));
  const rs = []; for (const n of ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']) rs.push(await b.ex.run(P(b.store, n)));
  assert.deepEqual(rs.map((r) => r.stop), [null, null, null, null, null, null]); assert.equal(records(b.dir).filter((r) => r.outcome === 'REFUSED_WITH_USAGE').length, 6);
});

test("E1': falhas REAIS continuam disparando: modelServed fora dos aceitos (EXCL_MODEL_MISMATCH) x2 => STOP_CONSECUTIVE_FAILURES na 3a, que NAO e enviada", async () => {
  const b = build([{ kind: 'ok', input: 10, output: 5 }, { kind: 'ok', input: 10, output: 5 }, { kind: 'ok', input: 10, output: 5 }], { accepted: ['modelo-que-nao-e-o-servido'] });
  const rs = []; for (const n of ['p1', 'p2', 'p3']) rs.push(await b.ex.run(P(b.store, n)));
  assert.deepEqual(rs.map((r) => r.stop), [null, null, 'STOP_CONSECUTIVE_FAILURES']); assert.equal(b.sd.seen.length, 2, 'a 3a nao foi enviada');
});

test("E1': recusa com modelServed fora dos aceitos (exclusion != NONE) CONTA como falha: 2 => STOP_CONSECUTIVE_FAILURES", async () => {
  const b = build([{ kind: 'refuse_with_usage', input: 10 }, { kind: 'refuse_with_usage', input: 10 }, { kind: 'ok' }], { accepted: ['modelo-que-nao-e-o-servido'] });
  const rs = []; for (const n of ['p1', 'p2', 'p3']) rs.push(await b.ex.run(P(b.store, n)));
  assert.deepEqual(rs.map((r) => r.stop), [null, null, 'STOP_CONSECUTIVE_FAILURES']); assert.equal(b.sd.seen.length, 2);
});

test("E1': erro SEM usage continua parando na 1a (UNCERTAIN => STOP_UNCERTAIN, nada mais enviado): a regra de incerteza nao mudou", async () => {
  const b = build([{ kind: 'error_no_usage' }, { kind: 'ok' }]);
  const r1 = await b.ex.run(P(b.store, 'p1')); assert.equal(r1.stop, 'STOP_UNCERTAIN'); const r2 = await b.ex.run(P(b.store, 'p2'));
  assert.ok(r2.stop, 'a operacao seguinte tambem e barrada (trava derivada do journal)'); assert.equal(b.sd.seen.length, 1);
});
