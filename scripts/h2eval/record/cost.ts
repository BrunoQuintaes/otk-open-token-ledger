/**
 * R12 cost: pre-call cap (worst case) and post-call cost by the price table. All pico-USD BigInt. Never 0 for unknown.
 * Cap basis (R07 R2 / R10 R2 §5.1 / contract R2 item 6): inputUpperBound × max(input, cache write at the MOST EXPENSIVE TTL)
 * + (maxOutput + reasoningAllowance) × output, rounded UP to micro-USD. The allowance (Haiku 5.5: 1 024, Gemini: 2 048, others 0)
 * is policy, injected by the caller; APIs that bill reasoning separately refuse an allowance of 0 (fail closed, because
 * "max_tokens includes reasoning" is NOT_VERIFIED). Any needed price missing => error (caller: STOP_PRICE_UNKNOWN before reserving).
 */
import { H2EVAL_SCHEMA, type CostCap, type Count, type CostTable, type NormalizedUsageH2, type PicoUsd } from '../types.js';
import type { UsageApi } from '../../../src/types/d1d8/index.js';
import type { PriceTable } from './prices.js';

/**
 * Per-API reasoning semantics (R08): whether the API reports reasoning as a separate count billed as output (gemini thoughtsTokenCount)
 * or inside output_tokens (openai/anthropic, split out by the adapters into DISJOINT outputVisible + reasoning). Billing is the same in
 * both cases (reasoning × output price); the distinction only decides whether a cap needs an explicit reasoning allowance > 0.
 */
export const REASONING_SEMANTICS: Record<UsageApi, 'subset_of_output' | 'separate_billed_as_output' | 'none'> = {
  'openai.chat_completions': 'subset_of_output', 'openai.responses': 'subset_of_output', 'anthropic.messages': 'subset_of_output',
  'gemini.generate_content': 'separate_billed_as_output', 'deepseek.chat_completions': 'subset_of_output', 'mistral.chat_completions': 'none', 'cohere.chat': 'none',
};

export interface CapInput { provider: string; model: string; api: UsageApi; inputUpperBoundTokens: number; maxOutputTokens: number; reasoningAllowanceTokens: number; atUtc: string;
  /** EXEC-ECON C160 (delta v3.1 item 5): Anthropic request WITHOUT cache_control (cacheDirectives NONE, H_PARITY) => "without cache_control there is neither write nor read"
   *  (anthropic_messages.ts header, R08 §4): the input is priced at the input price, without the cache-write surcharge. Only honoured for provider anthropic. */
  noCacheWrite?: boolean;
  /** EXEC-ECON C160 (delta v3.1 item 9): G-7b RESOLVED as "maxOutputTokens bounds the thoughts" => an allowance of 0 is accepted on an API that bills reasoning separately. Absent => the fail-closed rule stays. */
  thoughtsBoundedByMaxOutput?: boolean }
export type CapResult = CostCap;
const MICRO = 1_000_000n; // pico-USD per micro-USD
export const ceilToMicro = (pico: bigint): bigint => ((pico + MICRO - 1n) / MICRO) * MICRO;

export function computeCostCap(prices: PriceTable, c: CapInput): CapResult | { error: 'PRICE_UNKNOWN'; missing: string[] } {
  const hint = c.inputUpperBoundTokens;
  const pIn = prices.micro(c.provider, c.model, 'input', c.atUtc, hint);
  const pOut = prices.micro(c.provider, c.model, 'output', c.atUtc, hint);
  const pW5 = prices.micro(c.provider, c.model, 'input_cache_write', c.atUtc, hint);
  const pW1 = prices.micro(c.provider, c.model, 'input_cache_write_1h', c.atUtc, hint);
  const missing: string[] = []; if (pIn === null) missing.push('input'); if (pOut === null) missing.push('output');
  if (missing.length) return { error: 'PRICE_UNKNOWN', missing };
  if (!Number.isInteger(c.inputUpperBoundTokens) || c.inputUpperBoundTokens <= 0 || !Number.isInteger(c.maxOutputTokens) || c.maxOutputTokens <= 0) return { error: 'PRICE_UNKNOWN', missing: ['bounds_invalid'] };
  if (!Number.isInteger(c.reasoningAllowanceTokens) || c.reasoningAllowanceTokens < 0) return { error: 'PRICE_UNKNOWN', missing: ['reasoning_allowance_invalid'] };
  if (REASONING_SEMANTICS[c.api] === 'separate_billed_as_output' && c.reasoningAllowanceTokens === 0 && c.thoughtsBoundedByMaxOutput !== true) return { error: 'PRICE_UNKNOWN', missing: ['reasoning_allowance_required_for_api'] };
  // most expensive write TTL (R2 item 5/6): 1h when priced, else 5m/single write price, else input only
  const noWrite = c.noCacheWrite === true && c.provider === 'anthropic';
  const ttl: CostCap['capBasis']['cacheWriteTtlUsed'] = noWrite ? 'NONE' : pW1 !== null && pW1 >= (pW5 ?? 0n) ? '1h' : pW5 !== null ? '5m' : 'NONE';
  const pWriteUsed = ttl === '1h' ? pW1! : ttl === '5m' ? pW5! : 0n;
  const worstIn = pWriteUsed > pIn! ? pWriteUsed : pIn!;
  const outTokens = BigInt(c.maxOutputTokens + c.reasoningAllowanceTokens);
  const raw = BigInt(c.inputUpperBoundTokens) * worstIn + outTokens * pOut!;
  const usd = ceilToMicro(raw);
  const basis = `${noWrite ? '[anthropic sem cache_control: sem sobretaxa de escrita] ' : ''}input ${c.inputUpperBoundTokens} × max(input=${pIn},cache_write[${ttl}]=${pWriteUsed})=${worstIn} + (output ${c.maxOutputTokens} + reasoning_allowance ${c.reasoningAllowanceTokens}) × ${pOut}; ceil to micro-USD (micro-USD/MTok; pico-USD = tokens × micro)`;
  return { usd: usd.toString(), basis, inputUpperBoundTokens: c.inputUpperBoundTokens, maxOutputTokens: c.maxOutputTokens, reasoningAllowanceTokens: c.reasoningAllowanceTokens, capBasis: { inputPriceMicro: pIn!.toString(), cacheWritePriceUsedMicro: pWriteUsed.toString(), cacheWriteTtlUsed: ttl, outputPriceMicro: pOut!.toString(), roundedUpToMicroUsd: usd !== raw } };
}

const num = (c: Count): bigint | null => (typeof c === 'number' ? BigInt(c) : null);

export interface CostInput { provider: string; model: string; api: UsageApi; usage: NormalizedUsageH2 | null; atUtc: string; capUsd: PicoUsd; prefixTokens: number | 'UNKNOWN'; possiblyCharged: boolean }

/** Ex-post cost by the table. CALCULATED only when every billed category has a numeric count and a price; else UNKNOWN. */
export function computeCost(prices: PriceTable, c: CostInput): CostTable {
  const unknown = (): CostTable => ({ schema: H2EVAL_SCHEMA.cost, usd: 'UNKNOWN', state: 'UNKNOWN', byCategory: {}, priceSnapshotSha256: prices.sha256, capCovered: 'UNKNOWN', cacheInterval: { lowerUsd: 'UNKNOWN', upperUsd: 'UNKNOWN', inInterval: 'UNKNOWN' }, billing: { state: 'NOT_AVAILABLE', observedUsd: null, source: null, tolerance: null }, possiblyCharged: c.possiblyCharged });
  const u = c.usage; if (!u || u.usageCompleteness === 'MISSING') return unknown();
  const hint = typeof u.U === 'number' ? u.U : undefined; // tier by observed prompt length (R08: Anthropic counts cache reads/writes in the prompt length)
  const p = (cat: Parameters<PriceTable['micro']>[2]) => prices.micro(c.provider, c.model, cat, c.atUtc, hint);
  const by: Record<string, PicoUsd | 'UNKNOWN' | 'NOT_APPLICABLE'> = {};
  let total = 0n; let ok = true;
  const line = (name: string, count: Count, cat: Parameters<PriceTable['micro']>[2] | null) => {
    if (count === 'NOT_APPLICABLE') { by[name] = 'NOT_APPLICABLE'; return; }
    const n = num(count);
    // C157 9.2 (E2E-01): a MEASURED zero count costs zero whatever the price (the pilot models have no published cache price: null, never invented). A non-zero count with a null price stays UNKNOWN (=> STOP).
    if (n === 0n) { by[name] = '0'; return; }
    const price = cat ? p(cat) : null;
    if (n === null || price === null) { by[name] = 'UNKNOWN'; ok = false; return; }
    const v = n * price; by[name] = v.toString(); total += v;
  };
  line('inputUncached', u.inputUncached, 'input');
  line('cacheRead', u.cacheRead, 'input_cache_read');
  // writes: APIs that separate TTLs give 5m/1h; others give a single `cacheWrite` at the (single) write price
  // C3-PREP B-2: when the API gives the TOTAL write AND its 5m/1h split, each TTL is priced at its own price (before: the total at the 5m price, so a 1h write was under-priced).
  // Split inconsistent with the total, or a 1h part (> 0) whose price or 5m complement is unknown => UNKNOWN (=> STOP). Split absent (both UNKNOWN): unchanged (total at the single/5m write price).
  if (u.cacheWrite !== 'NOT_APPLICABLE') {
    const nT = num(u.cacheWrite); const n5 = num(u.cacheWrite5m); const n1 = num(u.cacheWrite1h);
    if (nT !== null && nT > 0n && (n1 !== null || n5 !== null) && !(n1 === null && n5 === nT) && !(n1 === 0n && n5 === null)) {
      const p5 = p('input_cache_write'); const p1 = p('input_cache_write_1h');
      if (n5 === null || n1 === null || n5 + n1 !== nT || (n5 > 0n && p5 === null) || (n1 > 0n && p1 === null)) { by['cacheWrite'] = 'UNKNOWN'; ok = false; }
      else { const v = n5 * (n5 > 0n ? p5! : 0n) + n1 * (n1 > 0n ? p1! : 0n); by['cacheWrite'] = v.toString(); total += v; }
    } else line('cacheWrite', u.cacheWrite, 'input_cache_write');
  } else { line('cacheWrite5m', u.cacheWrite5m, 'input_cache_write'); line('cacheWrite1h', u.cacheWrite1h, p('input_cache_write_1h') === null && u.cacheWrite1h === 0 ? 'input_cache_write' : 'input_cache_write_1h'); }
  line('outputVisible', u.outputVisible, 'output');
  const rs = REASONING_SEMANTICS[c.api];
  // categories are disjoint (contract §4): reasoning tokens are billed at the output price for every API; UNKNOWN reasoning => cost UNKNOWN
  line('reasoning', u.reasoning, 'output');
  // image/audio tokens are already inside the input counts of all three APIs (R08): no separate line
  by['imageUnits'] = 'NOT_APPLICABLE'; by['audioUnits'] = 'NOT_APPLICABLE';
  if (!ok) return { ...unknown(), byCategory: by };
  const cap = BigInt(c.capUsd);
  const capCovered = total <= cap;
  // cache interval (contract §5): lower = prefix read at cache-read price + rest at input; upper = all input at max(input, write)
  const U = num(u.U); const pIn = p('input'); const pRead = p('input_cache_read'); const pW = [p('input_cache_write') ?? 0n, p('input_cache_write_1h') ?? 0n, pIn ?? 0n].reduce((a, b) => (b > a ? b : a), 0n);
  const out = by['outputVisible'] !== undefined && by['outputVisible'] !== 'UNKNOWN' && by['outputVisible'] !== 'NOT_APPLICABLE' ? BigInt(by['outputVisible']) : null;
  const reasoningSep = typeof by['reasoning'] === 'string' && /^\d+$/.test(by['reasoning']) ? BigInt(by['reasoning']) : 0n;
  void rs;
  let cacheInterval: CostTable['cacheInterval'] = { lowerUsd: 'UNKNOWN', upperUsd: 'UNKNOWN', inInterval: 'UNKNOWN' };
  if (U !== null && pIn !== null && pRead !== null && out !== null && typeof c.prefixTokens === 'number') {
    const prefix = BigInt(Math.min(c.prefixTokens, Number(U)));
    const lower = prefix * pRead + (U - prefix) * pIn + out + reasoningSep;
    const upper = U * pW + out + reasoningSep;
    cacheInterval = { lowerUsd: lower.toString(), upperUsd: upper.toString(), inInterval: total >= lower && total <= upper };
  }
  return { schema: H2EVAL_SCHEMA.cost, usd: total.toString(), state: 'CALCULATED', byCategory: by, priceSnapshotSha256: prices.sha256, capCovered, cacheInterval, billing: { state: 'NOT_AVAILABLE', observedUsd: null, source: null, tolerance: null }, possiblyCharged: c.possiblyCharged };
}
