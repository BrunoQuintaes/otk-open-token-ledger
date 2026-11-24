/**
 * EXEC-ECON C160 delta 6 (DECISOES_MASTER_ECON; achado do smoke pago ECON, seq 2): gpt-6-luna sem prompt_tokens_details.cache_write_tokens
 * => liquidação pelo LIMITE SUPERIOR (prompt × 0,125 + completion × 0,50), custo declarado UPPER_BOUND, tentativa NÃO incerta.
 * Forma exata da seq 2 do smoke, só metadados (o texto da resposta é substituído). Offline, transporte falso, US$ 0.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runEcon, type Tentativa } from '../../../scripts/h2eval/econ/econ.js';
import { openaiCacheWriteUpperBound } from '../../../scripts/h2eval/core/e3gArm.js';
import { ambiente, respostaDe } from './econ_fixture.js';

/** seq 2 do smoke (CHECKPOINT ECON_SMOKE_RUN l. 39/53): HTTP 200, content_filter, prompt 61, completion 1249 (raciocínio 1136), tier default, servido gpt-6-luna, SEM cache_write_tokens */
function smokeSeq2(over: { usage?: Record<string, unknown>; finish?: string } = {}) {
  return { httpStatus: 200, body: { id: 'chatcmpl-SINTETICO', object: 'chat.completion', model: 'gpt-6-luna', service_tier: 'default',
    choices: [{ index: 0, finish_reason: over.finish ?? 'content_filter', message: { role: 'assistant', content: '<texto omitido: so metadados>', refusal: null } }],
    usage: over.usage ?? { prompt_tokens: 61, completion_tokens: 1249, total_tokens: 1310, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 1136, audio_tokens: 0 } } } };
}
const J = (dir: string) => readFileSync(path.join(dir, 'journal.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; body: Record<string, unknown> });
const T = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'TENTATIVAS.jsonl'), 'utf8').trim().split('\n')[0]!) as Tentativa;
const run1 = async (answer: () => { httpStatus: number; body: unknown }) => { const a = ambiente({ only: 'gpt-6-luna', blocks: 2, answer }); const s = await runEcon(a.cfg); return { a, s, j: J(a.cfg.batchDir), t: T(a.cfg.batchDir) }; };

test('[DELTA6] forma exata da seq 2 do smoke: REFUSED_WITH_USAGE, custo UPPER_BOUND = 61 x 0,125 + 1249 x 0,50, liquidado (não incerto), coleta segue', async () => {
  const { a, s, j, t } = await run1(() => smokeSeq2());
  assert.equal(t.outcome, 'REFUSED_WITH_USAGE'); assert.equal(t.stopReason, 'content_filter');
  assert.equal(t.cost.state, 'UPPER_BOUND');
  assert.ok(Math.abs(t.cost.highUsd - (61 * 0.125 + 1249 * 0.5) / 1e6) < 1e-12, `high ${t.cost.highUsd}`);
  assert.ok(Math.abs(t.cost.lowUsd - (61 * 0.01 + 1249 * 0.5) / 1e6) < 1e-12, `low ${t.cost.lowUsd}`);
  assert.ok(t.cost.lowUsd <= t.cost.highUsd && t.cost.highUsd < t.cost.capUsd);
  assert.equal(s.parada, null, 'a tentativa não é incerta: as 2 tentativas rodam'); assert.equal(a.sent.length, 2);
  const cc = j.find((l) => l.kind === 'COST_COMPUTED')!; assert.equal(cc.body['state'], 'UPPER_BOUND'); assert.equal(cc.body['costClass'], 'UPPER_BOUND'); assert.equal(cc.body['cacheWriteEvidence'], 'ABSENT_FIELD_UPPER_BOUND');
  const st = j.find((l) => l.kind === 'SETTLED')!; assert.equal(st.body['usd'], String(61n * 125000n + 1249n * 500000n)); assert.equal(st.body['costClass'], 'UPPER_BOUND');
  assert.equal(j.some((l) => l.kind === 'UNCERTAIN_ISOLATED'), false);
  const led = readFileSync(path.join(a.cfg.batchDir, 'ledger.jsonl'), 'utf8'); assert.ok(led.includes('"settle"')); assert.equal(led.includes('"uncertain"'), false);
  assert.equal(t.usage!.U, 61); assert.equal(t.usage!.cacheWrite, null, 'a divisão não é inventada no registro (segue UNKNOWN)');
});
test('[DELTA6] também com finish_reason stop (resposta normal sem cache_write_tokens): OK + UPPER_BOUND', async () => {
  const { t, s } = await run1(() => smokeSeq2({ finish: 'stop' }));
  assert.equal(t.outcome, 'OK'); assert.equal(t.cost.state, 'UPPER_BOUND'); assert.equal(s.parada, null);
});
test('[DELTA6] qualquer outro campo ausente segue UNKNOWN (incerta): prompt_tokens ausente, completion_tokens ausente, cache_write_tokens presente mas null', async () => {
  const base = { prompt_tokens: 61, completion_tokens: 1249, total_tokens: 1310, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 1136, audio_tokens: 0 } };
  const semP: Record<string, unknown> = { ...base }; delete semP['prompt_tokens'];
  const semC: Record<string, unknown> = { ...base }; delete semC['completion_tokens'];
  const cwNull = { ...base, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0, cache_write_tokens: null } };
  for (const [nome, u] of [['prompt ausente', semP], ['completion ausente', semC], ['cache_write null', cwNull]] as const) {
    const { t, s, j } = await run1(() => smokeSeq2({ usage: u as Record<string, unknown> }));
    assert.equal(t.cost.state, 'UNKNOWN', nome); assert.equal(s.parada!.stop, 'STOP_UNCERTAIN', nome);
    assert.equal(j.some((l) => l.kind === 'SETTLED'), false, nome); assert.equal(j.some((l) => l.body['costClass'] === 'UPPER_BOUND'), false, nome);
  }
});
test('[DELTA6] com cache_write_tokens presente o custo é CALCULATED (nada muda)', async () => {
  const { t } = await run1(() => respostaDe('openai', 'gpt-6-luna', 'texto'));
  assert.equal(t.cost.state, 'CALCULATED');
});
test('[DELTA6] função pura: só gpt-6-luna; só cacheWrite UNKNOWN; só com prompt e completion inteiros >= 0 e a chave ausente', () => {
  const usage = { cacheWrite: 'UNKNOWN', inputUncached: 'UNKNOWN', cacheRead: 0, outputVisible: 113, reasoning: 1136, U: 'UNKNOWN' };
  const body = smokeSeq2().body;
  assert.deepEqual(openaiCacheWriteUpperBound('gpt-6-luna', usage, body), { ...usage, inputUncached: 0, cacheRead: 0, cacheWrite: 61, outputVisible: 1249, reasoning: 0, U: 61 });
  assert.equal(openaiCacheWriteUpperBound('gpt-4o-mini-2024-07-18', usage, body), null);
  assert.equal(openaiCacheWriteUpperBound('gemini-3.1-flash-lite', usage, body), null);
  assert.equal(openaiCacheWriteUpperBound('gpt-6-luna', { ...usage, cacheWrite: 5 }, body), null);
  assert.equal(openaiCacheWriteUpperBound('gpt-6-luna', usage, smokeSeq2({ usage: { prompt_tokens: -1, completion_tokens: 3 } }).body), null);
  assert.equal(openaiCacheWriteUpperBound('gpt-6-luna', usage, smokeSeq2({ usage: { prompt_tokens: 1.5, completion_tokens: 3 } }).body), null);
  assert.equal(openaiCacheWriteUpperBound('gpt-6-luna', usage, smokeSeq2({ usage: { prompt_tokens: 1, completion_tokens: 3, prompt_tokens_details: { cache_write_tokens: 'x' } } }).body), null);
  assert.deepEqual(openaiCacheWriteUpperBound('gpt-6-luna', usage, smokeSeq2({ usage: { prompt_tokens: 7, completion_tokens: 3 } }).body)!.U, 7, 'sem prompt_tokens_details: limite vale');
});
test('[DELTA6] fora do estudo (sem cfg.econ) a resposta sem cache_write_tokens segue UNKNOWN (semântica antiga)', async () => {
  const { createH2EvalExecutor } = await import('../../../scripts/h2eval/index.js');
  const { loadEconPriceTable, corpusContentStore, planOf, readCronograma, ECON_TIMEOUT_MS } = await import('../../../scripts/h2eval/econ/econ.js');
  const a = ambiente({ only: 'gpt-6-luna', blocks: 1, answer: () => smokeSeq2() });
  const cron = readCronograma(a.cfg.cronogramaPath, { expectedSha256: a.cfg.cronogramaSha256, timeoutMs: ECON_TIMEOUT_MS });
  const ex = createH2EvalExecutor({ batchDir: a.cfg.batchDir, contentStore: corpusContentStore(a.cfg.corpusDir), prices: loadEconPriceTable(), ledger: { campaignUsd: '1', providersUsd: { anthropic: '0', openai: '1', google: '0' } }, ledgerPath: path.join(a.cfg.batchDir, 'ledger.openai.jsonl'),
    egress: { ...a.cfg.egress, allowedHosts: ['api.openai.com'] }, capPolicy: { inputUpperBoundTokens: () => 1000, reasoningAllowanceTokens: () => 0 }, executorCodeSha: 'c'.repeat(40) });
  try { const r = await ex.run(planOf(cron[0]!, a.cfg)); assert.equal(r.state, 'UNCERTAIN'); } finally { ex.close(); }
  const j = J(a.cfg.batchDir); assert.equal(j.find((l) => l.kind === 'COST_COMPUTED')!.body['state'], 'UNKNOWN'); assert.equal(j.some((l) => l.kind === 'SETTLED'), false);
});
