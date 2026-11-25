/**
 * PILOTO_V3 — what the canonical budget ledger may be settled with after one call.
 *
 * Only a usage the PROVIDER reported for the whole response settles a reservation:
 *  - the client saw the complete response (full JSON, or the stream up to message_stop, no deliberate
 *    disconnect): the provider's usage object exactly as received;
 *  - otherwise (e.g. after a deliberate disconnect only the server saw the end): the OTK categories, and
 *    only when the OTK measured the operation as `final` and settled its money.
 * Anything else settles nothing (usage null), so the ledger keeps the reservation as uncertain. Categories
 * are never filled in: an absent count stays absent, and the ledger prices absent as unknown, not zero.
 * The HTTP status is the one the client observed, never assumed.
 * OpenAI Chat Completions reports cached tokens INSIDE prompt_tokens; the ledger is priced per disjoint
 * category, so it receives input = prompt − cached and cache_read = cached (OpenAI bills no cache write:
 * 0 by its published tariff). A missing cached_tokens leaves the usage unknown, never zero.
 * Gemini (FECHAMENTO_GEMINI_AD): usageMetadata → input = prompt − cached, cache_read = cached, output = candidates +
 * thoughts (thinking billed as output). The API omits zero-valued counts (proto3 JSON), so an omitted cached/thoughts
 * count is 0 and an omitted candidatesTokenCount is total − prompt − thoughts; anything malformed or inconsistent with
 * the documented total leaves the usage unknown (geminiRaw in runPilotV3.ts applies the same rule to the oracle).
 *
 * Pure functions (no I/O). Used by `runPilotV3.ts`; the result is passed to `BudgetLedger.settle` in
 * `budgetLedger.ts`. Covered by `test/unit/pilot_v3_settlement.test.ts`.
 *
 * @module scripts/pilot/anthropic/pilotV3Settlement
 */
import type { ProviderUsage } from './budgetLedger.js';

/** Provider whose usage shape is being mapped. */
export type SettlementProvider = 'anthropic' | 'openai' | 'gemini';

/** What is known about one pilot call when it is settled. */
export interface SettlementInput {
  /** default anthropic (Messages usage shape) */
  provider?: SettlementProvider;
  /** HTTP status the client observed; `undefined` when no response arrived. */
  httpStatus: number | undefined;
  /** the client saw the whole response and did not disconnect on purpose */
  clientComplete: boolean;
  /** Provider usage object as the client received it, in the provider's own field names; null/undefined if none. */
  clientUsage: Record<string, unknown> | null | undefined;
  /** OTK's measurement state for the operation (only `'final'` is used). */
  otkMeasurement: string | null;
  /** OTK's money state for the operation (only `'settled'` is used). */
  otkMoneyState: string | null;
  /** OTK token categories with decimal-string counts; a null/undefined count means "not measured". */
  otkCategories: ReadonlyArray<{ name: string; count: string | null | undefined }> | null;
}

/** Where the settlement usage came from; `'none'` means nothing settles and the reservation stays uncertain. */
export type SettlementSource = 'provider_response' | 'otk_final_measurement' | 'none';

/**
 * Decides which usage (if any) may settle the ledger reservation of one call (rules in the module comment).
 *
 * @param s - What the client and OTK observed.
 * @returns The observed HTTP status, the usage in ledger (Anthropic) field names or `null`, and its source.
 */
export function settlementFor(s: SettlementInput): { httpStatus: number | undefined; usage: ProviderUsage | null; source: SettlementSource } {
  if (s.httpStatus !== 200) return { httpStatus: s.httpStatus, usage: null, source: 'none' };
  const openai = s.provider === 'openai';
  const gemini = s.provider === 'gemini';
  if (s.clientComplete && s.clientUsage) {
    return { httpStatus: 200, usage: openai ? fromOpenAiUsage(s.clientUsage) : gemini ? fromGeminiUsage(s.clientUsage) : { ...s.clientUsage } as ProviderUsage, source: 'provider_response' };
  }
  if (s.otkMeasurement !== 'final' || s.otkMoneyState !== 'settled') return { httpStatus: 200, usage: null, source: 'none' };
  const count = (name: string): number | undefined => {
    const c = s.otkCategories?.find((x) => x.name === name);
    return c && c.count !== null && c.count !== undefined ? Number(c.count) : undefined;
  };
  if (gemini) {
    // OTK categories: cache read absent = not reported (0 by proto3 omission); reasoning absent = 0 likewise
    const input = count('input'); const cached = count('input_cache_read') ?? 0; const out = count('output'); const thoughts = count('output_reasoning') ?? 0;
    return {
      httpStatus: 200,
      usage: { input_tokens: carve(input, cached), output_tokens: out === undefined ? undefined : out + thoughts, cache_creation_input_tokens: 0, cache_read_input_tokens: cached },
      source: 'otk_final_measurement',
    };
  }
  if (openai) {
    const input = count('input'); const cached = count('input_cache_read');
    return {
      httpStatus: 200,
      usage: { input_tokens: carve(input, cached), output_tokens: count('output'), cache_creation_input_tokens: 0, cache_read_input_tokens: cached },
      source: 'otk_final_measurement',
    };
  }
  return {
    httpStatus: 200,
    usage: { input_tokens: count('input'), output_tokens: count('output'), cache_creation_input_tokens: count('input_cache_write'), cache_read_input_tokens: count('input_cache_read') },
    source: 'otk_final_measurement',
  };
}

/**
 * OpenAI Chat Completions usage → disjoint ledger categories (cached tokens are a subset of prompt_tokens).
 *
 * @param u - OpenAI `usage` object.
 * @returns Ledger usage; input is `undefined` (unknown) when `prompt_tokens` or `cached_tokens` is missing or cached
 *   exceeds the prompt; cache creation is always 0.
 */
export function fromOpenAiUsage(u: Record<string, unknown>): ProviderUsage {
  const num = (v: unknown) => (typeof v === 'number' ? v : undefined);
  const prompt = num(u['prompt_tokens']);
  const details = u['prompt_tokens_details'] as Record<string, unknown> | null | undefined;
  const cached = num(details?.['cached_tokens']);
  return {
    input_tokens: carve(prompt, cached),
    output_tokens: num(u['completion_tokens']),
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  };
}

/**
 * Gemini usageMetadata → disjoint ledger categories (rule in the header; unknown fields stay undefined).
 *
 * @param u - Gemini `usageMetadata` object.
 * @returns Ledger usage; every count except cache creation is `undefined` when a field is malformed, tool-use
 *   prompt tokens are present, or the parts do not add up to `totalTokenCount`.
 */
export function fromGeminiUsage(u: Record<string, unknown>): ProviderUsage {
  const n = (v: unknown): number | null | undefined => (v === undefined ? undefined : typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
  const unknown: ProviderUsage = { input_tokens: undefined, output_tokens: undefined, cache_creation_input_tokens: 0, cache_read_input_tokens: undefined };
  const prompt = n(u['promptTokenCount']); const total = n(u['totalTokenCount']); const cached = n(u['cachedContentTokenCount']);
  const thoughts = n(u['thoughtsTokenCount']); let cand = n(u['candidatesTokenCount']); const tool = n(u['toolUsePromptTokenCount']);
  if (prompt == null || total == null || cached === null || thoughts === null || cand === null || tool === null || (tool ?? 0) > 0) return unknown;
  const c0 = cached ?? 0; const t0 = thoughts ?? 0;
  if (cand === undefined) cand = total - prompt - t0;
  if (cand < 0 || c0 > prompt || prompt + cand + t0 !== total) return unknown;
  return { input_tokens: prompt - c0, output_tokens: cand + t0, cache_creation_input_tokens: 0, cache_read_input_tokens: c0 };
}

/**
 * prompt − cached, or unknown when either is missing or cached exceeds the prompt (malformed usage)
 *
 * @param prompt - Prompt tokens including cached ones.
 * @param cached - Cached prompt tokens.
 * @returns Uncached input tokens, or `undefined`.
 */
function carve(prompt: number | undefined, cached: number | undefined): number | undefined {
  return prompt !== undefined && cached !== undefined && cached <= prompt ? prompt - cached : undefined;
}
