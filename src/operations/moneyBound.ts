/**
 * D1–D8 / S4 + fechamento pós-S5 (RV2-04) — strict money ceiling: which requests have a defensible
 * upper bound of cost (audit ABC-04, D7 §9; distinct from the flexible CU quota).
 *
 * A tenant with at least one money budget (own or shared) is in strict mode: a request reaches
 * the provider only if ALL of the following hold, otherwise it is refused BEFORE the upstream:
 *  1. (provider, api, requested model) is listed in the policy, with the exact set of models the
 *     provider may return for it; the reservation is the worst case over that whole set;
 *  2. every top-level body field is in the API's allowlist: fields that add cost outside the
 *     token model or change the documented limits (tools and their system prompt, server tools,
 *     cache writes, thinking, inference geography, service tiers, ...) are refused, and so are
 *     forwarded provider-namespaced headers other than the API version (betas can change limits);
 *  3. the input is text only, without cache_control;
 *  4. the requested output limit is at most the model's documented maximum output;
 *  5. the frozen price table prices input and output of every returned model of the set.
 * Bound (policy v2): input tokens ≤ the model's documented context window (the API refuses a
 * request whose input alone exceeds it), priced at the HIGHEST input-side tariff of the frozen table;
 * output tokens ≤ max_tokens, priced at the highest output-side tariff. No byte count, estimate or
 * local tokenizer enters the bound. Sources, date and assumptions: docs/_ops/.../FECHAMENTO_POS_S5/
 * RV2-04_LIMITE_MONETARIO.md. The reservation is large on purpose (≈ US$ 0.25 for Haiku 4.5 at
 * max_tokens 1024), which restricts how many calls fit under a ceiling.
 * At settlement (PgOperationStore) a returned model outside the set (in a final usage, or in a
 * partial usage written when the stream was cut — S5 AUD-1), or a cost above the reserved worst
 * case (complete quote, or the known subtotal of a partial quote — S5 AUD-2), freezes every budget
 * of the operation: the guarantee no longer holds, so nothing else is admitted until an operator
 * reviews it. The observed cost is recorded as is (never truncated). Detection after the fact does
 * not undo spend; the bound holds only while the provider charges per its published rules.
 *
 * Pure data and checks (no I/O). The policy of an instance is chosen at startup in `bootstrapD1D8.ts`
 * (OTK_MONEY_BOUND_POLICY); {@link assessMoneyBound} is called by `proxyDurable.ts` before admission, and
 * the settlement helpers by `PgOperationStore.ts`. Model limits and source URLs are data recorded on the
 * dates stated in each `docRef`; they are not refreshed automatically.
 *
 * @module src/operations/moneyBound
 */
import type { PricingTerms, UsageApi } from '../types/d1d8/index.js';

/** One bounded-cost entry: a (provider, api, requested model) and the documented limits that bound its cost. */
export interface MoneyBoundRule {
  /** Provider id (lower case). */
  provider: string;
  api: UsageApi;
  /** Requested model id (lower case). */
  model: string;
  /** Every model id the provider may report for this request (lower case), incl. dated snapshots. */
  returnedModels: string[];
  /** Documented context window of the model (tokens): bounds the billable input of one request. */
  contextWindowTokens: bigint;
  /** Documented maximum output tokens of one synchronous request. */
  maxOutputTokens: bigint;
  /** Official sources of the alias → snapshot relation and of the two limits, with date. */
  docRef: string;
  /** v4: tariff assumptions frozen into the admitted operation's limits (checked at settlement). */
  pricingTerms?: PricingTerms;
  /**
   * v5: Gemini thinking control the request must carry. 'level_minimal' (Gemini 3.x, which cannot turn thinking fully
   * off): generationConfig.thinkingConfig = { thinkingLevel: "minimal" } exactly; the bound still holds because the
   * documented maxOutputTokens caps thought + response tokens, priced at the output tariff. Absent: the v4 rule
   * (pricingTerms.thinking 'off' → thinkingBudget 0).
   */
  geminiThinking?: 'level_minimal';
}

/** A published, versioned set of bounded-cost rules; an instance applies exactly one. */
export interface MoneyBoundPolicy {
  /** Policy id with its publication date, e.g. `otk.money_bound_policy.v2@2026-10-02`. */
  id: string;
  /** Rules; a request matching none is refused in strict mode. */
  rules: MoneyBoundRule[];
  /**
   * v4: top-level fields this policy accepts on top of the API's base allowlist, each with the only values
   * accepted (e.g. OpenAI `service_tier` only "default"). v2/v3 have none, so their admissions are unchanged.
   */
  extraFields?: Partial<Record<UsageApi, Readonly<Record<string, readonly unknown[]>>>>;
}

/** Top-level body fields that do not add cost beyond input/output tokens of the listed model. */
const ALLOWED_FIELDS: Partial<Record<UsageApi, ReadonlySet<string>>> = {
  'anthropic.messages': new Set(['model', 'max_tokens', 'messages', 'system', 'stream', 'temperature', 'top_p', 'top_k', 'stop_sequences', 'metadata']),
  // policy v3: n (several completions) is refused upstream of this check; tools, audio/modalities, prediction,
  // service_tier, store, reasoning options and response formats are left out on purpose
  'openai.chat_completions': new Set(['model', 'messages', 'max_tokens', 'max_completion_tokens', 'stream', 'stream_options', 'temperature', 'top_p', 'stop', 'seed', 'presence_penalty', 'frequency_penalty']),
  // policy v4 (Gemini generateContent): only the text conversation and the generation config; tools, toolConfig,
  // cachedContent (paid cache storage), serviceTier and safety settings are left out on purpose. The nested
  // content of each allowed field is checked by assessGeminiBody.
  'gemini.generate_content': new Set(['model', 'contents', 'systemInstruction', 'generationConfig']),
};

/** Gemini generationConfig keys that do not add cost beyond text tokens of one candidate. */
const GEMINI_GENERATION_CONFIG = new Set(['maxOutputTokens', 'temperature', 'topP', 'topK', 'stopSequences', 'candidateCount', 'seed', 'presencePenalty', 'frequencyPenalty', 'thinkingConfig']);

/**
 * Nested check of a Gemini body (policy v4). Content = { role?: 'user'|'model', parts: [{ text: string }] }; any
 * other part (inlineData, fileData, function calls/responses, code execution, thought, thoughtSignature,
 * videoMetadata, ...) is outside the text scope. Thinking must be explicitly off (thinkingBudget 0): the
 * reservation prices maxOutputTokens of visible output only. Returns the reason for refusal, or null.
 *
 * @param body - Parsed request body.
 * @param rule - The matched rule (its thinking requirement is applied).
 * @returns Refusal reason, or `null` when the body is inside the bounded scope.
 */
function assessGeminiBody(body: Record<string, unknown>, rule: MoneyBoundRule): string | null {
  const terms = rule.pricingTerms;
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const content = (c: unknown, where: string): string | null => {
    if (!isObj(c)) return `${where} must be an object`;
    for (const k of Object.keys(c)) if (k !== 'role' && k !== 'parts') return `${where}.${k} is outside the bounded scope`;
    if (c['role'] !== undefined && c['role'] !== 'user' && c['role'] !== 'model') return `${where}.role ${JSON.stringify(c['role'])} is outside the bounded scope`;
    const parts = c['parts'];
    if (!Array.isArray(parts) || parts.length === 0) return `${where}.parts must be a non-empty array`;
    for (let i = 0; i < parts.length; i++) {
      const p = parts[i];
      if (!isObj(p)) return `${where}.parts[${i}] must be an object`;
      const keys = Object.keys(p);
      if (keys.length !== 1 || keys[0] !== 'text' || typeof p['text'] !== 'string') {
        const other = keys.find((k) => k !== 'text') ?? 'text';
        return `${where}.parts[${i}].${other} is outside the bounded scope (text parts only)`;
      }
    }
    return null;
  };
  const contents = body['contents'];
  if (!Array.isArray(contents) || contents.length === 0) return 'contents must be a non-empty array';
  for (let i = 0; i < contents.length; i++) { const r = content(contents[i], `contents[${i}]`); if (r) return r; }
  if (body['systemInstruction'] !== undefined) { const r = content(body['systemInstruction'], 'systemInstruction'); if (r) return r; }
  const gc = body['generationConfig'];
  if (gc !== undefined && !isObj(gc)) return 'generationConfig must be an object';
  for (const k of Object.keys(gc ?? {})) if (!GEMINI_GENERATION_CONFIG.has(k)) return `generationConfig.${k} may add cost outside the token bound`;
  if (rule.geminiThinking === 'level_minimal') {
    const tc = isObj(gc) ? gc['thinkingConfig'] : undefined;
    if (!isObj(tc)) return 'generationConfig.thinkingConfig.thinkingLevel must be "minimal" for this model';
    for (const k of Object.keys(tc)) if (k !== 'thinkingLevel') return `generationConfig.thinkingConfig.${k} is outside the bounded scope`;
    if (tc['thinkingLevel'] !== 'minimal' && tc['thinkingLevel'] !== 'MINIMAL') return 'generationConfig.thinkingConfig.thinkingLevel must be "minimal" for this model';
  } else if (terms?.thinking === 'off') {
    const tc = isObj(gc) ? gc['thinkingConfig'] : undefined;
    if (!isObj(tc)) return 'generationConfig.thinkingConfig.thinkingBudget must be 0 (thinking off) for this model';
    for (const k of Object.keys(tc)) if (k !== 'thinkingBudget') return `generationConfig.thinkingConfig.${k} is outside the bounded scope`;
    if (tc['thinkingBudget'] !== 0) return 'generationConfig.thinkingConfig.thinkingBudget must be 0 (thinking off) for this model';
  }
  return null;
}

/** Forwarded headers in a provider namespace that may change limits or billing (only the version is allowed). */
const PROVIDER_HEADER = /^(anthropic-|openai-|x-goog-)/;
const ALLOWED_PROVIDER_HEADERS: ReadonlySet<string> = new Set(['anthropic-version']);

const HAIKU45_SOURCES = 'https://platform.claude.com/docs/en/about-claude/models/overview (alias claude-haiku-4-5 → claude-haiku-4-5-20251001; context window 200K; max output 64K) and '
  + 'https://platform.claude.com/docs/en/build-with-claude/context-windows (input alone above the window → 400; output and every input category count toward the window), consulted 2026-10-02';

/**
 * Policy v2: the paid pilot scope (Anthropic Messages, Claude Haiku 4.5), bounded by the model's
 * documented limits. Prices: scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json.
 */
export const MONEY_BOUND_POLICY_V2: MoneyBoundPolicy = Object.freeze({
  id: 'otk.money_bound_policy.v2@2026-10-02',
  rules: [
    {
      provider: 'anthropic', api: 'anthropic.messages', model: 'claude-haiku-4-5',
      returnedModels: ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
      contextWindowTokens: 200_000n, maxOutputTokens: 64_000n, docRef: HAIKU45_SOURCES,
    },
    {
      provider: 'anthropic', api: 'anthropic.messages', model: 'claude-haiku-4-5-20251001',
      returnedModels: ['claude-haiku-4-5-20251001'],
      contextWindowTokens: 200_000n, maxOutputTokens: 64_000n, docRef: HAIKU45_SOURCES,
    },
  ],
}) as MoneyBoundPolicy;

const GPT4O_MINI_SOURCES = 'https://developers.openai.com/api/docs/models/gpt-4o-mini (snapshot gpt-4o-mini-2024-07-18; context window 128,000; max output 16,384) '
  + 'and https://developers.openai.com/api/docs/pricing (Standard tier), consulted 2026-10-03';

/**
 * Policy v3 (PILOTO_V3 OpenAI): v2 unchanged plus OpenAI Chat Completions with gpt-4o-mini. Opt-in per instance
 * (OTK_MONEY_BOUND_POLICY); v2 stays the default, so budgets that require v2 keep their admissions.
 */
export const MONEY_BOUND_POLICY_V3: MoneyBoundPolicy = Object.freeze({
  id: 'otk.money_bound_policy.v3@2026-10-03',
  rules: [
    ...MONEY_BOUND_POLICY_V2.rules,
    {
      provider: 'openai', api: 'openai.chat_completions', model: 'gpt-4o-mini',
      returnedModels: ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18'],
      contextWindowTokens: 128_000n, maxOutputTokens: 16_384n, docRef: GPT4O_MINI_SOURCES,
    },
    {
      provider: 'openai', api: 'openai.chat_completions', model: 'gpt-4o-mini-2024-07-18',
      returnedModels: ['gpt-4o-mini-2024-07-18'],
      contextWindowTokens: 128_000n, maxOutputTokens: 16_384n, docRef: GPT4O_MINI_SOURCES,
    },
  ],
}) as MoneyBoundPolicy;

const GEMINI25_FLASH_LITE_SOURCES = 'https://ai.google.dev/gemini-api/docs/models/gemini-2.5-flash-lite (model code gemini-2.5-flash-lite, Stable; '
  + 'input token limit 1,048,576; output token limit 65,536), https://ai.google.dev/gemini-api/docs/generate-content/thinking (2.5 Flash Lite: model '
  + 'does not think by default; thinkingBudget = 0 disables thinking; maxOutputTokens includes thought tokens), '
  + 'https://ai.google.dev/api/generate-content (serviceTier unspecified = standard; usageMetadata.serviceTier) and '
  + 'https://ai.google.dev/gemini-api/docs/pricing (Standard paid tier), consulted 2026-10-03 (FECHAMENTO_GEMINI_AD/fontes)';

/**
 * Policy v4 (FECHAMENTO_GEMINI_AD): v3 unchanged plus Gemini generateContent/streamGenerateContent with
 * gemini-2.5-flash-lite (text only, one candidate, thinking explicitly off, Standard tier), and OpenAI's
 * `service_tier` accepted only as "default" (the OTK itself sends "default" when the client omits it). Every
 * OpenAI and Gemini admission freezes its tariff assumptions (pricingTerms). Opt-in per instance.
 */
export const MONEY_BOUND_POLICY_V4: MoneyBoundPolicy = Object.freeze({
  id: 'otk.money_bound_policy.v4@2026-10-03',
  rules: [
    ...MONEY_BOUND_POLICY_V3.rules.map((r) => (r.provider === 'openai' ? { ...r, pricingTerms: { serviceTier: 'default' } } : r)),
    {
      provider: 'gemini', api: 'gemini.generate_content', model: 'gemini-2.5-flash-lite',
      returnedModels: ['gemini-2.5-flash-lite'],
      contextWindowTokens: 1_048_576n, maxOutputTokens: 65_536n, docRef: GEMINI25_FLASH_LITE_SOURCES,
      pricingTerms: { serviceTier: 'standard', thinking: 'off' },
    },
  ],
  extraFields: { 'openai.chat_completions': { service_tier: ['default'] } },
}) as MoneyBoundPolicy;

const GEMINI35_FLASH_LITE_SOURCES = 'https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite (model code gemini-3.5-flash-lite, Stable; '
  + 'input token limit 1,048,576; output token limit 65,536), https://ai.google.dev/gemini-api/docs/generate-content/thinking (Gemini 3 Flash and '
  + 'Flash-Lite do not support full thinking-off; minimal is the default for 3.5 Flash-Lite; maxOutputTokens includes thought tokens) and '
  + 'https://ai.google.dev/gemini-api/docs/pricing (Standard paid tier: input $0.30, output incl. thinking $2.50), consulted 2026-10-04 '
  + '(FECHAMENTO_GEMINI_AD/fontes_20261004)';

/**
 * Policy v5 (FECHAMENTO_GEMINI_AD, author decision 2026-10-04 after gemini-2.5-flash-lite was closed to the account):
 * v4 unchanged plus gemini-3.5-flash-lite (text only, one candidate, thinkingLevel "minimal" explicit, Standard tier).
 * Thinking cannot be turned off on this model; the reservation covers it because maxOutputTokens caps thought +
 * response tokens (documented) and thoughts are priced at the output tariff. Opt-in per instance.
 */
export const MONEY_BOUND_POLICY_V5: MoneyBoundPolicy = Object.freeze({
  id: 'otk.money_bound_policy.v5@2026-10-04',
  rules: [
    ...MONEY_BOUND_POLICY_V4.rules,
    {
      provider: 'gemini', api: 'gemini.generate_content', model: 'gemini-3.5-flash-lite',
      returnedModels: ['gemini-3.5-flash-lite'],
      contextWindowTokens: 1_048_576n, maxOutputTokens: 65_536n, docRef: GEMINI35_FLASH_LITE_SOURCES,
      pricingTerms: { serviceTier: 'standard' }, geminiThinking: 'level_minimal',
    },
  ],
  extraFields: MONEY_BOUND_POLICY_V4.extraFields,
}) as MoneyBoundPolicy;

/** Policy applied by default (budgets created without an explicit money_policy require it: migration 151). */
export const MONEY_BOUND_POLICY: MoneyBoundPolicy = MONEY_BOUND_POLICY_V2;

/** Every published policy, by id (an instance applies exactly one). */
export const MONEY_BOUND_POLICIES: Readonly<Record<string, MoneyBoundPolicy>> = Object.freeze({
  [MONEY_BOUND_POLICY_V2.id]: MONEY_BOUND_POLICY_V2,
  [MONEY_BOUND_POLICY_V3.id]: MONEY_BOUND_POLICY_V3,
  [MONEY_BOUND_POLICY_V4.id]: MONEY_BOUND_POLICY_V4,
  [MONEY_BOUND_POLICY_V5.id]: MONEY_BOUND_POLICY_V5,
});

/**
 * Outcome of {@link assessMoneyBound}: accepted with the matching rule and the input bound (tokens = the
 * model's context window), or refused with a human-readable reason (no secrets, no prompt content).
 */
export type MoneyBoundDecision =
  | { ok: true; rule: MoneyBoundRule; policyId: string; inputBoundTokens: bigint; pricingTerms?: PricingTerms }
  | { ok: false; reason: string };

// Walks the messages/system value; returns the first non-text marker found, or null. Depth-capped against hostile nesting.
function hasNonText(v: unknown, depth = 0): string | null {
  if (depth > 32) return 'content nested too deeply';
  if (v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) { for (const x of v) { const r = hasNonText(x, depth + 1); if (r) return r; } return null; }
  const o = v as Record<string, unknown>;
  if ('cache_control' in o) return 'cache_control';
  // a message may reference earlier audio output by id (OpenAI): not text, outside the token bound
  if ('audio' in o) return 'audio';
  const t = typeof o['type'] === 'string' ? (o['type'] as string) : '';
  if (t && t !== 'text') return `content type ${t}`;
  for (const x of Object.values(o)) { const r = hasNonText(x, depth + 1); if (r) return r; }
  return null;
}

/**
 * Strict-mode admission check (pure). `headers` are the request headers that would be forwarded.
 *
 * Provider and model are compared trimmed and lower-cased.
 *
 * @param policy - The instance's money-bound policy.
 * @param a - Provider, API, requested model, parsed request body, effective output limit (tokens) and the
 *   names of headers that would be forwarded.
 * @returns `{ ok: true, ... }` when every condition in the file header holds, otherwise `{ ok: false, reason }`.
 */
export function assessMoneyBound(policy: MoneyBoundPolicy, a: {
  provider: string; api: UsageApi; model: string; body: Record<string, unknown>; maxOutputTokens: bigint; headers?: readonly string[];
}): MoneyBoundDecision {
  const p = a.provider.trim().toLowerCase();
  const m = a.model.trim().toLowerCase();
  const rule = policy.rules.find((r) => r.provider === p && r.api === a.api && r.model === m);
  if (!rule) return { ok: false, reason: `no bounded-cost rule for ${p}/${a.api}/${m} in ${policy.id}` };
  const allowed = ALLOWED_FIELDS[a.api];
  if (!allowed) return { ok: false, reason: `api ${a.api} has no field allowlist` };
  const extra = policy.extraFields?.[a.api] ?? {};
  for (const k of Object.keys(a.body)) {
    if (allowed.has(k)) continue;
    if (Object.hasOwn(extra, k)) {
      if (!extra[k]!.includes(a.body[k])) return { ok: false, reason: `field ${k}=${JSON.stringify(a.body[k])} is outside the bound (accepted: ${extra[k]!.map((v) => JSON.stringify(v)).join(', ')})` };
      continue;
    }
    return { ok: false, reason: `field ${k} may add cost outside the token bound` };
  }
  for (const h of a.headers ?? []) {
    const n = h.toLowerCase();
    if (PROVIDER_HEADER.test(n) && !ALLOWED_PROVIDER_HEADERS.has(n)) return { ok: false, reason: `header ${n} may change limits or billing outside the bound` };
  }
  if (a.api === 'gemini.generate_content') {
    const r = assessGeminiBody(a.body, rule);
    if (r) return { ok: false, reason: r };
  } else {
    const nonText = hasNonText(a.body['messages']) ?? hasNonText(a.body['system']);
    if (nonText) return { ok: false, reason: `${nonText} is outside the bounded scope` };
  }
  if (a.maxOutputTokens <= 0n || a.maxOutputTokens > rule.maxOutputTokens) {
    return { ok: false, reason: `max output ${a.maxOutputTokens} outside 1..${rule.maxOutputTokens} documented for ${m}` };
  }
  return { ok: true, rule, policyId: policy.id, inputBoundTokens: rule.contextWindowTokens, ...(rule.pricingTerms ? { pricingTerms: rule.pricingTerms } : {}) };
}

/**
 * Whether a reported service tier matches the admitted one (Gemini's documented default 'unspecified' is Standard).
 *
 * @param expected - Tier frozen at admission (lower case).
 * @param reported - Tier reported in the usage; a `SERVICE_TIER_` prefix and case are ignored.
 * @returns `false` when nothing was reported.
 */
export function serviceTierMatches(expected: string, reported: string | null | undefined): boolean {
  if (reported === null || reported === undefined) return false;
  const r = reported.trim().toLowerCase().replace(/^service_tier_/, '');
  const e = expected.toLowerCase();
  return r === e || (e === 'standard' && r === 'unspecified');
}

/**
 * Whether the model the provider reported is one the reservation covered.
 *
 * @param allowed - Lower-case models covered by the reservation; `undefined` = no restriction (not strict mode).
 * @param returned - Model reported by the provider, or `null` when not reported.
 * @returns `true` when unrestricted or the trimmed, lower-cased model is in the list; `false` when not reported.
 */
export function returnedModelAllowed(allowed: readonly string[] | undefined, returned: string | null): boolean {
  if (!allowed) return true;
  if (returned === null) return false;
  return allowed.includes(returned.trim().toLowerCase());
}
