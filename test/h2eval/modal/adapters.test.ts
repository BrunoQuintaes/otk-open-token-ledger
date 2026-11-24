/** R14: request builders and usage parsers against documented response shapes (fixtures/responses/*.json). Offline. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, modalitySupport, buildOpenAiChatRequest, buildAnthropicMessagesRequest, buildGoogleGenerateContentRequest, parseOpenAiChatResponse, parseAnthropicMessagesResponse, parseGoogleGenerateContentResponse } from '../../../scripts/h2eval/modal/adapters/index.js';
import { cacheObserved } from '../../../scripts/h2eval/modal/canonical.js';

const fx = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/responses/${name}.json`, import.meta.url)), 'utf8')) as Record<string, { httpStatus: number; body: unknown }>;
const OA = fx('openai_chat'); const AN = fx('anthropic_messages'); const GO = fx('google_generate_content');
const T = { requestModalities: ['text'] as Array<'text' | 'image' | 'audio'> };

describe('request builders fix the price-relevant parameters', () => {
  it('openai: service_tier default, stream false, max_completion_tokens, no reasoning parameter', () => {
    const r = buildOpenAiChatRequest({ model: 'gpt-4o-mini-2024-07-18', messages: [{ role: 'user', parts: [{ kind: 'text', text: 'oi' }] }], maxOutputTokens: 24 });
    assert.equal(r.path, '/v1/chat/completions');
    assert.deepEqual([r.body['service_tier'], r.body['stream'], r.body['max_completion_tokens'], 'n' in r.body, 'max_tokens' in r.body], ['default', false, 24, false, false]);
    assert.equal((r.body['messages'] as Array<{ content: unknown }>)[0]!.content, 'oi'); // text-only => string (documented TextContent)
    assert.equal('reasoning_effort' in r.body, false);
    assert.equal('headersTemplate' in r, false); // R15-B4: no header template with a credential placeholder; the core injects the key at send time
    assert.deepEqual(r.requestModalities, ['text']);
    const img = buildOpenAiChatRequest({ model: 'gpt-4o-mini-2024-07-18', messages: [{ role: 'user', parts: [{ kind: 'text', text: 'o que ha?' }, { kind: 'image', dataUrlOrUrl: 'data:image/png;base64,AAAA', detail: 'high' }] }], maxOutputTokens: 24 });
    assert.deepEqual(img.requestModalities, ['text', 'image']);
    assert.equal(((img.body['messages'] as Array<{ content: Array<{ type: string; image_url?: { detail: string } }> }>)[0].content[1].image_url!.detail), 'high');
  });
  it('anthropic: standard_only, stream false, max_tokens; haiku-4-5 without thinking; haiku-5-5 effort low; no cache_control unless asked', () => {
    const a = buildAnthropicMessagesRequest({ model: 'claude-haiku-4-5-20251001', messages: [{ role: 'user', parts: [{ kind: 'text', text: 'oi' }] }], maxOutputTokens: 24 });
    assert.deepEqual([a.body['service_tier'], a.body['stream'], a.body['max_tokens']], ['standard_only', false, 24]);
    assert.equal('thinking' in a.body, false); assert.equal('output_config' in a.body, false); assert.equal('inference_geo' in a.body, false); assert.equal('speed' in a.body, false);
    assert.equal(JSON.stringify(a.body).includes('cache_control'), false);
    const b = buildAnthropicMessagesRequest({ model: 'claude-haiku-5-5', messages: [{ role: 'user', parts: [{ kind: 'text', text: 'prefixo', cacheBreakpoint: { ttl: '5m' } }] }], maxOutputTokens: 24 });
    assert.deepEqual(b.body['output_config'], { effort: 'low' }); assert.equal('thinking' in b.body, false);
    assert.match(b.params.reasoning, /OFF not documented \(NOT_VERIFIED\)/);
    assert.equal(JSON.stringify(b.body).includes('"cache_control":{"type":"ephemeral"}'), true);
    assert.equal('headersTemplate' in b, false); // R15-B4 (the anthropic-version header is set by modal/index.ts buildRequest)
  });
  it('google: generateContent path, thinkingLevel MINIMAL, maxOutputTokens, inlineData parts set modalities', () => {
    const g = buildGoogleGenerateContentRequest({ model: 'gemini-3.5-flash-lite', contents: [{ role: 'user', parts: [{ kind: 'text', text: 'oi' }, { kind: 'audio', mimeType: 'audio/wav', base64: 'AAAA' }] }], maxOutputTokens: 24 });
    assert.equal(g.path, '/v1beta/models/gemini-3.5-flash-lite:generateContent');
    assert.deepEqual(g.body['generationConfig'], { maxOutputTokens: 24, thinkingConfig: { thinkingLevel: 'MINIMAL' } }); // no candidateCount (R14-FIX)
    assert.deepEqual(g.requestModalities, ['text', 'audio']);
    assert.equal(g.params.stream, false);
  });
  it('modality support follows R08 §5-6', () => {
    assert.equal(modalitySupport('gpt-4o-mini-2024-07-18', 'audio'), 'NOT_SUPPORTED');
    assert.equal(modalitySupport('claude-haiku-4-5-20251001', 'audio'), 'NOT_SUPPORTED');
    assert.equal(modalitySupport('claude-haiku-5-5', 'image'), 'SUPPORTED');
    assert.equal(modalitySupport('gemini-3.5-flash-lite', 'audio'), 'SUPPORTED');
    assert.equal(Object.keys(ADAPTERS).length, 8); // + claude-sonnet-5-5, claude-opus-5-5 (C157 §9.2); + gemini-3.1-flash-lite, gpt-6-luna (E3G, C160 BRACO-GO, text only)
    assert.equal(modalitySupport('gemini-3.1-flash-lite', 'image'), 'NOT_SUPPORTED'); assert.equal(modalitySupport('gpt-6-luna', 'image'), 'NOT_SUPPORTED');
  });
});

describe('openai chat parser', () => {
  it('maps every category disjointly (H1 record 448/24)', () => {
    const p = parseOpenAiChatResponse(OA['ok_text']!.httpStatus, OA['ok_text']!.body, T);
    assert.equal(p.outcome, 'OK'); assert.equal(p.modelServed, 'gpt-4o-mini-2024-07-18');
    assert.deepEqual([p.usage.inputUncached, p.usage.cacheRead, p.usage.outputVisible, p.usage.reasoning], [448n, 0n, 24n, 0n]);
    assert.deepEqual([p.usage.cacheWrite5m, p.usage.cacheWrite1h, p.usage.cacheWrite, p.usage.imageUnits, p.usage.audioUnits, p.usage.toolTokens], ['NOT_APPLICABLE', 'NOT_APPLICABLE', 'NOT_APPLICABLE', 'NOT_APPLICABLE', 'NOT_APPLICABLE', 'NOT_APPLICABLE']);
    assert.equal(p.usage.usageCompleteness, 'COMPLETE'); assert.equal(p.pricingTerms.standard, true);
    assert.equal(cacheObserved(p.usage), 'NO_HIT');
  });
  it('cache hit: prompt_tokens includes cached; inputUncached = prompt - cached', () => {
    const p = parseOpenAiChatResponse(200, OA['ok_cache_hit']!.body, T);
    assert.deepEqual([p.usage.inputUncached, p.usage.cacheRead, p.usage.providerTotals.inputTotal], [68n, 3328n, 3396n]);
    assert.equal(cacheObserved(p.usage), 'HIT');
  });
  it('absent details => UNKNOWN, never 0; completeness PARTIAL', () => {
    const p = parseOpenAiChatResponse(200, OA['ok_details_absent']!.body, T);
    assert.equal(p.usage.cacheRead, 'UNKNOWN'); assert.equal(p.usage.inputUncached, 'UNKNOWN'); assert.equal(p.usage.reasoning, 'NOT_APPLICABLE'); assert.equal(p.usage.outputVisible, 10n); // non-reasoning model (R14-FIX)
    assert.deepEqual([p.usage.providerTotals.inputTotal, p.usage.providerTotals.outputTotal], [100n, 10n]);
    assert.equal(p.usage.usageCompleteness, 'PARTIAL'); assert.equal(cacheObserved(p.usage), 'UNKNOWN');
  });
  it('image request: imageUnits UNKNOWN (inside prompt_tokens, no field) with a note', () => {
    const p = parseOpenAiChatResponse(200, OA['ok_image']!.body, { requestModalities: ['text', 'image'] });
    assert.equal(p.usage.imageUnits, 'UNKNOWN'); assert.match(p.usage.notes.join(' '), /inside prompt_tokens/);
  });
  it('refusals and content filter keep the usage (REFUSED_WITH_USAGE)', () => {
    assert.equal(parseOpenAiChatResponse(200, OA['refusal_with_usage']!.body, T).outcome, 'REFUSED_WITH_USAGE');
    const cf = parseOpenAiChatResponse(200, OA['content_filter']!.body, T); assert.equal(cf.outcome, 'REFUSED_WITH_USAGE'); assert.equal(cf.usage.inputUncached, 57n);
  });
  it('unexpected tool/audio output => INCOMPLETE_UNEXPECTED_CONTENT', () => {
    assert.equal(parseOpenAiChatResponse(200, OA['tool_calls_unexpected']!.body, T).outcome, 'INCOMPLETE_UNEXPECTED_CONTENT');
    const a = parseOpenAiChatResponse(200, OA['audio_output_unexpected']!.body, T); assert.equal(a.outcome, 'INCOMPLETE_UNEXPECTED_CONTENT'); assert.ok(a.flags.includes('audio_output_tokens'));
  });
  it('non-standard tier is marked', () => { const p = parseOpenAiChatResponse(200, OA['tier_flex_nonstandard']!.body, T); assert.equal(p.pricingTerms.standard, false); assert.deepEqual(p.pricingTerms.nonStandardReasons, ['service_tier=flex']); });
  it('errors without usage => ERROR_NO_USAGE with code, counts UNKNOWN', () => {
    const e = parseOpenAiChatResponse(429, OA['error_429_no_usage']!.body, T); assert.equal(e.outcome, 'ERROR_NO_USAGE'); assert.equal(e.errorCode, 'rate_limit_exceeded'); assert.equal(e.usage.inputUncached, 'UNKNOWN'); assert.equal(e.usage.usageCompleteness, 'MISSING');
    assert.equal(parseOpenAiChatResponse(400, OA['error_400_invalid_json']!.body, T).errorCode, 'invalid_json');
  });
  it('modelServed is raw, never normalized', () => { assert.equal(parseOpenAiChatResponse(200, OA['model_served_differs']!.body, T).modelServed, 'gpt-4o-mini-2099-01-01'); });
});

describe('anthropic messages parser', () => {
  it('input_tokens excludes cache; H1 record 634/24', () => {
    const p = parseAnthropicMessagesResponse(200, AN['ok_text_haiku45']!.body, T);
    assert.equal(p.outcome, 'OK'); assert.deepEqual([p.usage.inputUncached, p.usage.cacheRead, p.usage.cacheWrite5m, p.usage.cacheWrite1h, p.usage.outputVisible], [634n, 0n, 0n, 0n, 24n]);
    assert.equal(p.usage.reasoning, 'NOT_APPLICABLE'); // R14-FIX (F-INT-2): details absent on a manual-only model without thinking block => thinking off, not "absent"
    assert.equal(p.usage.providerTotals.outputTotal, 24n); assert.equal(p.pricingTerms.standard, true); assert.equal(p.usage.audioUnits, 'NOT_APPLICABLE');
  });
  it('haiku-5-5 thinking tokens are a subset of output', () => {
    const p = parseAnthropicMessagesResponse(200, AN['ok_text_haiku55_thinking']!.body, T);
    assert.deepEqual([p.usage.reasoning, p.usage.outputVisible, p.usage.providerTotals.outputTotal], [36n, 24n, 60n]); assert.equal(p.usage.usageCompleteness, 'COMPLETE');
  });
  it('cache creation / hit classified by usage', () => {
    const c = parseAnthropicMessagesResponse(200, AN['ok_cache_creation_5m']!.body, T); assert.equal(cacheObserved(c.usage), 'CREATION'); assert.equal(c.usage.cacheWrite5m, 4600n);
    const h = parseAnthropicMessagesResponse(200, AN['ok_cache_hit']!.body, T); assert.equal(cacheObserved(h.usage), 'HIT'); assert.equal(h.usage.providerTotals.inputTotal, 4695n);
    const n = parseAnthropicMessagesResponse(200, AN['ok_cache_write_no_split']!.body, T); assert.equal(n.usage.cacheWrite, 4600n); assert.equal(n.usage.cacheWrite5m, 'UNKNOWN');
  });
  it('refusals with usage (stop_reason refusal, refusal block)', () => {
    assert.equal(parseAnthropicMessagesResponse(200, AN['refusal_stop_reason_with_usage']!.body, T).outcome, 'REFUSED_WITH_USAGE');
    const b = parseAnthropicMessagesResponse(200, AN['refusal_block_with_usage']!.body, T); assert.equal(b.outcome, 'REFUSED_WITH_USAGE'); assert.equal(b.usage.inputUncached, 2095n); assert.equal(b.usage.cacheWrite5m, 2051n);
  });
  it('tool use => INCOMPLETE; geo us / speed fast => non-standard', () => {
    assert.equal(parseAnthropicMessagesResponse(200, AN['tool_use_unexpected']!.body, T).outcome, 'INCOMPLETE_UNEXPECTED_CONTENT');
    assert.deepEqual(parseAnthropicMessagesResponse(200, AN['geo_us_nonstandard']!.body, T).pricingTerms.nonStandardReasons, ['inference_geo=us']);
    assert.deepEqual(parseAnthropicMessagesResponse(200, AN['speed_fast_nonstandard']!.body, T).pricingTerms.nonStandardReasons, ['speed=fast']);
  });
  it('errors without usage', () => { const e = parseAnthropicMessagesResponse(429, AN['error_429_no_usage']!.body, T); assert.equal(e.outcome, 'ERROR_NO_USAGE'); assert.equal(e.errorCode, 'rate_limit_error'); assert.equal(e.modelServed, 'UNKNOWN'); });
});

describe('google generateContent parser', () => {
  it('H1 record 450/20; thoughts are a separate addend', () => {
    const p = parseGoogleGenerateContentResponse(200, GO['ok_text']!.body, T);
    assert.equal(p.outcome, 'OK'); assert.equal(p.modelServed, 'gemini-3.5-flash-lite');
    assert.deepEqual([p.usage.outputVisible, p.usage.reasoning], [20n, 0n]); // thoughtsTokenCount absent, but totalTokenCount 470 = 450 + 20 => derived 0 (documented identity), not assumed
    assert.match(p.usage.notes.join(' '), /derived 0 from totalTokenCount/);
    const r = parseGoogleGenerateContentResponse(200, { ...(GO['ok_text']!.body as object), usageMetadata: { promptTokenCount: 450, candidatesTokenCount: 20, totalTokenCount: 480 } }, T);
    assert.equal(r.usage.reasoning, 'UNKNOWN'); assert.equal(r.usage.providerTotals.outputTotal, 'UNKNOWN'); // remainder 10 without a field: UNKNOWN, never guessed
    assert.ok(p.flags.includes('finish_reason_max_tokens'));
    const t = parseGoogleGenerateContentResponse(200, GO['ok_text_thoughts']!.body, T); assert.deepEqual([t.usage.outputVisible, t.usage.reasoning, t.usage.providerTotals.outputTotal], [20n, 37n, 57n]);
  });
  it('cached field present => split; absent => UNKNOWN (not 0)', () => {
    const h = parseGoogleGenerateContentResponse(200, GO['ok_cache_hit']!.body, T); assert.deepEqual([h.usage.inputUncached, h.usage.cacheRead], [2196n, 2032n]); assert.equal(cacheObserved(h.usage), 'HIT');
    const a = parseGoogleGenerateContentResponse(200, GO['ok_cache_field_absent']!.body, T); assert.equal(a.usage.cacheRead, 'UNKNOWN'); assert.equal(a.usage.inputUncached, 'UNKNOWN'); assert.equal(a.usage.providerTotals.inputTotal, 4228n); assert.equal(a.pricingTerms.standard, true);
  });
  it('image and audio units from promptTokensDetails by modality', () => {
    const i = parseGoogleGenerateContentResponse(200, GO['ok_image']!.body, { requestModalities: ['text', 'image'] }); assert.equal(i.usage.imageUnits, 1548n); assert.equal(i.usage.audioUnits, 'NOT_APPLICABLE');
    const a = parseGoogleGenerateContentResponse(200, GO['ok_audio']!.body, { requestModalities: ['text', 'audio'] }); assert.equal(a.usage.audioUnits, 1920n);
  });
  it('blocked prompt / safety finish keep usage; function call => INCOMPLETE; flex => non-standard', () => {
    const b = parseGoogleGenerateContentResponse(200, GO['blocked_prompt_with_usage']!.body, T); assert.equal(b.outcome, 'REFUSED_WITH_USAGE'); assert.equal(b.usage.providerTotals.inputTotal, 57n); assert.equal(b.usage.outputVisible, 'UNKNOWN');
    assert.equal(parseGoogleGenerateContentResponse(200, GO['finish_safety_with_usage']!.body, T).outcome, 'REFUSED_WITH_USAGE');
    assert.equal(parseGoogleGenerateContentResponse(200, GO['function_call_unexpected']!.body, T).outcome, 'INCOMPLETE_UNEXPECTED_CONTENT');
    assert.deepEqual(parseGoogleGenerateContentResponse(200, GO['tier_flex_nonstandard']!.body, T).pricingTerms.nonStandardReasons, ['service_tier=flex']);
  });
  it('errors without usage', () => { const e = parseGoogleGenerateContentResponse(429, GO['error_429_no_usage']!.body, T); assert.equal(e.outcome, 'ERROR_NO_USAGE'); assert.equal(e.errorCode, 'RESOURCE_EXHAUSTED'); });
});

describe('contract invariants over every fixture', () => {
  it('no absent field ever becomes 0; rawUsageSanitized holds numbers only', () => {
    const all: Array<[string, { httpStatus: number; body: unknown }, (s: number, b: unknown) => ReturnType<typeof parseOpenAiChatResponse>]> = [];
    for (const [k, v] of Object.entries(OA)) if (!k.startsWith('_')) all.push([k, v, (s, b) => parseOpenAiChatResponse(s, b, T)]);
    for (const [k, v] of Object.entries(AN)) if (!k.startsWith('_')) all.push([k, v, (s, b) => parseAnthropicMessagesResponse(s, b, T)]);
    for (const [k, v] of Object.entries(GO)) if (!k.startsWith('_')) all.push([k, v, (s, b) => parseGoogleGenerateContentResponse(s, b, T)]);
    for (const [k, v, f] of all) {
      const p = f(v.httpStatus, v.body);
      for (const [name, c] of Object.entries(p.usage)) { if (typeof c === 'bigint') assert.ok(c >= 0n, `${k}.${name}`); }
      for (const val of Object.values(p.usage.rawUsageSanitized)) assert.ok(val === null || typeof val === 'number', k);
      // a zero can only come from an explicit 0 in the body
      const txt = JSON.stringify(v.body);
      if (p.usage.cacheRead === 0n) assert.ok(/cached_tokens":0|cache_read_input_tokens":0|cachedContentTokenCount":0/.test(txt), `${k}: cacheRead 0 without an explicit 0`);
    }
  });
});
