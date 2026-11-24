/**
 * Anthropic Messages adapter for claude-haiku-4-5-20251001 and claude-haiku-5-5 (R08 §2, §8).
 * Price-fixing parameters: service_tier "standard_only", stream false, max_tokens as the output ceiling, no
 * inference_geo (US-only inference costs 1.1x; the response's usage.inference_geo is checked), no speed.
 * Reasoning: Haiku 4.5 = omit `thinking` (no reasoning); Haiku 5.5 = adaptive thinking is on by default and
 * `budget_tokens` is rejected, so the minimum documented control is output_config.effort = "low" (R08 §8);
 * turning it OFF is NOT documented in the archived pages -> recorded as NOT_VERIFIED, reasoning is parsed and billed as output.
 * Usage semantics (contract §4): input_tokens EXCLUDES cache reads and writes; cache_creation.ephemeral_5m/1h split the
 * write; output_tokens_details.thinking_tokens is a subset of output_tokens.
 * Cache: without `cache_control` there is neither write nor read (R08 §4); the S3 arm adds one breakpoint on the prefix.
 * Sources (R08 official_docs): anthropic/messages-create.html, anthropic/messages-usage-object.html, anthropic/pricing.html,
 * anthropic/extended-thinking.html, anthropic/haiku-5-5.html, anthropic/service-tiers.html, anthropic/vision.html.
 */
import type { ParsedResponse, RequestEnvelope, Modality } from '../types.js';
import { NA, UNKNOWN, completeness, emptyUsage, intAt, sanitizeNumbers, sub, terms } from '../canonical.js';

export const ANTHROPIC_MESSAGES_PATH = '/v1/messages';
export const ANTHROPIC_VERSION_HEADER = '2023-06-01';
export const ANTHROPIC_STANDARD_TIER = 'standard_only';
/** VNEXT-1: a stop/finish reason is kept only as a short identifier (never free text). */
export const stopReasonOf = (v: unknown): string | 'UNKNOWN' => (typeof v === 'string' && /^[A-Za-z0-9_]{1,40}$/.test(v) ? v : 'UNKNOWN');

export interface AnthropicImagePart { kind: 'image'; mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; base64: string }
export type AnthropicUserPart = { kind: 'text'; text: string; cacheBreakpoint?: { ttl?: '5m' | '1h' } } | AnthropicImagePart;

/**
 * `system` is sent as an array of text blocks ("system: optional string or array of TextBlockParam { type: "text", text, cache_control,
 * citations }", anthropic/messages-create.html) so that a cache breakpoint can sit on it: "Prompt caching references the entire prompt:
 * tools, system, and messages (in that order), up to and including the block designated with cache_control" (anthropic/prompt-caching.html).
 */
export function buildAnthropicMessagesRequest(args: { model: 'claude-haiku-4-5-20251001' | 'claude-haiku-5-5' | 'claude-sonnet-5-5' | 'claude-opus-5-5' | 'claude-sonnet-5'; system?: string; systemCacheBreakpoint?: { ttl?: '5m' | '1h' }; messages: Array<{ role: 'user' | 'assistant'; parts: AnthropicUserPart[] }>; maxOutputTokens: number }): RequestEnvelope {
  const modalities = new Set<Modality>(['text']);
  let cacheDirectives = 'none (no cache_control: neither write nor read)';
  if (args.systemCacheBreakpoint) cacheDirectives = `cache_control ephemeral ttl=${args.systemCacheBreakpoint.ttl ?? '5m'} on the system block`;
  const messages = args.messages.map((m) => ({
    role: m.role,
    content: m.parts.map((p) => {
      if (p.kind === 'image') { modalities.add('image'); return { type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.base64 } }; }
      const block: Record<string, unknown> = { type: 'text', text: p.text };
      if (p.cacheBreakpoint) { block['cache_control'] = { type: 'ephemeral', ...(p.cacheBreakpoint.ttl === '1h' ? { ttl: '1h' } : {}) }; cacheDirectives = `cache_control ephemeral ttl=${p.cacheBreakpoint.ttl ?? '5m'} on one text block`; }
      return block;
    }),
  }));
  const body: Record<string, unknown> = { model: args.model, max_tokens: args.maxOutputTokens, messages, stream: false, service_tier: ANTHROPIC_STANDARD_TIER };
  if (args.system !== undefined) {
    const sys: Record<string, unknown> = { type: 'text', text: args.system };
    if (args.systemCacheBreakpoint) sys['cache_control'] = { type: 'ephemeral', ...(args.systemCacheBreakpoint.ttl === '1h' ? { ttl: '1h' } : {}) };
    body['system'] = [sys];
  }
  let reasoning: string;
  if (args.model === 'claude-haiku-4-5-20251001') reasoning = 'thinking omitted => no reasoning (extended thinking is manual-only on Haiku 4.5; R08 §8)';
  else { body['output_config'] = { effort: 'low' }; reasoning = 'adaptive thinking on by default; minimum documented control output_config.effort=low; OFF not documented (NOT_VERIFIED); thinking_tokens parsed and billed as output'; }
  return {
    provider: 'anthropic', api: 'anthropic.messages', model: args.model as RequestEnvelope['model'], /* EXEC-ECON: claude-sonnet-5 fora da MatrixModel legada */ method: 'POST', path: ANTHROPIC_MESSAGES_PATH,
    body,
    params: { maxOutputTokens: args.maxOutputTokens, temperature: 'DEFAULT', reasoning, serviceTier: ANTHROPIC_STANDARD_TIER, stream: false, cacheDirectives },
    requestModalities: [...modalities],
  };
}

export function parseAnthropicMessagesResponse(httpStatus: number, body: unknown, ctx: { requestModalities: Modality[]; thinkingRequested?: boolean }): ParsedResponse {
  const flags: string[] = [];
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const err = b['error'] as Record<string, unknown> | undefined;
  const errorCode = err ? String(err['type'] ?? 'error') : null;
  const usageObj = b['usage'];
  const modelServed = typeof b['model'] === 'string' ? (b['model'] as string) : 'UNKNOWN';
  const uo = (usageObj && typeof usageObj === 'object' ? usageObj : {}) as Record<string, unknown>;
  const tier = typeof uo['service_tier'] === 'string' ? (uo['service_tier'] as string) : null;
  const geo = typeof uo['inference_geo'] === 'string' ? (uo['inference_geo'] as string) : null;
  const speed = typeof uo['speed'] === 'string' ? (uo['speed'] as string) : null;
  // standard = service_tier "standard"; inference_geo "global"/"not_available"/absent (US-only => 1.1x); speed "standard"/absent ("fast" = premium)
  const pricingTerms = terms(tier, geo, speed, ['standard', ''], { geoStandard: (g) => g === null || g === 'global' || g === 'not_available', speedStandard: (s) => s === null || s === 'standard' });

  if (!usageObj || typeof usageObj !== 'object') {
    return { api: 'anthropic.messages', outcome: 'ERROR_NO_USAGE', httpStatus, modelServed, usage: emptyUsage([`no usage object (http ${httpStatus})`]), pricingTerms, flags: ['no_usage'], errorCode, stopReason: stopReasonOf(b['stop_reason']), truncated: b['stop_reason'] === undefined ? 'UNKNOWN' : b['stop_reason'] === 'max_tokens' };
  }
  const u = emptyUsage();
  u.usageSource = 'provider_response';
  u.rawUsageSanitized = sanitizeNumbers(usageObj);
  const input = intAt(usageObj, 'input_tokens');
  const output = intAt(usageObj, 'output_tokens');
  const cr = intAt(usageObj, 'cache_read_input_tokens');
  const cw = intAt(usageObj, 'cache_creation_input_tokens');
  const cw5 = intAt(usageObj, 'cache_creation.ephemeral_5m_input_tokens');
  const cw1 = intAt(usageObj, 'cache_creation.ephemeral_1h_input_tokens');
  const think = intAt(usageObj, 'output_tokens_details.thinking_tokens');
  u.inputUncached = input; // excludes cache (R08 §4 / contract §4)
  u.cacheRead = cr;
  u.cacheWrite = cw; u.cacheWrite5m = cw5; u.cacheWrite1h = cw1;
  if (cw5 === UNKNOWN && cw1 === UNKNOWN && typeof cw === 'bigint') u.notes.push('cache_creation 5m/1h split absent: only the total write is known');
  if (cr === UNKNOWN || cw === UNKNOWN) u.notes.push('cache fields absent: cache read/write UNKNOWN (not assumed 0)');
  // F-INT-2 (R14-FIX): `output_tokens_details` is absent when the model did not think. Rule (R08 §8 + messages-create.html):
  //  - thinking was NOT enabled for this response => reasoning = NOT_APPLICABLE (thinking off by construction, not "absent") and
  //    outputVisible = output_tokens. "Not enabled" is established by ctx.thinkingRequested === false, or, body-only, by a
  //    manual-only model (claude-haiku-4-5-*, where omitting `thinking` disables it) whose content has no thinking block;
  //  - thinking enabled (adaptive/manual) and the detail absent => reasoning/visible UNKNOWN (never guessed).
  const contentBlocks = Array.isArray(b['content']) ? (b['content'] as Array<Record<string, unknown>>) : [];
  const hasThinkingBlock = contentBlocks.some((c) => c['type'] === 'thinking' || c['type'] === 'redacted_thinking');
  const manualOnlyModel = /^claude-haiku-4-5(-|$)/.test(modelServed);
  const thinkingOff = !hasThinkingBlock && (ctx.thinkingRequested === false || (ctx.thinkingRequested === undefined && manualOnlyModel));
  if (think === UNKNOWN && thinkingOff) { u.reasoning = NA; u.outputVisible = output; u.notes.push(`output_tokens_details absent and thinking not enabled (${ctx.thinkingRequested === false ? 'request without thinking' : 'manual-only model without thinking block'}): reasoning NOT_APPLICABLE, outputVisible = output_tokens`); }
  else {
    u.reasoning = think;
    u.outputVisible = sub(output, think);
    if (think === UNKNOWN) u.notes.push('output_tokens_details.thinking_tokens absent with thinking possibly enabled: reasoning/visible split UNKNOWN');
  }
  u.providerTotals = { inputTotal: typeof input === 'bigint' && typeof cr === 'bigint' && typeof cw === 'bigint' ? input + cr + cw : UNKNOWN, outputTotal: output };
  u.toolTokens = NA; // no server tools requested; iterations/server_tool_use would be flagged below
  u.imageUnits = ctx.requestModalities.includes('image') ? UNKNOWN : NA;
  if (ctx.requestModalities.includes('image')) u.notes.push('visual tokens are inside input_tokens; no separate field in the Messages usage object');
  u.audioUnits = NA; // Messages API has no audio input (R08 §6)

  let outcome: ParsedResponse['outcome'] = 'OK';
  const content = Array.isArray(b['content']) ? (b['content'] as Array<Record<string, unknown>>) : [];
  if (httpStatus !== 200 || err) { outcome = 'ERROR_WITH_USAGE'; flags.push('http_error_with_usage'); }
  else {
    if (b['stop_reason'] === 'refusal') { flags.push('stop_reason_refusal'); outcome = 'REFUSED_WITH_USAGE'; }
    if (content.some((c) => c['type'] === 'refusal')) { flags.push('refusal_block'); outcome = 'REFUSED_WITH_USAGE'; }
    if (content.some((c) => c['type'] === 'tool_use' || c['type'] === 'server_tool_use')) { flags.push('tool_use'); outcome = 'INCOMPLETE_UNEXPECTED_CONTENT'; }
    if (content.some((c) => c['type'] === 'thinking' || c['type'] === 'redacted_thinking')) flags.push('thinking_block');
    if (content.some((c) => c['type'] !== 'text' && c['type'] !== 'thinking' && c['type'] !== 'redacted_thinking' && c['type'] !== 'refusal' && c['type'] !== 'tool_use' && c['type'] !== 'server_tool_use')) { flags.push('unexpected_content_type'); outcome = 'INCOMPLETE_UNEXPECTED_CONTENT'; }
    if (uo['server_tool_use'] || uo['iterations']) { flags.push('server_tool_usage_present'); outcome = 'INCOMPLETE_UNEXPECTED_CONTENT'; }
    if (b['stop_reason'] === 'max_tokens') flags.push('stop_reason_max_tokens');
  }
  u.usageCompleteness = completeness(u);
  const stopReason = stopReasonOf(b['stop_reason']);
  return { api: 'anthropic.messages', outcome, httpStatus, modelServed, usage: u, pricingTerms, flags, errorCode, stopReason, truncated: stopReason === 'UNKNOWN' ? 'UNKNOWN' : stopReason === 'max_tokens' };
}
