/**
 * MET-02 integration point (INTERFACES.md §9): `ADAPTERS: Record<UsageApi, ProviderAdapter>` for the three APIs of the matrix,
 * built on the pure builders/parsers of ./adapters/*. Also re-exports the price table, cost engine and ex ante estimators.
 * Nothing here does I/O, reads env or logs.
 */
import { createHash } from 'node:crypto';
import type { UsageApi, ModelSupport } from '../../../src/types/d1d8/index.js';
import { modelDeprecationOf } from './contract_r2.js';
import { resolveModelSupport } from '../../../src/providers/catalog/modelCatalog.js';
import { extractInputText } from '../../../src/tokenization/localCounter.js';
import type { BuiltRequest, Count, NormalizedUsageH2, OperationPlan, ParsedRefusal, ProviderAdapter, ResolvedContent, ResolvedPart } from './interfaces_v0.js';
import type { CanonicalUsage, ParsedResponse, Count as CountBig, MatrixModel } from './types.js';
import { H2EVAL_MODAL_VERSION } from './types.js';
import { cacheObserved } from './canonical.js';
import { buildOpenAiChatRequest, parseOpenAiChatResponse, type OpenAiUserPart } from './adapters/openai_chat.js';
import { buildAnthropicMessagesRequest, parseAnthropicMessagesResponse, type AnthropicUserPart } from './adapters/anthropic_messages.js';
import { buildGoogleGenerateContentRequest, parseGoogleGenerateContentResponse, type GoogleUserPart } from './adapters/google_generate_content.js';

export { H2EVAL_MODAL_VERSION } from './types.js';
export * from './adapters/index.js';
export { loadPriceTable, computeCost, costCap, PRICE_TABLE_PATH } from './pricing/pricing.js';
export { estimateExAnte, estimateTextTokens, estimateOpenAiImageTokens, estimateAnthropicImageTokens, readPngSize } from './estimators/index.js';

/** Official API hosts (documentation: anthropic/messages-create.html shows `https://api.anthropic.com/v1/messages`; OpenAI and Google as published in their API references). The core enforces its own allowlist on top. */
export const OFFICIAL_HOSTS = Object.freeze({ openai: ['api.openai.com'], anthropic: ['api.anthropic.com'], google: ['generativelanguage.googleapis.com'] });

export class AdapterError extends Error { constructor(public readonly code: string, msg: string) { super(`${code}: ${msg}`); } }
const MATRIX = new Set<string>(['gpt-4o-mini-2024-07-18', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'gemini-3.5-flash-lite']);
const deprecationOf = (m: string) => (MATRIX.has(m) ? modelDeprecationOf(m as MatrixModel).modelDeprecation : 'UNKNOWN' as const);
/** rev. 2 `params.thinking` wins over the v0 `reasoning` record when both are present (they must agree; the plan is the pre-registered source). */
function reasoningFromPlan(plan: OperationPlan): Record<string, string | number | boolean> | 'NONE' {
  const t = plan.params.thinking;
  if (!t) return plan.params.reasoning;
  if (t.mode === 'omit') { hParityOf(plan); return 'NONE'; } // EXEC-ECON item 1: nothing about reasoning is sent (the H_PARITY branch of each adapter omits every key)
  const fromThinking: Record<string, string | number | boolean> | 'NONE' = t.mode === 'none' ? 'NONE' : t.mode === 'adaptive' ? { effort: t.effort ?? 'low' } : t.mode === 'manual' ? { budget_tokens: t.budgetTokens ?? 0 } : { thinking_level: t.thinkingLevel ?? 'minimal' };
  if (plan.params.reasoning !== 'NONE' || fromThinking !== 'NONE') { if (JSON.stringify(plan.params.reasoning) !== JSON.stringify(fromThinking) && plan.params.reasoning !== 'NONE') throw new AdapterError('H2EVAL_PARAM_CONFLICT', `params.thinking ${JSON.stringify(t)} disagrees with params.reasoning ${JSON.stringify(plan.params.reasoning)}`); }
  return fromThinking;
}

/**
 * EXEC-ECON C160 (delta v3.1 items 1, 2, 10): the H_PARITY body profile = the body the H path (BOT-02 clients, protocol §2.1) sends.
 *   Anthropic {model, max_tokens, messages, system} (+ stream:false, service_tier:"standard_only": DIFERE_DE_H, declared);
 *   OpenAI    {model, messages, max_completion_tokens, n:1, stream:false, store:false} (+ service_tier:"default": DIFERE_DE_H, declared);
 *   Google    {contents, generationConfig:{maxOutputTokens, candidateCount:1}, systemInstruction}.
 * Nothing of sampling, reasoning (thinking / output_config / reasoning_effort / thinkingConfig), tools or cache is sent (H-2 (i)).
 * The profile and thinking.mode 'omit' come TOGETHER (one without the other is refused); temperature DEFAULT, reasoning NONE and cacheDirectives NONE are required.
 * Absent profile: every legacy body is byte for byte unchanged.
 */
export const H_PARITY_MODELS: Readonly<Record<string, 'anthropic' | 'openai' | 'google'>> = Object.freeze({ 'claude-sonnet-5': 'anthropic', 'claude-opus-5-5': 'anthropic', 'claude-haiku-5-5': 'anthropic', 'gpt-6-luna': 'openai', 'gemini-3.1-flash-lite': 'google' });
export function hParityOf(plan: OperationPlan): boolean {
  const prof = plan.params.bodyProfile; const omit = plan.params.thinking?.mode === 'omit';
  if (prof === undefined && !omit) return false;
  if (prof !== 'H_PARITY' || !omit) throw new AdapterError('H2EVAL_PARAM_CONFLICT', `bodyProfile ${String(prof)} and thinking.mode ${String(plan.params.thinking?.mode)}: H_PARITY and 'omit' go together`);
  if (plan.params.reasoning !== 'NONE') throw new AdapterError('H2EVAL_PARAM_CONFLICT', 'H_PARITY: params.reasoning must be NONE (nothing sent)');
  if (plan.params.temperature !== 'DEFAULT') throw new AdapterError('H2EVAL_PARAM_CONFLICT', 'H_PARITY: no sampling parameter is sent (temperature must be DEFAULT)');
  if (plan.params.cacheDirectives !== 'NONE') throw new AdapterError('H2EVAL_PARAM_CONFLICT', 'H_PARITY: no cache directive is sent');
  if (H_PARITY_MODELS[plan.modelRequested] === undefined) throw new AdapterError('H2EVAL_MODEL_NOT_IN_MATRIX', `H_PARITY: ${plan.modelRequested} is not an ECON model`);
  return true;
}

const toNum = (c: CountBig): Count => (typeof c === 'bigint' ? Number(c) : c);
const numbersOnly = (r: Record<string, number | null>): Record<string, number> => Object.fromEntries(Object.entries(r).filter((kv): kv is [string, number] => typeof kv[1] === 'number'));

function toH2(p: ParsedResponse): NormalizedUsageH2 {
  const u: CanonicalUsage = p.usage;
  const add = (...xs: CountBig[]): CountBig => { let s = 0n; for (const x of xs) { if (x === 'NOT_APPLICABLE') continue; if (typeof x !== 'bigint') return 'UNKNOWN'; s += x; } return s; };
  const writes: CountBig = typeof u.cacheWrite5m === 'bigint' && typeof u.cacheWrite1h === 'bigint' ? u.cacheWrite5m + u.cacheWrite1h : u.cacheWrite;
  const U = add(u.inputUncached, u.cacheRead, writes);
  return {
    schema: 'h2eval.usage.v0',
    inputUncached: toNum(u.inputUncached), cacheRead: toNum(u.cacheRead), cacheWrite5m: toNum(u.cacheWrite5m), cacheWrite1h: toNum(u.cacheWrite1h), cacheWrite: toNum(u.cacheWrite),
    outputVisible: toNum(u.outputVisible), reasoning: toNum(u.reasoning), imageUnits: toNum(u.imageUnits), audioUnits: toNum(u.audioUnits), toolTokens: toNum(u.toolTokens),
    U: toNum(U), usageCompleteness: u.usageCompleteness, usageSource: 'provider_response', rawUsageSanitized: numbersOnly(u.rawUsageSanitized),
    modelServed: p.modelServed, serviceTierServed: p.pricingTerms.serviceTier ?? 'UNKNOWN', cacheObserved: cacheObserved(u),
    // VNEXT-1 (C151): the stop reason leaves the parser (it used to be dropped here) and the completion is derived from it alone
    stopReason: p.stopReason, completion: completionOf(p), outputTotal: toNum(u.providerTotals.outputTotal),
  };
}
/** VNEXT-1: completion from the provider reason: truncated => NOT completed; refusal outcome => REFUSED; end_turn|stop|STOP => COMPLETE; other identifiers => OTHER; absent => UNKNOWN. */
export function completionOf(p: Pick<ParsedResponse, 'stopReason' | 'truncated' | 'outcome'>): NormalizedUsageH2['completion'] {
  if (p.truncated === true) return 'TRUNCATED_MAX_TOKENS';
  if (p.outcome === 'REFUSED_WITH_USAGE') return 'REFUSED';
  if (p.stopReason === 'UNKNOWN') return 'UNKNOWN';
  return ['end_turn', 'stop', 'STOP', 'stop_sequence'].includes(p.stopReason) ? 'COMPLETE' : 'OTHER';
}

function refusalOf(p: ParsedResponse): ParsedRefusal {
  const usagePresent = p.usage.usageSource === 'provider_response';
  if (p.outcome === 'REFUSED_WITH_USAGE') {
    const code = p.flags.includes('finish_reason_content_filter') ? 'content_filter' : p.flags.some((f) => f.startsWith('block_reason_')) ? 'blocked_prompt' : p.flags.some((f) => f.startsWith('finish_reason_SAFETY') || f.startsWith('finish_reason_')) && p.api === 'gemini.generate_content' ? 'safety' : 'refusal';
    return { refused: true, code, httpStatus: p.httpStatus, usagePresent };
  }
  if (p.outcome === 'ERROR_NO_USAGE' || p.outcome === 'ERROR_WITH_USAGE') {
    const e = (p.errorCode ?? '').toLowerCase();
    const code = /rate_limit|resource_exhausted|requests/.test(e) ? 'rate_limit' : /invalid|schema|bad_request|invalid_argument/.test(e) ? 'invalid_request' : /auth|permission|unauthenticated/.test(e) ? 'auth' : /overload|unavailable/.test(e) ? 'overloaded' : `http_${p.httpStatus}`;
    return { refused: false, code, httpStatus: p.httpStatus, usagePresent };
  }
  return { refused: false, code: 'NONE', httpStatus: p.httpStatus, usagePresent };
}

function binary(part: Extract<ResolvedPart, { type: 'image' | 'audio' }>): string {
  if (!part.bytesBase64) throw new AdapterError('H2EVAL_BINARY_NOT_RESOLVED', `${part.type} part ${part.bytesSha256.slice(0, 12)} has no bytes: the pure adapter cannot fetch them (ContentStore.getBytes is async); the core/E2E-01 must resolve bytesBase64 before buildRequest`);
  return part.bytesBase64;
}

function applyServiceTier(plan: OperationPlan, expected: string, body: Record<string, unknown>, key: string): void {
  if (plan.params.serviceTier === 'NONE') { delete body[key]; return; }
  if (plan.params.serviceTier !== expected) throw new AdapterError('H2EVAL_PARAM_NOT_DOCUMENTED', `service tier ${plan.params.serviceTier} is not the documented standard value ${expected} (R08 §2)`);
  body[key] = plan.params.serviceTier;
}
const assertTemperatureDefault = (plan: OperationPlan, body: Record<string, unknown>, key: string) => { if (plan.params.temperature !== 'DEFAULT') body[key] = plan.params.temperature; };
const textPartsOf = (api: UsageApi, body: unknown) => { const ex = extractInputText(api, body); return { texts: ex.texts, nonText: ex.nonText, reasons: ex.reasons }; };
const nonTextOf = (content: ResolvedContent): BuiltRequest['nonTextParts'] => content.messages.flatMap((m) => m.parts.filter((p): p is Extract<ResolvedPart, { type: 'image' | 'audio' }> => p.type !== 'text').map((p) => ({ kind: p.type, units: 'UNKNOWN' as Count, unit: p.type === 'image' ? `provider_tokens (ex ante via estimators/, ${p.width}x${p.height})` : `provider_tokens (ex ante UNSUPPORTED_FOR_ESTIMATION, ${p.seconds}s)` })));

const openaiAdapter: ProviderAdapter = {
  provider: 'openai', api: 'openai.chat_completions', adapterVersion: H2EVAL_MODAL_VERSION, officialHosts: OFFICIAL_HOSTS.openai,
  buildRequest(plan, content) {
    const hp = hParityOf(plan);
    const luna = plan.modelRequested === 'gpt-6-luna'; // E3G (C160 BRACO-GO; DR-208): arm model, text only, service_tier "default" in EVERY request
    if (plan.modelRequested !== 'gpt-4o-mini-2024-07-18' && !luna) throw new AdapterError('H2EVAL_MODEL_NOT_IN_MATRIX', plan.modelRequested);
    if (luna && plan.params.serviceTier !== 'default') throw new AdapterError('H2EVAL_ARM_TIER_NOT_FIXED', `gpt-6-luna: service_tier must be fixed to "default" (Standard) in every request; plan has ${String(plan.params.serviceTier)}`);
    if (luna && content.messages.some((m) => m.parts.some((p) => p.type !== 'text'))) throw new AdapterError('H2EVAL_MODALITY_NOT_SUPPORTED', 'E3G arm: text only (the attested prices are text prices)');
    const sys = content.messages.find((m) => m.role === 'system');
    const msgs = content.messages.filter((m) => m.role !== 'system').map((m) => ({ role: m.role as 'user' | 'assistant', parts: m.parts.map((p): OpenAiUserPart => (p.type === 'text' ? { kind: 'text', text: p.text } : p.type === 'image' ? { kind: 'image', dataUrlOrUrl: `data:${p.mime};base64,${binary(p)}`, detail: 'auto' } : (() => { throw new AdapterError('H2EVAL_MODALITY_NOT_SUPPORTED', 'gpt-4o-mini does not accept audio (R08 §6)'); })())) }));
    if (reasoningFromPlan(plan) !== 'NONE') throw new AdapterError('H2EVAL_PARAM_NOT_DOCUMENTED', 'gpt-4o-mini has no documented reasoning parameter (R08 §8)');
    const cd = plan.params.cacheDirectives; let promptCacheKey: string | undefined;
    if (cd !== 'NONE') { const keys = Object.keys(cd); if (keys.length !== 1 || keys[0] !== 'prompt_cache_key') throw new AdapterError('H2EVAL_PARAM_NOT_DOCUMENTED', `openai cache directive ${keys.join(',')}`); promptCacheKey = String(cd['prompt_cache_key']); }
    const env = buildOpenAiChatRequest({ model: luna ? 'gpt-6-luna' : 'gpt-4o-mini-2024-07-18', system: sys ? sys.parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n') : undefined, messages: msgs, maxOutputTokens: plan.params.maxTokens, promptCacheKey });
    applyServiceTier(plan, 'default', env.body, 'service_tier'); assertTemperatureDefault(plan, env.body, 'temperature');
    if (hp) { env.body['n'] = 1; env.body['stream'] = false; env.body['store'] = false; } // EXEC-ECON item 10 (D2 da master): sent EXPLICITLY, equal to H
    const t = textPartsOf(env.api as UsageApi, env.body);
    return { url: `https://${OFFICIAL_HOSTS.openai[0]}${env.path}`, method: 'POST', headers: { 'content-type': 'application/json' }, credentialHeader: 'authorization', credentialFormat: 'bearer', body: env.body, textParts: t.texts, nonTextParts: nonTextOf(content) };
  },
  parseRefusal: (s, b) => refusalOf(parseOpenAiChatResponse(s, b, { requestModalities: [] })),
  parseUsage: (b) => toH2(parseOpenAiChatResponse(200, b, { requestModalities: [] })),
  modelSupport: (m) => resolveModelSupport('openai', 'openai.chat_completions', m),
  modelDeprecation: (m) => deprecationOf(m),
};

const anthropicAdapter: ProviderAdapter = {
  provider: 'anthropic', api: 'anthropic.messages', adapterVersion: H2EVAL_MODAL_VERSION, officialHosts: OFFICIAL_HOSTS.anthropic,
  buildRequest(plan, content) {
    const model = plan.modelRequested as MatrixModel | 'claude-sonnet-5';
    const hp = hParityOf(plan); // EXEC-ECON item 2: claude-sonnet-5 (arm B of the ECON study) exists ONLY under H_PARITY
    if (model !== 'claude-haiku-4-5-20251001' && model !== 'claude-haiku-5-5' && model !== 'claude-sonnet-5-5' && model !== 'claude-opus-5-5' && !(hp && model === 'claude-sonnet-5')) throw new AdapterError('H2EVAL_MODEL_NOT_IN_MATRIX', plan.modelRequested);
    const adaptiveOnly = model === 'claude-sonnet-5-5' || model === 'claude-opus-5-5'; // thinking cannot be disabled (Sonnet 5.5 refuses it; Opus 5.5 is always adaptive)
    const sysIdx = content.messages.findIndex((m) => m.role === 'system');
    const sys = sysIdx >= 0 ? content.messages[sysIdx] : undefined;
    const cd = plan.params.cacheDirectives; let wantCache = false;
    if (cd !== 'NONE') { if (cd['cache_control'] !== 'ephemeral') throw new AdapterError('H2EVAL_PARAM_NOT_DOCUMENTED', `anthropic cache directive ${JSON.stringify(cd)}`); wantCache = true; }
    // TTL: contract rev. 2 `cacheTtlRequested` wins; else the directive's ttl; else the documented default 5m
    const ttl: '5m' | '1h' = plan.params.cacheTtlRequested === '1h' || (plan.params.cacheTtlRequested !== '5m' && cd !== 'NONE' && cd['ttl'] === '1h') ? '1h' : '5m';
    // BREAKPOINT RULE (F-INT-1, R07/R13 design): the stable prefix = the first `prefixMessages` messages of ResolvedContent, COUNTING the
    // system message when present (E2E-01: a dialogue has prefixMessages = 1 = the system message). The single explicit breakpoint goes on
    // the LAST text block of the LAST message of that prefix: prefixMessages = 1 with a system message => on the system block; larger
    // prefixes => on the last block of the corresponding user/assistant message. prefixMessages NOT_APPLICABLE with a cache plan => the
    // whole prompt is the prefix (last block of the last message). Documented basis: "Prompt caching references the entire prompt: tools,
    // system, and messages (in that order), up to and including the block designated with cache_control" (anthropic/prompt-caching.html).
    const total = content.messages.length;
    const prefixEnd = content.prefixMessages === 'NOT_APPLICABLE' ? total : Math.min(content.prefixMessages, total);
    const breakpointOnSystem = wantCache && sys !== undefined && prefixEnd - 1 === sysIdx;
    const nonSys = content.messages.map((m, idx) => ({ m, idx })).filter((x) => x.m.role !== 'system');
    const msgs = nonSys.map(({ m, idx }) => ({ role: m.role as 'user' | 'assistant', parts: m.parts.map((p, j): AnthropicUserPart => {
      if (p.type === 'text') { const last = wantCache && !breakpointOnSystem && idx === prefixEnd - 1 && j === m.parts.length - 1; return last ? { kind: 'text', text: p.text, cacheBreakpoint: { ttl } } : { kind: 'text', text: p.text }; }
      if (p.type === 'image') { const mt = p.mime as AnthropicUserPart extends { kind: 'image'; mediaType: infer M } ? M : never; if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(p.mime)) throw new AdapterError('H2EVAL_MEDIA_TYPE', p.mime); return { kind: 'image', mediaType: mt, base64: binary(p) }; }
      throw new AdapterError('H2EVAL_MODALITY_NOT_SUPPORTED', 'Messages API has no audio input (R08 §6)');
    }) }));
    if (wantCache && !breakpointOnSystem && !nonSys.some(({ idx }) => idx === prefixEnd - 1)) throw new AdapterError('H2EVAL_CACHE_PREFIX_EMPTY', `prefixMessages=${String(content.prefixMessages)} selects no message for the breakpoint`);
    const env = buildAnthropicMessagesRequest({ model, system: sys ? sys.parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n') : undefined, systemCacheBreakpoint: breakpointOnSystem ? { ttl } : undefined, messages: msgs, maxOutputTokens: plan.params.maxTokens });
    // reasoning from the plan (never invented): haiku-4-5 => NONE or {budget_tokens}; haiku-5-5 => {effort}
    const r = reasoningFromPlan(plan);
    delete env.body['output_config'];
    // VNEXT-2 (C151 item 2): policy OFF on Haiku 5.5 is DOCUMENTED as thinking: {type: "disabled"} at effort high or below (runs/R17_REAL/H2_DIAG/docs/effort.html
    // sha256 b069c61b…, effort.txt l. 448-460; docs/thinking.html sha256 09378fd5…, l. 617-620); effort is omitted (= medium) so the combination stays valid.
    delete env.body['thinking'];
    if (hp) { /* EXEC-ECON item 1: OMIT, no thinking and no output_config (both deleted above); the model's own default applies */ }
    else if (r === 'NONE' && adaptiveOnly) throw new AdapterError('H2EVAL_PARAM_NOT_DOCUMENTED', `${model} does not accept thinking disabled: the plan must carry an adaptive effort`);
    else if (r === 'NONE' && model === 'claude-haiku-5-5') env.body['thinking'] = { type: 'disabled' };
    if (!hp && r !== 'NONE') {
      if ((model === 'claude-haiku-5-5' || adaptiveOnly) && typeof r['effort'] === 'string' && Object.keys(r).length === 1) env.body['output_config'] = { effort: r['effort'] };
      else if (model === 'claude-haiku-4-5-20251001' && typeof r['budget_tokens'] === 'number' && Object.keys(r).length === 1) env.body['thinking'] = { type: 'enabled', budget_tokens: r['budget_tokens'] };
      else throw new AdapterError('H2EVAL_PARAM_NOT_DOCUMENTED', `anthropic reasoning ${JSON.stringify(r)} for ${model} (R08 §8)`);
    }
    applyServiceTier(plan, 'standard_only', env.body, 'service_tier'); assertTemperatureDefault(plan, env.body, 'temperature');
    const t = textPartsOf(env.api as UsageApi, env.body);
    return { url: `https://${OFFICIAL_HOSTS.anthropic[0]}${env.path}`, method: 'POST', headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01' }, credentialHeader: 'x-api-key', credentialFormat: 'raw', body: env.body, textParts: t.texts, nonTextParts: nonTextOf(content) };
  },
  parseRefusal: (s, b) => refusalOf(parseAnthropicMessagesResponse(s, b, { requestModalities: [] })),
  // body-only: thinkingRequested unknown => the parser applies the manual-only-model rule (claude-haiku-4-5-* without thinking block => NOT_APPLICABLE)
  parseUsage: (b, ctx) => toH2(parseAnthropicMessagesResponse(200, b, { requestModalities: [], thinkingRequested: ctx?.thinkingRequested })),
  modelSupport: (m) => resolveModelSupport('anthropic', 'anthropic.messages', m),
  modelDeprecation: (m) => deprecationOf(m),
};

const googleAdapter: ProviderAdapter = {
  provider: 'google', api: 'gemini.generate_content', adapterVersion: H2EVAL_MODAL_VERSION, officialHosts: OFFICIAL_HOSTS.google,
  buildRequest(plan, content) {
    const hp = hParityOf(plan);
    const arm = plan.modelRequested === 'gemini-3.1-flash-lite'; // E3G (C160 BRACO-GO; DR-168/187/194): arm model, text only, Standard (no tier parameter)
    if (plan.modelRequested !== 'gemini-3.5-flash-lite' && !arm) throw new AdapterError('H2EVAL_MODEL_NOT_IN_MATRIX', plan.modelRequested);
    if (arm && content.messages.some((m) => m.parts.some((p) => p.type !== 'text'))) throw new AdapterError('H2EVAL_MODALITY_NOT_SUPPORTED', 'E3G arm: text only (the attested prices are text prices)');
    const sys = content.messages.find((m) => m.role === 'system');
    const contents = content.messages.filter((m) => m.role !== 'system').map((m) => ({ role: (m.role === 'assistant' ? 'model' : 'user') as 'user' | 'model', parts: m.parts.map((p): GoogleUserPart => (p.type === 'text' ? { kind: 'text', text: p.text } : p.type === 'image' ? { kind: 'image', mimeType: p.mime as 'image/png', base64: binary(p) } : { kind: 'audio', mimeType: p.mime as 'audio/wav', base64: binary(p) })) }));
    if (plan.params.cacheDirectives !== 'NONE') throw new AdapterError('H2EVAL_PARAM_NOT_DOCUMENTED', 'gemini: implicit caching only; no per-request directive is sent (explicit cachedContents not used)');
    const env = buildGoogleGenerateContentRequest({ model: arm ? 'gemini-3.1-flash-lite' : 'gemini-3.5-flash-lite', system: sys ? sys.parts.filter((p): p is { type: 'text'; text: string } => p.type === 'text').map((p) => p.text).join('\n') : undefined, contents, maxOutputTokens: plan.params.maxTokens });
    const gc = env.body['generationConfig'] as Record<string, unknown>;
    const r = reasoningFromPlan(plan);
    if (hp) { delete gc['thinkingConfig']; gc['candidateCount'] = 1; } // EXEC-ECON items 1 and 10 (D2 da master): no thinkingConfig; candidateCount:1 sent EXPLICITLY, equal to H
    else if (r === 'NONE') delete gc['thinkingConfig']; // the model's default is "On (minimal)": NONE sends no config and the parser still reads thoughtsTokenCount
    else if (typeof r['thinking_level'] === 'string' && Object.keys(r).length === 1 && ['minimal', 'low', 'medium', 'high'].includes(r['thinking_level'])) gc['thinkingConfig'] = { thinkingLevel: r['thinking_level'].toUpperCase() };
    else throw new AdapterError('H2EVAL_PARAM_NOT_DOCUMENTED', `gemini reasoning ${JSON.stringify(r)} (R08 §8)`);
    if (plan.params.serviceTier !== 'NONE') throw new AdapterError('H2EVAL_PARAM_NOT_DOCUMENTED', 'gemini generateContent: no tier parameter is sent (Standard tier is the default; the response serviceTier is checked)');
    assertTemperatureDefault(plan, gc, 'temperature');
    const t = textPartsOf(env.api as UsageApi, env.body);
    return { url: `https://${OFFICIAL_HOSTS.google[0]}${env.path}`, method: 'POST', headers: { 'content-type': 'application/json' }, credentialHeader: 'x-goog-api-key', credentialFormat: 'raw', body: env.body, textParts: t.texts, nonTextParts: nonTextOf(content) };
  },
  parseRefusal: (s, b) => refusalOf(parseGoogleGenerateContentResponse(s, b, { requestModalities: [] })),
  // E3G4 (B4): o braco (gemini-3.1-flash-lite) so aceita texto no buildRequest; com textOnly, imagem/audio ausentes sao NOT_APPLICABLE (token > 0 continua sinalizado e contado). Sem textOnly: inalterado
  parseUsage: (b, ctx) => toH2(parseGoogleGenerateContentResponse(200, b, { requestModalities: ctx?.textOnly ? [] : ['image', 'audio'] })),
  modelSupport: (m) => resolveModelSupport('gemini', 'gemini.generate_content', m),
  modelDeprecation: (m) => deprecationOf(m),
};

/** INTERFACES.md §9: keyed by UsageApi (only the three APIs of the matrix are present). */
export const ADAPTERS: Readonly<Partial<Record<UsageApi, ProviderAdapter>>> & { 'openai.chat_completions': ProviderAdapter; 'anthropic.messages': ProviderAdapter; 'gemini.generate_content': ProviderAdapter } = Object.freeze({
  'openai.chat_completions': openaiAdapter,
  'anthropic.messages': anthropicAdapter,
  'gemini.generate_content': googleAdapter,
});

/** Canonical JSON (keys sorted recursively, no whitespace): the serialization the body hash is taken over. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/**
 * F-INT-1 (coordinator's decision): the adapter is the SINGLE SOURCE of the request body; the pre-registrable reference is derived from it.
 * Pure: same (plan, content) => same body and sha256. `bodySha256 = sha256(canonicalJson(body))`.
 */
export function bodyOf(plan: OperationPlan, content: ResolvedContent): { body: unknown; canonical: string; bodySha256: string; api: UsageApi; url: string } {
  const a = ADAPTERS[plan.api as 'openai.chat_completions' | 'anthropic.messages' | 'gemini.generate_content'];
  if (!a) throw new AdapterError('H2EVAL_API_NOT_IN_MATRIX', String(plan.api));
  const r = a.buildRequest(plan, content);
  const canonical = canonicalJson(r.body);
  return { body: r.body, canonical, bodySha256: createHash('sha256').update(canonical).digest('hex'), api: a.api, url: r.url };
}

export function adapterForModel(model: MatrixModel): ProviderAdapter {
  return model === 'gpt-4o-mini-2024-07-18' ? openaiAdapter : model === 'gemini-3.5-flash-lite' ? googleAdapter : anthropicAdapter;
}

export type { ProviderAdapter, BuiltRequest, NormalizedUsageH2, ParsedRefusal, OperationPlan, ResolvedContent } from './interfaces_v0.js';
export type { ModelSupport };
