/** R14: the ProviderAdapter surface published by BOT-02 (INTERFACES.md §2, §9), exercised with a plan and resolved content. Offline, pure. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, adapterForModel, AdapterError } from '../../../scripts/h2eval/modal/index.js';
import type { OperationPlan, ResolvedContent } from '../../../scripts/h2eval/modal/index.js';

const fx = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/responses/${name}.json`, import.meta.url)), 'utf8')) as Record<string, { httpStatus: number; body: unknown }>;
const png = readFileSync(fileURLToPath(new URL('./fixtures/images/synthetic_200x200_flat.png', import.meta.url)));

function plan(over: Partial<OperationPlan> & Pick<OperationPlan, 'provider' | 'api' | 'modelRequested'>): OperationPlan {
  return { schema: 'h2eval.plan.v0', studyId: 'h2eval', protocolHash: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), batchId: 'b1', phase: 'PILOT', cellId: 'summary_S', groupId: 'g1', promptId: 'p1', rep: 1, variant: 'v0', split: 'NONE', endpoint: 'x', task: 'summary', sizeBucket: 'S', structure: 'S1', modality: 'text', plannedCacheArm: 'S1', promptSha256: 'c'.repeat(64), prefixSha256: 'NOT_APPLICABLE', nonce: 'NOT_APPLICABLE', params: { maxTokens: 24, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: 'NONE', cacheDirectives: 'NONE' }, ...over };
}
const content = (parts: ResolvedContent['messages'][number]['parts'], prefixMessages: ResolvedContent['prefixMessages'] = 'NOT_APPLICABLE'): ResolvedContent => ({ promptSha256: 'c'.repeat(64), messages: [{ role: 'user', parts }], prefixMessages });
const TXT = { type: 'text' as const, text: 'Resuma: o gato subiu no telhado.' };

describe('ADAPTERS registry', () => {
  it('has the three APIs, official hosts, and the H1 model catalog behind modelSupport', () => {
    assert.deepEqual(Object.keys(ADAPTERS).sort(), ['anthropic.messages', 'gemini.generate_content', 'openai.chat_completions']);
    assert.deepEqual(ADAPTERS['openai.chat_completions'].officialHosts, ['api.openai.com']);
    assert.equal(ADAPTERS['openai.chat_completions'].modelSupport('gpt-4o-mini-2024-07-18').support, 'alias_known');
    assert.equal(ADAPTERS['anthropic.messages'].modelSupport('claude-haiku-5-5').tokenizer?.encoding, 'cl100k_base');
    assert.equal(adapterForModel('gemini-3.5-flash-lite').provider, 'google');
  });
});

describe('buildRequest applies plan.params and never invents parameters', () => {
  it('openai: credential never in headers; body hashed by core; textParts from the H1 extractor', () => {
    const a = ADAPTERS['openai.chat_completions'];
    const r = a.buildRequest(plan({ provider: 'openai', api: 'openai.chat_completions', modelRequested: 'gpt-4o-mini-2024-07-18', params: { maxTokens: 24, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: 'default', cacheDirectives: 'NONE' } }), content([TXT]));
    assert.equal(r.url, 'https://api.openai.com/v1/chat/completions'); assert.equal(r.credentialHeader, 'authorization'); assert.equal(r.credentialFormat, 'bearer');
    assert.equal(JSON.stringify(r).toLowerCase().includes('api_key'), false); assert.equal('authorization' in r.headers, false);
    assert.deepEqual(r.textParts, [TXT.text]); assert.deepEqual(r.nonTextParts, []);
    assert.equal((r.body as Record<string, unknown>)['service_tier'], 'default'); assert.equal('temperature' in (r.body as object), false);
    assert.throws(() => a.buildRequest(plan({ provider: 'openai', api: 'openai.chat_completions', modelRequested: 'gpt-4o-mini-2024-07-18', params: { maxTokens: 24, temperature: 'DEFAULT', reasoning: { reasoning_effort: 'low' }, serviceTier: 'NONE', cacheDirectives: 'NONE' } }), content([TXT])), (e: unknown) => e instanceof AdapterError && e.code === 'H2EVAL_PARAM_NOT_DOCUMENTED');
    assert.throws(() => a.buildRequest(plan({ provider: 'openai', api: 'openai.chat_completions', modelRequested: 'gpt-4o-mini-2024-07-18', params: { maxTokens: 24, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: 'flex', cacheDirectives: 'NONE' } }), content([TXT])), /H2EVAL_PARAM_NOT_DOCUMENTED/);
    assert.throws(() => a.buildRequest(plan({ provider: 'openai', api: 'openai.chat_completions', modelRequested: 'gpt-4o-mini-2024-07-18' }), content([TXT, { type: 'audio', mime: 'audio/wav', bytesSha256: 'd'.repeat(64), seconds: 10, bytesBase64: 'AAAA' }])), /H2EVAL_MODALITY_NOT_SUPPORTED/);
  });
  it('image part: nonTextParts lists it with UNKNOWN units; bytes must be resolved (pure adapter cannot fetch)', () => {
    const a = ADAPTERS['openai.chat_completions'];
    const img = { type: 'image' as const, mime: 'image/png', bytesSha256: 'e'.repeat(64), width: 200, height: 200 };
    assert.throws(() => a.buildRequest(plan({ provider: 'openai', api: 'openai.chat_completions', modelRequested: 'gpt-4o-mini-2024-07-18', modality: 'image' }), content([TXT, img])), /H2EVAL_BINARY_NOT_RESOLVED/);
    const r = a.buildRequest(plan({ provider: 'openai', api: 'openai.chat_completions', modelRequested: 'gpt-4o-mini-2024-07-18', modality: 'image' }), content([TXT, { ...img, bytesBase64: png.toString('base64') }]));
    assert.equal(r.nonTextParts.length, 1); assert.equal(r.nonTextParts[0]!.kind, 'image'); assert.equal(r.nonTextParts[0]!.units, 'UNKNOWN');
    assert.deepEqual(r.textParts, [TXT.text]);
  });
  it('anthropic: cache_control only when the plan asks, on the last text block of the prefix; reasoning per model', () => {
    const a = ADAPTERS['anthropic.messages'];
    const c: ResolvedContent = { promptSha256: 'c'.repeat(64), messages: [{ role: 'user', parts: [{ type: 'text', text: 'prefixo longo' }] }, { role: 'assistant', parts: [{ type: 'text', text: 'ok' }] }, { role: 'user', parts: [{ type: 'text', text: 'pergunta' }] }], prefixMessages: 2 };
    const r = a.buildRequest(plan({ provider: 'anthropic', api: 'anthropic.messages', modelRequested: 'claude-haiku-4-5-20251001', structure: 'S3', plannedCacheArm: 'S3_HITATTEMPT', params: { maxTokens: 24, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: 'standard_only', cacheDirectives: { cache_control: 'ephemeral' } } }), c);
    const msgs = (r.body as { messages: Array<{ content: Array<Record<string, unknown>> }> }).messages;
    assert.deepEqual(msgs[1]!.content[0]!['cache_control'], { type: 'ephemeral' }); assert.equal('cache_control' in msgs[0]!.content[0]!, false); assert.equal('cache_control' in msgs[2]!.content[0]!, false);
    assert.equal(r.credentialHeader, 'x-api-key'); assert.equal(r.headers['anthropic-version'], '2023-06-01'); assert.equal('x-api-key' in r.headers, false);
    assert.equal('thinking' in (r.body as object), false);
    const h55 = a.buildRequest(plan({ provider: 'anthropic', api: 'anthropic.messages', modelRequested: 'claude-haiku-5-5', params: { maxTokens: 24, temperature: 'DEFAULT', reasoning: { effort: 'low' }, serviceTier: 'standard_only', cacheDirectives: 'NONE' } }), content([TXT]));
    assert.deepEqual((h55.body as Record<string, unknown>)['output_config'], { effort: 'low' });
    assert.throws(() => a.buildRequest(plan({ provider: 'anthropic', api: 'anthropic.messages', modelRequested: 'claude-haiku-5-5', params: { maxTokens: 24, temperature: 'DEFAULT', reasoning: { budget_tokens: 1024 }, serviceTier: 'NONE', cacheDirectives: 'NONE' } }), content([TXT])), /H2EVAL_PARAM_NOT_DOCUMENTED/); // rejected by Claude 4.7+ (R08 §8)
    assert.throws(() => a.buildRequest(plan({ provider: 'anthropic', api: 'anthropic.messages', modelRequested: 'claude-haiku-4-5-20251001' }), content([TXT, { type: 'audio', mime: 'audio/wav', bytesSha256: 'd'.repeat(64), seconds: 10, bytesBase64: 'AAAA' }])), /H2EVAL_MODALITY_NOT_SUPPORTED/);
  });
  it('google: thinking_level mapped, no tier parameter, audio part accepted and listed', () => {
    const a = ADAPTERS['gemini.generate_content'];
    const r = a.buildRequest(plan({ provider: 'google', api: 'gemini.generate_content', modelRequested: 'gemini-3.5-flash-lite', modality: 'audio', params: { maxTokens: 24, temperature: 'DEFAULT', reasoning: { thinking_level: 'minimal' }, serviceTier: 'NONE', cacheDirectives: 'NONE' } }), content([TXT, { type: 'audio', mime: 'audio/wav', bytesSha256: 'd'.repeat(64), seconds: 10, bytesBase64: 'AAAA' }]));
    assert.equal(r.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent'); assert.equal(r.credentialHeader, 'x-goog-api-key');
    assert.deepEqual((r.body as { generationConfig: Record<string, unknown> }).generationConfig['thinkingConfig'], { thinkingLevel: 'MINIMAL' });
    assert.equal(r.nonTextParts[0]!.kind, 'audio'); assert.match(r.nonTextParts[0]!.unit, /UNSUPPORTED_FOR_ESTIMATION/);
    assert.throws(() => a.buildRequest(plan({ provider: 'google', api: 'gemini.generate_content', modelRequested: 'gemini-3.5-flash-lite', params: { maxTokens: 24, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: 'standard', cacheDirectives: 'NONE' } }), content([TXT])), /H2EVAL_PARAM_NOT_DOCUMENTED/);
  });
});

describe('parseUsage / parseRefusal (INTERFACES §2)', () => {
  it('openai: U = prompt_tokens; cacheObserved by usage; rawUsageSanitized numbers only', () => {
    const u = ADAPTERS['openai.chat_completions'].parseUsage(fx('openai_chat')['ok_cache_hit']!.body);
    assert.equal(u.schema, 'h2eval.usage.v0'); assert.deepEqual([u.inputUncached, u.cacheRead, u.U, u.cacheObserved], [68, 3328, 3396, 'HIT']);
    assert.equal(u.modelServed, 'gpt-4o-mini-2024-07-18'); assert.equal(u.serviceTierServed, 'default'); assert.ok(Object.values(u.rawUsageSanitized).every((v) => typeof v === 'number'));
    const r = ADAPTERS['openai.chat_completions'].parseRefusal(200, fx('openai_chat')['refusal_with_usage']!.body); assert.deepEqual(r, { refused: true, code: 'refusal', httpStatus: 200, usagePresent: true });
    const e = ADAPTERS['openai.chat_completions'].parseRefusal(429, fx('openai_chat')['error_429_no_usage']!.body); assert.deepEqual(e, { refused: false, code: 'rate_limit', httpStatus: 429, usagePresent: false });
    assert.equal(ADAPTERS['openai.chat_completions'].parseRefusal(200, fx('openai_chat')['content_filter']!.body).code, 'content_filter');
  });
  it('anthropic: U = input + cache read + writes; refusal codes; UNKNOWN never 0', () => {
    const u = ADAPTERS['anthropic.messages'].parseUsage(fx('anthropic_messages')['refusal_block_with_usage']!.body);
    assert.deepEqual([u.inputUncached, u.cacheRead, u.cacheWrite5m, u.U], [2095, 2051, 2051, 2095 + 2051 + 2051]); assert.equal(u.cacheObserved, 'HIT');
    assert.deepEqual(ADAPTERS['anthropic.messages'].parseRefusal(200, fx('anthropic_messages')['refusal_block_with_usage']!.body), { refused: true, code: 'refusal', httpStatus: 200, usagePresent: true });
    const a = ADAPTERS['anthropic.messages'].parseUsage(fx('anthropic_messages')['ok_text_haiku45']!.body); assert.equal(a.reasoning, 'NOT_APPLICABLE'); assert.equal(a.outputVisible, 24); assert.equal(a.usageCompleteness, 'COMPLETE'); // R14-FIX
    assert.equal(ADAPTERS['anthropic.messages'].parseRefusal(400, fx('anthropic_messages')['error_400_no_usage']!.body).code, 'invalid_request');
  });
  it('google: thoughts separate; modality units; blocked prompt => blocked_prompt with usage', () => {
    const u = ADAPTERS['gemini.generate_content'].parseUsage(fx('google_generate_content')['ok_audio']!.body); assert.equal(u.audioUnits, 1920); assert.equal(u.imageUnits, 'UNKNOWN'); // image units unknown when the request modality is not told to parseUsage
    const t = ADAPTERS['gemini.generate_content'].parseUsage(fx('google_generate_content')['ok_text_thoughts']!.body); assert.deepEqual([t.outputVisible, t.reasoning], [20, 37]);
    assert.deepEqual(ADAPTERS['gemini.generate_content'].parseRefusal(200, fx('google_generate_content')['blocked_prompt_with_usage']!.body), { refused: true, code: 'blocked_prompt', httpStatus: 200, usagePresent: true });
    assert.equal(ADAPTERS['gemini.generate_content'].parseRefusal(200, fx('google_generate_content')['finish_safety_with_usage']!.body).code, 'safety');
    assert.equal(ADAPTERS['gemini.generate_content'].parseRefusal(429, fx('google_generate_content')['error_429_no_usage']!.body).code, 'rate_limit');
  });
});
