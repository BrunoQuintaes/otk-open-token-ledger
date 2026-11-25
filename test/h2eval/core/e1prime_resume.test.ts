/**
 * Tests resuming a partial batch after a consecutive-failure stop: the stop stays terminal and visible, settled
 * operations are not re-sent, and money and uncertainty stops still block.
 *
 * Modules under test: `scripts/h2eval/core/runner.ts` (`createExecutor`), `scripts/h2eval/core/journal.ts`
 * (`openJournal`, `verifyJournalText`) and `scripts/h2eval/cli/status.ts` (`status`), with the doubles in
 * `../support/double.ts`.
 *
 * Strategy / scenarios: a journal shaped like a real partial batch (two settled operations, the third stopped
 * before planning) resumes without re-sending the settled ones and without marking the stopped one as settled (the
 * gap shows in the status); resuming a completed batch again sends nothing and moves no money; a sub-ledger without
 * balance stops before any send, also after a restart; and an uncertain operation is not re-sent on resume and
 * blocks new ones.
 *
 * Needs: a writable temporary directory. It sets `H2EVAL_TEST_KEY` to a fake canary value. No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/e1prime_resume.test.ts`
 *
 * @module test/h2eval/core/e1prime_resume.test
 */
// SYNTHETIC — OFFLINE. E1' (C158/C159, 2026-11-12), parte 2: retomada de lote PARCIAL depois de STOP_CONSECUTIVE_FAILURES. O STOP e gravado antes de planejar/reservar/enviar (a operacao parada nunca foi enviada nem cobrada).
// ESCOPO MINIMO (coordenadora 20:28Z): o E1' NAO muda a retomada. A linha STOP_GLOBAL(STOP_CONSECUTIVE_FAILURES) continua TERMINAL (caso real: lote 2 do Haiku, operacao f43f5a1c = desvio de execucao, lote fecha em <= 59/60, sem reenvio).
// Aqui: (1) as liquidadas NAO sao reenviadas; (2) a operacao parada NAO e reenviada e NAO aparece como liquidada (o buraco e visivel no status); (3) idempotencia; (4) STOP financeiro e incerta continuam travando.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { verifyJournalText, openJournal } from '../../../scripts/h2eval/core/journal.js';
import { status } from '../../../scripts/h2eval/cli/status.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, scriptedDouble, OFFICIAL_HOST } from '../support/double.js';

process.env['H2EVAL_TEST_KEY'] = 'zq-e1p-resume';
const TEXTS = { p1: 'Resuma este texto sintético sobre medição de tokens em três frases curtas.', p2: 'Outro texto sintético, diferente, para a segunda operação.', p3: 'Um terceiro texto sintético para a terceira operação do lote.', p4: 'Quarto texto sintético para a quarta operação.' };
function cfgOf(dir: string, store: ReturnType<typeof memoryContentStore>, steps: Parameters<typeof scriptedDouble>[0], accepted?: readonly string[], caps?: Partial<ExecutorConfig['ledger']>) {
  const sd = scriptedDouble(steps); const modelo = plan({ promptSha256: store.sha['p1']! }).modelRequested;
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir, {}),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' }, ...caps },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], double: sd.double, credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' } },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40), consecutiveFailureStop: 2,
    ...(accepted ? { acceptedModelsServed: { [modelo]: accepted } } : {}),
  };
  return { cfg, sd };
}
const P = (store: { sha: Record<string, string> }, n: string) => plan({ promptSha256: store.sha[n]!, promptId: n.toUpperCase() });
const lines = (dir: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));
const kindsOf = (dir: string, id: string) => lines(dir).filter((l) => l.operationId === id).map((l) => l.kind);

test("E1' retomada parcial (estado real do lote 2): STOP_GLOBAL(STOP_CONSECUTIVE_FAILURES) continua TERMINAL e VISIVEL: p1/p2 liquidadas nao sao reenviadas, a p3 parada NAO e reenviada e NAO aparece como liquidada (desvio de execucao, sem 60a observacao)", async () => {
  const dir = tmp('e1p-resume'); const store = memoryContentStore(TEXTS);
  const a = cfgOf(dir, store, [{ kind: 'ok' }, { kind: 'ok' }]); const ex1 = createExecutor(a.cfg); for (const n of ['p1', 'p2']) await ex1.run(P(store, n));
  const id3 = operationIdOf(P(store, 'p3'));
  // o que o executor gravou no lote 2 real: o STOP e a unica linha da operacao parada (nada planejado, reservado nem enviado)
  openJournal(path.join(dir, 'journal.jsonl')).append('STOP_GLOBAL', id3, { reason: 'STOP_CONSECUTIVE_FAILURES', model: plan({ promptSha256: store.sha['p3']! }).modelRequested });
  const b = cfgOf(dir, store, [{ kind: 'ok' }, { kind: 'ok' }, { kind: 'ok' }]); const ex2 = createExecutor(b.cfg);
  const r2 = []; for (const n of ['p1', 'p2', 'p3']) r2.push(await ex2.run(P(store, n)));
  assert.deepEqual(r2.map((r) => [r.replayed, r.stop]), [[true, null], [true, null], [true, null]], 'as 3 sao replay: nada e reenviado (inclusive a parada)');
  assert.equal(b.sd.seen.length, 0, 'zero chamadas na retomada'); assert.equal(lines(dir).filter((l) => l.kind === 'SENT').length, 2, 'so p1 e p2 foram enviadas, uma vez cada');
  const ks = kindsOf(dir, id3); assert.ok(!ks.includes('SETTLED') && !ks.includes('SENT') && ks.includes('STOP_GLOBAL'), 'a p3 NAO e liquidada e a parada continua no journal (visivel)');
  const st = status(dir); assert.equal(st.operations[id3]!.last === 'REPLAY_SKIPPED' || st.operations[id3]!.last === 'STOP_GLOBAL', true);
  assert.equal(Object.values(st.operations).filter((o) => o.kinds.includes('SETTLED')).length, 2, 'o status mostra 2 liquidadas de 3 operacoes (o buraco aparece: a p3 nao tem SETTLED)');
});

test("E1' idempotencia: retomar de novo depois de completa nao envia nada e nao muda o dinheiro", async () => {
  const dir = tmp('e1p-idem'); const store = memoryContentStore(TEXTS);
  const a = cfgOf(dir, store, [{ kind: 'ok' }, { kind: 'ok' }, { kind: 'ok' }]); const ex1 = createExecutor(a.cfg); for (const n of ['p1', 'p2', 'p3']) await ex1.run(P(store, n));
  const antes = lines(dir).filter((l) => l.kind === 'SENT').length;
  const b = cfgOf(dir, store, [{ kind: 'ok' }]); const ex2 = createExecutor(b.cfg); const r = []; for (const n of ['p1', 'p2', 'p3']) r.push(await ex2.run(P(store, n)));
  assert.ok(r.every((x) => x.replayed && x.stop === null)); assert.equal(b.sd.seen.length, 0); assert.equal(lines(dir).filter((l) => l.kind === 'SENT').length, antes);
});

test("E1' STOP financeiro continua parando: sub-ledger sem saldo => STOP_BUDGET antes de qualquer envio; apos reinicio nada e enviado (inalterado)", async () => {
  const dir = tmp('e1p-fin'); const store = memoryContentStore(TEXTS);
  const a = cfgOf(dir, store, [{ kind: 'ok' }], undefined, { providersUsd: { anthropic: '0.000001', openai: '3', google: '3' } }); const ex1 = createExecutor(a.cfg);
  const r1 = await ex1.run(P(store, 'p1')); assert.match(String(r1.stop), /^STOP_BUDGET/); assert.equal(a.sd.seen.length, 0);
  assert.equal(lines(dir).filter((l) => l.kind === 'SENT').length, 0);
  const b = cfgOf(dir, store, [{ kind: 'ok' }], undefined, { providersUsd: { anthropic: '0.000001', openai: '3', google: '3' } }); const ex2 = createExecutor(b.cfg);
  const r2 = await ex2.run(P(store, 'p1')); assert.equal(r2.replayed, true, 'comportamento inalterado do E1: a operacao parada por orcamento e replay terminal'); assert.equal(b.sd.seen.length, 0, 'nada enviado');
  assert.equal(lines(dir).filter((l) => l.kind === 'SENT').length, 0);
});

test("E1' incerta continua travando: erro sem usage => STOP_UNCERTAIN; na retomada a incerta NAO e reenviada e as novas ficam barradas", async () => {
  const dir = tmp('e1p-unc'); const store = memoryContentStore(TEXTS);
  const a = cfgOf(dir, store, [{ kind: 'error_no_usage' }, { kind: 'ok' }]); const ex1 = createExecutor(a.cfg);
  const r1 = await ex1.run(P(store, 'p1')); assert.equal(r1.stop, 'STOP_UNCERTAIN'); assert.equal(a.sd.seen.length, 1);
  const b = cfgOf(dir, store, [{ kind: 'ok' }, { kind: 'ok' }]); const ex2 = createExecutor(b.cfg);
  const r2 = await ex2.run(P(store, 'p1')); assert.equal(r2.stop, 'STOP_UNCERTAIN'); assert.equal(r2.replayed, true); const r3 = await ex2.run(P(store, 'p2')); assert.ok(r3.stop, 'nova operacao barrada');
  assert.equal(b.sd.seen.length, 0, 'nada reenviado na retomada');
});
