/**
 * Tests the purpose-based probe judgement (measure the input; a truncation with complete usage does not fail) for
 * the probes of the largest comparison model, whose probes may be truncated by their output cap.
 *
 * Modules under test: `scripts/h2eval/core/modelProbe.ts` (`judgeProbe`, `probeKeyOf`, `probeStateOf`) and
 * `scripts/h2eval/core/runner.ts` (`createExecutor`), with the journal verifier and the doubles in
 * `../support/double.ts`.
 *
 * Strategy / partitions: unit checks with the planned probe sizes (a summary probe with a 512-token cap and an
 * analysis first call with a 256-token cap, each truncated with complete usage, pass; a token ratio of 1.91 fails
 * while exactly 1.9 passes; a refusal without usage, reasoning above the allowance and a wrong served model fail);
 * executor runs (truncated probes pass and the band continues; ratio 1.91, refusal without usage and an uncertain
 * send stop the series and nothing more is sent). Sizes come from the audited plan, not from provider responses.
 * Tests tagged with a commit id failed on the executor before the fix.
 *
 * Needs: a writable temporary directory. It sets `H2EVAL_TEST_KEY` to a fake canary value. Doubles only: no network,
 * no credential, no GO file.
 *
 * Run just this file: `npx tsx --test test/h2eval/core/e3hr_opus_probe.test.ts`
 *
 * @module test/h2eval/core/e3hr_opus_probe.test
 */
// SYNTHETIC — OFFLINE. E3HR (C160, OPUS-FIX): o delta da sonda do E1HR (0c48a96d sobre c9d27216) portado para o executor E2''' 11bcd2f4, com os casos do OPUS (R6-M E3PPP).
// A sonda de modelo/faixa e julgada pelo seu PROPOSITO declarado (medir a ENTRADA: U/L0 <= limite e U <= reserva). Para o Opus (claude-opus-5-5, faixa medida 12..810), as sondas do plano
// sao a 1a operacao de cada banda ABOVE_RANGE_Bk: resumo com max_tokens 512 (L0 ~ 860-875), call1 de analise com max_tokens 256 (L0 ~ 5.000) e codigo com 2048. O raciocinio conta no max_tokens,
// entao uma sonda de resumo/call1 pode TRUNCAR por max_tokens com usage completo: isso NAO reprova (a entrada medida e a mesma). Continuam reprovando: razao 1,91 > 1,9, recusa SEM usage, incerta.
// Casos marcados [FALHA NO 11bcd2f4] reprovam no executor anterior (COMPLETION_TRUNCATED_MAX_TOKENS => STOP_MODEL_PROBE_FAILED) e passam no E3HR. Doubles apenas: sem rede, sem credencial, sem GO.
// Nenhum dado do Opus foi usado: os tamanhos (512/256, L0 ~ 875 e ~ 5.000) vem do PLANO auditado (ANALISE_SONDAS_OPUS.md), nao de resposta do provedor.
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

process.env['H2EVAL_TEST_KEY'] = 'zq-e3hr-canary';
const OPUS = 'claude-opus-5-5'; const LIMIT = 1.9;   // PROBE_MAX_RATIO do roda_r6m (1.9)
const phrase = (i: number) => `trecho${i} de prosa sintetica para a sonda`;
const textOf = (n: number, tag: string) => Array.from({ length: n }, (_, i) => phrase(i)).join(' ') + ` ${tag}`;
// RESUMO (banda B0: 810 < L0 <= 1620) e CALL1 (banda B2: 3240 < L0 <= 6480); cada texto tem uma segunda operacao da mesma banda
const TEXTS = { s1: textOf(95, 's1'), s2: textOf(96, 's2'), c1: textOf(420, 'c1'), c2: textOf(421, 'c2') };
function pricesFor(dir: string, model: string) { const f = writePriceFixture(dir); writeFileSync(f, readFileSync(f, 'utf8').split('sim-haiku').join(model)); return loadPriceTable(f); }
const kinds = (dir: string) => verifyJournalText(readFileSync(path.join(dir, 'journal.jsonl'), 'utf8'));
type Mut = (body: Record<string, unknown>) => void;
const served: Mut = (b) => { b['model'] = OPUS; };
const truncAt = (maxTokens: number): Mut => (b) => { served(b); b['stop_reason'] = 'max_tokens'; (b['usage'] as Record<string, unknown>)['output_tokens'] = maxTokens; };
const refusal: Mut = (b) => { served(b); b['stop_reason'] = 'refusal'; b['content'] = []; (b['usage'] as Record<string, unknown>)['output_tokens'] = 0; };

function build(o: { dir?: string; ratio?: number; mutate?: Mut; throwSend?: boolean }) {
  const dir = o.dir ?? tmp('e3hr'); const store = memoryContentStore(TEXTS); const sent: BuiltRequest[] = []; let lastL0 = 0;
  const cfg: ExecutorConfig = {
    batchDir: dir, adapters: { 'anthropic.messages': doubleAdapter() }, contentStore: store, prices: pricesFor(dir, OPUS),
    ledger: { campaignUsd: '11', providersUsd: { anthropic: '5', openai: '3', google: '3' } },
    egress: { mode: 'OFFLINE', campaign: 'h2eval-test', allowedHosts: [OFFICIAL_HOST], credentialEnvVars: { anthropic: 'H2EVAL_TEST_KEY' },
      double: async (req: BuiltRequest) => {
        sent.push(req); if (o.throwSend) throw new Error('SYN_SEND_FAILURE');
        const r = rawBodyOf({ kind: 'ok', input: Math.round((o.ratio ?? 1.5) * lastL0), output: 40 });
        (o.mutate ?? served)(r.body as Record<string, unknown>); return { httpStatus: r.status, body: r.body };
      } },
    // reserva folgada (10x) para isolar o criterio da razao; a reserva continua julgada (testada no e1hr_probe.test.ts)
    capPolicy: { inputUpperBoundTokens: (_p, L0) => { lastL0 = L0 as number; return Math.ceil((L0 as number) * 10) + 100; }, reasoningAllowanceTokens: () => 1024 },
    executorCodeSha: 'c'.repeat(40), modelProbe: { maxMeasuredToEstimatedRatio: LIMIT }, consecutiveFailureStop: 2,
  };
  return { dir, store, sent, ex: createExecutor(cfg) };
}
const P = (store: { sha: Record<string, string> }, n: string, maxTokens: number) => { const base = plan({ promptSha256: store.sha[n]!, promptId: n.toUpperCase(), modelRequested: OPUS }); return { ...base, params: { ...base.params, maxTokens } }; };
async function serial(b: ReturnType<typeof build>, names: string[], maxTokens: number) { const out: Array<{ stop: string | null }> = []; for (const n of names) { const r = await b.ex.run(P(b.store, n, maxTokens)); out.push(r); if (r.stop) break; } return out; }
type Res = { key: string; verdict: string; reasons: string[]; ratio: number | string; localCount: number; measured: Record<string, unknown> };
const result = (dir: string) => kinds(dir).find((l) => l.kind === 'MODEL_PROBE_RESULT')?.body as Res | undefined;

// ---------------- unidade: judgeProbe com os numeros das sondas do Opus (L0 do plano; nenhum dado do Opus)
const rsp = { httpStatus: 200 as number | 'UNKNOWN', outcome: 'OK', stopReason: 'max_tokens', usageCompleteness: 'COMPLETE', modelServed: OPUS, modelRequested: OPUS, costState: 'CALCULATED', exclusion: 'NONE' };
const J = (L0: number, U: number, u: Record<string, unknown>, resp: Record<string, unknown> | undefined, reservedBound = Math.ceil(1.91 * L0) + 37) =>
  judgeProbe({ limit: LIMIT, L0, reservedBound, usage: { U, outputVisible: 0, reasoning: 'NOT_APPLICABLE', outputTotal: 0, completion: 'TRUNCATED_MAX_TOKENS', tierServed: 'standard', ...u }, tierRequested: 'standard_only', reasoningAllowance: 1024, ...(resp ? { response: resp as never } : {}) });

test('[FALHA NO 11bcd2f4] unidade Opus: sonda de RESUMO (val-b2 summary-S, L0 859, max_tokens 512) truncada com usage completo passa; raciocinio dentro da franquia conta no teto', () => {
  assert.deepEqual(J(859, 1288, { outputVisible: 512, outputTotal: 512 }, rsp), { verdict: 'PASSED', reasons: [], ratio: 1288 / 859 });
  assert.equal(J(875, 1310, { outputVisible: 300, reasoning: 212, outputTotal: 512 }, rsp).verdict, 'PASSED', 'train-b3 summary-S: 300 visiveis + 212 de raciocinio = 512');
  assert.equal(J(1000, 1900, { outputVisible: 512, outputTotal: 512 }, rsp, 5000).verdict, 'PASSED', 'truncada com razao == limite passa');
  assert.equal(J(859, 1288, { outputVisible: 512, outputTotal: 512 }, undefined).verdict, 'FAILED', 'sem o contexto da resposta continua fail-closed');
});

test('[FALHA NO 11bcd2f4] unidade Opus: CALL1 de analise (val-b3 36db30b5, L0 5041, max_tokens 256) truncada com usage completo passa', () => {
  assert.deepEqual(J(5041, 7562, { outputVisible: 0, reasoning: 256, outputTotal: 256 }, rsp), { verdict: 'PASSED', reasons: [], ratio: 7562 / 5041 });
  assert.equal(J(5422, 8133, { outputVisible: 256, outputTotal: 256 }, rsp).verdict, 'PASSED', 'train-b3 call1 6b2b9f3f');
});

test('unidade Opus: razao 1,91 reprova (truncada ou completa), mesmo com usage completo; == 1,9 passa', () => {
  const t = J(1000, 1910, { outputVisible: 512, outputTotal: 512 }, rsp, 5000); assert.equal(t.verdict, 'FAILED'); assert.ok(t.reasons.some((x) => x.startsWith('RATIO_ABOVE_LIMIT(1.9100>1.9)')), t.reasons.join(','));
  assert.equal(J(1000, 1910, { completion: 'COMPLETE' }, undefined, 5000).verdict, 'FAILED');
  assert.equal(J(1000, 1900, { completion: 'COMPLETE' }, undefined, 5000).verdict, 'PASSED', 'razao == limite passa (criterio da razao inalterado)');
});

test('unidade Opus: recusa SEM usage reprova (USAGE_MISSING); raciocinio acima da franquia reprova; modelo servido errado reprova', () => {
  const r = judgeProbe({ limit: LIMIT, L0: 859, reservedBound: 1678, usage: null, tierRequested: 'standard_only', reasoningAllowance: 1024, response: { ...rsp, outcome: 'ERROR_NO_USAGE', stopReason: 'refusal', usageCompleteness: 'MISSING' } });
  assert.deepEqual(r, { verdict: 'FAILED', reasons: ['USAGE_MISSING'], ratio: 'UNKNOWN' });
  assert.equal(J(5041, 7562, { reasoning: 1025, outputTotal: 1025 }, rsp).verdict, 'FAILED');
  assert.equal(J(859, 1288, {}, { ...rsp, modelServed: 'claude-sonnet-5-5' }).verdict, 'FAILED');
});

// ---------------- executor (runner do 11bcd2f4 + delta) ponta a ponta com o double
test('[FALHA NO 11bcd2f4] Opus: sonda de RESUMO (banda ABOVE_RANGE_B0, max_tokens 512) TRUNCADA com usage completo => PASSED, sem STOP, a banda segue', async () => {
  let n = 0; const b = build({ ratio: 1.5, mutate: (x) => { n += 1; (n === 1 ? truncAt(512) : served)(x); } });
  const rs = await serial(b, ['s1', 's2'], 512); assert.deepEqual(rs.map((r) => r.stop), [null, null]); assert.equal(b.sent.length, 2);
  const res = result(b.dir)!; assert.equal(res.key, probeKeyOf('anthropic', OPUS, 'ABOVE_RANGE_B0')); assert.ok(res.localCount > 810 && res.localCount <= 1620, `L0 ${res.localCount}`);
  assert.equal(res.verdict, 'PASSED', res.reasons.join(',')); assert.equal(res.measured['completion'], 'TRUNCATED_MAX_TOKENS'); assert.equal(res.measured['outputVisible'], 512);
  const k = kinds(b.dir); assert.equal(k.filter((l) => l.kind === 'STOP_GLOBAL').length, 0); assert.equal(probeStateOf(k, res.key), 'PASSED'); b.ex.close();
});

test('[FALHA NO 11bcd2f4] Opus: sonda CALL1 (banda ABOVE_RANGE_B2, max_tokens 256) TRUNCADA com usage completo => PASSED, sem STOP, a banda segue', async () => {
  let n = 0; const b = build({ ratio: 1.5, mutate: (x) => { n += 1; (n === 1 ? truncAt(256) : served)(x); } });
  const rs = await serial(b, ['c1', 'c2'], 256); assert.deepEqual(rs.map((r) => r.stop), [null, null]); assert.equal(b.sent.length, 2);
  const res = result(b.dir)!; assert.equal(res.key, probeKeyOf('anthropic', OPUS, 'ABOVE_RANGE_B2')); assert.ok(res.localCount > 3240 && res.localCount <= 6480, `L0 ${res.localCount}`);
  assert.equal(res.verdict, 'PASSED', res.reasons.join(',')); assert.equal(res.measured['completion'], 'TRUNCATED_MAX_TOKENS'); b.ex.close();
});

test('Opus: sonda com razao 1,91 reprova (truncada ou completa): STOP_MODEL_PROBE_FAILED e nada mais e enviado', async () => {
  for (const [nome, m] of [['truncada', truncAt(512)], ['completa', served]] as Array<[string, Mut]>) {
    const b = build({ ratio: 1.91, mutate: m }); const rs = await serial(b, ['s1', 's2'], 512);
    assert.equal(rs[0]!.stop, 'STOP_MODEL_PROBE_FAILED', nome); assert.equal(b.sent.length, 1, nome);
    const res = result(b.dir)!; assert.equal(res.verdict, 'FAILED', nome); assert.ok(typeof res.ratio === 'number' && res.ratio > 1.9, `${nome}: ${res.ratio}`);
    assert.ok(res.reasons.some((x) => x.startsWith('RATIO_ABOVE_LIMIT')), `${nome}: ${res.reasons.join(',')}`); b.ex.close();
  }
});

test('Opus: sonda RECUSADA SEM usage reprova (USAGE_MISSING; STOP) e nada mais e enviado', async () => {
  const b = build({ ratio: 1.5, mutate: (x) => { refusal(x); delete x['usage']; } }); const rs = await serial(b, ['s1', 's2'], 512);
  assert.ok(rs[0]!.stop !== null); assert.equal(b.sent.length, 1);
  const res = result(b.dir)!; assert.equal(res.verdict, 'FAILED'); assert.deepEqual(res.reasons, ['USAGE_MISSING']); assert.notEqual(probeStateOf(kinds(b.dir), res.key), 'PASSED'); b.ex.close();
});

test('Opus: sonda INCERTA (falha de envio) reprova: STOP_UNCERTAIN, sem julgamento (UNRESOLVED), e o reinicio nao envia nada da banda', async () => {
  const dir = tmp('e3hru'); const b = build({ dir, throwSend: true, mutate: truncAt(512) }); const rs = await serial(b, ['s1', 's2'], 512);
  assert.equal(rs[0]!.stop, 'STOP_UNCERTAIN'); assert.equal(b.sent.length, 1); assert.equal(result(dir), undefined, 'incerta nunca e julgada');
  assert.equal(probeStateOf(kinds(dir), probeKeyOf('anthropic', OPUS, 'ABOVE_RANGE_B0')), 'UNRESOLVED'); b.ex.close();
  const again = build({ dir, ratio: 1.0 }); const r2 = await again.ex.run(P(again.store, 's2', 512)); assert.ok(r2.stop !== null); assert.equal(again.sent.length, 0, 'nada enviado depois da sonda incerta'); again.ex.close();
});
