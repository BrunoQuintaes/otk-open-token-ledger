/**
 * Tests for the cache-outcome classifier that labels each provider call HIT, CREATION, NO_HIT or UNKNOWN from the
 * returned usage alone.
 *
 * Module under test: `scripts/h2eval/cache/classify.ts` (`classifyCache`, `diagnose`, `resolveArm`,
 * `summarizeDialog`).
 *
 * Strategy / partitions: one block per provider usage shape (OpenAI `prompt_tokens_details.cached_tokens`,
 * Anthropic cache read and write including the 5-minute and 1-hour write split, Gemini `cachedContentTokenCount`
 * present, absent and absent in strict mode); missing, unreadable or inconsistent usage (always UNKNOWN, never 0);
 * an OpenAI cached count that is not a multiple of 128; independence from the planned arm and the cache directive;
 * final arm resolution (planned arm against observed outcome, contaminated controls kept and flagged); diagnosis
 * reasons; and the per-dialog summary (only calls 2 and 3 are eligible for a hit). The usage fixtures copy the
 * token numbers of real calls from an earlier evaluation campaign; the content is synthetic.
 *
 * Needs: nothing external (pure functions, no I/O).
 *
 * Run just this file: `npx tsx --test test/h2eval/cache/classify.test.ts`
 *
 * @module test/h2eval/cache/classify.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCache, diagnose, resolveArm, summarizeDialog } from '../../../scripts/h2eval/cache/classify.js';

// Formas reais de uso, copiadas dos calls.jsonl da campanha da H1 (OVERNIGHT2_20261006): números reais, conteúdo sintético
const OA_MISS = { prompt_tokens: 3396, completion_tokens: 24, total_tokens: 3420, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } };
const OA_HIT = { prompt_tokens: 3396, completion_tokens: 24, total_tokens: 3420, prompt_tokens_details: { cached_tokens: 3328, audio_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } };
const GM_MISS = { promptTokenCount: 4228, candidatesTokenCount: 20, totalTokenCount: 4248, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 4228 }], serviceTier: 'standard' };
const GM_HIT = { promptTokenCount: 4228, candidatesTokenCount: 20, totalTokenCount: 4248, cachedContentTokenCount: 2032, promptTokensDetails: [{ modality: 'TEXT', tokenCount: 4228 }], cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 2032 }], serviceTier: 'standard' };
const AN_NONE = { input_tokens: 634, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 24, service_tier: 'standard' };
const AN_CREATE = { input_tokens: 100, cache_creation_input_tokens: 4600, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 4600, ephemeral_1h_input_tokens: 0 }, output_tokens: 24 };
const AN_HIT = { input_tokens: 150, cache_creation_input_tokens: 0, cache_read_input_tokens: 4600, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 }, output_tokens: 24 };

test('OpenAI: HIT só com cached_tokens > 0; escrita é NOT_APPLICABLE; CREATION nunca é observável (sem escrita reportada)', () => {
  const m = classifyCache('openai', OA_MISS); assert.equal(m.observed, 'NO_HIT'); assert.equal(m.cacheRead, 0); assert.equal(m.cacheWrite, 'NOT_APPLICABLE');
  const h = classifyCache('openai', OA_HIT); assert.equal(h.observed, 'HIT'); assert.equal(h.cacheRead, 3328); assert.equal(h.inputUncached, 68); assert.equal(h.totalInput, 3396); assert.deepEqual(h.flags, []);
  assert.ok(Math.abs((h.hitFraction as number) - 3328 / 3396) < 1e-12);
});

test('Anthropic: CREATION = escrita > 0 e leitura 0; HIT = leitura > 0; NO_HIT = ambas 0; total normalizado soma entrada+leitura+escrita', () => {
  assert.equal(classifyCache('anthropic', AN_NONE).observed, 'NO_HIT');
  const c = classifyCache('anthropic', AN_CREATE); assert.equal(c.observed, 'CREATION'); assert.equal(c.cacheWrite, 4600); assert.equal(c.cacheWrite5m, 4600); assert.equal(c.totalInput, 4700);
  const h = classifyCache('anthropic', AN_HIT); assert.equal(h.observed, 'HIT'); assert.equal(h.cacheRead, 4600); assert.equal(h.totalInput, 4750); assert.equal(h.inputUncached, 150);
  const mixed = classifyCache('anthropic', { ...AN_HIT, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 0 } });
  assert.equal(mixed.observed, 'HIT'); assert.ok(mixed.flags.includes('HIT_WITH_WRITE'));
});

test('Anthropic: separa escrita 5m e 1h; soma do detalhamento sem o total; inconsistência é sinalizada', () => {
  const x = classifyCache('anthropic', { input_tokens: 10, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 200, ephemeral_1h_input_tokens: 4400 } });
  assert.equal(x.observed, 'CREATION'); assert.equal(x.cacheWrite, 4600); assert.equal(x.cacheWrite1h, 4400);
  const bad = classifyCache('anthropic', { ...AN_CREATE, cache_creation_input_tokens: 4601 }); assert.ok(bad.flags.includes('CREATION_BREAKDOWN_MISMATCH'));
});

test('Gemini: HIT por cachedContentTokenCount > 0 (parcial real da H1: 2032 de 4228); sem o campo => NO_HIT com sinal da inferência; strictAbsent => UNKNOWN', () => {
  const h = classifyCache('google', GM_HIT); assert.equal(h.observed, 'HIT'); assert.equal(h.cacheRead, 2032); assert.equal(h.inputUncached, 2196); assert.ok((h.hitFraction as number) < 0.5);
  const m = classifyCache('google', GM_MISS); assert.equal(m.observed, 'NO_HIT'); assert.ok(m.flags.includes('READ_INFERRED_FROM_ABSENT_FIELD'));
  const s = classifyCache('google', GM_MISS, { strictAbsent: true }); assert.equal(s.observed, 'UNKNOWN'); assert.equal(s.cacheRead, 'UNKNOWN');
  assert.ok(classifyCache('google', { ...GM_HIT, cacheTokensDetails: [{ modality: 'TEXT', tokenCount: 1 }] }).flags.includes('CACHE_DETAILS_MISMATCH'));
});

test('UNKNOWN (nunca 0 nem NO_HIT) quando o uso falta ou é ilegível ou inconsistente', () => {
  for (const p of ['openai', 'anthropic', 'google'] as const) for (const bad of [undefined, null, 'x', 42, [], {}]) { const r = classifyCache(p, bad); assert.equal(r.observed, 'UNKNOWN', `${p} ${JSON.stringify(bad)}`); assert.notEqual(r.cacheRead, 0); }
  assert.equal(classifyCache('openai', { prompt_tokens: 100 }).observed, 'UNKNOWN'); // sem prompt_tokens_details
  assert.equal(classifyCache('openai', { prompt_tokens: 100, prompt_tokens_details: {} }).observed, 'UNKNOWN');
  assert.equal(classifyCache('openai', { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 128 } }).observed, 'UNKNOWN'); // cacheado maior que o prompt
  assert.ok(classifyCache('openai', { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 128 } }).flags.includes('CACHED_EXCEEDS_PROMPT'));
  assert.equal(classifyCache('anthropic', { input_tokens: 5 }).observed, 'UNKNOWN');
  assert.equal(classifyCache('anthropic', { input_tokens: 5, cache_read_input_tokens: 0 }).observed, 'UNKNOWN'); // escrita desconhecida com leitura 0
  assert.equal(classifyCache('anthropic', { input_tokens: 5, cache_read_input_tokens: 77 }).observed, 'HIT'); // leitura > 0 decide mesmo sem a escrita
  assert.equal(classifyCache('google', { totalTokenCount: 5 }).observed, 'UNKNOWN');
  assert.equal(classifyCache('openai', { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: -1 } }).observed, 'UNKNOWN');
  assert.equal(classifyCache('openai', { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 1.5 } }).observed, 'UNKNOWN');
  assert.equal(classifyCache('openai', { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: '128' } }).observed, 'UNKNOWN');
});

test('OpenAI: cached_tokens fora de múltiplo de 128 é sinalizado (R08: arredondamento documentado)', () => {
  assert.ok(classifyCache('openai', { prompt_tokens: 3396, prompt_tokens_details: { cached_tokens: 3300 } }).flags.includes('OPENAI_CACHED_NOT_MULTIPLE_OF_128'));
});

test('a classificação vem SÓ do usage: o braço planejado e a diretiva não entram (mesma entrada => mesma saída)', () => {
  assert.equal(classifyCache.length >= 2, true);
  const a = classifyCache('anthropic', AN_NONE); const b = classifyCache('anthropic', AN_NONE);
  assert.deepEqual(a, b);
  // chamada "planejada com hit" cujo usage não tem hit é NO_HIT, e o braço final muda sem descartar
  const r = resolveArm('S3_HITATTEMPT', a.observed); assert.equal(r.finalArm, 'S3_NO_HIT'); assert.equal(r.changedFromPlan, true); assert.equal(r.kept, true);
});

test('braço final: S3 planejado vira HIT/CREATION/NO_HIT/UNKNOWN pelo observado; S2 com hit é controle CONTAMINADO (registrado, não reclassificado); nada é descartado', () => {
  assert.deepEqual(['HIT', 'CREATION', 'NO_HIT', 'UNKNOWN'].map((o) => resolveArm('S3_HITATTEMPT', o as 'HIT').finalArm), ['S3_HIT', 'S3_CREATION', 'S3_NO_HIT', 'S3_UNKNOWN']);
  assert.equal(resolveArm('S3_HITATTEMPT', 'HIT').changedFromPlan, false);
  const c = resolveArm('S2_NOHIT', 'HIT'); assert.equal(c.finalArm, 'S2_HIT_CONTAMINATED'); assert.equal(c.controlContaminated, true); assert.equal(c.kept, true);
  assert.equal(resolveArm('S2_NOHIT', 'NO_HIT').controlContaminated, false); assert.equal(resolveArm('S2_NOHIT', 'NO_HIT').changedFromPlan, false);
  assert.equal(resolveArm('S1', 'NO_HIT').finalArm, 'S1'); assert.equal(resolveArm('S1', 'HIT').finalArm, 'S1_HIT');
});

test('diagnóstico: marcação ignorada, prefixo abaixo do mínimo, hit parcial, criação sem diretiva', () => {
  const none = classifyCache('anthropic', AN_NONE);
  assert.deepEqual(diagnose({ cacheDirective: 'cache_control', estimatedPrefixTokens: 4750, minPrefixTokens: 4096 }, none), ['MARKED_BUT_NOT_APPLIED']);
  assert.deepEqual(diagnose({ cacheDirective: 'cache_control', estimatedPrefixTokens: 3000, minPrefixTokens: 4096 }, none), ['MARKED_BUT_NOT_APPLIED', 'PREFIX_BELOW_DOCUMENTED_MINIMUM']);
  assert.deepEqual(diagnose({ cacheDirective: 'cache_control', estimatedPrefixTokens: 3000, minPrefixTokens: null }, none), ['MARKED_BUT_NOT_APPLIED']); // mínimo NOT_VERIFIED: não se inventa
  assert.deepEqual(diagnose({ cacheDirective: 'automatic' }, none), []);
  assert.deepEqual(diagnose({ cacheDirective: 'automatic', estimatedPrefixTokens: 4000 }, classifyCache('google', GM_HIT)), ['PARTIAL_HIT']);
  assert.deepEqual(diagnose({ cacheDirective: 'automatic', estimatedPrefixTokens: 3400 }, classifyCache('openai', OA_HIT)), []); // dentro da tolerância de 128
  assert.deepEqual(diagnose({ cacheDirective: 'none' }, classifyCache('anthropic', AN_CREATE)), ['CREATION_WITHOUT_DIRECTIVE']);
});

test('resumo por diálogo: só as chamadas 2 e 3 são elegíveis a hit; UNKNOWN fora da taxa e contado à parte', () => {
  const o = (u: unknown) => classifyCache('anthropic', u);
  const s = summarizeDialog([o(AN_CREATE), o(AN_HIT), o(AN_HIT)]); assert.deepEqual([s.hitEligibleCalls, s.hits, s.unknowns, s.firstCallObserved], [2, 2, 0, 'CREATION']);
  const t = summarizeDialog([o(AN_CREATE), o(undefined), o(AN_HIT)]); assert.deepEqual([t.hitEligibleCalls, t.hits, t.unknowns], [1, 1, 1]);
  const u = summarizeDialog([o(AN_NONE), o(AN_NONE), o(AN_NONE)]); assert.deepEqual([u.hitEligibleCalls, u.hits], [2, 0]);
});
