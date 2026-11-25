/**
 * FECHAMENTO_GEMINI_AD — unit gates (no services, no network):
 *  - G-GEM-AUTH (transport): upstream headers per provider, client credentials removed in any case, query credentials;
 *  - G-GEM-USAGE: independent Gemini fixtures (JSON and SSE bytes) normalized and priced; the expected CU and money
 *    are computed HERE from the fixture numbers and the table DATA (weights 900 × 600 milli; µUSD/MTok input
 *    100 000, cache 10 000, output 400 000), never by the functions under test; SSE fed split at EVERY byte offset;
 *  - G-GEM-MONEY (pure): policy v4 admission, v2/v3 unchanged, tier matching;
 *  - versioned development weights: the historical profile keeps its digest.
 *
 * Modules under test: `upstreamHeaders` from `src/proxy/ProxyForwarder.ts`,
 * `stripQueryCredentials` from `src/proxy/ProxyGateway.ts`, the measurement exports of
 * `src/providers/d1d8Measurement.ts`, `src/providers/usage/streamUsageAccumulator.ts`,
 * `developmentWeights` from `src/operations/d1d8Ports.ts`, `src/operations/moneyBound.ts` and,
 * for the last case, `d1d8ProfileFromEnv` from `src/operations/bootstrapD1D8.ts`.
 *
 * Strategy / partitions: headers per provider with client credentials in any letter case, and
 * credentials in the query string; Gemini JSON responses (basic, implicit cache, thinking,
 * absent or invalid usage, blocked prompt, served tier); Gemini streams split at every byte
 * offset and one byte at a time, cut early, with no usage, with a blocked prompt, plus the
 * served tier of an OpenAI stream; money policy v4 vs v2/v3, the OpenAI service tier, the
 * published policy list and tier matching; the historical and new development weight
 * profiles; startup configuration accepting v4 and a known weights profile and refusing unknown
 * ones.
 *
 * Needs: must be run from the repository root (reads
 * `scripts/pilot/price_table_pilot_v3_gemini_20261003.json` by relative path). The startup case
 * passes its own environment object and a database URL on a closed local port; no database or
 * network.
 *
 * Run just this file: `npx tsx --test test/unit/gem_gemini_units.test.ts`
 *
 * @module test/unit/gem_gemini_units.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { upstreamHeaders } from '../../src/proxy/ProxyForwarder.js';
import { stripQueryCredentials } from '../../src/proxy/ProxyGateway.js';
import { normalizeUsage, computeCu, bindPricing, createPriceTableRegistry, parsePriceTableV1, priceTableRef } from '../../src/providers/d1d8Measurement.js';
import { createStreamUsageAccumulator } from '../../src/providers/usage/streamUsageAccumulator.js';
import { developmentWeights } from '../../src/operations/d1d8Ports.js';
import { assessMoneyBound, serviceTierMatches, MONEY_BOUND_POLICY_V2, MONEY_BOUND_POLICY_V3, MONEY_BOUND_POLICY_V4, MONEY_BOUND_POLICIES } from '../../src/operations/moneyBound.js';
import type { NormalizedUsage } from '../../src/types/d1d8/index.js';

const TABLE = parsePriceTableV1(JSON.parse(fs.readFileSync('scripts/pilot/price_table_pilot_v3_gemini_20261003.json', 'utf8')));
const REF = priceTableRef(TABLE);
const pricing = bindPricing(createPriceTableRegistry([TABLE]));
const CFG = developmentWeights('development-2026-10-03').active()!;
const ctx = { provider: 'gemini', modelRequested: 'gemini-2.5-flash-lite', origin: 'provider_response' as const, observedAt: '2026-10-03T23:00:00.000Z' };
// oracle data (copied from the sources, not read from the code): micro-CU per token and µUSD per MTok
const W = 900n * 600n;
const PIN = 100_000n; const PCACHE = 10_000n; const POUT = 400_000n;
const resp = (usageMetadata: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => ({
  candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP', index: 0 }],
  ...(usageMetadata ? { usageMetadata } : {}), modelVersion: 'gemini-2.5-flash-lite', responseId: 'r-1', ...extra,
});
const count = (u: NormalizedUsage, name: string) => u.categories.find((c) => c.name === name)?.count ?? null;
function priced(u: NormalizedUsage) { return pricing.priceUsage(u, u.observedAt, REF); }

describe('G-GEM-AUTH — transport headers', () => {
  const inHeaders = { 'Content-Type': 'application/json', Authorization: 'Bearer otk-token', 'X-Goog-Api-Key': 'otk-token', 'X-API-KEY': 'otk-token', 'Api-Key': 'otk-token', accept: '*/*' };
  it('gemini: only x-goog-api-key with the provider key; every client credential removed whatever its case', () => {
    const h = upstreamHeaders(inHeaders, 'AIza-provider', 'gemini');
    assert.deepEqual(Object.keys(h).map((k) => k.toLowerCase()).sort(), ['accept', 'content-type', 'x-goog-api-key']);
    assert.equal(h['x-goog-api-key'], 'AIza-provider');
    assert.ok(!JSON.stringify(h).includes('otk-token'));
  });
  it('anthropic and openai unchanged (regression)', () => {
    const a = upstreamHeaders(inHeaders, 'sk-ant', 'anthropic');
    assert.equal(a['x-api-key'], 'sk-ant'); assert.equal(a['anthropic-version'], '2023-06-01'); assert.equal(a['authorization'], undefined);
    const o = upstreamHeaders(inHeaders, 'sk-oa', 'openai');
    assert.equal(o['authorization'], 'Bearer sk-oa'); assert.equal(o['x-goog-api-key'], undefined); assert.equal(o['x-api-key'], undefined);
    assert.ok(!JSON.stringify([a, o]).includes('otk-token'));
  });
  it('query credentials removed in any case; legitimate parameters kept in order', () => {
    const q = stripQueryCredentials(new URLSearchParams('alt=sse&key=a&KEY=b&Access_Token=c&api_key=d&apiKey=e&x=1'));
    assert.equal(q.toString(), 'alt=sse&x=1');
  });
});

describe('G-GEM-USAGE — JSON fixtures, hand oracle', () => {
  it('basic 100/50: categories, model, id, finish; CU and money by hand', () => {
    const u = normalizeUsage('gemini.generate_content', resp({ promptTokenCount: 100, candidatesTokenCount: 50, totalTokenCount: 150 }), ctx);
    assert.equal(u.completeness, 'complete');
    assert.deepEqual([u.tIn, u.tOut, u.modelReturned, u.providerRequestId, u.finishReason, u.serviceTier], [100n, 50n, 'gemini-2.5-flash-lite', 'r-1', 'STOP', null]);
    assert.deepEqual(computeCu(u, CFG).cu, { units: 150n * W, scale: 1_000_000n });
    const q = priced(u);
    assert.equal(q.status, 'priced');
    assert.equal(q.total!.units, 100n * PIN + 50n * POUT);
  });
  it('implicit cache inside the prompt: priced at the cache rate, CU unchanged, never added twice', () => {
    const u = normalizeUsage('gemini.generate_content', resp({ promptTokenCount: 3000, cachedContentTokenCount: 2048, candidatesTokenCount: 40, totalTokenCount: 3040 }), ctx);
    assert.equal(u.completeness, 'complete');
    assert.equal(u.tIn, 3000n);
    assert.deepEqual(computeCu(u, CFG).cu, { units: 3040n * W, scale: 1_000_000n });
    assert.equal(priced(u).total!.units, (3000n - 2048n) * PIN + 2048n * PCACHE + 40n * POUT);
  });
  it('thinking: thoughts are an output addend inside the documented total and billed at the output rate', () => {
    const u = normalizeUsage('gemini.generate_content', resp({ promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 32 }), ctx);
    assert.deepEqual([u.completeness, u.tIn, u.tOut], ['complete', 20n, 12n]);
    assert.equal(count(u, 'output_reasoning'), 7n);
    assert.equal(priced(u).total!.units, 20n * PIN + 12n * POUT);
  });
  it('absent usage → missing (never zero); absent prompt → partial; invalid counts → partial with issue', () => {
    assert.equal(normalizeUsage('gemini.generate_content', resp(undefined), ctx).completeness, 'missing');
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ['prompt absent', { candidatesTokenCount: 5, totalTokenCount: 5 }, 'base_absent'],
      ['negative', { promptTokenCount: -1, candidatesTokenCount: 5, totalTokenCount: 4 }, 'negative'],
      ['fractional', { promptTokenCount: 10.5, candidatesTokenCount: 5, totalTokenCount: 15 }, 'non_integer'],
      ['string', { promptTokenCount: '10', candidatesTokenCount: 5, totalTokenCount: 15 }, 'invalid_type'],
      ['total inconsistent', { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 99 }, 'inconsistent_total'],
      ['cache above prompt', { promptTokenCount: 10, cachedContentTokenCount: 11, candidatesTokenCount: 5, totalTokenCount: 15 }, 'subset_exceeds_base'],
      ['tool-use prompt (out of scope, inclusion unverified)', { promptTokenCount: 10, toolUsePromptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 18 }, 'inclusion_unverified'],
      ['negative thoughts', { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: -2, totalTokenCount: 13 }, 'negative'],
    ];
    for (const [name, um, issue] of cases) {
      const u = normalizeUsage('gemini.generate_content', resp(um), ctx);
      assert.equal(u.completeness, 'partial', name);
      assert.equal(u.tIn, null, name);
      assert.ok(u.issues?.some((i) => i.kind === issue), `${name}: ${JSON.stringify(u.issues)}`);
      assert.notEqual(priced(u).status, 'priced', name);
    }
  });
  it('blocked prompt without candidates: finish blocked:<reason>, output derived 0 from the total (derivation recorded)', () => {
    const u = normalizeUsage('gemini.generate_content', { promptFeedback: { blockReason: 'PROHIBITED_CONTENT' }, usageMetadata: { promptTokenCount: 30, totalTokenCount: 30 }, modelVersion: 'gemini-2.5-flash-lite' }, ctx);
    assert.deepEqual([u.completeness, u.tIn, u.tOut, u.finishReason], ['complete', 30n, 0n, 'blocked:PROHIBITED_CONTENT']);
    assert.ok(u.issues?.some((i) => i.kind === 'derived_from_total'));
    assert.equal(priced(u).total!.units, 30n * PIN);
  });
  it('served tier read from usageMetadata.serviceTier', () => {
    const u = normalizeUsage('gemini.generate_content', resp({ promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2, serviceTier: 'priority' }), ctx);
    assert.equal(u.serviceTier, 'priority');
  });
});

describe('G-GEM-USAGE — SSE bytes (CRLF, several events per chunk, cumulative usage, no [DONE]) split at every offset', () => {
  const ev = (o: unknown) => `data: ${JSON.stringify(o)}\r\n\r\n`;
  const um = (c: number) => ({ promptTokenCount: 12, candidatesTokenCount: c, totalTokenCount: 12 + c });
  const fixture = Buffer.from([
    ev({ candidates: [{ content: { parts: [{ text: 'olá ✓ ' }] } }], usageMetadata: um(2), modelVersion: 'gemini-2.5-flash-lite', responseId: 'r-s' }),
    ev({ candidates: [{ content: { parts: [{ text: 'çãõ 😀 ' }] } }], usageMetadata: um(5), modelVersion: 'gemini-2.5-flash-lite', responseId: 'r-s' }),
    ev({ candidates: [{ content: { parts: [{ text: 'fim' }] }, finishReason: 'STOP' }], usageMetadata: um(9), modelVersion: 'gemini-2.5-flash-lite', responseId: 'r-s' }),
  ].join(''), 'utf8');
  const run = (chunks: Buffer[]) => {
    const texts: string[] = [];
    const acc = createStreamUsageAccumulator('gemini.generate_content', { ...ctx, origin: 'provider_stream' }, { maxBufferedBytes: 64 * 1024 }, { onTextDelta: (t) => texts.push(t) });
    for (const c of chunks) acc.push(c);
    return { u: acc.finish(), text: texts.join('') };
  };
  it('every split point (incl. inside multi-byte characters and inside CRLF): final 12/9, text intact, CU/money by hand', () => {
    for (let i = 0; i <= fixture.length; i++) {
      const { u, text } = run([fixture.subarray(0, i), fixture.subarray(i)]);
      assert.equal(u.completeness, 'complete', `split ${i}`);
      assert.deepEqual([u.tIn, u.tOut, u.finishReason, u.providerRequestId], [12n, 9n, 'STOP', 'r-s'], `split ${i}`);
      assert.equal(text, 'olá ✓ çãõ 😀 fim', `split ${i}`);
    }
    const { u } = run([fixture]);
    assert.deepEqual(computeCu(u, CFG).cu, { units: 21n * W, scale: 1_000_000n }, 'cumulative 9, not 2 + 5 + 9');
    assert.equal(priced(u).total!.units, 12n * PIN + 9n * POUT);
  });
  it('one byte per chunk', () => {
    const { u } = run([...fixture].map((b) => Buffer.from([b])));
    assert.deepEqual([u.completeness, u.tOut], ['complete', 9n]);
  });
  it('stream cut before the finish → partial (never final); no usage at all → missing', () => {
    const cut = fixture.subarray(0, fixture.indexOf(Buffer.from('fim')) - 40);
    assert.equal(run([cut]).u.completeness, 'partial');
    assert.equal(run([Buffer.from(ev({ candidates: [{ content: { parts: [{ text: 'x' }] } }] }))]).u.completeness, 'missing');
  });
  it('blocked prompt in a stream: final with the prompt usage', () => {
    const { u } = run([Buffer.from(ev({ promptFeedback: { blockReason: 'SAFETY' }, usageMetadata: { promptTokenCount: 30, totalTokenCount: 30 } }))]);
    assert.deepEqual([u.completeness, u.tIn, u.tOut, u.finishReason], ['complete', 30n, 0n, 'blocked:SAFETY']);
  });
  it('OpenAI chunks: the served tier is captured from the stream (server side)', () => {
    const acc = createStreamUsageAccumulator('openai.chat_completions', { ...ctx, provider: 'openai', modelRequested: 'gpt-4o-mini', origin: 'provider_stream' }, { maxBufferedBytes: 65536 });
    acc.push(`data: ${JSON.stringify({ id: 'c1', model: 'gpt-4o-mini-2024-07-18', service_tier: 'priority', choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    acc.push(`data: ${JSON.stringify({ id: 'c1', model: 'gpt-4o-mini-2024-07-18', service_tier: 'priority', choices: [], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\ndata: [DONE]\n\n`);
    assert.equal(acc.finish().serviceTier, 'priority');
  });
});

describe('G-GEM-MONEY (pure) — policy v4; v2/v3 unchanged', () => {
  const g = (body: Record<string, unknown>, maxOut = 64n) => assessMoneyBound(MONEY_BOUND_POLICY_V4, { provider: 'gemini', api: 'gemini.generate_content', model: 'gemini-2.5-flash-lite', body, maxOutputTokens: maxOut, headers: ['content-type'] });
  const ok = { contents: [{ role: 'user', parts: [{ text: 'a' }] }, { role: 'model', parts: [{ text: 'b' }] }, { parts: [{ text: 'c' }] }], systemInstruction: { parts: [{ text: 's' }] }, generationConfig: { maxOutputTokens: 64, temperature: 0, thinkingConfig: { thinkingBudget: 0 } } };
  it('text-only body with thinking off: admitted with the documented window and the frozen terms', () => {
    const d = g(ok);
    assert.ok(d.ok);
    if (d.ok) { assert.equal(d.inputBoundTokens, 1_048_576n); assert.deepEqual(d.pricingTerms, { serviceTier: 'standard', thinking: 'off' }); assert.equal(d.policyId, 'otk.money_bound_policy.v4@2026-10-03'); }
    assert.equal(g(ok, 65_536n).ok, true);
    assert.equal(g(ok, 65_537n).ok, false);
  });
  it('the same Gemini request is refused under v2 and v3 (no rule): earlier policies unchanged', () => {
    for (const p of [MONEY_BOUND_POLICY_V2, MONEY_BOUND_POLICY_V3]) assert.equal(assessMoneyBound(p, { provider: 'gemini', api: 'gemini.generate_content', model: 'gemini-2.5-flash-lite', body: ok, maxOutputTokens: 64n }).ok, false);
  });
  it('OpenAI service_tier: v3 refuses any client value (unchanged); v4 accepts only "default"', () => {
    const oa = (p: typeof MONEY_BOUND_POLICY_V4, t: unknown) => assessMoneyBound(p, { provider: 'openai', api: 'openai.chat_completions', model: 'gpt-4o-mini', body: { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'x' }], max_tokens: 8, ...(t === undefined ? {} : { service_tier: t }) }, maxOutputTokens: 8n });
    assert.equal(oa(MONEY_BOUND_POLICY_V3, 'default').ok, false);
    assert.equal(oa(MONEY_BOUND_POLICY_V3, undefined).ok, true);
    assert.equal(oa(MONEY_BOUND_POLICY_V4, 'default').ok, true);
    for (const t of ['auto', 'flex', 'priority', 'scale', 'fast', null, 1]) assert.equal(oa(MONEY_BOUND_POLICY_V4, t).ok, false, String(t));
    const d = oa(MONEY_BOUND_POLICY_V4, undefined);
    assert.ok(d.ok && d.pricingTerms?.serviceTier === 'default');
  });
  it('published policies: v2 default object unchanged, v3 rules unchanged, v4 listed', () => {
    assert.deepEqual(Object.keys(MONEY_BOUND_POLICIES).sort(), ['otk.money_bound_policy.v2@2026-10-02', 'otk.money_bound_policy.v3@2026-10-03', 'otk.money_bound_policy.v4@2026-10-03', 'otk.money_bound_policy.v5@2026-10-04']);
    // v5 = v4 rules unchanged + gemini-3.5-flash-lite
    const v5 = MONEY_BOUND_POLICIES['otk.money_bound_policy.v5@2026-10-04']!;
    assert.deepEqual(v5.rules.slice(0, MONEY_BOUND_POLICY_V4.rules.length), MONEY_BOUND_POLICY_V4.rules);
    assert.deepEqual(v5.rules.slice(MONEY_BOUND_POLICY_V4.rules.length).map((r) => [r.model, r.geminiThinking, r.contextWindowTokens, r.maxOutputTokens]), [['gemini-3.5-flash-lite', 'level_minimal', 1_048_576n, 65_536n]]);
    assert.equal(assessMoneyBound(MONEY_BOUND_POLICY_V4, { provider: 'gemini', api: 'gemini.generate_content', model: 'gemini-3.5-flash-lite', body: { contents: [{ parts: [{ text: 'a' }] }], generationConfig: { thinkingConfig: { thinkingLevel: 'minimal' } } }, maxOutputTokens: 8n }).ok, false, 'v4 has no 3.5 rule');
    assert.equal(MONEY_BOUND_POLICY_V3.rules.some((r) => r.pricingTerms), false);
    assert.equal(MONEY_BOUND_POLICY_V3.extraFields, undefined);
  });
  it('tier matching: OpenAI exact; Gemini standard/STANDARD/unspecified; null never matches', () => {
    assert.ok(serviceTierMatches('default', 'default'));
    assert.ok(!serviceTierMatches('default', 'auto'));
    assert.ok(serviceTierMatches('standard', 'STANDARD') && serviceTierMatches('standard', 'unspecified') && serviceTierMatches('standard', 'SERVICE_TIER_STANDARD'));
    assert.ok(!serviceTierMatches('standard', 'priority') && !serviceTierMatches('standard', null) && !serviceTierMatches('default', undefined));
  });
});

describe('versioned development weights (DL-09)', () => {
  it('historical profile keeps its version and digest (pilots v3 Anthropic/OpenAI); the new one adds only gemini-2.5-flash-lite = 600', () => {
    const hist = developmentWeights().active()!;
    assert.deepEqual(hist.ref, { version: 'dev-static-from-CostUnits.ts', digest: '0xf27b2c15b14173bcff5ba8c4c73516b49172d22f1a63cad636f885fe01dcbd93' });
    assert.equal(CFG.ref.version, 'dev-static-from-CostUnits.ts+gemini-2.5-flash-lite@2026-10-03');
    assert.equal(CFG.ref.digest, '0x2376ce79f055faee50aa946ddd645eef1d9cc789022c3effadcb200991f4e800', 'frozen digest (pilot runner pins it too)');
    assert.equal(CFG.developmentProfile, true);
    const added = Object.keys(CFG.table.modelWeightsMilli).filter((k) => !(k in hist.table.modelWeightsMilli));
    assert.deepEqual(added, ['gemini-2.5-flash-lite']);
    assert.equal(CFG.table.modelWeightsMilli['gemini-2.5-flash-lite'], CFG.table.modelWeightsMilli['gemini-2.0-flash']);
    assert.equal(hist.table.modelWeightsMilli['gemini-2.5-flash-lite'], undefined);
    const w = developmentWeights('development-2026-10-03');
    assert.ok(w.byRef(hist.ref) && w.byRef(CFG.ref), 'operations of either profile resolve their weights');
    assert.throws(() => developmentWeights('development-typo'));
    const w4 = developmentWeights('development-2026-10-04').active()!;
    assert.deepEqual(w4.ref, { version: 'dev-static-from-CostUnits.ts+gemini-2.5-flash-lite+gemini-3.5-flash-lite@2026-10-04', digest: '0xf5175787996e57b277954b96299c97efa24c3c5870cc79c46c7440a559895cb8' });
    assert.deepEqual(Object.keys(w4.table.modelWeightsMilli).filter((k) => !(k in hist.table.modelWeightsMilli)).sort(), ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite']);
    assert.ok(developmentWeights('development-2026-10-04').byRef(CFG.ref) && developmentWeights('development-2026-10-04').byRef(hist.ref));
  });
});

describe('bootstrap of the durable profile (entrypoint configuration)', () => {
  it('OTK_MONEY_BOUND_POLICY=v4 and OTK_CU_WEIGHTS_PROFILE=development-2026-10-03 are accepted; unknown development profiles are startup errors', async () => {
    const { d1d8ProfileFromEnv } = await import('../../src/operations/bootstrapD1D8.js');
    const missing = async (env: NodeJS.ProcessEnv) => {
      try { await d1d8ProfileFromEnv('postgres://u:p@127.0.0.1:1/none', env); return []; } catch (e) { return (e as { missing?: string[] }).missing ?? []; }
    };
    const has = (m: string[], p: string) => m.some((x) => x.startsWith(p));
    const ok = await missing({ OTK_MONEY_BOUND_POLICY: MONEY_BOUND_POLICY_V4.id, OTK_CU_WEIGHTS_PROFILE: 'development-2026-10-03' });
    assert.equal(has(ok, 'OTK_MONEY_BOUND_POLICY'), false);
    assert.equal(has(ok, 'OTK_CU_WEIGHTS'), false);
    for (const bad of ['development-2026-10-05', 'development-', 'developmentX']) {
      assert.equal(has(await missing({ OTK_CU_WEIGHTS_PROFILE: bad }), 'OTK_CU_WEIGHTS_PROFILE'), true, bad);
    }
  });
});
