// SYNTHETIC — OFFLINE. E2' (C159-A Q04, 2026-11-13): a MESMA regra do E1' (3ea40943) portada para o executor E2 (be8acab2) de Sonnet/Opus, exercida com o perfil de tetos do E2 (ciclo3_c158: 32/32/0/0)
// e com o valor de producao consecutiveFailureStop = 2 (cli/run.ts). Mostra: (1) recusas com usage completo nao contam; (2) a recusa NAO zera uma sequencia de falhas REAIS em curso (falha real, recusa, falha real => STOP na 4a);
// (3) falhas reais (modelServed fora dos aceitos) e erro sem usage continuam com o tratamento anterior; (4) o perfil do E2 continua o unico aceito acima do padrao (o teste de tetos fica em capsProfileExecutor.test.ts).
// Doubles apenas; sem rede, sem credencial, sem GO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';
import { tmp, prices, memoryContentStore, plan, doubleAdapter, bodyOf, OFFICIAL_HOST, type ScriptedBody } from '../support/double.js';

process.env['H2EVAL_TEST_KEY'] = 'zq-e2p-canary';
const TEXTS = { p1: 'Primeiro texto sintético para o E2 linha.', p2: 'Segundo texto sintético para o E2 linha.', p3: 'Terceiro texto sintético para o E2 linha.', p4: 'Quarto texto sintético para o E2 linha.', p5: 'Quinto texto sintético para o E2 linha.' };
const CICLO3 = { campaignUsd: '32', providersUsd: { anthropic: '32', openai: '0', google: '0' } };
type Step = ScriptedBody & { servedAs?: string };

function build(steps: Step[], accepted?: readonly string[] | 'SELF') {
  const dir = tmp('e2p'); const store = memoryContentStore(TEXTS); const seen: BuiltRequest[] = [];
  const modelo = plan({ promptSha256: store.sha['p1']! }).modelRequested;
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: prices(dir, {}), ledger: CICLO3,
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' }, double: async (req: BuiltRequest) => {
      seen.push(req); const s = steps.shift() ?? ({ kind: 'ok' } as Step); const r = bodyOf(s);
      const body = s.servedAs && r.body && typeof r.body === 'object' ? { ...(r.body as Record<string, unknown>), model: s.servedAs } : r.body;
      return { httpStatus: r.status, body };
    } },
    capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40),
    consecutiveFailureStop: 2, // o valor de producao (cli/run.ts)
    ...(accepted ? { acceptedModelsServed: { [modelo]: accepted === 'SELF' ? [modelo] : accepted } } : {}), // 'SELF': so o modelo pedido (o que o double serve por padrao) e aceito
  };
  return { dir, store, seen, modelo, ex: createExecutor(cfg) };
}
const P = (store: { sha: Record<string, string> }, n: string) => plan({ promptSha256: store.sha[n]!, promptId: n.toUpperCase() });
const lines = (dir: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));
const records = (dir: string) => readdirSync(path.join(dir, 'records')).map((f) => JSON.parse(readFileSync(path.join(dir, 'records', f), 'utf8')) as { outcome: string; exclusion: string; cost: { state: string } });

test("E2' (perfil ciclo3_c158): 2 recusas COM usage seguidas nao param; a 3a e enviada; recusas registradas com custo CALCULADO e liquidadas no ledger", async () => {
  const b = build([{ kind: 'refuse_with_usage', input: 10 }, { kind: 'refuse_with_usage', input: 10 }, { kind: 'ok', input: 10, output: 5 }]);
  const rs = []; for (const n of ['p1', 'p2', 'p3']) rs.push(await b.ex.run(P(b.store, n)));
  assert.deepEqual(rs.map((r) => r.stop), [null, null, null]); assert.equal(b.seen.length, 3);
  const rf = records(b.dir).filter((r) => r.outcome === 'REFUSED_WITH_USAGE'); assert.equal(rf.length, 2); assert.ok(rf.every((r) => r.exclusion === 'NONE' && r.cost.state === 'CALCULATED'));
  assert.equal(lines(b.dir).filter((l) => l.kind === 'SETTLED').length, 3, 'as 3 (inclusive as recusas) liquidadas no ledger');
  assert.equal(lines(b.dir).filter((l) => l.kind === 'STOP_GLOBAL').length, 0); b.ex.close();
});

test("E2': a recusa NAO zera uma sequencia de falhas REAIS: falha real, recusa com usage, falha real => STOP_CONSECUTIVE_FAILURES na 4a, que NAO e enviada", async () => {
  const MOD = 'claude-sonnet-5-5-SERVIDO-ERRADO';
  // so o modelo pedido e aceito: as operacoes servidas como MOD sao falhas reais (EXCL_MODEL_MISMATCH); a recusa e servida pelo modelo aceito (exclusion NONE)
  const b2 = build([{ kind: 'ok', input: 10, output: 5, servedAs: MOD }, { kind: 'refuse_with_usage', input: 10 }, { kind: 'ok', input: 10, output: 5, servedAs: MOD }, { kind: 'ok' }], 'SELF');
  const rs = []; for (const n of ['p1', 'p2', 'p3', 'p4']) rs.push(await b2.ex.run(P(b2.store, n)));
  assert.deepEqual(rs.map((r) => r.stop), [null, null, null, 'STOP_CONSECUTIVE_FAILURES']); assert.equal(b2.seen.length, 3, 'a 4a nao foi enviada');
  const rec = records(b2.dir); assert.equal(rec.filter((r) => r.exclusion === 'EXCL_MODEL_MISMATCH').length, 2); assert.equal(rec.filter((r) => r.outcome === 'REFUSED_WITH_USAGE' && r.exclusion === 'NONE').length, 1);
  b2.ex.close();
});

test("E2': uma resposta OK continua zerando a sequencia: falha real, OK, falha real => nenhuma parada (comportamento anterior)", async () => {
  const MOD = 'modelo-servido-errado';
  const b2 = build([{ kind: 'ok', input: 10, output: 5, servedAs: MOD }, { kind: 'ok', input: 10, output: 5 }, { kind: 'ok', input: 10, output: 5, servedAs: MOD }, { kind: 'ok', input: 10, output: 5 }], 'SELF');
  const rs = []; for (const n of ['p1', 'p2', 'p3', 'p4']) rs.push(await b2.ex.run(P(b2.store, n)));
  assert.deepEqual(rs.map((r) => r.stop), [null, null, null, null]); assert.equal(b2.seen.length, 4); b2.ex.close();
});

test("E2' (perfil ciclo3_c158): falhas REAIS x2 (modelServed fora dos aceitos) => STOP_CONSECUTIVE_FAILURES na 3a; recusa fora dos aceitos CONTA; erro sem usage => STOP_UNCERTAIN na 1a", async () => {
  const a = build([{ kind: 'ok', input: 10, output: 5 }, { kind: 'ok', input: 10, output: 5 }, { kind: 'ok' }], ['modelo-que-nao-e-o-servido']);
  const ra = []; for (const n of ['p1', 'p2', 'p3']) ra.push(await a.ex.run(P(a.store, n)));
  assert.deepEqual(ra.map((r) => r.stop), [null, null, 'STOP_CONSECUTIVE_FAILURES']); assert.equal(a.seen.length, 2); a.ex.close();
  const r = build([{ kind: 'refuse_with_usage', input: 10 }, { kind: 'refuse_with_usage', input: 10 }, { kind: 'ok' }], ['modelo-que-nao-e-o-servido']);
  const rr = []; for (const n of ['p1', 'p2', 'p3']) rr.push(await r.ex.run(P(r.store, n)));
  assert.deepEqual(rr.map((x) => x.stop), [null, null, 'STOP_CONSECUTIVE_FAILURES']); assert.equal(r.seen.length, 2); r.ex.close();
  const u = build([{ kind: 'error_no_usage' }, { kind: 'ok' }]);
  const u1 = await u.ex.run(P(u.store, 'p1')); assert.equal(u1.stop, 'STOP_UNCERTAIN'); const u2 = await u.ex.run(P(u.store, 'p2')); assert.ok(u2.stop); assert.equal(u.seen.length, 1); u.ex.close();
});
