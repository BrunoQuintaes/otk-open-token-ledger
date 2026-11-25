/**
 * R14 addendum: contract rev. 2 items 3-8 and 10 in the modal module; cap violation => STOP. Offline.
 *
 * Tests the second-revision contract items implemented in the modal module: requested service tier, thinking
 * defaults, cache TTL, model deprecation, the reasoning allowance in the cost cap, the cap-violation stop, the
 * image-only exploratory estimate, and per-modality usage details.
 *
 * Modules under test: `scripts/h2eval/modal/contract_r2.ts` (`defaultThinkingFor`, `reasoningRecordOf`,
 * `serviceTierRequestedFor`, `cacheTtlRequestedOf`, `modelDeprecationOf`, `exploratoryFormulaEstimate`,
 * `REASONING_ALLOWANCE_TOKENS`, `capCovered`), `scripts/h2eval/modal/pricing/pricing.ts`,
 * `scripts/h2eval/modal/estimators/index.ts` and the adapters.
 *
 * Strategy / partitions: thinking defaults and the records the adapters accept (nothing invented); tier, TTL and
 * deprecation fields; allowances per model and the cap basis naming the dearest cache-write TTL; a cost within the
 * cap (passes), above it (stop) and unknown (no stop here); the exploratory image estimate against the experimental
 * estimators and the documented example, and `null` for text and audio; Gemini per-modality details and the OpenAI
 * 128-token cache rounding note.
 *
 * Needs: the response fixtures in `test/h2eval/modal/fixtures/responses/`. No network.
 *
 * Run just this file: `npx tsx --test test/h2eval/modal/contract_r2.test.ts`
 *
 * @module test/h2eval/modal/contract_r2.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defaultThinkingFor, reasoningRecordOf, serviceTierRequestedFor, cacheTtlRequestedOf, modelDeprecationOf, exploratoryFormulaEstimate, REASONING_ALLOWANCE_TOKENS, capCovered } from '../../../scripts/h2eval/modal/contract_r2.js';
import { loadPriceTable, costCap, computeCost } from '../../../scripts/h2eval/modal/pricing/pricing.js';
import { estimateExAnte } from '../../../scripts/h2eval/modal/estimators/index.js';
import { parseOpenAiChatResponse, parseGoogleGenerateContentResponse, ADAPTERS } from '../../../scripts/h2eval/modal/index.js';

const fx = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/responses/${name}.json`, import.meta.url)), 'utf8')) as Record<string, { httpStatus: number; body: unknown }>;
const PT = loadPriceTable();

describe('items 3, 4, 5, 10: tier requested, thinking, cache TTL, deprecation', () => {
  it('thinking defaults per model and their v0 reasoning records', () => {
    assert.equal(defaultThinkingFor('gpt-4o-mini-2024-07-18').mode, 'none'); assert.equal(defaultThinkingFor('claude-haiku-4-5-20251001').mode, 'none');
    const h = defaultThinkingFor('claude-haiku-5-5'); assert.deepEqual([h.mode, (h as { effort: string }).effort, h.offDocumented], ['adaptive', 'low', 'NOT_VERIFIED']);
    const g = defaultThinkingFor('gemini-3.5-flash-lite'); assert.deepEqual([g.mode, g.offDocumented], ['minimal', false]);
    assert.equal(reasoningRecordOf(defaultThinkingFor('gpt-4o-mini-2024-07-18')), 'NONE'); assert.deepEqual(reasoningRecordOf(h), { effort: 'low' }); assert.deepEqual(reasoningRecordOf(g), { thinking_level: 'minimal' });
    assert.deepEqual(reasoningRecordOf({ mode: 'manual', budgetTokens: 1024 }), { budget_tokens: 1024 });
  });
  it('the adapters accept exactly those records (and nothing invented)', () => {
    const plan = (model: string, reasoning: ReturnType<typeof reasoningRecordOf>) => ({ schema: 'h2eval.plan.v0' as const, studyId: 's', protocolHash: 'a'.repeat(64), manifestSha256: 'b'.repeat(64), batchId: 'b', phase: 'PILOT' as const, cellId: 'c', groupId: 'g', promptId: 'p', rep: 1, variant: 'v', split: 'NONE' as const, provider: 'anthropic' as const, api: 'anthropic.messages' as const, endpoint: 'e', modelRequested: model, task: 'summary' as const, sizeBucket: 'S' as const, structure: 'S1' as const, modality: 'text' as const, plannedCacheArm: 'S1' as const, promptSha256: 'c'.repeat(64), prefixSha256: 'NOT_APPLICABLE' as const, nonce: 'NOT_APPLICABLE' as const, params: { maxTokens: 24, temperature: 'DEFAULT' as const, reasoning, serviceTier: 'NONE' as const, cacheDirectives: 'NONE' as const } });
    const content = { promptSha256: 'c'.repeat(64), messages: [{ role: 'user' as const, parts: [{ type: 'text' as const, text: 'oi' }] }], prefixMessages: 'NOT_APPLICABLE' as const };
    const h55 = ADAPTERS['anthropic.messages'].buildRequest(plan('claude-haiku-5-5', reasoningRecordOf(defaultThinkingFor('claude-haiku-5-5'))), content); assert.deepEqual((h55.body as Record<string, unknown>)['output_config'], { effort: 'low' });
    const h45 = ADAPTERS['anthropic.messages'].buildRequest(plan('claude-haiku-4-5-20251001', { budget_tokens: 1024 }), content); assert.deepEqual((h45.body as Record<string, unknown>)['thinking'], { type: 'enabled', budget_tokens: 1024 });
    const g = ADAPTERS['gemini.generate_content'].buildRequest({ ...plan('gemini-3.5-flash-lite', reasoningRecordOf(defaultThinkingFor('gemini-3.5-flash-lite'))), provider: 'google', api: 'gemini.generate_content' }, content); assert.deepEqual((g.body as { generationConfig: Record<string, unknown> }).generationConfig['thinkingConfig'], { thinkingLevel: 'MINIMAL' });
  });
  it('service tier requested / served field; cache TTL; deprecation', () => {
    assert.deepEqual(serviceTierRequestedFor('gpt-4o-mini-2024-07-18'), { serviceTierRequested: 'default', servedField: 'service_tier (response body)' });
    assert.equal(serviceTierRequestedFor('claude-haiku-5-5').serviceTierRequested, 'standard_only'); assert.equal(serviceTierRequestedFor('gemini-3.5-flash-lite').serviceTierRequested, 'NONE');
    assert.equal(cacheTtlRequestedOf({ cache_control: 'ephemeral', ttl: '1h' }, 'claude-haiku-4-5-20251001'), '1h'); assert.equal(cacheTtlRequestedOf({ cache_control: 'ephemeral' }, 'claude-haiku-5-5'), '5m');
    assert.equal(cacheTtlRequestedOf({ prompt_cache_key: 'k' }, 'gpt-4o-mini-2024-07-18'), 'NOT_APPLICABLE'); assert.equal(cacheTtlRequestedOf('NONE', 'claude-haiku-5-5'), 'NOT_APPLICABLE');
    assert.equal(modelDeprecationOf('gpt-4o-mini-2024-07-18').modelDeprecation, 'DEPRECATED_SHUTDOWN_2027-01-14'); assert.equal(modelDeprecationOf('claude-haiku-4-5-20251001').modelDeprecation, 'LEGACY'); assert.equal(modelDeprecationOf('gemini-3.5-flash-lite').modelDeprecation, 'ACTIVE');
    const served = ADAPTERS['openai.chat_completions'].parseUsage(fx('openai_chat')['tier_flex_nonstandard']!.body); assert.equal(served.serviceTierServed, 'flex'); // divergence recorded, not corrected
  });
});

describe('item 6: reasoning allowance in the cap; cap violation => STOP', () => {
  it('allowances 0 / 0 / 1,024 / 2,048 and capBasis lists the dearest write TTL', () => {
    assert.deepEqual(REASONING_ALLOWANCE_TOKENS, { 'gpt-4o-mini-2024-07-18': 0n, 'claude-haiku-4-5-20251001': 0n, 'claude-haiku-5-5': 1024n, 'claude-sonnet-5-5': 1024n, 'claude-opus-5-5': 1024n, 'gemini-3.5-flash-lite': 2048n, 'gemini-3.1-flash-lite': 2048n, 'gpt-6-luna': 0n }); // E3G (C160 BRACO-GO): + arm models
    const h = costCap('claude-haiku-5-5', 5000n, 24n, PT); assert.ok('capBasis' in h);
    if ('capBasis' in h) { assert.equal(h.capBasis.inputPriceSource, 'cacheWrite1h'); assert.equal(h.capBasis.inputPriceUsedMicroPerMTok, '1000000'); assert.equal(h.reasoningAllowanceTokens, '1024'); assert.equal(h.picoUsd, (5000n * 1000000n + 24n * 2500000n + 1024n * 2500000n).toString()); }
    const g = costCap('gemini-3.5-flash-lite', 5000n, 24n, PT); if ('capBasis' in g) { assert.equal(g.capBasis.inputPriceSource, 'input'); assert.equal(g.picoUsd, (5000n * 300000n + (24n + 2048n) * 2500000n).toString()); }
    const o = costCap('gpt-4o-mini-2024-07-18', 5000n, 24n, PT); if ('capBasis' in o) assert.equal(o.reasoningAllowanceTokens, '0');
  });
  it('capCovered: table cost within the cap passes; above it => STOP_CAP_VIOLATION; UNKNOWN cost => UNKNOWN, no stop here', () => {
    const p = parseOpenAiChatResponse(200, fx('openai_chat')['ok_text']!.body, { requestModalities: ['text'] }); const cost = computeCost('gpt-4o-mini-2024-07-18', p.usage, p.pricingTerms, PT);
    const cap = costCap('gpt-4o-mini-2024-07-18', 500n, 24n, PT); if ('error' in cap) throw new Error(cap.error);
    assert.deepEqual(capCovered(cost, cap), { capCovered: true, stop: null });
    const tiny = costCap('gpt-4o-mini-2024-07-18', 10n, 1n, PT); if ('error' in tiny) throw new Error(tiny.error);
    assert.deepEqual(capCovered(cost, tiny), { capCovered: false, stop: 'STOP_CAP_VIOLATION' });
    const e = parseOpenAiChatResponse(429, fx('openai_chat')['error_429_no_usage']!.body, { requestModalities: ['text'] }); assert.deepEqual(capCovered(computeCost('gpt-4o-mini-2024-07-18', e.usage, e.pricingTerms, PT), cap), { capCovered: 'UNKNOWN', stop: null });
  });
});

describe('item 7: exploratoryFormulaEstimate (image only) never replaces L0', () => {
  it('openai_tile / anthropic_28px agree with the EXPERIMENTAL estimators; gemini_rough reproduces the page example (960x540 -> 6 tiles)', () => {
    assert.deepEqual(exploratoryFormulaEstimate('gpt-4o-mini-2024-07-18', 'image', { width: 1024, height: 1024, detail: 'high' })!.tokens, 2833 + 4 * 5667);
    assert.equal(exploratoryFormulaEstimate('claude-haiku-4-5-20251001', 'image', { width: 1000, height: 1000 })!.tokens, 1296);
    assert.equal(exploratoryFormulaEstimate('claude-haiku-4-5-20251001', 'image', { width: 1920, height: 1080 })!.tokens, 'UNKNOWN');
    const g = exploratoryFormulaEstimate('gemini-3.5-flash-lite', 'image', { width: 960, height: 540 })!; assert.deepEqual([g.formula, g.rawInputs['cropUnit'], g.rawInputs['tiles'], g.tokens], ['gemini_rough', 360, 6, 1548]);
    assert.equal(exploratoryFormulaEstimate('gemini-3.5-flash-lite', 'image', { width: 384, height: 384 })!.tokens, 258);
  });
  it('only for image; text/audio => null; the ex ante estimator for Gemini image and for all audio stays UNSUPPORTED', () => {
    assert.equal(exploratoryFormulaEstimate('gemini-3.5-flash-lite', 'audio', { width: 0, height: 0 }), null);
    assert.equal(exploratoryFormulaEstimate('gpt-4o-mini-2024-07-18', 'text', { width: 10, height: 10 }), null);
    assert.equal(estimateExAnte('gemini-3.5-flash-lite', 'gemini.generate_content', 'image', { image: { width: 960, height: 540 } }).status, 'UNSUPPORTED_FOR_ESTIMATION');
    assert.equal(estimateExAnte('gemini-3.5-flash-lite', 'gemini.generate_content', 'audio', { audioSeconds: 60 }).status, 'UNSUPPORTED_FOR_ESTIMATION');
  });
});

describe('item 8: promptTokensDetailsByModality and cacheRoundingNote', () => {
  it('gemini by-modality detail is carried; openai cached_tokens > 0 carries the 128 rounding note', () => {
    const g = parseGoogleGenerateContentResponse(200, fx('google_generate_content')['ok_image']!.body, { requestModalities: ['text', 'image'] }); assert.deepEqual(g.usage.promptTokensDetailsByModality, { TEXT: 22, IMAGE: 1548 });
    const a = parseGoogleGenerateContentResponse(200, fx('google_generate_content')['ok_audio']!.body, { requestModalities: ['text', 'audio'] }); assert.deepEqual(a.usage.promptTokensDetailsByModality, { TEXT: 22, AUDIO: 1920 });
    assert.equal(parseOpenAiChatResponse(200, fx('openai_chat')['ok_cache_hit']!.body, { requestModalities: ['text'] }).usage.cacheRoundingNote, 'openai_128');
    assert.equal(parseOpenAiChatResponse(200, fx('openai_chat')['ok_text']!.body, { requestModalities: ['text'] }).usage.cacheRoundingNote, undefined);
    assert.equal(3328 % 128, 0);
  });
});
