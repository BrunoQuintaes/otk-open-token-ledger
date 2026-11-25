/**
 * Tests that a model probe is judged by its declared purpose (measuring the input) so that a refused or truncated
 * probe with complete usage passes, while every real failure still fails.
 *
 * Modules under test: `scripts/h2eval/core/modelProbe.ts` (`judgeProbe`, `probeKeyOf`, `probeStateOf`) and
 * `scripts/h2eval/core/runner.ts` (`createExecutor`), with the journal verifier and the doubles in
 * `../support/double.ts`.
 *
 * Strategy / partitions: unit checks of the completion criterion (a refusal with complete usage and a truncation
 * with complete usage pass; without response context only COMPLETE passes; each failing refusal condition fails
 * with its reason; the other criteria such as the token ratio, the reserve, reasoning, service tier and unknown
 * usage still apply); executor runs (refused and truncated probes pass and the region continues; a ratio of 1.95, a
 * refusal without usage, partial usage, a wrong served model, and an uncertain send each stop the series and nothing
 * more is sent). Tests tagged with a commit id failed on the executor before the fix.
 *
 * Needs: a writable temporary directory. It sets `H2EVAL_TEST_KEY` to a fake canary value. Doubles only: no
 * network, no credential, no GO file.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/e1hr_probe.test.ts`
 *
 * @module test/h2eval/core/e1hr_probe.test
 */
// SYNTHETIC — OFFLINE. E1HR (C160, HAIKU-R-FIX; opcao (b) do X1 do kit HAIKU-R, B2): a sonda de modelo/faixa e julgada pelo seu PROPOSITO declarado (medir a ENTRADA: U/L0 <= limite, U <= reserva).
// Uma sonda que termina em REFUSAL_WITH_USAGE (protocolo HAIKU-R 48befe37 §5.1: HTTP 200, outcome REFUSED_WITH_USAGE, usage COMPLETE, stop_reason refusal, U>0, modelo servido = pedido, custo CALCULATED,
// exclusion NONE) ou TRUNCADA por max_tokens com usage completo NAO reprova; recusa sem usage, usage parcial, modelo errado, razao acima do limite, entrada acima da reserva e sonda incerta continuam reprovando.
// Os testes marcados [FALHA NO c9d27216] reprovam no executor anterior (COMPLETION_REFUSED / COMPLETION_TRUNCATED_MAX_TOKENS) e passam no E1HR. Doubles apenas: sem rede, sem credencial, sem GO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createExecutor, type ExecutorConfig } from '../../../scripts/h2eval/core/runner.js';
import { verifyJournalText } from '../../../scripts/h2eval/core/journal.js';
import { judgeProbe, probeKeyOf, probeStateOf } from '../../../scripts/h2eval/core/modelProbe.js';
import { loadPriceTable } from '../../../scripts/h2eval/record/prices.js';
import { tmp, writePriceFixture, memoryContentStore, plan, doubleAdapter, bodyOf as rawBodyOf, OFFICIAL_HOST } from '../support/double.js';
import type { BuiltRequest } from '../../../scripts/h2eval/types.js';

process.env['H2EVAL_TEST_KEY'] = 'zq-e1hr-canary';
const NEW = 'claude-future-9'; const LIMIT = 1.9;
const SHORT = Array.from({ length: 30 }, (_, i) => `palavra${i} sintetica de teste`).join(' ');
const TEXTS = { a: SHORT, b: SHORT + ' b', c: SHORT + ' c' };
function pricesFor(dir: string, model: string) { const f = writePriceFixture(dir); writeFileSync(f, readFileSync(f, 'utf8').split('sim-haiku').join(model)); return loadPriceTable(f); }
const kinds = (dir: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));
type Mut = (body: Record<string, unknown>) => void;
// respostas do double: o modelo servido e o PEDIDO (como no provedor real: 308/308 no ciclo 3), salvo quando o caso o muda
const served: Mut = (b) => { b['model'] = NEW; };
const refusal: Mut = (b) => { served(b); b['stop_reason'] = 'refusal'; b['content'] = []; (b['usage'] as Record<string, unknown>)['output_tokens'] = 0; };
const truncated: Mut = (b) => { served(b); b['stop_reason'] = 'max_tokens'; };

function build(o: { dir?: string; ratio?: number; mutate?: Mut; throwSend?: boolean }) {
  const dir = o.dir ?? tmp('e1hr'); const store = memoryContentStore(TEXTS); const sent: BuiltRequest[] = []; let lastL0 = 0;
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: pricesFor(dir, NEW),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' },
      double: async (req: BuiltRequest) => {
        sent.push(req); if (o.throwSend) throw new Error('SYN_SEND_FAILURE');
        const r = rawBodyOf({ kind: 'ok', input: Math.round((o.ratio ?? 1.5) * lastL0), output: 5 });
        (o.mutate ?? served)(r.body as Record<string, unknown>); return { httpStatus: r.status, body: r.body };
      } },
    capPolicy: { inputUpperBoundTokens: (_p, L0) => { lastL0 = L0 as number; return Math.ceil((L0 as number) * 10) + 100; }, reasoningAllowanceTokens: () => 0 },
    executorCodeSha: 'c'.repeat(40), modelProbe: { maxMeasuredToEstimatedRatio: LIMIT }, consecutiveFailureStop: 2,
  };
  return { dir, store, sent, ex: createExecutor(cfg) };
}
const P = (store: { sha: Record<string, string> }, n: string) => plan({ promptSha256: store.sha[n]!, promptId: n.toUpperCase(), modelRequested: NEW });
async function serial(b: ReturnType<typeof build>, names: string[]) { const out: Array<{ stop: string | null }> = []; for (const n of names) { const r = await b.ex.run(P(b.store, n)); out.push(r); if (r.stop) break; } return out; }
const result = (dir: string) => kinds(dir).find((l) => l.kind === 'MODEL_PROBE_RESULT')?.body as { verdict: string; reasons: string[]; ratio: number | string; measured: Record<string, unknown> } | undefined;
const key = probeKeyOf('anthropic', NEW, 'UNMEASURED_MODEL');

// ---------------- unidade: judgeProbe com o contexto da resposta
const okU = { U: 150, outputVisible: 0, reasoning: 0, outputTotal: 0, completion: 'REFUSED', tierServed: 'standard' };
const rwu = { httpStatus: 200 as number | 'UNKNOWN', outcome: 'REFUSED_WITH_USAGE', stopReason: 'refusal', usageCompleteness: 'COMPLETE', modelServed: NEW, modelRequested: NEW, costState: 'CALCULATED', exclusion: 'NONE' };
const trc = { ...rwu, outcome: 'OK', stopReason: 'max_tokens' };
const J = (u: Partial<typeof okU>, resp: Record<string, unknown> | undefined, x: Record<string, unknown> = {}) => judgeProbe({ limit: LIMIT, L0: 100, reservedBound: 500, usage: { ...okU, ...u }, tierRequested: 'standard_only', reasoningAllowance: 0, ...(resp ? { response: resp as never } : {}), ...x });

test('[FALHA NO c9d27216] unidade: REFUSAL_WITH_USAGE (todas as condicoes do §5.1) passa o criterio de completion; TRUNCADA com usage completo passa', () => {
  assert.deepEqual(J({}, rwu), { verdict: 'PASSED', reasons: [], ratio: 1.5 });
  assert.deepEqual(J({ completion: 'TRUNCATED_MAX_TOKENS', outputVisible: 512, outputTotal: 512 }, trc), { verdict: 'PASSED', reasons: [], ratio: 1.5 });
  assert.equal(J({}, { ...rwu, modelServed: 'claude-haiku-5-5-20261001', acceptedModels: ['claude-haiku-5-5-20261001'] }).verdict, 'PASSED', 'modelo servido na lista de aceitos configurada');
});

test('unidade: sem o contexto da resposta (chamada antiga) so COMPLETE passa (fail-closed)', () => {
  assert.equal(J({}, undefined).verdict, 'FAILED'); assert.ok(J({}, undefined).reasons.includes('COMPLETION_REFUSED'));
  assert.equal(J({ completion: 'TRUNCATED_MAX_TOKENS' }, undefined).verdict, 'FAILED'); assert.equal(J({ completion: 'COMPLETE' }, undefined).verdict, 'PASSED');
  for (const c of ['OTHER', 'UNKNOWN']) assert.equal(J({ completion: c }, rwu).verdict, 'FAILED', c);
});

test('unidade: cada condicao do §5.1 que falha reprova a sonda recusada (e a truncada), com o motivo', () => {
  const casos: Array<[string, Record<string, unknown>, Partial<typeof okU>, RegExp]> = [
    ['http', { httpStatus: 400 }, {}, /HTTP_400/], ['http desconhecido', { httpStatus: 'UNKNOWN' }, {}, /HTTP_UNKNOWN/],
    ['outcome', { outcome: 'ERROR_WITH_USAGE' }, {}, /OUTCOME_ERROR_WITH_USAGE/], ['stop_reason', { stopReason: 'end_turn' }, {}, /STOP_REASON_end_turn/],
    ['usage parcial', { usageCompleteness: 'PARTIAL' }, {}, /USAGE_PARTIAL/], ['modelo errado', { modelServed: 'claude-sonnet-5-5' }, {}, /MODEL_SERVED_claude-sonnet-5-5/],
    ['modelo desconhecido', { modelServed: 'UNKNOWN' }, {}, /MODEL_SERVED_UNKNOWN/], ['custo', { costState: 'UNKNOWN' }, {}, /COST_UNKNOWN/],
    ['exclusao', { exclusion: 'EXCL_MODEL_MISMATCH' }, {}, /EXCLUSION_EXCL_MODEL_MISMATCH/], ['U zero', {}, { U: 0 }, /U_NOT_POSITIVE/],
  ];
  for (const [nome, r, u, re] of casos) {
    const v = J(u, { ...rwu, ...r }); assert.equal(v.verdict, 'FAILED', `recusa: ${nome}`); assert.ok(v.reasons.some((x) => x.startsWith('COMPLETION_REFUSED(') && re.test(x)), `recusa ${nome}: ${v.reasons.join(',')}`);
    const t = J({ ...u, completion: 'TRUNCATED_MAX_TOKENS' }, { ...trc, ...r }); assert.equal(t.verdict, 'FAILED', `truncada: ${nome}`);
  }
  assert.equal(J({}, { ...rwu, outcome: 'OK' }).verdict, 'FAILED', 'REFUSED com outcome OK nao e REFUSAL_WITH_USAGE');
  assert.equal(J({ completion: 'TRUNCATED_MAX_TOKENS' }, { ...trc, outcome: 'REFUSED_WITH_USAGE' }).verdict, 'FAILED', 'truncada exige outcome OK');
  assert.equal(J({}, { ...rwu, modelServed: 'outro', acceptedModels: ['claude-haiku-5-5-20261001'] }).verdict, 'FAILED', 'fora da lista de aceitos');
});

test('unidade: os demais criterios continuam valendo na sonda recusada/truncada (razao 1,95, reserva, raciocinio, tier, U desconhecido)', () => {
  const r195 = J({ U: 195 }, rwu); assert.equal(r195.verdict, 'FAILED'); assert.ok(r195.reasons.some((x) => x.startsWith('RATIO_ABOVE_LIMIT(1.9500')));
  assert.equal(J({ U: 195, completion: 'TRUNCATED_MAX_TOKENS' }, trc).verdict, 'FAILED'); assert.equal(J({ U: 195, completion: 'COMPLETE' }, undefined).verdict, 'FAILED');
  assert.equal(J({ U: 190 }, rwu).verdict, 'PASSED', 'razao == limite passa');
  assert.equal(J({ U: 150 }, rwu, { reservedBound: 149 }).verdict, 'FAILED'); assert.equal(J({ reasoning: 1 }, rwu).verdict, 'FAILED'); assert.equal(J({ tierServed: 'priority' }, rwu).verdict, 'FAILED');
  assert.equal(J({ U: 'UNKNOWN' as unknown as number }, rwu).verdict, 'FAILED'); assert.equal(judgeProbe({ limit: LIMIT, L0: 100, reservedBound: 500, usage: null, tierRequested: 'standard_only', reasoningAllowance: 0, response: rwu }).verdict, 'FAILED');
});

// ---------------- executor (runner) ponta a ponta com o double
test('[FALHA NO c9d27216] sonda RECUSADA com usage completo (REFUSAL_WITH_USAGE) NAO reprova: PASSED, sem STOP, a regiao segue', async () => {
  let n = 0; const b = build({ ratio: 1.4, mutate: (x) => { n += 1; (n === 1 ? refusal : served)(x); } });
  const rs = await serial(b, ['a', 'b', 'c']); assert.deepEqual(rs.map((r) => r.stop), [null, null, null]); assert.equal(b.sent.length, 3);
  const res = result(b.dir)!; assert.equal(res.verdict, 'PASSED', res.reasons.join(',')); assert.equal(res.measured['completion'], 'REFUSED'); assert.ok(typeof res.ratio === 'number' && res.ratio > 1.3 && res.ratio < 1.5);
  const k = kinds(b.dir); assert.equal(k.filter((l) => l.kind === 'STOP_GLOBAL').length, 0); assert.equal(probeStateOf(k, key), 'PASSED'); assert.equal(k.filter((l) => l.kind === 'MODEL_PROBE_STARTED').length, 1);
  assert.equal(k.filter((l) => l.kind === 'ERROR_WITH_USAGE').length, 1, 'a recusa continua registrada como tal no diario'); b.ex.close();
});

test('[FALHA NO c9d27216] sonda TRUNCADA por max_tokens com usage completo NAO reprova: PASSED, sem STOP, a regiao segue', async () => {
  let n = 0; const b = build({ ratio: 1.4, mutate: (x) => { n += 1; (n === 1 ? truncated : served)(x); } });
  const rs = await serial(b, ['a', 'b']); assert.deepEqual(rs.map((r) => r.stop), [null, null]); assert.equal(b.sent.length, 2);
  const res = result(b.dir)!; assert.equal(res.verdict, 'PASSED', res.reasons.join(',')); assert.equal(res.measured['completion'], 'TRUNCATED_MAX_TOKENS'); b.ex.close();
});

test('sonda com razao 1,95 reprova (recusada, truncada ou completa): STOP_MODEL_PROBE_FAILED e nada mais e enviado', async () => {
  for (const [nome, m] of [['recusada', refusal], ['truncada', truncated], ['completa', served]] as Array<[string, Mut]>) {
    const b = build({ ratio: 1.95, mutate: m }); const rs = await serial(b, ['a', 'b']);
    assert.equal(rs[0]!.stop, 'STOP_MODEL_PROBE_FAILED', nome); assert.equal(b.sent.length, 1, nome);
    const res = result(b.dir)!; assert.equal(res.verdict, 'FAILED', nome); assert.ok(res.reasons.some((x) => x.startsWith('RATIO_ABOVE_LIMIT')), `${nome}: ${res.reasons.join(',')}`); b.ex.close();
  }
});

test('sonda RECUSADA SEM usage reprova (USAGE_MISSING; STOP) e nada mais e enviado', async () => {
  const b = build({ ratio: 1.4, mutate: (x) => { refusal(x); delete x['usage']; } }); const rs = await serial(b, ['a', 'b']);
  assert.ok(rs[0]!.stop !== null); assert.equal(b.sent.length, 1);
  const res = result(b.dir)!; assert.equal(res.verdict, 'FAILED'); assert.deepEqual(res.reasons, ['USAGE_MISSING']); assert.notEqual(probeStateOf(kinds(b.dir), key), 'PASSED'); b.ex.close();
});

test('sonda recusada com usage PARCIAL ou com modelo servido ERRADO reprova', async () => {
  const casos: Array<[string, Mut, RegExp]> = [
    ['usage parcial', (x) => { refusal(x); delete (x['usage'] as Record<string, unknown>)['cache_read_input_tokens']; }, /./],
    ['modelo errado', (x) => { refusal(x); x['model'] = 'claude-sonnet-5-5'; }, /MODEL_SERVED_claude-sonnet-5-5/],
    ['truncada com modelo errado', (x) => { truncated(x); x['model'] = 'claude-sonnet-5-5'; }, /MODEL_SERVED_claude-sonnet-5-5/],
  ];
  for (const [nome, m, re] of casos) {
    const b = build({ ratio: 1.4, mutate: m }); const rs = await serial(b, ['a', 'b']);
    assert.ok(rs[0]!.stop !== null, nome); assert.equal(b.sent.length, 1, nome);
    const res = result(b.dir)!; assert.equal(res.verdict, 'FAILED', nome); assert.ok(res.reasons.some((x) => re.test(x)), `${nome}: ${res.reasons.join(',')}`); b.ex.close();
  }
});

test('sonda INCERTA (falha de envio) reprova: STOP_UNCERTAIN, sonda sem PASSED (UNRESOLVED), e o reinicio nao envia nada da regiao', async () => {
  const dir = tmp('e1hru'); const b = build({ dir, throwSend: true, mutate: refusal }); const rs = await serial(b, ['a', 'b']);
  assert.equal(rs[0]!.stop, 'STOP_UNCERTAIN'); assert.equal(b.sent.length, 1); assert.equal(result(dir), undefined, 'incerta nunca e julgada');
  assert.equal(probeStateOf(kinds(dir), key), 'UNRESOLVED'); b.ex.close();
  const again = build({ dir, ratio: 1.0 }); const r2 = await again.ex.run(P(again.store, 'b')); assert.ok(r2.stop !== null); assert.equal(again.sent.length, 0, 'nada enviado depois da sonda incerta'); again.ex.close();
});
