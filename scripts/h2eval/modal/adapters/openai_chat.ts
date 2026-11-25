/**
 * OpenAI Chat Completions adapter for gpt-4o-mini-2024-07-18 (the H1 endpoint, R08 §2).
 * Price-fixing parameters: service_tier "default" (fixed standard price; the response echoes the tier actually used),
 * stream false, max_completion_tokens as the output ceiling. gpt-4o-mini is not a reasoning model (R08 §8), so no
 * reasoning parameter is sent; reasoning_tokens is still parsed (billed as output).
 * Usage semantics (contract §4 + R08 §4): prompt_tokens INCLUDES cached tokens; cached_tokens is a subset of input,
 * "rounded down to the nearest multiple of 128"; reasoning_tokens is a subset of completion_tokens.
 * Sources (R08 official_docs): openai/chat-create.html, openai/prompt-caching.html, openai/gpt-4o-mini.html, openai/images-vision.html.
 *
 * Pure builder and parser; the per-API adapter in `modal/index.ts` calls them and adds the host and the transport details.
 *
 * @module scripts/h2eval/modal/adapters/openai_chat
 */
import type { ParsedResponse, RequestEnvelope, Modality } from '../types.js';
import { NA, UNKNOWN, completeness, emptyUsage, intAt, sanitizeNumbers, sub, terms } from '../canonical.js';
import { stopReasonOf } from './anthropic_messages.js';

/** Request path of Chat Completions. */
export const OPENAI_CHAT_PATH = '/v1/chat/completions';
/** Standard service tier value sent and expected back. */
export const OPENAI_STANDARD_TIER = 'default';
/** E3G (C160 BRACO-GO; DR-208): arm model, Standard (service_tier "default" in every request), context <= 272k. A reasoning model with a charged cache write. */
export const OPENAI_ARM_MODEL = 'gpt-6-luna';
const isArmServed = (served: string): boolean => /^gpt-6-luna(-|$)/.test(served);

/** Image part: a data URL (or URL) and the detail level. */
export interface OpenAiImagePart { kind: 'image'; dataUrlOrUrl: string; detail: 'low' | 'high' | 'auto' }
/** One part of a user or assistant message: text or image. */
export type OpenAiUserPart = { kind: 'text'; text: string } | OpenAiImagePart;

/**
 * Builds the Chat Completions request body.
 *
 * @param args - Model, optional system text, messages, output ceiling in tokens and optional prompt cache key.
 * @returns The request envelope (path only, no host or credential) with the price-relevant parameters.
 */
export function buildOpenAiChatRequest(args: { model: 'gpt-4o-mini-2024-07-18' | 'gpt-6-luna'; system?: string; messages: Array<{ role: 'user' | 'assistant'; parts: OpenAiUserPart[] }>; maxOutputTokens: number; promptCacheKey?: string }): RequestEnvelope {
  const messages: Array<Record<string, unknown>> = [];
  if (args.system !== undefined) messages.push({ role: 'system', content: args.system });
  const modalities = new Set<Modality>(['text']);
  for (const m of args.messages) {
    // Deterministic content form (openai/chat-create.html, ChatCompletionUserMessageParam: "content: string or array of
    // ChatCompletionContentPart ... TextContent = string ... ArrayOfContentParts ... Can contain text, image, or audio inputs"):
    // text-only message => string (concatenation of its text parts); any image part => array of parts (the only form that carries images).
    if (m.parts.every((p) => p.kind === 'text')) { messages.push({ role: m.role, content: m.parts.map((p) => (p as { kind: 'text'; text: string }).text).join('') }); continue; }
    const content = m.parts.map((p) => {
      if (p.kind === 'text') return { type: 'text', text: p.text };
      modalities.add('image');
      return { type: 'image_url', image_url: { url: p.dataUrlOrUrl, detail: p.detail } };
    });
    messages.push({ role: m.role, content });
  }
  // max_completion_tokens: "An upper bound for the number of tokens that can be generated for a completion, including visible output
  // tokens and reasoning tokens"; max_tokens: "Deprecated ... now deprecated in favor of max_completion_tokens" (openai/chat-create.html).
  // DECLARED change versus H1 (which used max_tokens for the same snapshot). `n` is not sent: "n: optional integer or null (default: 1)".
  const body: Record<string, unknown> = {
    model: args.model,
    messages,
    max_completion_tokens: args.maxOutputTokens,
    stream: false,
    service_tier: OPENAI_STANDARD_TIER,
  };
  if (args.promptCacheKey !== undefined) body['prompt_cache_key'] = args.promptCacheKey; // routing only; it does not create or disable caching (R08 §4)
  return {
    provider: 'openai', api: 'openai.chat_completions', model: args.model, method: 'POST', path: OPENAI_CHAT_PATH,
    body,
    params: { maxOutputTokens: args.maxOutputTokens, temperature: 'DEFAULT', reasoning: 'not a reasoning model; no reasoning parameter sent (R08 §8)', serviceTier: OPENAI_STANDARD_TIER, stream: false, cacheDirectives: args.promptCacheKey ? `prompt_cache_key=${args.promptCacheKey} (routing only)` : 'none (automatic caching cannot be disabled; control = unique prefix per operation)' },
    requestModalities: [...modalities],
  };
}

/**
 * Parses a Chat Completions response into disjoint usage categories, outcome and stop reason.
 *
 * @param httpStatus - HTTP status of the response.
 * @param body - Parsed response body.
 * @param ctx - Modalities the request carried (decides whether image/audio fields are not applicable).
 * @returns The parsed response; missing counts stay `'UNKNOWN'`, never 0.
 */
export function parseOpenAiChatResponse(httpStatus: number, body: unknown, ctx: { requestModalities: Modality[] }): ParsedResponse {
  const flags: string[] = [];
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const err = b['error'] as Record<string, unknown> | undefined;
  const errorCode = err ? String(err['code'] ?? err['type'] ?? 'error') : null;
  const usageObj = b['usage'];
  const modelServed = typeof b['model'] === 'string' ? (b['model'] as string) : 'UNKNOWN';
  const tier = typeof b['service_tier'] === 'string' ? (b['service_tier'] as string) : null;
  const pricingTerms = terms(tier, null, null, [OPENAI_STANDARD_TIER]);
  if (tier === null && httpStatus === 200) flags.push('service_tier_absent_in_response');

  if (!usageObj || typeof usageObj !== 'object') {
    return { api: 'openai.chat_completions', outcome: 'ERROR_NO_USAGE', httpStatus, modelServed, usage: emptyUsage([`no usage object (http ${httpStatus})`]), pricingTerms, flags: [...flags, 'no_usage'], errorCode, stopReason: 'UNKNOWN', truncated: 'UNKNOWN' };
  }
  const u = emptyUsage();
  u.usageSource = 'provider_response';
  u.rawUsageSanitized = sanitizeNumbers(usageObj);
  const prompt = intAt(usageObj, 'prompt_tokens');
  const completion = intAt(usageObj, 'completion_tokens');
  const cached = intAt(usageObj, 'prompt_tokens_details.cached_tokens');
  const audioIn = intAt(usageObj, 'prompt_tokens_details.audio_tokens');
  const reasoning = intAt(usageObj, 'completion_tokens_details.reasoning_tokens');
  const audioOut = intAt(usageObj, 'completion_tokens_details.audio_tokens');
  u.providerTotals = { inputTotal: prompt, outputTotal: completion };
  u.cacheRead = cached; // subset of prompt_tokens
  u.inputUncached = sub(prompt, cached);
  if (typeof cached === 'bigint' && cached > 0n) u.cacheRoundingNote = 'openai_128'; // "rounding down to the nearest multiple of 128" (openai/prompt-caching.html)
  if (cached === UNKNOWN) u.notes.push('prompt_tokens_details.cached_tokens absent: cache split UNKNOWN (not assumed 0)');
  u.cacheWrite5m = NA; u.cacheWrite1h = NA; u.cacheWrite = NA; // no charged cache write for models before GPT-5.6 (R08 §3)
  if (isArmServed(modelServed)) {
    // E3G (DR-208): gpt-6-luna CHARGES the cache write (0.125); prompt_tokens_details.cache_write_tokens is a subset of prompt_tokens (Bot providers3p/usage.js, same field).
    // Absent field => UNKNOWN (never 0): the cost stays UNKNOWN and the money possibly charged.
    const written = intAt(usageObj, 'prompt_tokens_details.cache_write_tokens');
    u.cacheWrite = written;
    u.inputUncached = sub(sub(prompt, cached), written);
    if (written === UNKNOWN) u.notes.push('prompt_tokens_details.cache_write_tokens absent on gpt-6-luna: cache write UNKNOWN (not assumed 0)');
  }
  // R14-FIX (same rule as F-INT-2): gpt-4o-mini "is not a reasoning model" (R08 §8); when completion_tokens_details is absent the
  // visible output is completion_tokens and reasoning is NOT_APPLICABLE (not "absent"). Any other served model keeps UNKNOWN.
  if (reasoning === UNKNOWN && /^gpt-4o-mini(-|$)/.test(modelServed)) { u.reasoning = NA; u.outputVisible = completion; u.notes.push('completion_tokens_details absent on a non-reasoning model: reasoning NOT_APPLICABLE, outputVisible = completion_tokens'); }
  else {
    u.reasoning = reasoning;
    u.outputVisible = sub(completion, reasoning);
    if (reasoning === UNKNOWN) u.notes.push('completion_tokens_details.reasoning_tokens absent: reasoning/visible split UNKNOWN');
  }
  u.toolTokens = NA; // no tool tokens field in Chat Completions usage
  // images: billed inside prompt_tokens, no separate field documented for Chat Completions (R08 §5)
  u.imageUnits = ctx.requestModalities.includes('image') ? UNKNOWN : NA;
  if (ctx.requestModalities.includes('image')) u.notes.push('image tokens are inside prompt_tokens; no separate field in Chat Completions usage');
  // gpt-4o-mini does not accept audio (R08 §6): without audio in the request the field is NOT_APPLICABLE; a non-zero value is flagged
  u.audioUnits = ctx.requestModalities.includes('audio') ? audioIn : NA;
  if (!ctx.requestModalities.includes('audio') && typeof audioIn === 'bigint' && audioIn > 0n) { u.audioUnits = audioIn; flags.push('unexpected_audio_input_tokens'); }
  if (typeof audioOut === 'bigint' && audioOut > 0n) flags.push('audio_output_tokens');

  // outcome
  let outcome: ParsedResponse['outcome'] = 'OK';
  const choices = Array.isArray(b['choices']) ? (b['choices'] as Array<Record<string, unknown>>) : [];
  const c0 = choices[0] ?? {};
  const msg = (c0['message'] ?? {}) as Record<string, unknown>;
  if (httpStatus !== 200 || err) { outcome = 'ERROR_WITH_USAGE'; flags.push('http_error_with_usage'); }
  else {
    if (msg['refusal'] !== undefined && msg['refusal'] !== null) { flags.push('refusal_block'); outcome = 'REFUSED_WITH_USAGE'; }
    if (c0['finish_reason'] === 'content_filter') { flags.push('finish_reason_content_filter'); outcome = 'REFUSED_WITH_USAGE'; }
    if (Array.isArray(msg['tool_calls']) && (msg['tool_calls'] as unknown[]).length) { flags.push('tool_calls'); outcome = 'INCOMPLETE_UNEXPECTED_CONTENT'; }
    if (msg['audio']) { flags.push('audio_output'); outcome = 'INCOMPLETE_UNEXPECTED_CONTENT'; }
    if (choices.length === 0) { flags.push('no_choices'); outcome = 'INCOMPLETE_UNEXPECTED_CONTENT'; }
    if (c0['finish_reason'] === 'length') flags.push('finish_reason_length');
  }
  u.usageCompleteness = completeness(u);
  const stopReason = stopReasonOf(c0['finish_reason']);
  return { api: 'openai.chat_completions', outcome, httpStatus, modelServed, usage: u, pricingTerms, flags, errorCode, stopReason, truncated: stopReason === 'UNKNOWN' ? 'UNKNOWN' : stopReason === 'length' };
}
