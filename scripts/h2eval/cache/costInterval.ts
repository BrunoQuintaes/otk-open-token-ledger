/**
 * H2-EVAL / R13 — intervalo de custo ex ante por operação: [hit total, sem hit] (CONTRACT_MIN §5 `cacheInterval`, R06 hipótese E).
 *   lowerUsd = prefixo cacheável TODO lido (ao preço de leitura) + resto da entrada ao preço de entrada + saída mínima
 *   upperUsd = TODA a entrada ao maior preço entre entrada e escrita de cache + saída no teto
 * Aritmética exata em pico-USD (BigInt). Preço desconhecido => estado UNKNOWN (nunca 0, nunca inventado).
 * É um intervalo de ESTIMATIVA do custo da tabela, não previsão nem gasto; preços são parâmetros (R08: a confirmar).
 *
 * English summary: computes, before a call, the list-price cost interval of one operation: the lower bound assumes the
 * whole cacheable prefix is read from cache and the minimum output; the upper bound assumes all input at the highest
 * of the input and cache-write prices and the output at its ceiling. It also computes the list-price cost of an
 * observed call (`costFromObservation`) and whether it falls inside the interval. Exact integer arithmetic in pico-USD
 * (1 USD = 10^12 pico-USD) with BigInt; an unknown price gives the state `UNKNOWN`, never 0. It is an estimate from a
 * price table, not a bill and not a forecast. Pure functions; no I/O and no environment variables.
 *
 * @module scripts/h2eval/cache/costInterval
 */
import type { CacheObservation, Provider } from './classify.js';

/**
 * List prices of one model, in USD per million tokens as decimal text (up to 6 decimals). A `null` cache price means
 * the price is unknown or the API does not charge it; `status` says how reliable the table row is.
 */
export interface ModelPrices {
  /** US$ por 1M tokens, texto decimal com até 6 casas */
  inputPerMTok: string; outputPerMTok: string;
  cacheReadPerMTok: string | null; cacheWrite5mPerMTok: string | null; cacheWrite1hPerMTok: string | null;
  status: 'DOCUMENTED' | 'PRELIMINARY' | 'TO_CONFIRM';
  /** acima disso há faixa de preço que este módulo NÃO modela: falha explícita em vez de preço errado */
  maxModeledPromptTokens?: number;
}

/** Preços do R08/R07 (captura de 10/11/2026). Só entram aqui para os testes e o piloto; o executor deve receber o snapshot atestado. */
export const R08_PRICES: Readonly<Record<string, ModelPrices>> = Object.freeze({
  'gpt-4o-mini': { inputPerMTok: '0.15', outputPerMTok: '0.60', cacheReadPerMTok: '0.075', cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, status: 'DOCUMENTED' },
  'claude-haiku-4-5': { inputPerMTok: '1.00', outputPerMTok: '5.00', cacheReadPerMTok: '0.10', cacheWrite5mPerMTok: '1.25', cacheWrite1hPerMTok: '2.00', status: 'DOCUMENTED' },
  'claude-haiku-5-5': { inputPerMTok: '0.10', outputPerMTok: '0.50', cacheReadPerMTok: '0.01', cacheWrite5mPerMTok: '0.125', cacheWrite1hPerMTok: '0.20', status: 'PRELIMINARY', maxModeledPromptTokens: 100000 },
  'gemini-3.5-flash-lite': { inputPerMTok: '0.30', outputPerMTok: '2.50', cacheReadPerMTok: '0.03', cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, status: 'DOCUMENTED' },
});

/**
 * Error for invalid cost inputs. `code`: `PRICE_FORMAT` (price text is not a non-negative decimal with up to 6
 * decimals), `TIER_NOT_MODELED` (prompt above `maxModeledPromptTokens`), `BAD_TOKENS` (negative, non-integer or
 * inverted token counts).
 */
export class PriceError extends Error {
  readonly code: 'PRICE_FORMAT' | 'TIER_NOT_MODELED' | 'BAD_TOKENS';
  constructor(code: PriceError['code'], m: string) { super(m); this.name = 'PriceError'; this.code = code; }
}

/**
 * US$/MTok (texto) -> pico-USD por token (inteiro exato): 1 US$/MTok = 1e-6 US$/token = 1e6 pico/token.
 *
 * @param price - Price in USD per million tokens, as decimal text such as `"0.15"`.
 * @returns Price in pico-USD per token, exact.
 * @throws {@link PriceError} With code `PRICE_FORMAT` when the text is not a non-negative decimal with up to 6 decimals.
 */
export function picoPerToken(price: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(price);
  if (!m) throw new PriceError('PRICE_FORMAT', `preço inválido: ${price}`);
  return BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? '').padEnd(6, '0'));
}

/**
 * Formats a pico-USD amount as a USD decimal string with 12 decimals, exactly (no floating point).
 *
 * @param p - Amount in pico-USD; may be negative.
 * @returns For example `"0.000001500000"` for 1,500,000 pico-USD.
 */
export function picoToUsd(p: bigint): string {
  const neg = p < 0n; const a = neg ? -p : p; const s = a.toString().padStart(13, '0');
  return `${neg ? '-' : ''}${s.slice(0, -12)}.${s.slice(-12)}`;
}

/**
 * Input of {@link costInterval}, all counts in tokens (non-negative integers): the input range, the cacheable prefix,
 * the output range (`outputTokensLow` defaults to 0) and, for Anthropic, the cache TTL (`unknown` takes the higher of
 * the two write prices).
 */
export interface IntervalInput {
  provider: Provider; prices: ModelPrices;
  inputTokensLow: number; inputTokensHigh: number; prefixTokens: number;
  outputTokensLow?: number; outputTokensHigh: number; cacheTtl?: '5m' | '1h' | 'unknown';
}

/**
 * Cost interval of one operation: bounds in pico-USD (integer text) and in USD (12-decimal text), all `UNKNOWN` when
 * `state` is `UNKNOWN`; the price status; the assumptions used; and the reasons for `UNKNOWN` (missing prices).
 */
export interface CostInterval {
  state: 'INTERVAL' | 'UNKNOWN'; lowerPico: string | 'UNKNOWN'; upperPico: string | 'UNKNOWN'; lowerUsd: string | 'UNKNOWN'; upperUsd: string | 'UNKNOWN';
  priceStatus: ModelPrices['status']; assumptions: string[]; reasons: string[];
}

const nonNeg = (x: number): boolean => Number.isInteger(x) && x >= 0;

/**
 * Computes the ex-ante list-price cost interval [full cache hit, no hit] of one operation.
 *
 * @param i - Token ranges, prices and TTL.
 * @returns The interval, or state `UNKNOWN` when a needed cache price is missing.
 * @throws {@link PriceError} With `BAD_TOKENS` for invalid counts, `TIER_NOT_MODELED` when the input exceeds the modeled
 *   price tier, or `PRICE_FORMAT` for a malformed price.
 */
export function costInterval(i: IntervalInput): CostInterval {
  const { prices: p } = i; const reasons: string[] = []; const assumptions: string[] = [];
  if (![i.inputTokensLow, i.inputTokensHigh, i.prefixTokens, i.outputTokensHigh, i.outputTokensLow ?? 0].every(nonNeg) || i.inputTokensLow > i.inputTokensHigh || (i.outputTokensLow ?? 0) > i.outputTokensHigh) throw new PriceError('BAD_TOKENS', 'contagens de tokens inválidas');
  if (p.maxModeledPromptTokens !== undefined && i.inputTokensHigh > p.maxModeledPromptTokens) throw new PriceError('TIER_NOT_MODELED', `entrada acima de ${p.maxModeledPromptTokens} tokens: faixa de preço não modelada`);
  const inp = picoPerToken(p.inputPerMTok); const out = picoPerToken(p.outputPerMTok);
  if (p.cacheReadPerMTok === null) reasons.push('CACHE_READ_PRICE_UNKNOWN');
  // preço de escrita: Anthropic tem 5m/1h; OpenAI/Gemini não cobram escrita (a entrada já é o teto)
  let writeMax = inp;
  if (i.provider === 'anthropic') {
    const w5 = p.cacheWrite5mPerMTok === null ? null : picoPerToken(p.cacheWrite5mPerMTok); const w1 = p.cacheWrite1hPerMTok === null ? null : picoPerToken(p.cacheWrite1hPerMTok);
    const ttl = i.cacheTtl ?? 'unknown';
    const cands = ttl === '5m' ? [w5] : ttl === '1h' ? [w1] : [w5, w1];
    if (cands.some((c) => c === null)) reasons.push('CACHE_WRITE_PRICE_UNKNOWN'); else for (const c of cands) if (c! > writeMax) writeMax = c!;
  } else assumptions.push('sem preço de escrita de cache nesta API: entrada é o teto');
  if (reasons.length) return { state: 'UNKNOWN', lowerPico: 'UNKNOWN', upperPico: 'UNKNOWN', lowerUsd: 'UNKNOWN', upperUsd: 'UNKNOWN', priceStatus: p.status, assumptions, reasons };
  const read = picoPerToken(p.cacheReadPerMTok!);
  const cacheable = BigInt(Math.min(i.prefixTokens, i.inputTokensLow));
  const lower = cacheable * read + (BigInt(i.inputTokensLow) - cacheable) * inp + BigInt(i.outputTokensLow ?? 0) * out;
  const upper = BigInt(i.inputTokensHigh) * writeMax + BigInt(i.outputTokensHigh) * out;
  assumptions.push('lower: prefixo cacheável todo lido, saída mínima', 'upper: toda a entrada ao maior preço entre entrada e escrita, saída no teto', 'estimativa da tabela; não é cobrança nem previsão');
  return { state: 'INTERVAL', lowerPico: lower.toString(), upperPico: upper.toString(), lowerUsd: picoToUsd(lower), upperUsd: picoToUsd(upper), priceStatus: p.status, assumptions, reasons };
}

/**
 * Custo da tabela a partir do USO OBSERVADO (classificador). UNKNOWN se qualquer categoria necessária for desconhecida.
 *
 * Without a per-TTL breakdown, an Anthropic cache write is priced at the 5-minute write price.
 *
 * @param obs - The observation from the cache classifier.
 * @param outputTokens - Output tokens of the call, or `UNKNOWN`.
 * @param prices - List prices of the model.
 * @returns The list-price cost in pico-USD, or `UNKNOWN`.
 * @throws {@link PriceError} With `PRICE_FORMAT` when a price text is malformed.
 */
export function costFromObservation(obs: CacheObservation, outputTokens: number | 'UNKNOWN', prices: ModelPrices): bigint | 'UNKNOWN' {
  if (typeof outputTokens !== 'number' || typeof obs.inputUncached !== 'number' || typeof obs.cacheRead !== 'number') return 'UNKNOWN';
  let cost = BigInt(obs.inputUncached) * picoPerToken(prices.inputPerMTok) + BigInt(outputTokens) * picoPerToken(prices.outputPerMTok);
  if (obs.cacheRead > 0) { if (prices.cacheReadPerMTok === null) return 'UNKNOWN'; cost += BigInt(obs.cacheRead) * picoPerToken(prices.cacheReadPerMTok); }
  if (obs.provider === 'anthropic') {
    const w5 = obs.cacheWrite5m; const w1 = obs.cacheWrite1h; const wt = obs.cacheWrite;
    if (typeof w5 === 'number' && typeof w1 === 'number') {
      if (w5 > 0) { if (prices.cacheWrite5mPerMTok === null) return 'UNKNOWN'; cost += BigInt(w5) * picoPerToken(prices.cacheWrite5mPerMTok); }
      if (w1 > 0) { if (prices.cacheWrite1hPerMTok === null) return 'UNKNOWN'; cost += BigInt(w1) * picoPerToken(prices.cacheWrite1hPerMTok); }
    } else if (typeof wt === 'number') {
      if (wt > 0) { if (prices.cacheWrite5mPerMTok === null) return 'UNKNOWN'; cost += BigInt(wt) * picoPerToken(prices.cacheWrite5mPerMTok); } // sem separação: pior caso de TTL desconhecido não é inventado aqui
    } else return 'UNKNOWN';
  }
  return cost;
}

/**
 * Tells whether an observed cost lies inside an interval, bounds included.
 *
 * @param actualPico - Observed cost in pico-USD, or `UNKNOWN`.
 * @param iv - The interval.
 * @returns `true`/`false`, or `UNKNOWN` when the cost or the interval is unknown.
 */
export function inInterval(actualPico: bigint | 'UNKNOWN', iv: CostInterval): boolean | 'UNKNOWN' {
  if (actualPico === 'UNKNOWN' || iv.state !== 'INTERVAL') return 'UNKNOWN';
  return actualPico >= BigInt(iv.lowerPico) && actualPico <= BigInt(iv.upperPico);
}
