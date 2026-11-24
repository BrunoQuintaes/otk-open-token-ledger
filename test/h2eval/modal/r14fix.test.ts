/** R14-FIX: F-INT-2 (Haiku 4.5 ends UNCERTAIN: outputVisible/reasoning UNKNOWN without output_tokens_details) and F-INT-1 (the adapter is the single source of the body; system block + breakpoint at the end of the stable prefix; OpenAI/Google field decisions). Offline. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ADAPTERS, bodyOf, canonicalJson, AdapterError, loadPriceTable, computeCost, parseAnthropicMessagesResponse, parseOpenAiChatResponse } from '../../../scripts/h2eval/modal/index.js';
import type { OperationPlan, ResolvedContent } from '../../../scripts/h2eval/modal/index.js';

const fx = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/responses/${name}.json`, import.meta.url)), 'utf8')) as Record<string, { httpStatus: number; body: unknown }>;
const AN = fx('anthropic_messages'); const OA = fx('openai_chat'); const PT = loadPriceTable();
const T = { requestModalities: ['text'] as Array<'text' | 'image' | 'audio'> };

function plan(model: string, over: Partial<OperationPlan> = {}, params: Partial<OperationPlan['params']> = {}): OperationPlan {
  const provider = model.startsWith('gpt') ? 'openai' : model.startsWith('gemini') ? 'google' : 'anthropic';
  const api = provider === 'openai' ? 'openai.chat_completions' : provider === 'google' ? 'gemini.generate_content' : 'anthropic.messages';
  return { schema: 'h2eval.plan.v0', studyId: 's', protocolHash: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), batchId: 'b', phase: 'PILOT', cellId: 'c', groupId: 'g', promptId: 'p', rep: 1, variant: 'v', split: 'NONE', provider, api, endpoint: '', modelRequested: model, task: 'summary', sizeBucket: 'S', structure: 'S1', modality: 'text', plannedCacheArm: 'S1', promptSha256: 'c'.repeat(64), prefixSha256: 'NOT_APPLICABLE', nonce: 'NOT_APPLICABLE', params: { maxTokens: 64, temperature: 'DEFAULT', reasoning: 'NONE', serviceTier: provider === 'openai' ? 'default' : provider === 'anthropic' ? 'standard_only' : 'NONE', cacheDirectives: 'NONE', ...params }, ...over };
}
/** E2E-01 dialogue shape: system = stable prefix (prefixMessages = 1), then the turns. */
const dialog = (): ResolvedContent => ({ promptSha256: 'd'.repeat(64), prefixMessages: 1, messages: [{ role: 'system', parts: [{ type: 'text', text: 'PREFIXO ESTAVEL LONGO' }] }, { role: 'user', parts: [{ type: 'text', text: 'turno 1' }] }, { role: 'assistant', parts: [{ type: 'text', text: 'resposta 1' }] }, { role: 'user', parts: [{ type: 'text', text: 'turno 2' }] }] });

describe('F-INT-2: Haiku 4.5 without output_tokens_details must cost CALCULATED (root cause and fix)', () => {
  it('root cause reproduced through the published interface: ok_cache_creation_5m (the executor case) => outputVisible 24, reasoning NOT_APPLICABLE, CREATION 4600', () => {
    const u = ADAPTERS['anthropic.messages'].parseUsage(AN['ok_cache_creation_5m']!.body);
    assert.deepEqual([u.outputVisible, u.reasoning, u.cacheWrite5m, u.cacheObserved, u.usageCompleteness], [24, 'NOT_APPLICABLE', 4600, 'CREATION', 'COMPLETE']);
    const p = parseAnthropicMessagesResponse(200, AN['ok_cache_creation_5m']!.body, T); const c = computeCost('claude-haiku-4-5-20251001', p.usage, p.pricingTerms, PT);
    assert.equal(c.state, 'CALCULATED'); assert.equal(c.picoUsd, (120n * 1000000n + 4600n * 1250000n + 24n * 5000000n).toString()); assert.equal(c.usd, '0.00599');
    assert.match(p.usage.notes.join(' '), /manual-only model without thinking block/);
    const h = parseAnthropicMessagesResponse(200, AN['ok_cache_creation_1h']!.body, T); const ch = computeCost('claude-haiku-4-5-20251001', h.usage, h.pricingTerms, PT);
    assert.equal(ch.state, 'CALCULATED'); assert.equal(ch.byCategory['cacheWrite1h']!.priceMicroPerMTok, '2000000');
    const t = parseAnthropicMessagesResponse(200, AN['ok_text_haiku45']!.body, T); assert.equal(computeCost('claude-haiku-4-5-20251001', t.usage, t.pricingTerms, PT).usd, '0.000754'); // = H1 ledger
  });
  it('the rule is narrow: thinking block present, or an adaptive model, keeps UNKNOWN unless the request said thinking off', () => {
    const m = parseAnthropicMessagesResponse(200, AN['haiku45_manual_thinking_details_absent']!.body, T); assert.equal(m.usage.reasoning, 'UNKNOWN'); assert.equal(m.usage.outputVisible, 'UNKNOWN'); assert.ok(m.flags.includes('thinking_block'));
    assert.equal(computeCost('claude-haiku-4-5-20251001', m.usage, m.pricingTerms, PT).state, 'CALCULATED'); // same price for both => total still priced (reasoning/visible split unknown)
    const a = parseAnthropicMessagesResponse(200, AN['haiku55_details_absent']!.body, T); assert.equal(a.usage.reasoning, 'UNKNOWN'); assert.equal(a.usage.outputVisible, 'UNKNOWN');
    const off = parseAnthropicMessagesResponse(200, AN['haiku55_details_absent']!.body, { ...T, thinkingRequested: false }); assert.equal(off.usage.reasoning, 'NOT_APPLICABLE'); assert.equal(off.usage.outputVisible, 90n);
    const on = parseAnthropicMessagesResponse(200, AN['ok_text_haiku45']!.body, { ...T, thinkingRequested: true }); assert.equal(on.usage.reasoning, 'UNKNOWN'); // manual thinking requested, no detail, no block: not assumed
    assert.equal(ADAPTERS['anthropic.messages'].parseUsage(AN['ok_text_haiku55_thinking']!.body).reasoning, 36); // detail present always wins
  });
  it('same check on gpt-4o-mini (non-reasoning model) and on Gemini (derived from totalTokenCount)', () => {
    const p = parseOpenAiChatResponse(200, OA['ok_completion_details_absent']!.body, T); assert.deepEqual([p.usage.reasoning, p.usage.outputVisible, p.usage.cacheRead], ['NOT_APPLICABLE', 10n, 0n]);
    const c = computeCost('gpt-4o-mini-2024-07-18', p.usage, p.pricingTerms, PT); assert.equal(c.state, 'CALCULATED'); assert.equal(c.picoUsd, (100n * 150000n + 10n * 600000n).toString());
    const g = ADAPTERS['gemini.generate_content'].parseUsage(fx('google_generate_content')['ok_text']!.body); assert.deepEqual([g.outputVisible, g.reasoning], [20, 0]);
  });
});

describe('F-INT-1: the adapter body is the single source (bodyOf), aligned with the R07/R13 design and the archived documentation', () => {
  it('anthropic: system as a text block; with a cache plan and prefixMessages = 1 the breakpoint is ON THE SYSTEM BLOCK, nowhere else; ttl from cacheTtlRequested', () => {
    const p = plan('claude-haiku-4-5-20251001', { structure: 'S3', plannedCacheArm: 'S3_HITATTEMPT', prefixSha256: 'e'.repeat(64) }, { cacheDirectives: { cache_control: 'ephemeral' }, cacheTtlRequested: '5m' });
    const { body, bodySha256 } = bodyOf(p, dialog()); const b = body as { system: Array<Record<string, unknown>>; messages: Array<{ role: string; content: Array<Record<string, unknown>> }>; max_tokens: number; service_tier: string; stream: boolean };
    assert.deepEqual(b.system, [{ type: 'text', text: 'PREFIXO ESTAVEL LONGO', cache_control: { type: 'ephemeral' } }]);
    assert.equal(b.messages.length, 3); assert.ok(b.messages.every((m) => m.content.every((c) => !('cache_control' in c)))); assert.deepEqual(b.messages.map((m) => m.role), ['user', 'assistant', 'user']);
    assert.deepEqual([b.max_tokens, b.service_tier, b.stream, 'thinking' in b, 'output_config' in b], [64, 'standard_only', false, false, false]);
    assert.match(bodySha256, /^[0-9a-f]{64}$/);
    const p1h = plan('claude-haiku-4-5-20251001', { structure: 'S3' }, { cacheDirectives: { cache_control: 'ephemeral' }, cacheTtlRequested: '1h' });
    assert.deepEqual((bodyOf(p1h, dialog()).body as { system: Array<Record<string, unknown>> }).system[0]!['cache_control'], { type: 'ephemeral', ttl: '1h' });
    assert.notEqual(bodyOf(p1h, dialog()).bodySha256, bodySha256);
  });
  it('breakpoint rule by prefixMessages: 2 => last block of the first user turn; NOT_APPLICABLE with cache plan => last block of the last message; no cache plan => no cache_control anywhere (system still a block)', () => {
    const d = dialog();
    const two = bodyOf(plan('claude-haiku-5-5', {}, { reasoning: { effort: 'low' }, cacheDirectives: { cache_control: 'ephemeral' } }), { ...d, prefixMessages: 2 }).body as { system: Array<Record<string, unknown>>; messages: Array<{ content: Array<Record<string, unknown>> }> };
    assert.equal('cache_control' in two.system[0]!, false); assert.deepEqual(two.messages[0]!.content[0]!['cache_control'], { type: 'ephemeral' }); assert.equal('cache_control' in two.messages[2]!.content[0]!, false);
    const na = bodyOf(plan('claude-haiku-5-5', {}, { reasoning: { effort: 'low' }, cacheDirectives: { cache_control: 'ephemeral' } }), { ...d, prefixMessages: 'NOT_APPLICABLE' }).body as { messages: Array<{ content: Array<Record<string, unknown>> }> };
    assert.deepEqual(na.messages[2]!.content[0]!['cache_control'], { type: 'ephemeral' });
    const none = bodyOf(plan('claude-haiku-4-5-20251001'), d).body as { system: unknown };
    assert.deepEqual(none.system, [{ type: 'text', text: 'PREFIXO ESTAVEL LONGO' }]); assert.equal(JSON.stringify(none).includes('cache_control'), false);
    const s1 = bodyOf(plan('claude-haiku-4-5-20251001'), { promptSha256: 'f'.repeat(64), prefixMessages: 'NOT_APPLICABLE', messages: [{ role: 'user', parts: [{ type: 'text', text: 'so uma mensagem' }] }] }).body as Record<string, unknown>;
    assert.equal('system' in s1, false);
    assert.throws(() => bodyOf(plan('claude-haiku-4-5-20251001', {}, { cacheDirectives: { cache_control: 'ephemeral' } }), { ...d, prefixMessages: 0 }), (e: unknown) => e instanceof AdapterError && e.code === 'H2EVAL_CACHE_PREFIX_EMPTY');
  });
  it('openai: max_completion_tokens (max_tokens is documented as deprecated), text-only content as string, no n, stream:false, service_tier default', () => {
    const b = bodyOf(plan('gpt-4o-mini-2024-07-18'), dialog()).body as { messages: Array<{ role: string; content: unknown }>; max_completion_tokens: number; stream: boolean; service_tier: string };
    assert.deepEqual(b.messages, [{ role: 'system', content: 'PREFIXO ESTAVEL LONGO' }, { role: 'user', content: 'turno 1' }, { role: 'assistant', content: 'resposta 1' }, { role: 'user', content: 'turno 2' }]);
    assert.deepEqual([b.max_completion_tokens, 'max_tokens' in b, 'n' in b, b.stream, b.service_tier], [64, false, false, false, 'default']);
  });
  it('google: no candidateCount; thinkingLevel in the exact API enum; systemInstruction parts; roles user/model', () => {
    const b = bodyOf(plan('gemini-3.5-flash-lite', {}, { reasoning: { thinking_level: 'minimal' } }), dialog()).body as { systemInstruction: unknown; contents: Array<{ role: string }>; generationConfig: Record<string, unknown> };
    assert.deepEqual(b.generationConfig, { maxOutputTokens: 64, thinkingConfig: { thinkingLevel: 'MINIMAL' } });
    assert.deepEqual(b.systemInstruction, { parts: [{ text: 'PREFIXO ESTAVEL LONGO' }] }); assert.deepEqual(b.contents.map((c) => c.role), ['user', 'model', 'user']);
  });
  it('bodyOf is deterministic and rev. 2 params.thinking is honoured (and must agree with reasoning when both are present)', () => {
    const p = plan('claude-haiku-5-5', {}, { reasoning: 'NONE', thinking: { mode: 'adaptive', effort: 'low' } });
    const x = bodyOf(p, dialog()); const y = bodyOf(p, dialog()); assert.equal(x.bodySha256, y.bodySha256); assert.equal(x.canonical, canonicalJson(x.body));
    assert.deepEqual((x.body as Record<string, unknown>)['output_config'], { effort: 'low' });
    assert.throws(() => bodyOf(plan('claude-haiku-5-5', {}, { reasoning: { effort: 'high' }, thinking: { mode: 'adaptive', effort: 'low' } }), dialog()), /H2EVAL_PARAM_CONFLICT/);
    const g = bodyOf(plan('gemini-3.5-flash-lite', {}, { thinking: { mode: 'minimal', thinkingLevel: 'minimal' } }), dialog()); assert.deepEqual(((g.body as { generationConfig: Record<string, unknown> }).generationConfig)['thinkingConfig'], { thinkingLevel: 'MINIMAL' });
  });
});
