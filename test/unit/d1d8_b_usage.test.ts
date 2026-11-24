/**
 * D1–D8 front B — usage normalization per API (D4 §6, D5-G02/G03, U2-04/U2-05).
 * Expected values come from test/fixtures/d1d8/common_vectors.json (hand-computed) or are
 * written inline with their arithmetic; none is produced by the code under test.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { normalizeUsage, normalizeUsageDetailed, categoryCount, T_RULE_ID } from '../../src/providers/usage/normalizeUsage.js';
import { USAGE_DOC_REFS } from '../../src/providers/usage/usageDocRefs.js';
import { extractUsage } from '../../src/proxy/UsageExtractor.js';
import type { UsageApi, UsageContext } from '../../src/types/d1d8/index.js';

const vectors = JSON.parse(readFileSync('test/fixtures/d1d8/common_vectors.json', 'utf8')) as { vectors: Array<Record<string, any>> };
const V = (id: string) => vectors.vectors.find((v) => v.id === id)!;
const ctx = (provider: string, modelRequested: string): UsageContext => ({ provider, modelRequested, origin: 'provider_response', observedAt: '2026-09-30T12:00:00.000Z' });
const big = (s: string | null) => (s === null ? null : BigInt(s));

describe('d1d8_b usage — common vectors', () => {
  for (const id of ['USAGE-ANTHROPIC-01', 'USAGE-OPENAI-CHAT-01', 'USAGE-OPENAI-RESPONSES-01', 'USAGE-GEMINI-01', 'USAGE-ZERO-01', 'USAGE-MISSING-01']) {
    it(id, () => {
      const v = V(id);
      const provider = (v.api as string).split('.')[0]!;
      const u = normalizeUsage(v.api as UsageApi, v.response, ctx(provider, 'requested-model'));
      assert.equal(u.completeness, v.expected.completeness);
      assert.equal(u.tIn, big(v.expected.tIn));
      assert.equal(u.tOut, big(v.expected.tOut));
      assert.equal(u.tRule, T_RULE_ID);
      assert.equal(u.origin, 'provider_response');
      assert.deepEqual(u.docRef, USAGE_DOC_REFS[v.api as UsageApi]);
      if ('input_cache_read' in v.expected) assert.equal(categoryCount(u, 'input_cache_read'), v.expected.input_cache_read);
    });
  }

  it('U2-04: the legacy extractor still returns 0/0 for Responses (historical reproduction kept)', () => {
    const v = V('USAGE-OPENAI-RESPONSES-01');
    const old = extractUsage('openai', 'fixture-model', v.response);
    assert.equal(old.inputTokens, Number(v.expected.previous_extractor.inputTokens));
    assert.equal(old.outputTokens, Number(v.expected.previous_extractor.outputTokens));
    const now = normalizeUsage('openai.responses', v.response, ctx('openai', 'gpt-4o-mini'));
    assert.equal(now.tIn, 100n);
    assert.equal(now.tOut, 20n);
  });
});

describe('d1d8_b usage — categories, provenance and inclusion (U2-05)', () => {
  it('Anthropic keeps cache write/read as separate addends and thinking as subset of output', () => {
    const u = normalizeUsage('anthropic.messages', V('USAGE-ANTHROPIC-01').response, ctx('anthropic', 'claude-haiku-4-5'));
    const by = Object.fromEntries(u.categories.map((c) => [c.name, c]));
    assert.equal(by['input_cache_write']!.count, 30n);
    assert.equal(by['input_cache_write']!.inclusion, 'separate_addend');
    assert.equal(by['input_cache_write']!.sourceField, 'usage.cache_creation_input_tokens');
    assert.equal(by['input_cache_read']!.count, 40n);
    assert.equal(by['output_reasoning']!.count, 10n);
    assert.equal(by['output_reasoning']!.inclusion, 'subset_of_output');
    assert.equal(u.modelReturned, 'claude-haiku-4-5-20251001');
    assert.equal(u.modelRequested, 'claude-haiku-4-5');
    assert.equal(u.providerRequestId, 'msg_fixture');
  });

  it('Gemini keeps thoughts as separate addend and cache as subset of prompt', () => {
    const u = normalizeUsage('gemini.generate_content', V('USAGE-GEMINI-01').response, ctx('gemini', 'gemini-2.0-flash'));
    const by = Object.fromEntries(u.categories.map((c) => [c.name, c]));
    assert.equal(by['output_reasoning']!.count, 10n);
    assert.equal(by['output_reasoning']!.inclusion, 'separate_addend');
    assert.equal(by['input_cache_read']!.inclusion, 'subset_of_input');
    assert.equal(u.modelReturned, 'gemini-2.0-flash');
    assert.equal(u.providerRequestId, 'gem_fixture');
  });

  it('OpenAI Chat subsets are not added again (1000 + 300, not 1000 + 600 + 300 + 200)', () => {
    const u = normalizeUsage('openai.chat_completions', V('USAGE-OPENAI-CHAT-01').response, ctx('openai', 'gpt-4o-mini'));
    assert.equal(u.tIn! + u.tOut!, 1300n);
  });

  it('DeepSeek cache hit is a subset; hit + miss must equal prompt', () => {
    const ok = normalizeUsageDetailed('deepseek.chat_completions', { usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 30 } }, ctx('deepseek', 'deepseek-chat'));
    assert.equal(ok.usage.completeness, 'complete');
    assert.equal(ok.usage.tIn, 50n);
    assert.equal(categoryCount(ok.usage, 'input_cache_read'), 20n);
    const bad = normalizeUsageDetailed('deepseek.chat_completions', { usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55, prompt_cache_hit_tokens: 20, prompt_cache_miss_tokens: 31 } }, ctx('deepseek', 'deepseek-chat'));
    assert.equal(bad.usage.completeness, 'partial');
    assert.equal(bad.usage.tIn, null);
    assert.ok(bad.issues.some((i) => i.kind === 'inconsistent_total'));
  });

  it('Cohere v2 uses usage.tokens; billed_units stay in the raw digest (listed as known, not mapped)', () => {
    const r = normalizeUsageDetailed('cohere.chat', { id: 'c1', usage: { billed_units: { input_tokens: 5, output_tokens: 26 }, tokens: { input_tokens: 71, output_tokens: 26 } } }, ctx('cohere', 'command-r'));
    assert.equal(r.usage.tIn, 71n);
    assert.equal(r.usage.tOut, 26n);
    assert.ok(!r.issues.some((i) => i.kind === 'unmapped_field'));
  });

  it('raw usage digest changes with any usage field and ignores non-usage fields', () => {
    const a = normalizeUsage('openai.chat_completions', { model: 'x', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }, ctx('openai', 'gpt-4o'));
    const b = normalizeUsage('openai.chat_completions', { model: 'y', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }, ctx('openai', 'gpt-4o'));
    const c = normalizeUsage('openai.chat_completions', { model: 'x', usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, extra: 1 } }, ctx('openai', 'gpt-4o'));
    assert.equal(a.rawUsageDigest, b.rawUsageDigest);
    assert.notEqual(a.rawUsageDigest, c.rawUsageDigest);
  });

  it('unknown usage fields are reported, not silently dropped', () => {
    const r = normalizeUsageDetailed('openai.chat_completions', { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3, new_category_tokens: 7 } }, ctx('openai', 'gpt-4o'));
    assert.ok(r.issues.some((i) => i.kind === 'unmapped_field' && i.field === 'usage.new_category_tokens'));
  });

  it('origin is carried verbatim (client_declared stays distinguishable)', () => {
    const u = normalizeUsage('openai.chat_completions', { usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 } }, { ...ctx('openai', 'gpt-4o'), origin: 'client_declared' });
    assert.equal(u.origin, 'client_declared');
  });
});

describe('d1d8_b usage — invalid, absent and zero are distinct (D4 §6, D4-G04)', () => {
  const cases: Array<[string, unknown, string]> = [
    ['negative', -1, 'negative'],
    ['fractional', 2.5, 'non_integer'],
    ['NaN', Number.NaN, 'non_finite'],
    ['Infinity', Number.POSITIVE_INFINITY, 'non_finite'],
    ['string', '12', 'invalid_type'],
    ['beyond 10^9', 1_000_000_001, 'out_of_range'],
    ['unsafe integer', 2 ** 60, 'out_of_range'],
  ];
  for (const [label, value, kind] of cases) {
    it(`${label} input → issue ${kind}, tIn/tOut null, never a token count`, () => {
      const r = normalizeUsageDetailed('openai.chat_completions', { usage: { prompt_tokens: value, completion_tokens: 3 } }, ctx('openai', 'gpt-4o'));
      assert.equal(r.usage.tIn, null);
      assert.equal(r.usage.tOut, null);
      assert.equal(r.usage.completeness, 'partial');
      assert.equal(categoryCount(r.usage, 'input'), null);
      assert.ok(r.issues.some((i) => i.kind === kind), JSON.stringify(r.issues));
    });
  }

  it('absent base field → base_absent, partial', () => {
    const r = normalizeUsageDetailed('openai.chat_completions', { usage: { completion_tokens: 3 } }, ctx('openai', 'gpt-4o'));
    assert.equal(r.usage.completeness, 'partial');
    assert.ok(r.issues.some((i) => i.kind === 'base_absent' && i.field === 'usage.prompt_tokens'));
  });

  it('invalid optional subset → partial (review MEDIUM-1: would otherwise be priced at the full input rate)', () => {
    const r = normalizeUsageDetailed('openai.chat_completions', { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: -5 } } }, ctx('openai', 'gpt-4o'));
    assert.equal(r.usage.completeness, 'partial');
    assert.equal(r.usage.tIn, null);
    assert.equal(categoryCount(r.usage, 'input_cache_read'), null);
    assert.ok(r.issues.some((i) => i.kind === 'negative'));
  });

  it('subset larger than its base → partial (provider data inconsistent)', () => {
    const r = normalizeUsageDetailed('openai.chat_completions', { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13, prompt_tokens_details: { cached_tokens: 11 } } }, ctx('openai', 'gpt-4o'));
    assert.equal(r.usage.completeness, 'partial');
    assert.ok(r.issues.some((i) => i.kind === 'subset_exceeds_base'));
  });

  it('total that disagrees with the rule → partial (a hidden category would be omitted)', () => {
    const r = normalizeUsageDetailed('openai.chat_completions', { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 20 } }, ctx('openai', 'gpt-4o'));
    assert.equal(r.usage.completeness, 'partial');
    assert.equal(r.usage.tIn, null);
    assert.ok(r.issues.some((i) => i.kind === 'inconsistent_total'));
  });

  it('Gemini omitted candidatesTokenCount is derived from the documented total (flagged), not assumed 0', () => {
    const r = normalizeUsageDetailed('gemini.generate_content', { usageMetadata: { promptTokenCount: 12, totalTokenCount: 12 } }, ctx('gemini', 'gemini-2.0-flash'));
    assert.equal(r.usage.tOut, 0n);
    assert.ok(r.issues.some((i) => i.kind === 'derived_from_total'));
    const noTotal = normalizeUsageDetailed('gemini.generate_content', { usageMetadata: { promptTokenCount: 12 } }, ctx('gemini', 'gemini-2.0-flash'));
    assert.equal(noTotal.usage.tOut, null);
    assert.equal(noTotal.usage.completeness, 'partial');
  });

  it('Gemini non-zero toolUsePromptTokenCount (inclusion undocumented) → partial, inclusion_unverified', () => {
    const r = normalizeUsageDetailed('gemini.generate_content', { usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 3, toolUsePromptTokenCount: 4, totalTokenCount: 15 } }, ctx('gemini', 'gemini-2.0-flash'));
    assert.equal(r.usage.completeness, 'partial');
    assert.ok(r.issues.some((i) => i.kind === 'inclusion_unverified'));
  });

  it('usage object of the wrong API shape is partial, not zero', () => {
    const r = normalizeUsageDetailed('openai.chat_completions', V('USAGE-OPENAI-RESPONSES-01').response, ctx('openai', 'gpt-4o-mini'));
    assert.equal(r.usage.completeness, 'partial');
    assert.equal(r.usage.tIn, null);
  });

  it('api outside the declared scope is refused explicitly', () => {
    assert.throws(() => normalizeUsage('azure.chat' as UsageApi, {}, ctx('azure', 'x')), /declared scope/);
  });
});
