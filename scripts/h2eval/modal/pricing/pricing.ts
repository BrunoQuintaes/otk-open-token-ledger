/**
 * Cost from canonical usage with the versioned H2-EVAL price table (contract §5).
 * Exact integer arithmetic: tokens x (micro-USD per MTok) = pico-USD. No rounding here.
 * UNKNOWN whenever a needed price is null, a needed count is UNKNOWN, or the pricing terms are not the standard ones.
 * ESTIMATED_UPPER_BOUND only when the provider total is known but its cache split is not (all input at the dearest
 * applicable input price): it is a bound, never a calculated cost.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { CanonicalUsage, Count, MatrixModel, PricingTermsObserved } from '../types.js';
import { NA, UNKNOWN } from '../canonical.js';

export type PriceKey = 'input' | 'cacheRead' | 'cacheWrite5m' | 'cacheWrite1h' | 'cacheWrite' | 'output' | 'reasoning' | 'imageTokens' | 'audioTokens';
export interface PriceTier { id: string; appliesWhen: string; prices: Record<PriceKey, string | null>; citation: string }
export interface PriceModel { provider: string; api: string; availability: string; standardTerms: Record<string, string>; promptLengthRule?: string; tiers: PriceTier[]; notes: string[] }
export interface PriceTableH2 { schema: 'otk.h2eval.price_table.v1'; version: string; currency: 'USD'; unit: string; capturedUtc: string; source: unknown; models: Record<string, PriceModel> }

/** C159C E-1: v3 = v2 + the published CACHE prices of Sonnet/Opus 5.5 (R08 pricing.html 96b086ac); v1 and v2 stay on disk unchanged */
export const PRICE_TABLE_PATH = fileURLToPath(new URL('./price_table_h2eval_v3.json', import.meta.url));

export function loadPriceTable(path: string = PRICE_TABLE_PATH): { table: PriceTableH2; sha256: string; path: string } {
  const buf = readFileSync(path);
  const table = JSON.parse(buf.toString('utf8')) as PriceTableH2;
  if (table.schema !== 'otk.h2eval.price_table.v1') throw new Error('price table: unexpected schema');
  for (const [m, pm] of Object.entries(table.models)) for (const t of pm.tiers) for (const [k, v] of Object.entries(t.prices)) {
    if (v !== null && !/^[0-9]+$/.test(v)) throw new Error(`price table: ${m}.${t.id}.${k} must be an integer string or null`);
    if (v === '0') throw new Error(`price table: ${m}.${t.id}.${k} is "0": unknown prices must be null, never zero`);
  }
  return { table, sha256: createHash('sha256').update(buf).digest('hex'), path };
}

export type CostState = 'CALCULATED' | 'ESTIMATED_UPPER_BOUND' | 'UNKNOWN';
export interface CostResult {
  state: CostState;
  /** pico-USD (10^-12 USD) as a decimal string; null when UNKNOWN */
  picoUsd: string | null;
  usd: string | null;
  byCategory: Record<string, { tokens: string; priceMicroPerMTok: string; picoUsd: string }>;
  tierId: string | null;
  priceTableVersion: string;
  priceTableSha256: string;
  reasons: string[];
  /** set => the runner must STOP (contract §8: unknown price) */
  stopRunner: boolean;
}

const picoToUsd = (p: bigint) => { const s = p.toString().padStart(13, '0'); return `${s.slice(0, -12)}.${s.slice(-12)}`.replace(/(\.\d*?[1-9])0+$|\.0+$/, '$1'); };

function selectTier(model: PriceModel, u: CanonicalUsage): { tier: PriceTier | null; reason: string | null } {
  const usable = model.tiers.filter((t) => !t.id.endsWith('_REFERENCE_ONLY'));
  if (usable.length === 1) return { tier: usable[0]!, reason: null };
  // prompt-length tiers (Haiku 5.5): prompt length = inputUncached + cacheRead + cacheWrite(s)
  const parts: Count[] = [u.inputUncached, u.cacheRead, typeof u.cacheWrite === 'bigint' ? u.cacheWrite : (typeof u.cacheWrite5m === 'bigint' && typeof u.cacheWrite1h === 'bigint' ? u.cacheWrite5m + u.cacheWrite1h : u.cacheWrite)];
  let len = 0n;
  for (const p of parts) { if (p === NA) continue; if (typeof p !== 'bigint') return { tier: null, reason: 'prompt length UNKNOWN: cannot pick the price tier' }; len += p; }
  const t = len <= 100000n ? usable.find((x) => x.id === 'prompt_le_100k') : usable.find((x) => x.id === 'prompt_gt_100k');
  return t ? { tier: t, reason: null } : { tier: null, reason: 'no tier matches the prompt length' };
}

/**
 * Computes the cost of one operation. `modality` tells which price applies to the input units (the APIs bill image/audio
 * tokens inside the input at the input price; the keys exist so a future table with distinct media prices still works).
 */
export function computeCost(model: MatrixModel, u: CanonicalUsage, termsObs: PricingTermsObserved, loaded: { table: PriceTableH2; sha256: string }): CostResult {
  const base: CostResult = { state: 'UNKNOWN', picoUsd: null, usd: null, byCategory: {}, tierId: null, priceTableVersion: loaded.table.version, priceTableSha256: loaded.sha256, reasons: [], stopRunner: false };
  const pm = loaded.table.models[model];
  if (!pm) return { ...base, reasons: [`model ${model} not in price table`], stopRunner: true };
  if (u.usageSource === 'none') return { ...base, reasons: ['no usage: cost UNKNOWN (upper bound = the operation cap, kept by the runner)'] };
  if (!termsObs.standard) return { ...base, reasons: [`non-standard pricing terms: ${termsObs.nonStandardReasons.join(', ')}`], stopRunner: true };
  const { tier, reason } = selectTier(pm, u);
  if (!tier) return { ...base, reasons: [reason ?? 'no tier'] };
  const P = (k: PriceKey): bigint | null => (tier.prices[k] === null ? null : BigInt(tier.prices[k]!));
  const by: CostResult['byCategory'] = {};
  const reasons: string[] = [];
  let total = 0n; let upperBound = false; let unknown = false; let stop = false;
  const line = (cat: string, tokens: Count, key: PriceKey) => {
    if (tokens === NA) return;
    if (tokens === UNKNOWN) { unknown = true; reasons.push(`${cat} UNKNOWN`); return; }
    if (tokens === 0n) return;
    const p = P(key);
    if (p === null) { unknown = true; stop = true; reasons.push(`price for ${cat} (${key}) is null in ${loaded.table.version}: runner must stop`); return; }
    by[cat] = { tokens: tokens.toString(), priceMicroPerMTok: p.toString(), picoUsd: (tokens * p).toString() };
    total += tokens * p;
  };
  // input side
  if (typeof u.inputUncached === 'bigint' && (typeof u.cacheRead === 'bigint' || u.cacheRead === NA)) {
    line('inputUncached', u.inputUncached, 'input');
    line('cacheRead', u.cacheRead, 'cacheRead');
  } else if (typeof u.providerTotals.inputTotal === 'bigint' && u.cacheRead === UNKNOWN) {
    // split unknown: bound with every input token at the input price (>= cache read price in every table here)
    const pIn = P('input'); const pCr = P('cacheRead');
    if (pIn === null) { stop = true; unknown = true; reasons.push('input price null'); }
    else if (pCr !== null && pCr > pIn) { unknown = true; reasons.push('cache read dearer than input: no bound'); }
    else { by['inputTotal_UPPER_BOUND'] = { tokens: u.providerTotals.inputTotal.toString(), priceMicroPerMTok: pIn.toString(), picoUsd: (u.providerTotals.inputTotal * pIn).toString() }; total += u.providerTotals.inputTotal * pIn; upperBound = true; reasons.push('cache split UNKNOWN: input bounded at the input price'); }
  } else { unknown = true; reasons.push('input UNKNOWN'); }
  // cache writes (Anthropic): priced only through the TTL split
  if (u.cacheWrite5m !== NA || u.cacheWrite1h !== NA) {
    if (typeof u.cacheWrite5m === 'bigint' && typeof u.cacheWrite1h === 'bigint') { line('cacheWrite5m', u.cacheWrite5m, 'cacheWrite5m'); line('cacheWrite1h', u.cacheWrite1h, 'cacheWrite1h'); }
    else if (typeof u.cacheWrite === 'bigint' && u.cacheWrite === 0n) { /* no write: nothing to price */ }
    else if (typeof u.cacheWrite === 'bigint') { const p1h = P('cacheWrite1h'); if (p1h === null) { unknown = true; stop = true; reasons.push('cacheWrite1h price null'); } else { by['cacheWrite_UPPER_BOUND_1h'] = { tokens: u.cacheWrite.toString(), priceMicroPerMTok: p1h.toString(), picoUsd: (u.cacheWrite * p1h).toString() }; total += u.cacheWrite * p1h; upperBound = true; reasons.push('cache write TTL split UNKNOWN: bounded at the 1h write price'); } }
    else { unknown = true; reasons.push('cache write UNKNOWN'); }
  } else if (u.cacheWrite !== NA) { line('cacheWrite', u.cacheWrite, 'cacheWrite'); }
  // output side: visible + reasoning, or the provider total when the split is unknown (same price in every table here)
  if (typeof u.outputVisible === 'bigint' && (typeof u.reasoning === 'bigint' || u.reasoning === NA)) { line('outputVisible', u.outputVisible, 'output'); line('reasoning', u.reasoning, 'reasoning'); }
  else if (typeof u.providerTotals.outputTotal === 'bigint') { const po = P('output'); const pr = P('reasoning'); if (po !== null && pr !== null && po === pr) { by['outputTotal'] = { tokens: u.providerTotals.outputTotal.toString(), priceMicroPerMTok: po.toString(), picoUsd: (u.providerTotals.outputTotal * po).toString() }; total += u.providerTotals.outputTotal * po; reasons.push('reasoning/visible split UNKNOWN; same price: total priced'); } else { unknown = true; reasons.push('output split UNKNOWN and prices differ'); } }
  else { unknown = true; reasons.push('output UNKNOWN'); }
  // media units: already inside the input totals for every API here; priced separately only if a table ever lists a distinct media price
  for (const [cat, tokens, key] of [['imageUnits', u.imageUnits, 'imageTokens'], ['audioUnits', u.audioUnits, 'audioTokens']] as const) {
    if (tokens === NA || tokens === UNKNOWN || tokens === 0n) continue;
    const pMedia = P(key); const pIn = P('input');
    if (pMedia === null) { unknown = true; stop = true; reasons.push(`price for ${cat} null: runner must stop`); continue; }
    if (pIn !== null && pMedia !== pIn) { by[`${cat}_PRICE_DELTA`] = { tokens: tokens.toString(), priceMicroPerMTok: (pMedia - pIn).toString(), picoUsd: (tokens * (pMedia - pIn)).toString() }; total += tokens * (pMedia - pIn); }
  }
  if (u.toolTokens !== NA && u.toolTokens !== UNKNOWN && u.toolTokens > 0n) { unknown = true; reasons.push('tool tokens present: no price rule in this table'); }
  if (unknown) return { ...base, byCategory: by, tierId: tier.id, reasons, stopRunner: stop };
  return { ...base, state: upperBound ? 'ESTIMATED_UPPER_BOUND' : 'CALCULATED', picoUsd: total.toString(), usd: picoToUsd(total), byCategory: by, tierId: tier.id, reasons, stopRunner: false };
}

/** Contract rev. 2 item 6: reasoning allowance added to the cap (Haiku 5.5: 1,024; Gemini: 2,048; others 0) because "max_tokens includes reasoning" is NOT_VERIFIED. */
export const REASONING_ALLOWANCE_TOKENS: Readonly<Record<MatrixModel, bigint>> = Object.freeze({ 'gpt-4o-mini-2024-07-18': 0n, 'claude-haiku-4-5-20251001': 0n, 'claude-haiku-5-5': 1024n, 'claude-sonnet-5-5': 1024n, 'claude-opus-5-5': 1024n, 'gemini-3.5-flash-lite': 2048n,
  // E3G (C160 BRACO-GO): gemini-3.1-flash-lite same rule as Gemini (thoughts are a separate addend; maxOutputTokens is not documented to include them);
  // gpt-6-luna 0: max_completion_tokens "including visible output tokens and reasoning tokens" (openai/chat-create.html, quoted in openai_chat.ts) bounds the reasoning
  'gemini-3.1-flash-lite': 2048n, 'gpt-6-luna': 0n });

export interface CostCapResult { picoUsd: string; usd: string; basis: string; tierId: string; reasoningAllowanceTokens: string; capBasis: { inputUpperBoundTokens: string; inputPriceUsedMicroPerMTok: string; inputPriceSource: 'input' | 'cacheWrite5m' | 'cacheWrite1h' | 'cacheWrite'; maxOutputTokens: string; outputPriceMicroPerMTok: string; reasoningAllowanceTokens: string; reasoningPriceMicroPerMTok: string; tierId: string } }

/**
 * Pre-call worst case (contract §3 costCap, rev. 2 item 6): input upper bound at max(input, cache write at the DEAREST TTL)
 * + (max output + reasoning allowance) at the output price, on the dearest tier. Pico-USD, exact (no rounding needed).
 */
export function costCap(model: MatrixModel, inputUpperBoundTokens: bigint, maxOutputTokens: bigint, loaded: { table: PriceTableH2; sha256: string }, reasoningAllowanceTokens: bigint = REASONING_ALLOWANCE_TOKENS[model] ?? 0n): CostCapResult | { error: string } {
  const pm = loaded.table.models[model]; if (!pm) return { error: 'model not in table' };
  const usable = pm.tiers.filter((t) => !t.id.endsWith('_REFERENCE_ONLY'));
  // worst tier = highest input price
  const tier = usable.reduce((a, b) => (BigInt(b.prices.input ?? '0') > BigInt(a.prices.input ?? '0') ? b : a));
  const cands = (['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheWrite'] as const).filter((k) => tier.prices[k] !== null).map((k) => ({ k, p: BigInt(tier.prices[k]!) }));
  if (!cands.length || tier.prices.output === null || tier.prices.reasoning === null) return { error: 'input/output/reasoning price null' };
  const best = cands.reduce((a, b) => (b.p > a.p ? b : a)); const pout = BigInt(tier.prices.output); const preas = BigInt(tier.prices.reasoning);
  const pico = inputUpperBoundTokens * best.p + maxOutputTokens * pout + reasoningAllowanceTokens * preas;
  return { picoUsd: pico.toString(), usd: picoToUsd(pico), tierId: tier.id, reasoningAllowanceTokens: reasoningAllowanceTokens.toString(),
    basis: `input ${inputUpperBoundTokens} x ${best.p} (${best.k}, dearest of input/cache-write TTLs) + output ${maxOutputTokens} x ${pout} + reasoning allowance ${reasoningAllowanceTokens} x ${preas} (tier ${tier.id})`,
    capBasis: { inputUpperBoundTokens: inputUpperBoundTokens.toString(), inputPriceUsedMicroPerMTok: best.p.toString(), inputPriceSource: best.k, maxOutputTokens: maxOutputTokens.toString(), outputPriceMicroPerMTok: pout.toString(), reasoningAllowanceTokens: reasoningAllowanceTokens.toString(), reasoningPriceMicroPerMTok: preas.toString(), tierId: tier.id } };
}

/** Contract §5 / rev. 2: table cost above the pre-call cap is a safety failure => global STOP. UNKNOWN cost cannot be checked (capCovered UNKNOWN, no stop here; the runner keeps it possiblyCharged). */
export function capCovered(cost: CostResult, cap: CostCapResult): { capCovered: boolean | 'UNKNOWN'; stop: 'STOP_CAP_VIOLATION' | null } {
  if (cost.picoUsd === null) return { capCovered: 'UNKNOWN', stop: null };
  const ok = BigInt(cost.picoUsd) <= BigInt(cap.picoUsd);
  return { capCovered: ok, stop: ok ? null : 'STOP_CAP_VIOLATION' };
}
