/**
 * D1–D8 / S4 ABC-04 + fechamento pós-S5 RV2-04 (pure): the strict-mode money reservation (policy v2)
 * is an upper bound of every price the official Haiku 4.5 table can produce for any usage the API can
 * bill for an allowed request — input up to the documented context window (200 000 tokens), split in
 * any way across the input categories of the table, and output up to max_tokens — for every returnable
 * model. Hand values (table, US$/MTok): input 1, cache read 0.10, cache write 5 min 1.25, output 5;
 * money scale 10^12 (pico-USD), so tokens × (µUSD/MTok) = pico-USD:
 *   max_tokens 64     → 200 000 × 1 250 000 +     64 × 5 000 000 = 250 320 000 000 (US$ 0.25032)
 *   max_tokens 1 024  → 250 000 000 000 +   5 120 000 000 = 255 120 000 000 (US$ 0.25512)
 *   max_tokens 64 000 → 250 000 000 000 + 320 000 000 000 = 570 000 000 000 (US$ 0.57)
 *   max_tokens 64 001 → refused (above the documented maximum output)
 *
 * Modules under test: `src/operations/moneyBound.ts` (`assessMoneyBound`, policies,
 * `returnedModelAllowed`), `src/pricing/reservation.ts` and `src/pricing/priceUsage.ts`.
 *
 * Strategy / partitions: the default policy and its per-model limits; reservations at the
 * max_tokens extremes listed above; many splits of a window-sized input across categories at
 * full output, for every returnable model, never cost more than the reservation; returned model
 * ids (listed in any case vs unlisted or absent); request categories without a defensible bound
 * (each refused with a reason); forwarded provider headers other than the API version.
 *
 * Needs: must be run from the repository root (reads the Haiku 4.5 price table under
 * `scripts/pilot/anthropic/` by relative path). No network.
 *
 * Run just this file: `npx tsx --test test/unit/d1d8_s4_money_bound.test.ts`
 *
 * @module test/unit/d1d8_s4_money_bound.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessMoneyBound, MONEY_BOUND_POLICY, MONEY_BOUND_POLICY_V2, returnedModelAllowed } from '../../src/operations/moneyBound.js';
import { createPriceTableRegistry, parsePriceTableV1, priceTableRef, priceUsageWithTable } from '../../src/pricing/priceUsage.js';
import { createEstimateReservation } from '../../src/pricing/reservation.js';
import { developmentCuConfig } from '../../src/economics/cuWeightsV2.js';
import type { NormalizedUsage } from '../../src/types/d1d8/index.js';

const table = parsePriceTableV1(JSON.parse(readFileSync('scripts/pilot/anthropic/price_table_anthropic_haiku45_20261001.json', 'utf8')));
const ref = priceTableRef(table);
const estimate = createEstimateReservation(createPriceTableRegistry([table]));
const body = { model: 'claude-haiku-4-5', max_tokens: 64, messages: [{ role: 'user', content: 'Say hello in one word.' }] };
const W = 200_000n;
const assess = (b: Record<string, unknown>, maxOut = 64n, model = 'claude-haiku-4-5', headers: string[] = ['content-type', 'anthropic-version']) =>
  assessMoneyBound(MONEY_BOUND_POLICY, { provider: 'anthropic', api: 'anthropic.messages', model, body: b, maxOutputTokens: maxOut, headers });
const reason = (d: ReturnType<typeof assess>) => (d.ok ? '' : d.reason);
const reserve = (maxOut: bigint, model = 'claude-haiku-4-5') =>
  estimate({ provider: 'anthropic', api: 'anthropic.messages', modelRequested: model, estimatedInputTokens: W, maxOutputTokens: maxOut }, developmentCuConfig(), ref).money!.units;

function anthropicUsage(input: bigint, cacheRead: bigint, cacheWrite: bigint, output: bigint, model: string): NormalizedUsage {
  return {
    schema: 'otk.usage.v1', api: 'anthropic.messages', provider: 'anthropic', modelRequested: 'claude-haiku-4-5', modelReturned: model,
    providerRequestId: 'msg', origin: 'provider_response', completeness: 'complete',
    categories: [
      { name: 'input', count: input, inclusion: 'base', sourceField: 'usage.input_tokens' },
      { name: 'output', count: output, inclusion: 'base', sourceField: 'usage.output_tokens' },
      { name: 'input_cache_read', count: cacheRead, inclusion: 'separate_addend', sourceField: 'usage.cache_read_input_tokens' },
      { name: 'input_cache_write', count: cacheWrite, inclusion: 'separate_addend', sourceField: 'usage.cache_creation_input_tokens' },
    ],
    tIn: input + cacheRead + cacheWrite, tOut: output, tRule: 'otk.t_rule.v1', rawUsageDigest: `0x${'00'.repeat(32)}`,
    normalizerVersion: 'test', docRef: { url: 'test', retrievedAt: '2026-10-01T00:00:00.000Z' }, observedAt: '2026-10-01T12:00:00.000Z',
  } as NormalizedUsage;
}

describe('RV2-04 — money bound policy v2 (pure)', () => {
  it('the default is v2, bounded by the documented window and maximum output of each listed model', () => {
    assert.equal(MONEY_BOUND_POLICY, MONEY_BOUND_POLICY_V2);
    assert.equal(MONEY_BOUND_POLICY.id, 'otk.money_bound_policy.v2@2026-10-02');
    for (const r of MONEY_BOUND_POLICY.rules) {
      assert.equal(r.contextWindowTokens, 200_000n);
      assert.equal(r.maxOutputTokens, 64_000n);
      assert.match(r.docRef, /models\/overview/);
      assert.match(r.docRef, /context-windows/);
    }
    const d = assess(body);
    assert.equal(d.ok, true);
    assert.equal((d as { inputBoundTokens: bigint }).inputBoundTokens, W, 'the input bound is the window, never a byte count or estimate');
    // a longer body does not change the bound
    assert.equal((assess({ ...body, messages: [{ role: 'user', content: 'x'.repeat(100_000) }] }) as { inputBoundTokens: bigint }).inputBoundTokens, W);
  });

  it('hand-computed reservations at the extremes of max_tokens; above the documented maximum is refused', () => {
    assert.equal(reserve(1n), 250_005_000_000n);
    assert.equal(reserve(64n), 250_320_000_000n);
    assert.equal(reserve(1024n), 255_120_000_000n);
    assert.equal(reserve(64_000n), 570_000_000_000n);
    assert.equal(assess(body, 64_000n).ok, true);
    assert.match(reason(assess(body, 64_001n)), /max output 64001 outside 1\.\.64000/);
  });

  it('every split of a window-sized input across the table categories, at full output, on every returnable model, costs ≤ the reservation', () => {
    for (const maxOut of [1n, 64n, 64_000n]) {
      const R = reserve(maxOut);
      const splits: Array<[bigint, bigint, bigint]> = [[W, 0n, 0n], [0n, W, 0n], [0n, 0n, W], [W / 3n, W / 3n, W - 2n * (W / 3n)], [1n, 0n, W - 1n]];
      for (const model of ['claude-haiku-4-5', 'claude-haiku-4-5-20251001']) {
        assert.equal(reserve(maxOut, model), R, 'same rule for alias and snapshot');
        for (const [i, cr, cw] of splits) {
          const q = priceUsageWithTable(anthropicUsage(i, cr, cw, maxOut, model), '2026-10-01T12:00:00.000Z', table, ref);
          assert.equal(q.status, 'priced', `${model} ${i}/${cr}/${cw}`);
          assert.ok(q.total!.units <= R, `${model} ${i}/${cr}/${cw}/${maxOut}: ${q.total!.units} ≤ ${R}`);
        }
      }
      // the worst split (all input as a 5-minute cache write, full output) reaches the reservation exactly
      const worst = priceUsageWithTable(anthropicUsage(0n, 0n, W, maxOut, 'claude-haiku-4-5-20251001'), '2026-10-01T12:00:00.000Z', table, ref);
      assert.equal(worst.total!.units, R);
    }
  });

  it('returned model check: listed ids pass (case-insensitive), anything else or no model breaks the bound', () => {
    const allowed = MONEY_BOUND_POLICY.rules[0]!.returnedModels;
    assert.equal(returnedModelAllowed(allowed, 'CLAUDE-HAIKU-4-5-20251001'), true);
    assert.equal(returnedModelAllowed(allowed, 'claude-sonnet-4-5'), false);
    assert.equal(returnedModelAllowed(allowed, null), false);
    assert.equal(returnedModelAllowed(undefined, 'anything'), true, 'non-strict operations carry no set');
  });

  it('categories without a defensible bound are refused, each with its reason (no silent pass)', () => {
    assert.match(reason(assess({ ...body, tools: [] })), /field tools/);
    assert.match(reason(assess({ ...body, tool_choice: { type: 'auto' } })), /field tool_choice/);
    assert.match(reason(assess({ ...body, thinking: { type: 'enabled', budget_tokens: 1024 } })), /field thinking/);
    assert.match(reason(assess({ ...body, service_tier: 'auto' })), /field service_tier/);
    assert.match(reason(assess({ ...body, inference_geo: 'us' })), /field inference_geo/);
    assert.match(reason(assess({ ...body, cache_control: { type: 'ephemeral' } })), /field cache_control/, 'automatic caching (top-level)');
    assert.match(reason(assess({ ...body, system: [{ type: 'text', text: 's', cache_control: { type: 'ephemeral' } }] })), /cache_control/);
    assert.match(reason(assess({ ...body, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', cache_control: { type: 'ephemeral', ttl: '1h' } }] }] })), /cache_control/);
    assert.match(reason(assess({ ...body, messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }] }] })), /content type image/);
    assert.match(reason(assess({ ...body, messages: [{ role: 'user', content: [{ type: 'document', source: { type: 'url', url: 'https://example.invalid/a.pdf' } }] }] })), /content type document/);
    let deep: unknown = 'x';
    for (let i = 0; i < 40; i++) deep = [deep];
    assert.match(reason(assess({ ...body, messages: deep })), /nested too deeply/);
    assert.match(reason(assess(body, 64n, 'claude-opus-4-5')), /no bounded-cost rule/);
    assert.match(reason(assessMoneyBound(MONEY_BOUND_POLICY, { provider: 'openai', api: 'openai.chat_completions', model: 'gpt-4o-mini', body: {}, maxOutputTokens: 64n })), /no bounded-cost rule/);
  });

  it('forwarded provider headers other than the API version are refused (betas can change limits or billing)', () => {
    assert.equal(assess(body, 64n, 'claude-haiku-4-5', ['content-type', 'anthropic-version', 'x-test-script']).ok, true);
    assert.match(reason(assess(body, 64n, 'claude-haiku-4-5', ['anthropic-version', 'anthropic-beta'])), /header anthropic-beta/);
    assert.match(reason(assess(body, 64n, 'claude-haiku-4-5', ['Anthropic-Beta'])), /header anthropic-beta/);
  });
});
