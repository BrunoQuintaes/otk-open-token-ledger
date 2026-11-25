/**
 * Tests that an Anthropic cache write split into 5-minute and 1-hour parts is priced per TTL, instead of pricing the
 * whole write at the 5-minute price.
 *
 * Modules under test: `scripts/h2eval/record/cost.ts` (`computeCost`) with prices from `priceTableFromModal` in
 * `scripts/h2eval/index.ts`.
 *
 * Strategy / partitions: a 1-hour write priced at the 1-hour price; a mixed split with each part at its own price,
 * and a 5-minute-only write unchanged; a split that does not add up to the total, or a 1-hour part whose complement
 * is unknown, giving `UNKNOWN` (never under-charging); and a model without a 1-hour price giving `UNKNOWN` when a
 * 1-hour write is present. Without any split the previous behaviour applies.
 *
 * Needs: nothing external (pure cost arithmetic on the repository price tables). No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/record/c3prep_cache_write_1h.test.ts`
 *
 * @module test/h2eval/record/c3prep_cache_write_1h.test
 */
// SYNTHETIC — OFFLINE. C3-PREP (C160), executor E2''' sobre o E2'' 6cab0d01: B-2 da auditoria Q04-C159C.
// record/cost.ts precificava o TOTAL da escrita de cache Anthropic (cache_creation_input_tokens) ao preco de 5m; uma escrita de 1h saia a 2,50 (Sonnet) / 5 (Opus) em vez de 4 / 8.
// Agora: com a divisao 5m/1h conhecida, cada TTL ao seu preco; divisao incoerente com o total, ou parte 1h sem preco/complemento conhecido => UNKNOWN (parada segura).
// Sem divisao (os dois UNKNOWN): comportamento anterior (total ao preco unico/5m). Sem rede, sem credencial, sem GO.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceTableFromModal } from '../../../scripts/h2eval/index.js';
import { computeCost } from '../../../scripts/h2eval/record/cost.js';

const SON = 'claude-sonnet-5-5'; const OPU = 'claude-opus-5-5';
const prices = priceTableFromModal();
const usage = (o: Partial<Record<string, unknown>>) => ({ schema: 'h2eval.usage.v0', inputUncached: 12, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheWrite: 0, outputVisible: 24, reasoning: 0, imageUnits: 'NOT_APPLICABLE', audioUnits: 'NOT_APPLICABLE', toolTokens: 'NOT_APPLICABLE', U: 0, usageCompleteness: 'COMPLETE', usageSource: 'provider_response', ...o }) as never;
const cost = (model: string, u: never) => computeCost(prices, { provider: 'anthropic', model, api: 'anthropic.messages', usage: u, atUtc: '2026-11-14T12:00:00.000Z', capUsd: '999999999999999', prefixTokens: 'UNKNOWN', possiblyCharged: false });
const MODELS = [[SON, 2_000_000n, 2_500_000n, 4_000_000n, 10_000_000n], [OPU, 4_000_000n, 5_000_000n, 8_000_000n, 20_000_000n]] as const;

test('C3-PREP B-2: escrita de 1h (total + divisao) sai ao preco de 1h, nao ao de 5m', () => {
  for (const [m, pin, , w1, pout] of MODELS) {
    const c = cost(m, usage({ cacheWrite: 1000, cacheWrite5m: 0, cacheWrite1h: 1000, U: 1012 }));
    assert.equal(c.state, 'CALCULATED', m); assert.equal(c.byCategory['cacheWrite'], (1000n * w1).toString(), `${m}: 1.000 tokens de 1h ao preco de 1h`);
    assert.equal(c.usd, (12n * pin + 1000n * w1 + 24n * pout).toString());
  }
});

test('C3-PREP B-2: divisao mista 5m + 1h soma cada TTL ao seu preco; so 5m continua igual ao E2\'\'', () => {
  for (const [m, , w5, w1] of MODELS) {
    assert.equal(cost(m, usage({ cacheWrite: 300, cacheWrite5m: 100, cacheWrite1h: 200, U: 312 })).byCategory['cacheWrite'], (100n * w5 + 200n * w1).toString(), m);
    assert.equal(cost(m, usage({ cacheWrite: 4789, cacheWrite5m: 4789, cacheWrite1h: 0, U: 4801 })).byCategory['cacheWrite'], (4789n * w5).toString(), `${m}: so 5m, como antes`);
    assert.equal(cost(m, usage({ cacheWrite: 4789, cacheWrite5m: 4789, cacheWrite1h: 'UNKNOWN', U: 4801 })).byCategory['cacheWrite'], (4789n * w5).toString(), `${m}: 5m = total, 1h ausente`);
    assert.equal(cost(m, usage({ cacheWrite: 50, cacheWrite5m: 'UNKNOWN', cacheWrite1h: 'UNKNOWN', U: 62 })).byCategory['cacheWrite'], (50n * w5).toString(), `${m}: sem divisao, comportamento anterior`);
  }
});

test('C3-PREP B-2: divisao incoerente ou parte 1h com complemento desconhecido => UNKNOWN (nunca subcobra)', () => {
  for (const [m] of MODELS) {
    for (const [nome, o] of [['soma != total', { cacheWrite: 300, cacheWrite5m: 100, cacheWrite1h: 100 }], ['1h > 0 e 5m UNKNOWN', { cacheWrite: 300, cacheWrite5m: 'UNKNOWN', cacheWrite1h: 100 }], ['5m < total e 1h UNKNOWN', { cacheWrite: 300, cacheWrite5m: 100, cacheWrite1h: 'UNKNOWN' }]] as const) {
      const c = cost(m, usage({ ...o, U: 312 })); assert.equal(c.state, 'UNKNOWN', `${m}: ${nome}`); assert.equal(c.usd, 'UNKNOWN');
    }
  }
});

test('C3-PREP B-2: modelo sem preco de 1h (Haiku 4.5 na v3: cacheWrite null) com escrita de 1h > 0 => UNKNOWN', () => {
  const c = computeCost(prices, { provider: 'anthropic', model: 'claude-haiku-4-5-20251001', api: 'anthropic.messages', usage: usage({ cacheWrite: 10, cacheWrite5m: 0, cacheWrite1h: 10, U: 22 }), atUtc: '2026-11-14T12:00:00.000Z', capUsd: '999999999999999', prefixTokens: 'UNKNOWN', possiblyCharged: false });
  if (prices.micro('anthropic', 'claude-haiku-4-5-20251001', 'input_cache_write_1h', '2026-11-14T12:00:00.000Z') === null) assert.equal(c.state, 'UNKNOWN');
  else assert.equal(c.state, 'CALCULATED');
});
