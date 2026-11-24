/** R14: versioned H2-EVAL price table and exact cost (pico-USD). Cross-checked against the H1 ledger values of 07/10/2026. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { loadPriceTable, computeCost, costCap } from '../../../scripts/h2eval/modal/pricing/pricing.js';
import { parseOpenAiChatResponse, parseAnthropicMessagesResponse, parseGoogleGenerateContentResponse } from '../../../scripts/h2eval/modal/adapters/index.js';

const fx = (name: string) => JSON.parse(readFileSync(fileURLToPath(new URL(`./fixtures/responses/${name}.json`, import.meta.url)), 'utf8')) as Record<string, { httpStatus: number; body: unknown }>;
const OA = fx('openai_chat'); const AN = fx('anthropic_messages'); const GO = fx('google_generate_content');
const T = { requestModalities: ['text'] as Array<'text' | 'image' | 'audio'> };
const PT = loadPriceTable();

describe('price table', () => {
  it('loads, is versioned and sourced from the R08 archive; null means unknown and 0 is refused', () => {
    assert.equal(PT.table.version, 'h2eval-v3-2026-11-13'); // C159C E-1: active table is v3 (v2 + Sonnet/Opus 5.5 cache prices)
    assert.match(PT.sha256, /^[0-9a-f]{64}$/); // C3-PREP B-3: this assertion had been swallowed by the comment above in 6cab0d01
    const src = PT.table.source as { matrix_json: { sha256: string } }; assert.equal(src.matrix_json.sha256, '4bb3fdc56909b152a72de6b1db54b9ab913907d4e28d57b4b51304ec475c05d8');
    assert.equal(PT.table.models['gpt-4o-mini-2024-07-18']!.tiers[0]!.prices.audioTokens, null);
    assert.equal(PT.table.models['claude-haiku-4-5-20251001']!.tiers[0]!.prices.cacheWrite, null);
    const d = mkdtempSync(join(tmpdir(), 'h2pt-')); const bad = JSON.parse(readFileSync(PT.path, 'utf8')); bad.models['gpt-4o-mini-2024-07-18'].tiers[0].prices.audioTokens = '0'; writeFileSync(join(d, 't.json'), JSON.stringify(bad));
    assert.throws(() => loadPriceTable(join(d, 't.json')), /never zero/);
  });
});

describe('cost = H1 ledger on the H1 records', () => {
  it('openai 448 in / 24 out => 81,600,000 pico-USD = 0.0000816 (H1 costUsd)', () => {
    const p = parseOpenAiChatResponse(200, OA['ok_text']!.body, T); const c = computeCost('gpt-4o-mini-2024-07-18', p.usage, p.pricingTerms, PT);
    assert.equal(c.state, 'CALCULATED'); assert.equal(c.picoUsd, '81600000'); assert.equal(c.usd, '0.0000816'); assert.equal(c.stopRunner, false);
  });
  it('openai cache hit 3396/3328 cached => 0.0002742 (H1 cache-2)', () => {
    const p = parseOpenAiChatResponse(200, OA['ok_cache_hit']!.body, T); const c = computeCost('gpt-4o-mini-2024-07-18', p.usage, p.pricingTerms, PT);
    assert.equal(c.usd, '0.0002742'); assert.equal(c.byCategory['cacheRead']!.priceMicroPerMTok, '75000');
  });
  it('anthropic 634/24 => 0.000754 (H1); reasoning split unknown but same price => CALCULATED', () => {
    const p = parseAnthropicMessagesResponse(200, AN['ok_text_haiku45']!.body, T); const c = computeCost('claude-haiku-4-5-20251001', p.usage, p.pricingTerms, PT);
    assert.equal(c.state, 'CALCULATED'); assert.equal(c.usd, '0.000754');
  });
  it('anthropic 5m cache write and cache hit priced by TTL and read price', () => {
    const w = parseAnthropicMessagesResponse(200, AN['ok_cache_creation_5m']!.body, T); const cw = computeCost('claude-haiku-4-5-20251001', w.usage, w.pricingTerms, PT);
    assert.equal(cw.picoUsd, (120n * 1000000n + 4600n * 1250000n + 24n * 5000000n).toString());
    const h = parseAnthropicMessagesResponse(200, AN['ok_cache_hit']!.body, T); const ch = computeCost('claude-haiku-4-5-20251001', h.usage, h.pricingTerms, PT);
    assert.equal(ch.picoUsd, (95n * 1000000n + 4600n * 100000n + 24n * 5000000n).toString());
    const n = parseAnthropicMessagesResponse(200, AN['ok_cache_write_no_split']!.body, T); const cn = computeCost('claude-haiku-4-5-20251001', n.usage, n.pricingTerms, PT);
    assert.equal(cn.state, 'ESTIMATED_UPPER_BOUND'); assert.ok(cn.byCategory['cacheWrite_UPPER_BOUND_1h']);
  });
  it('gemini 450/20 => 0.000185 (H1); cache hit 4228/2032 => 0.00076976 (H1 cache-2); thoughts billed as output', () => {
    const p = parseGoogleGenerateContentResponse(200, GO['ok_text']!.body, T); const c = computeCost('gemini-3.5-flash-lite', p.usage, p.pricingTerms, PT);
    assert.equal(c.state, 'ESTIMATED_UPPER_BOUND'); assert.equal(c.usd, '0.000185'); // cachedContentTokenCount absent => bound (equal to the H1 ledger figure, which read the absence as 0)
    const h = parseGoogleGenerateContentResponse(200, GO['ok_cache_hit']!.body, T); const ch = computeCost('gemini-3.5-flash-lite', h.usage, h.pricingTerms, PT);
    assert.equal(ch.state, 'CALCULATED'); assert.equal(ch.usd, '0.00076976');
    const t = parseGoogleGenerateContentResponse(200, GO['ok_text_thoughts']!.body, T); const ct = computeCost('gemini-3.5-flash-lite', t.usage, t.pricingTerms, PT);
    assert.equal(ct.byCategory['reasoning']!.priceMicroPerMTok, '2500000');
  });
  it('haiku-5-5: prompt length (input + cache reads + writes) picks the tier', () => {
    const p = parseAnthropicMessagesResponse(200, AN['ok_text_haiku55_thinking']!.body, T); const c = computeCost('claude-haiku-5-5', p.usage, p.pricingTerms, PT);
    assert.equal(c.tierId, 'prompt_le_100k'); assert.equal(c.picoUsd, (820n * 100000n + 24n * 500000n + 36n * 500000n).toString());
    const o = parseAnthropicMessagesResponse(200, AN['ok_haiku55_over_100k']!.body, T); const co = computeCost('claude-haiku-5-5', o.usage, o.pricingTerms, PT);
    assert.equal(co.tierId, 'prompt_gt_100k'); assert.equal(co.byCategory['inputUncached']!.priceMicroPerMTok, '500000'); assert.equal(co.byCategory['cacheRead']!.priceMicroPerMTok, '50000');
  });
});

describe('UNKNOWN and STOP rules', () => {
  it('non-standard terms (flex, us geo, fast) => cost UNKNOWN and runner stop', () => {
    const f = parseOpenAiChatResponse(200, OA['tier_flex_nonstandard']!.body, T); const c = computeCost('gpt-4o-mini-2024-07-18', f.usage, f.pricingTerms, PT); assert.equal(c.state, 'UNKNOWN'); assert.equal(c.stopRunner, true);
    const g = parseAnthropicMessagesResponse(200, AN['geo_us_nonstandard']!.body, T); assert.equal(computeCost('claude-haiku-4-5-20251001', g.usage, g.pricingTerms, PT).state, 'UNKNOWN');
    const s = parseAnthropicMessagesResponse(200, AN['speed_fast_nonstandard']!.body, T); assert.equal(computeCost('claude-haiku-5-5', s.usage, s.pricingTerms, PT).state, 'UNKNOWN');
  });
  it('no usage => UNKNOWN (never 0), no stop (the cap bounds it)', () => {
    const e = parseOpenAiChatResponse(429, OA['error_429_no_usage']!.body, T); const c = computeCost('gpt-4o-mini-2024-07-18', e.usage, e.pricingTerms, PT);
    assert.equal(c.state, 'UNKNOWN'); assert.equal(c.picoUsd, null); assert.equal(c.stopRunner, false);
  });
  it('cache split unknown => upper bound, flagged, never CALCULATED', () => {
    const p = parseOpenAiChatResponse(200, OA['ok_details_absent']!.body, T); const c = computeCost('gpt-4o-mini-2024-07-18', p.usage, p.pricingTerms, PT);
    assert.equal(c.state, 'ESTIMATED_UPPER_BOUND'); assert.equal(c.picoUsd, (100n * 150000n + 10n * 600000n).toString());
  });
  it('a null price that the usage needs stops the runner (audio tokens on gpt-4o-mini)', () => {
    const p = parseOpenAiChatResponse(200, OA['ok_text']!.body, { requestModalities: ['text', 'audio'] });
    p.usage.audioUnits = 10n; // would only happen with an audio request, which this model does not accept
    const c = computeCost('gpt-4o-mini-2024-07-18', p.usage, p.pricingTerms, PT); assert.equal(c.state, 'UNKNOWN'); assert.equal(c.stopRunner, true); assert.match(c.reasons.join(' '), /null/);
  });
  it('image/audio units at the input price add no delta; a model outside the table stops', () => {
    const i = parseGoogleGenerateContentResponse(200, GO['ok_image']!.body, { requestModalities: ['text', 'image'] }); const c = computeCost('gemini-3.5-flash-lite', i.usage, i.pricingTerms, PT);
    assert.equal(c.state, 'ESTIMATED_UPPER_BOUND'); assert.equal(c.picoUsd, (1570n * 300000n + 15n * 2500000n).toString());
    // @ts-expect-error model outside the matrix
    assert.equal(computeCost('gpt-5', i.usage, i.pricingTerms, PT).stopRunner, true);
  });
  it('costCap = worst case: input at max(input, cache write), output at the ceiling, dearest tier', () => {
    const c = costCap('claude-haiku-4-5-20251001', 5000n, 24n, PT) as { picoUsd: string };
    assert.equal(c.picoUsd, (5000n * 2000000n + 24n * 5000000n).toString());
    const h = costCap('claude-haiku-5-5', 5000n, 24n, PT) as { tierId: string }; assert.equal(h.tierId, 'prompt_gt_100k');
  });
});
