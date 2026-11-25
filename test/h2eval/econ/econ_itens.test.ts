/**
 * EXEC-ECON C160: testes UNITÁRIOS dos 12 itens do delta v3.1 (offline, transporte falso, US$ 0).
 * Cada teste traz [ITEM n] no nome para o G15 conferir a cobertura item a item.
 *
 * English summary: unit tests of the twelve items of the economic-study executor change, each test tagged with its
 * item number so coverage can be checked item by item.
 *
 * Modules under test: `scripts/h2eval/econ/econ.ts` (schedule validation, plans, cost-cap policy, order verdict,
 * attempt lines, Google reserve), the adapters in `scripts/h2eval/modal/index.ts`, `scripts/h2eval/record/cost.ts`
 * (`computeCostCap`), `persistResponse` in `scripts/h2eval/core/runner.ts`, the caps profile in
 * `scripts/h2eval/core/ledger.ts` and the body-parity checker `./paridade_h_kit_v3_1.mjs`.
 *
 * Strategy / partitions: request bodies without reasoning, sampling, tool or cache keys for every model, and the
 * legacy bodies unchanged; body parity against the checker (whose file hash is verified first); explicit
 * single-candidate and no-streaming fields; the model that exists only in parity mode and its price gap; content-
 * addressed response persistence; schedule-to-plan mapping and schedule validation; the study ledger profile; corpus
 * hash recomputation; the Anthropic cost cap without the cache-write surcharge; a cost check over the real external
 * schedule (skipped when absent); the three allowed hosts; the fixed timeout; the Google reserve; the order verdict;
 * visible output text; and the per-attempt line with uncertain cost as a range, never 0.
 *
 * Needs: a writable temporary directory. One test reads a schedule and corpus from a fixed folder outside the
 * repository and is skipped, visibly, when it is absent. No network, no spending.
 *
 * Run just this file: `npx tsx --test test/h2eval/econ/econ_itens.test.ts`
 *
 * @module test/h2eval/econ/econ_itens.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, bodyOf } from '../../../scripts/h2eval/modal/index.js';
import { computeCostCap } from '../../../scripts/h2eval/record/cost.js';
import { persistResponse } from '../../../scripts/h2eval/core/runner.js';
import { operationIdOf } from '../../../scripts/h2eval/core/ids.js';
import { CAPS_PROFILE_ECON_DR277, openLedger } from '../../../scripts/h2eval/core/ledger.js';
import { priceTableFromModal } from '../../../scripts/h2eval/index.js';
import {
  ECON_MODELS, ECON_TIMEOUT_MS, ECON_ALLOWED_HOSTS, EconError, planOf, validateCronograma, readCronograma, corpusContentStore, loadEconPriceTable, econPriceGaps, validateSonnet5Table,
  googleThoughtsAllowance, econCapPolicy, newOrderIndex, indexJournal, orderVerdict, outputTextOf, tentativaOf, somaCostCap, type CronLine,
} from '../../../scripts/h2eval/econ/econ.js';
import { tmp, writeCorpus, writeCronograma, writeSonnet5Fixture, respostaDe } from './econ_fixture.js';
// módulo .mjs do kit (cópia byte a byte de ECON_PREP/V3_1/KIT/paridade_h.mjs; sha conferido no teste do item 10)
import { conferirCorpo } from './paridade_h_kit_v3_1.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/**
 * O arquivo do kit tem fim de linha CRLF (sha 5fef3430 = bytes do kit). Um checkout com LF (core.autocrlf) volta a CRLF byte a byte antes do sha.
 *
 * @param b - File bytes with LF or CRLF line endings.
 * @returns The same bytes with every line ending as CRLF.
 */
function comCRLF(b: Buffer): Uint8Array { const out: number[] = []; for (let i = 0; i < b.length; i++) { if (b[i] === 13 && b[i + 1] === 10) continue; if (b[i] === 10) out.push(13); out.push(b[i]!); } return Uint8Array.from(out); }
/** kit v3.1 (fora do repositório; só leitura). Ausente => o teste do K-CUSTO real é pulado e declarado. */
const KIT_V31 = 'C:/dev/otk-round2-orchestrator-20261106/docs/_ops/coordination/academic_20261110/runs/C160/ECON_PREP/V3_1';
const ctx = { studyId: 'econ-teste', protocolHash: 'a'.repeat(64), manifestSha256: 'b'.repeat(64) };
const line = (model: string, provider: CronLine['provider'], over: Partial<CronLine> = {}): CronLine => ({ seq: 0, block: 0, posNoBloco: 0, opId: 'd'.repeat(64), itemId: 'item0aaaaaaaaaaa', family: 'classificar', templateId: 'tpl-0', arm: 'B', rep: 1, model, provider, promptSha256: 'e'.repeat(64), systemSha256: 'x', maxOutputTokens: 8192, samplingParams: 'NOT_SENT', reasoningParams: 'NOT_SENT', cacheDirectives: 'NONE', tools: 'NONE', maxRetries: 0, ...over });
const content = { promptSha256: 'e'.repeat(64), prefixMessages: 'NOT_APPLICABLE' as const, messages: [{ role: 'system' as const, parts: [{ type: 'text' as const, text: 'Sistema.' }] }, { role: 'user' as const, parts: [{ type: 'text' as const, text: 'Olá.' }] }] };
const MODELS = Object.entries(ECON_MODELS).map(([m, v]) => [m, v.provider] as [string, CronLine['provider']]);
const REASONING_KEYS = /^(thinking|output_config|reasoning|reasoning_effort|thinkingConfig|temperature|top_p|top_k|topP|topK|seed|tools|tool_choice|toolConfig|cachedContent|prompt_cache_key)$/;

// ------------------------------------------------------------------ item 1 + item 10: corpo H nos 5 modelos (paridade_h do kit)
test('[ITEM 1] OMIT: nenhuma chave de raciocínio, amostragem, ferramenta ou cache nos 5 modelos (corpo H_PARITY)', () => {
  for (const [m, p] of MODELS) {
    const b = ADAPTERS[ECON_MODELS[m as keyof typeof ECON_MODELS].api].buildRequest(planOf(line(m, p), ctx) as never, content).body as Record<string, unknown>;
    const keys = [...Object.keys(b), ...Object.keys((b['generationConfig'] as object | undefined) ?? {})];
    assert.deepEqual(keys.filter((k) => REASONING_KEYS.test(k)), [], m);
    assert.equal(JSON.stringify(b).includes('cache_control'), false, m);
  }
});
test('[ITEM 1] H_PARITY e thinking omit andam juntos; temperature/cache/reasoning recusados', () => {
  const p = planOf(line('claude-haiku-5-5', 'anthropic'), ctx);
  const bad = [{ ...p, params: { ...p.params, bodyProfile: undefined } }, { ...p, params: { ...p.params, thinking: { mode: 'none' as const } } }, { ...p, params: { ...p.params, temperature: 0.2 } }, { ...p, params: { ...p.params, cacheDirectives: { cache_control: 'ephemeral' } } }, { ...p, params: { ...p.params, reasoning: { effort: 'low' } } }];
  for (const x of bad) assert.throws(() => ADAPTERS['anthropic.messages'].buildRequest(x as never, content), /H2EVAL_PARAM_CONFLICT/);
});
test('[ITEM 1] corpo legado (sem H_PARITY) inalterado: Haiku 5.5 OFF ainda manda thinking disabled; Opus 5.5 OFF ainda recusa', () => {
  const p = planOf(line('claude-haiku-5-5', 'anthropic'), ctx);
  const legacy = { ...p, params: { ...p.params, bodyProfile: undefined, thinking: { mode: 'none' as const } } };
  assert.deepEqual((ADAPTERS['anthropic.messages'].buildRequest(legacy as never, content).body as Record<string, unknown>)['thinking'], { type: 'disabled' });
  assert.throws(() => ADAPTERS['anthropic.messages'].buildRequest({ ...legacy, modelRequested: 'claude-opus-5-5' } as never, content), /H2EVAL_PARAM_NOT_DOCUMENTED/);
});
test('[ITEM 10] paridade_h do kit v3.1 (sha conferido) nos 5 modelos: ausentes [] e só as diferenças admitidas', () => {
  assert.equal(createHash('sha256').update(comCRLF(readFileSync(path.join(HERE, 'paridade_h_kit_v3_1.mjs')))).digest('hex'), '5fef34306fb031898ec6e1531aeff1afd823212fb888d3f09f6a2d1192bbafa9');
  const ADMITIDAS: Record<string, string[]> = { anthropic: ['service_tier', 'stream'], openai: ['service_tier'], google: [] };
  for (const [m, p] of MODELS) {
    const r = conferirCorpo(p, ADAPTERS[ECON_MODELS[m as keyof typeof ECON_MODELS].api].buildRequest(planOf(line(m, p), ctx) as never, content).body, 8192) as { classe: string; viola: string[]; difere: string[]; ausentes: string[] };
    assert.deepEqual(r.ausentes, [], m); assert.deepEqual(r.viola, [], m);
    assert.deepEqual([...r.difere].sort(), [...ADMITIDAS[p]!].sort(), m);
    assert.equal(r.classe, p === 'google' ? 'IGUAL_A_H' : 'DIFERE_DE_H', m);
  }
});
test('[ITEM 10] D2: n:1, stream:false, store:false (OpenAI) e candidateCount:1 (Google) EXPLÍCITOS; legado sem H_PARITY não os manda', () => {
  const o = ADAPTERS['openai.chat_completions'].buildRequest(planOf(line('gpt-6-luna', 'openai'), ctx) as never, content).body as Record<string, unknown>;
  assert.equal(o['n'], 1); assert.equal(o['stream'], false); assert.equal(o['store'], false);
  const g = ADAPTERS['gemini.generate_content'].buildRequest(planOf(line('gemini-3.1-flash-lite', 'google'), ctx) as never, content).body as { generationConfig: Record<string, unknown> };
  assert.deepEqual(g.generationConfig, { maxOutputTokens: 8192, candidateCount: 1 });
  const lp = planOf(line('gpt-6-luna', 'openai'), ctx); const legacy = { ...lp, params: { ...lp.params, bodyProfile: undefined, thinking: { mode: 'none' as const } } };
  const ol = ADAPTERS['openai.chat_completions'].buildRequest(legacy as never, content).body as Record<string, unknown>;
  assert.equal('n' in ol || 'store' in ol, false);
});

// ------------------------------------------------------------------ item 2: Sonnet 5
test('[ITEM 2] claude-sonnet-5 só existe sob H_PARITY; catálogo do estudo marca G-3 pendente', () => {
  const p = planOf(line('claude-sonnet-5', 'anthropic'), ctx);
  assert.equal((ADAPTERS['anthropic.messages'].buildRequest(p as never, content).body as { model: string }).model, 'claude-sonnet-5');
  assert.throws(() => ADAPTERS['anthropic.messages'].buildRequest({ ...p, params: { ...p.params, bodyProfile: undefined, thinking: { mode: 'adaptive', effort: 'low' }, reasoning: { effort: 'low' } } } as never, content), /H2EVAL_MODEL_NOT_IN_MATRIX/);
  assert.equal(ECON_MODELS['claude-sonnet-5'].availability, 'PENDENTE_G3');
});
test('[ITEM 2] preço do Sonnet 5: sem tabela atestada => lacuna (o consumidor não começa); tabela sem atestação humana é recusada', () => {
  const sem = loadEconPriceTable(); assert.deepEqual(econPriceGaps(sem, '2026-11-20T00:00:00Z'), ['claude-sonnet-5']);
  assert.equal(sem.parts['sonnet5'], 'AUSENTE_G2');
  const dir = tmp('s5'); const com = loadEconPriceTable({ sonnet5TablePath: writeSonnet5Fixture(dir) }); assert.deepEqual(econPriceGaps(com, '2026-11-20T00:00:00Z'), []);
  for (const [over, code] of [[{ attestedBy: 'agente' }, /ECON_SONNET5_NOT_ATTESTED/], [{ decisionRecords: [] }, /ECON_SONNET5_NOT_ATTESTED/], [{ tier: 'PRIORITY' }, /ECON_SONNET5_NOT_ATTESTED/]] as const) {
    const t = JSON.parse(readFileSync(writeSonnet5Fixture(dir), 'utf8')); Object.assign(t.models['claude-sonnet-5'].attestation, over);
    assert.throws(() => validateSonnet5Table(Buffer.from(JSON.stringify(t))), code);
  }
  const t = JSON.parse(readFileSync(writeSonnet5Fixture(dir), 'utf8')); t.models['claude-sonnet-5'].tiers[0].prices.output = null;
  assert.throws(() => validateSonnet5Table(Buffer.from(JSON.stringify(t))), /ECON_SONNET5_PRICE_MISSING/);
  // os outros 4 modelos: as MESMAS tabelas congeladas (nenhum preço copiado)
  assert.equal(com.parts['v3'], priceTableFromModal().sha256);
});

// ------------------------------------------------------------------ item 3: persistência
test('[ITEM 3] persistResponse: arquivo por conteúdo (sha do arquivo = responseSha256), wx; repetido idêntico aceito; conteúdo divergente no mesmo nome recusado', () => {
  const d = tmp('resp'); const body = { a: 1, t: 'texto' };
  const sha = persistResponse(d, body);
  assert.equal(sha, createHash('sha256').update(JSON.stringify(body)).digest('hex'));
  assert.equal(createHash('sha256').update(readFileSync(path.join(d, 'responses', `${sha}.json`))).digest('hex'), sha);
  assert.equal(persistResponse(d, body), sha);
  const d2 = tmp('resp2'); mkdirSync(path.join(d2, 'responses', `${sha}.json`), { recursive: true });
  assert.throws(() => persistResponse(d2, body));
});

// ------------------------------------------------------------------ item 4: cronograma e plano
test('[ITEM 4] opId do cronograma = operationId; plano por linha com 8192, H_PARITY, lote por bloco', () => {
  const p = planOf(line('gpt-6-luna', 'openai', { opId: '1'.repeat(64), block: 7, seq: 3 }), ctx);
  assert.equal(operationIdOf(p), '1'.repeat(64)); assert.equal(p.params.maxTokens, 8192); assert.equal(p.batchId, 'econ-b0007'); assert.equal(p.econSeq, 3);
  assert.throws(() => operationIdOf({ ...p, opId: 'xyz' }), /opId must be hex64/);
});
test('[ITEM 4] validateCronograma recusa seq fora de ordem, opId repetido, modelo fora do estudo, desenho diferente e bloco que volta', () => {
  const dir = tmp('cr'); const { prompts } = writeCorpus(dir); const ok = writeCronograma(dir, prompts).lines;
  assert.equal(validateCronograma(ok, ECON_TIMEOUT_MS).length, 10);
  const muta = (i: number, f: (l: CronLine) => CronLine) => ok.map((l, j) => (j === i ? f({ ...l }) : l));
  assert.throws(() => validateCronograma([ok[1]!, ok[0]!, ...ok.slice(2)], ECON_TIMEOUT_MS), /ECON_CRONOGRAMA_SEQ/);
  assert.throws(() => validateCronograma(muta(1, (l) => ({ ...l, opId: ok[0]!.opId })), ECON_TIMEOUT_MS), /ECON_CRONOGRAMA_OPID/);
  assert.throws(() => validateCronograma(muta(1, (l) => ({ ...l, model: 'claude-sonnet-5-5' })), ECON_TIMEOUT_MS), /ECON_CRONOGRAMA_MODEL/);
  assert.throws(() => validateCronograma(muta(1, (l) => ({ ...l, maxOutputTokens: 4096 })), ECON_TIMEOUT_MS), /ECON_CRONOGRAMA_DESENHO/);
  assert.throws(() => validateCronograma(muta(1, (l) => ({ ...l, maxRetries: 1 })), ECON_TIMEOUT_MS), /ECON_CRONOGRAMA_DESENHO/);
  assert.throws(() => validateCronograma(muta(6, (l) => ({ ...l, block: 0 })).map((l, j) => (j === 5 ? { ...l, block: 1 } : l)), ECON_TIMEOUT_MS), /ECON_CRONOGRAMA_BLOCO/);
  const c = writeCronograma(dir, prompts); assert.throws(() => readCronograma(c.file, { expectedSha256: '0'.repeat(64), timeoutMs: ECON_TIMEOUT_MS }), /ECON_CRONOGRAMA_SHA/);
});
test('[ITEM 4] ledger único do estudo: perfil nomeado 132 / 95 / 11 / 28 aceito; outro número recusado', () => {
  const d = tmp('led');
  const l = openLedger(path.join(d, 'ledger.jsonl'), { campaignUsd: CAPS_PROFILE_ECON_DR277.campaign, providersUsd: { ...CAPS_PROFILE_ECON_DR277.providers } });
  assert.equal(l.state().providers.anthropic.capUsd, (95n * 10n ** 12n).toString());
  assert.throws(() => openLedger(path.join(d, 'l2.jsonl'), { campaignUsd: '132', providersUsd: { anthropic: '96', openai: '11', google: '28' } }), /ledger caps above defaults/);
});
test('[ITEM 4] conteúdo do corpus: promptSha256 recomputado; corpus adulterado recusado', () => {
  const dir = tmp('corp'); const { corpusDir, prompts } = writeCorpus(dir);
  const s = corpusContentStore(corpusDir); assert.ok(s.charsOf(prompts[0]!) > 100);
  const f = path.join(corpusDir, 'itens.jsonl'); const t = readFileSync(f, 'utf8').replace('Anotar', 'Anotár');
  writeFileSync(f, t); assert.throws(() => corpusContentStore(corpusDir), /ECON_CORPUS_PROMPT_SHA/);
});

// ------------------------------------------------------------------ item 5: teto Anthropic sem sobretaxa de cache
test('[ITEM 5] teto Anthropic H_PARITY: entrada ao preço de entrada (sem escrita 1h); sem a marca, a regra congelada continua', () => {
  const prices = priceTableFromModal(); const base = { provider: 'anthropic', model: 'claude-opus-5-5', api: 'anthropic.messages' as const, inputUpperBoundTokens: 10_000, maxOutputTokens: 8192, reasoningAllowanceTokens: 0, atUtc: '2026-11-20T00:00:00Z' };
  const sem = computeCostCap(prices, { ...base, noCacheWrite: true }); const com = computeCostCap(prices, base);
  assert.ok(!('error' in sem) && !('error' in com));
  assert.equal(sem.capBasis.cacheWriteTtlUsed, 'NONE'); assert.equal(sem.capBasis.cacheWritePriceUsedMicro, '0');
  assert.equal(BigInt(sem.usd), 10_000n * 4_000_000n + 8192n * 20_000_000n); // 4 e 20 USD/M (AL14)
  assert.equal(com.capBasis.cacheWriteTtlUsed, '1h'); assert.ok(BigInt(com.usd) > BigInt(sem.usd));
  // a marca não vale fora do Anthropic (luna cobra escrita de cache automática: pior caso mantido)
  const arm = loadEconPriceTable(); const l = computeCostCap(arm, { ...base, provider: 'openai', model: 'gpt-6-luna', api: 'openai.chat_completions', noCacheWrite: true });
  assert.ok(!('error' in l)); assert.notEqual(l.capBasis.cacheWriteTtlUsed, 'NONE');
});
test('[ITEM 5] K-CUSTO sobre o cronograma e o corpus REAIS do kit v3.1 (se presentes): Σ costCap Anthropic <= 95 com o preço de entrada', { skip: !existsSync(KIT_V31) ? 'kit v3.1 ausente nesta máquina' : false }, () => {
  const cron = readCronograma(path.join(KIT_V31, 'PLANOS', 'CRONOGRAMA.jsonl'), { expectedSha256: 'cfae90aaa37c90b39d117840c652752668924791771cf95db00ac3a23972b1d8', timeoutMs: ECON_TIMEOUT_MS });
  const s = corpusContentStore(path.join(KIT_V31, 'CORPUS'));
  const dir = tmp('kc'); const prices = loadEconPriceTable({ sonnet5TablePath: writeSonnet5Fixture(dir, {}) });
  // Sonnet 5 a 2/10 (página de 28/10, NÃO atestado) só para reproduzir o número do kit; o executor real exige a tabela atestada (G-2)
  const t = JSON.parse(readFileSync(writeSonnet5Fixture(dir), 'utf8')); t.models['claude-sonnet-5'].tiers[0].prices = { ...t.models['claude-sonnet-5'].tiers[0].prices, input: '2000000', output: '10000000', reasoning: '10000000' };
  const p2 = path.join(dir, 's5_2_10.json'); writeFileSync(p2, JSON.stringify(t));
  const k = somaCostCap(cron, s.charsOf, loadEconPriceTable({ sonnet5TablePath: p2 }), { estado: 'ABERTO' }, '2026-11-20T00:00:00Z', computeCostCap);
  assert.equal(k['semPreco'], 'NENHUM'); void prices;
  assert.ok((k['anthropic'] as number) <= 95, `anthropic ${k['anthropic']}`);
  assert.ok(Math.abs((k['anthropic'] as number) - 92.63) <= 0.05, `anthropic ${k['anthropic']} vs 92,63 do kit`);
  assert.ok(Math.abs((k['openai'] as number) - 8.47) <= 0.05, `openai ${k['openai']}`);
  // Google com o G-7b ABERTO (2 x 8192): acima de 28 — vai ao autor (D1/P1 do X1); com G-7b LIMITA volta ao pior caso do kit
  assert.ok((k['google'] as number) > 28, `google ${k['google']}`);
  const kl = somaCostCap(cron, s.charsOf, loadEconPriceTable({ sonnet5TablePath: p2 }), { estado: 'LIMITA', fonte: 'teste' }, '2026-11-20T00:00:00Z', computeCostCap);
  assert.ok(Math.abs((kl['google'] as number) - 25.39) <= 0.05, `google LIMITA ${kl['google']}`);
});

// ------------------------------------------------------------------ item 7: hosts
test('[ITEM 7] egress do estudo: só os 3 hosts oficiais', () => {
  assert.deepEqual([...ECON_ALLOWED_HOSTS].sort(), ['api.anthropic.com', 'api.openai.com', 'generativelanguage.googleapis.com']);
  for (const [m, p] of MODELS) assert.ok(ECON_ALLOWED_HOSTS.includes(new URL(bodyOf(planOf(line(m, p), ctx) as never, content).url).host), m);
});

// ------------------------------------------------------------------ item 8: timeout único
test('[ITEM 8] timeout pré-registrado 600 000 ms: outro valor recusado; linha com timeoutMs diferente recusada; igual aceito', () => {
  assert.equal(ECON_TIMEOUT_MS, 600_000);
  const dir = tmp('to'); const { prompts } = writeCorpus(dir); const ok = writeCronograma(dir, prompts).lines;
  assert.throws(() => validateCronograma(ok, 120_000), /ECON_TIMEOUT_NOT_PREREGISTERED/);
  assert.throws(() => validateCronograma(ok.map((l, i) => (i === 3 ? { ...l, timeoutMs: 300_000 } : l)), ECON_TIMEOUT_MS), /ECON_TIMEOUT_DESIGUAL/);
  assert.equal(validateCronograma(ok.map((l) => ({ ...l, timeoutMs: 600_000 })), ECON_TIMEOUT_MS).length, ok.length);
});

// ------------------------------------------------------------------ item 9: reserva Google pelo G-7b
test('[ITEM 9] reserva Google sai do parâmetro G-7b (ABERTO = 2 x 8192 marcado como hipótese; LIMITA = 0; NAO_LIMITA = T_max)', () => {
  assert.deepEqual(googleThoughtsAllowance({ estado: 'ABERTO' }).tokens, 8192); assert.match(googleThoughtsAllowance({ estado: 'ABERTO' }).basis, /HIPOTESE/);
  assert.equal(googleThoughtsAllowance({ estado: 'LIMITA', fonte: 'smoke' }).tokens, 0);
  assert.equal(googleThoughtsAllowance({ estado: 'NAO_LIMITA', tMaxThoughts: 3000, fonte: 'smoke' }).tokens, 3000);
  assert.throws(() => googleThoughtsAllowance({ estado: 'NAO_LIMITA', tMaxThoughts: 0, fonte: 'x' }), /ECON_G7B_TMAX_INVALIDO/);
  const charsOf = () => 1593; const pg = planOf(line('gemini-3.1-flash-lite', 'google'), ctx); const pa = planOf(line('claude-opus-5-5', 'anthropic'), ctx);
  for (const [g, t] of [[{ estado: 'ABERTO' }, 8192], [{ estado: 'NAO_LIMITA', tMaxThoughts: 1234, fonte: 'x' }, 1234], [{ estado: 'LIMITA', fonte: 'x' }, 0]] as const) {
    const cp = econCapPolicy({ charsOf, g7b: g }); assert.equal(cp.reasoningAllowanceTokens(pg), t); assert.equal(cp.reasoningAllowanceTokens(pa), 0); assert.equal(cp.inputUpperBoundTokens(pg), 1000);
  }
  // o motor de custo: 0 de folga no Google só com a marca do G-7b LIMITA (sem ela, fail-closed como antes)
  const arm = loadEconPriceTable(); const base = { provider: 'google', model: 'gemini-3.1-flash-lite', api: 'gemini.generate_content' as const, inputUpperBoundTokens: 1000, maxOutputTokens: 8192, reasoningAllowanceTokens: 0, atUtc: '2026-11-20T00:00:00Z' };
  assert.ok('error' in computeCostCap(arm, base)); assert.ok(!('error' in computeCostCap(arm, { ...base, thoughtsBoundedByMaxOutput: true })));
  const c = computeCostCap(arm, { ...base, reasoningAllowanceTokens: 8192 }); assert.ok(!('error' in c) && BigInt(c.usd) === 1000n * 250_000n + 16384n * 1_500_000n);
});

// ------------------------------------------------------------------ item 11: guarda de ordem (pura)
test('[ITEM 11] orderVerdict: só envia quando todo seq menor está executado e terminal; seq do journal estritamente crescente', () => {
  const ids = ['o0', 'o1', 'o2'];
  const L = (kind: string, op: string, body: object = {}) => ({ kind, operationId: op, body }) as never;
  const idx = indexJournal(newOrderIndex(), [L('PLANNED', 'o0', { econSeq: 0 }), L('SENT', 'o0'), L('SETTLED', 'o0')]);
  assert.equal(orderVerdict(idx, 1, ids), null);
  assert.match(orderVerdict(idx, 2, ids)!, /SEQ_1_NAO_EXECUTADO/);
  assert.match(orderVerdict(idx, 0, ids)!, /PLANNED_COM_SEQ_0_GE_0/);
  const naoEnviado = indexJournal(newOrderIndex(), [L('PLANNED', 'o0', { econSeq: 0 }), L('STOP_GLOBAL', 'o0', { reason: 'STOP_FILE' })]);
  assert.match(orderVerdict(naoEnviado, 1, ids)!, /SEQ_0_NAO_EXECUTADO/);
  const emVoo = indexJournal(newOrderIndex(), [L('PLANNED', 'o0', { econSeq: 0 }), L('SENT', 'o0')]);
  assert.match(orderVerdict(emVoo, 1, ids)!, /SEQ_0_NAO_EXECUTADO/);
  const fora = indexJournal(newOrderIndex(), [L('PLANNED', 'o1', { econSeq: 1 }), L('PLANNED', 'o0', { econSeq: 0 })]);
  assert.equal(orderVerdict(fora, 2, ids), 'JOURNAL_SEQ_NAO_CRESCENTE');
  const incerto = indexJournal(newOrderIndex(), [L('PLANNED', 'o0', { econSeq: 0 }), L('SENT', 'o0'), L('TIMEOUT_UNCERTAIN', 'o0'), L('UNCERTAIN_ISOLATED', 'o0')]);
  assert.equal(orderVerdict(incerto, 1, ids), null); // terminal (incerto); o runner ainda bloqueia por STOP_UNCERTAIN sem reconhecimento humano
});

// ------------------------------------------------------------------ item 6 + 12: linha por tentativa e recusa
test('[ITEM 6] outputTextOf: texto visível por provedor (sem thinking/thought); ausente => null', () => {
  assert.equal(outputTextOf('anthropic', respostaDe('anthropic', 'claude-opus-5-5', 'texto', 'T').body), 'T');
  assert.equal(outputTextOf('openai', respostaDe('openai', 'gpt-6-luna', 'texto', 'T').body), 'T');
  assert.equal(outputTextOf('google', respostaDe('google', 'gemini-3.1-flash-lite', 'texto', 'T').body), 'T');
  for (const p of ['anthropic', 'openai', 'google'] as const) assert.equal(outputTextOf(p, respostaDe(p, 'm', 'zero').body), p === 'openai' ? '' : null);
  assert.equal(outputTextOf('openai', respostaDe('openai', 'gpt-6-luna', 'filtro').body), null);
});
test('[ITEM 6] tentativaOf: incerto => custo UNKNOWN [0, teto] (nunca 0 como custo), acima do teto => highUsd >= teto; NOT_APPLICABLE declarado', () => {
  const l = line('gpt-6-luna', 'openai');
  const rec = { operationId: l.opId, outcome: 'TIMEOUT_UNCERTAIN', modelDeprecation: 'UNKNOWN', exclusion: 'NONE', httpStatus: 'UNKNOWN', refusal: null, usage: null, responseSha256: 'UNKNOWN', cost: { state: 'UNKNOWN', usd: 'UNKNOWN', capCovered: 'UNKNOWN' }, tsSentUtc: 't', tsReceivedUtc: 'UNKNOWN', latencyMs: 'UNKNOWN', finalState: 'UNCERTAIN', stopReason: 'UNKNOWN', completion: 'UNKNOWN' } as never;
  const t = tentativaOf(l, rec, null, 5_000_000_000n, ECON_TIMEOUT_MS);
  assert.deepEqual(t.cost, { state: 'UNKNOWN', lowUsd: 0, highUsd: 0.005, capUsd: 0.005 }); assert.equal(t.httpStatus, null); assert.equal(t.truncated, 'UNKNOWN'); assert.equal(t.outputText, null); assert.equal(t.timeoutMs, 600_000);
  const acima = tentativaOf(l, { ...(rec as object), outcome: 'OK', httpStatus: 200, stopReason: 'stop', cost: { state: 'CALCULATED', usd: '7000000000', capCovered: false }, usage: { inputUncached: 1, cacheRead: 0, cacheWrite: 'NOT_APPLICABLE', outputTotal: 2, U: 1, usageCompleteness: 'COMPLETE', modelServed: 'gpt-6-luna' } } as never, {}, 5_000_000_000n, ECON_TIMEOUT_MS);
  assert.equal(acima.cost.state, 'CALCULATED_ABOVE_CAP'); assert.equal(acima.cost.highUsd, 0.007); assert.deepEqual(acima.usage!.naComoZero, ['cacheWrite']);
});

void EconError;
