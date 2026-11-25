/**
 * Tests for the cache cost interval: exact pico-USD arithmetic for the cheapest and the most expensive outcome of
 * a call whose cache result is not known in advance.
 *
 * Module under test: `scripts/h2eval/cache/costInterval.ts` (`picoPerToken`, `picoToUsd`, `costInterval`,
 * `inInterval`, `costFromObservation`), with `classifyCache` from `scripts/h2eval/cache/classify.ts` to build
 * observations.
 *
 * Strategy / partitions: price string parsing (valid decimals and rejected formats) and pico-to-USD formatting;
 * exact interval values for OpenAI and Anthropic (the upper bound uses the larger of the input and cache-write
 * prices, 1-hour write when the TTL is unknown); the lower bound using only the prefix that fits in the input;
 * inverted or non-integer token bounds (rejected); unknown prices (state `UNKNOWN` with a reason, never 0); a price
 * tier the table does not model (explicit failure); and the observed-usage cost for miss, hit and creation, which
 * must fall inside the interval, with an out-of-interval value detected.
 *
 * Needs: nothing external (pure BigInt arithmetic on the built-in price table).
 *
 * Run just this file: `npx tsx --test test/h2eval/cache/costInterval.test.ts`
 *
 * @module test/h2eval/cache/costInterval.test
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyCache } from '../../../scripts/h2eval/cache/classify.js';
import { costFromObservation, costInterval, inInterval, picoPerToken, picoToUsd, PriceError, R08_PRICES, type ModelPrices } from '../../../scripts/h2eval/cache/costInterval.js';

test('picoPerToken: exato (US$/MTok × 1e6 pico/token); formato inválido recusado', () => {
  assert.equal(picoPerToken('0.15'), 150000n); assert.equal(picoPerToken('1.00'), 1000000n); assert.equal(picoPerToken('0.125'), 125000n); assert.equal(picoPerToken('2.5'), 2500000n); assert.equal(picoPerToken('0.01'), 10000n);
  for (const bad of ['1e-3', '-1', '1.2345678', '', 'x', '1,5']) assert.throws(() => picoPerToken(bad), (e: unknown) => e instanceof PriceError && e.code === 'PRICE_FORMAT');
  assert.equal(picoToUsd(150000n * 1_000_000n), '0.150000000000'); assert.equal(picoToUsd(1n), '0.000000000001'); assert.equal(picoToUsd(0n), '0.000000000000'); assert.equal(picoToUsd(12_345_678_901_234n), '12.345678901234');
});

test('intervalo OpenAI gpt-4o-mini: valores exatos de [hit total, sem hit]', () => {
  const iv = costInterval({ provider: 'openai', prices: R08_PRICES['gpt-4o-mini']!, inputTokensLow: 5000, inputTokensHigh: 5000, prefixTokens: 4500, outputTokensHigh: 24 });
  assert.equal(iv.state, 'INTERVAL'); assert.equal(iv.lowerPico, String(4500n * 75000n + 500n * 150000n)); assert.equal(iv.upperPico, String(5000n * 150000n + 24n * 600000n));
  assert.equal(iv.lowerUsd, '0.000412500000'); assert.equal(iv.upperUsd, '0.000764400000'); assert.ok(BigInt(iv.lowerPico) < BigInt(iv.upperPico));
});

test('intervalo Anthropic: o teto usa o MAIOR preço entre entrada e escrita (1h quando o TTL é desconhecido; 5m quando é 5m)', () => {
  const base = { provider: 'anthropic' as const, prices: R08_PRICES['claude-haiku-4-5']!, inputTokensLow: 5000, inputTokensHigh: 5000, prefixTokens: 4500, outputTokensHigh: 24 };
  const u = costInterval(base); assert.equal(u.upperPico, String(5000n * 2_000_000n + 24n * 5_000_000n)); assert.equal(u.lowerPico, String(4500n * 100000n + 500n * 1_000_000n));
  assert.equal(costInterval({ ...base, cacheTtl: '5m' }).upperPico, String(5000n * 1_250_000n + 24n * 5_000_000n)); assert.equal(costInterval({ ...base, cacheTtl: '1h' }).upperPico, u.upperPico);
});

test('lower usa só o prefixo que cabe na entrada; saída mínima entra no lower; limites invertidos recusados', () => {
  const p = R08_PRICES['gemini-3.5-flash-lite']!;
  const a = costInterval({ provider: 'google', prices: p, inputTokensLow: 1000, inputTokensHigh: 1200, prefixTokens: 4500, outputTokensLow: 5, outputTokensHigh: 24 });
  assert.equal(a.lowerPico, String(1000n * 30000n + 5n * 2_500_000n)); assert.equal(a.upperPico, String(1200n * 300000n + 24n * 2_500_000n));
  assert.throws(() => costInterval({ provider: 'google', prices: p, inputTokensLow: 10, inputTokensHigh: 5, prefixTokens: 0, outputTokensHigh: 1 }), (e: unknown) => e instanceof PriceError && e.code === 'BAD_TOKENS');
  assert.throws(() => costInterval({ provider: 'google', prices: p, inputTokensLow: 1.5, inputTokensHigh: 5, prefixTokens: 0, outputTokensHigh: 1 }));
  assert.throws(() => costInterval({ provider: 'google', prices: p, inputTokensLow: 1, inputTokensHigh: 5, prefixTokens: -1, outputTokensHigh: 1 }));
});

test('preço desconhecido => estado UNKNOWN com motivo, nunca 0 nem preço inventado', () => {
  const noRead: ModelPrices = { ...R08_PRICES['gpt-4o-mini']!, cacheReadPerMTok: null };
  const iv = costInterval({ provider: 'openai', prices: noRead, inputTokensLow: 100, inputTokensHigh: 100, prefixTokens: 50, outputTokensHigh: 10 });
  assert.equal(iv.state, 'UNKNOWN'); assert.equal(iv.lowerUsd, 'UNKNOWN'); assert.equal(iv.upperUsd, 'UNKNOWN'); assert.deepEqual(iv.reasons, ['CACHE_READ_PRICE_UNKNOWN']);
  const noWrite: ModelPrices = { ...R08_PRICES['claude-haiku-4-5']!, cacheWrite1hPerMTok: null };
  assert.deepEqual(costInterval({ provider: 'anthropic', prices: noWrite, inputTokensLow: 1, inputTokensHigh: 1, prefixTokens: 1, outputTokensHigh: 1 }).reasons, ['CACHE_WRITE_PRICE_UNKNOWN']);
  assert.equal(costInterval({ provider: 'anthropic', prices: noWrite, cacheTtl: '5m', inputTokensLow: 1, inputTokensHigh: 1, prefixTokens: 1, outputTokensHigh: 1 }).state, 'INTERVAL'); // só o TTL pedido precisa de preço
  assert.equal(inInterval(5n, iv), 'UNKNOWN');
});

test('faixa de preço não modelada (haiku-5-5 acima de 100k tokens) falha explícito em vez de dar preço errado', () => {
  assert.throws(() => costInterval({ provider: 'anthropic', prices: R08_PRICES['claude-haiku-5-5']!, inputTokensLow: 1, inputTokensHigh: 100001, prefixTokens: 1, outputTokensHigh: 1 }), (e: unknown) => e instanceof PriceError && e.code === 'TIER_NOT_MODELED');
  assert.equal(costInterval({ provider: 'anthropic', prices: R08_PRICES['claude-haiku-5-5']!, inputTokensLow: 1, inputTokensHigh: 100000, prefixTokens: 1, outputTokensHigh: 1 }).state, 'INTERVAL');
});

test('custo pelo USO OBSERVADO: miss, hit e criação caem no intervalo; UNKNOWN se faltar categoria; fora do intervalo é detectado', () => {
  const P = R08_PRICES['claude-haiku-4-5']!;
  const miss = classifyCache('anthropic', { input_tokens: 5000, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
  const create = classifyCache('anthropic', { input_tokens: 400, cache_creation_input_tokens: 4600, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 4600, ephemeral_1h_input_tokens: 0 } });
  const hit = classifyCache('anthropic', { input_tokens: 400, cache_creation_input_tokens: 0, cache_read_input_tokens: 4600, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } });
  const iv = costInterval({ provider: 'anthropic', prices: P, inputTokensLow: 5000, inputTokensHigh: 5000, prefixTokens: 4600, outputTokensLow: 0, outputTokensHigh: 24 });
  assert.equal(costFromObservation(hit, 24, P), BigInt(iv.lowerPico) + 24n * 5_000_000n); // hit total com a mesma saída = lower + saída
  for (const o of [miss, create, hit]) assert.equal(inInterval(costFromObservation(o, 24, P), iv), true);
  assert.equal(costFromObservation(create, 24, P), 400n * 1_000_000n + 4600n * 1_250_000n + 24n * 5_000_000n);
  assert.equal(costFromObservation(hit, 'UNKNOWN', P), 'UNKNOWN'); assert.equal(costFromObservation(classifyCache('anthropic', undefined), 24, P), 'UNKNOWN');
  assert.equal(inInterval(BigInt(iv.upperPico) + 1n, iv), false); assert.equal(inInterval(BigInt(iv.lowerPico) - 1n, iv), false);
  // preço de leitura desconhecido com leitura observada => UNKNOWN, não 0
  assert.equal(costFromObservation(hit, 24, { ...P, cacheReadPerMTok: null }), 'UNKNOWN');
  assert.equal(costFromObservation(create, 24, { ...P, cacheWrite5mPerMTok: null }), 'UNKNOWN');
});
