/**
 * PILOTO_V3 (OpenAI) — money bound policy v3: v2 unchanged and still the default; v3 adds OpenAI Chat
 * Completions with gpt-4o-mini (documented limits 128K / 16,384) and refuses every field that may add cost
 * outside the token bound. The combined pilot price table prices both models (worst case per side).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  assessMoneyBound, MONEY_BOUND_POLICIES, MONEY_BOUND_POLICY, MONEY_BOUND_POLICY_V2, MONEY_BOUND_POLICY_V3,
} from '../../src/operations/moneyBound.js';
import { parsePriceTableV1, worstCaseSidePrices } from '../../src/pricing/priceUsage.js';
import { d1d8ProfileFromEnv, type D1D8ConfigError } from '../../src/operations/bootstrapD1D8.js';

const oa = (body: Record<string, unknown>, maxOut = 64n, headers: string[] = []) =>
  assessMoneyBound(MONEY_BOUND_POLICY_V3, { provider: 'openai', api: 'openai.chat_completions', model: String(body['model'] ?? 'gpt-4o-mini'), body, maxOutputTokens: maxOut, headers });
const base = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'oi' }], max_tokens: 64 };

describe('money bound policy v3 (PILOTO_V3 OpenAI)', () => {
  it('v2 is unchanged and remains the default; v3 extends it', () => {
    assert.equal(MONEY_BOUND_POLICY, MONEY_BOUND_POLICY_V2);
    assert.equal(MONEY_BOUND_POLICY_V2.id, 'otk.money_bound_policy.v2@2026-10-02');
    assert.equal(MONEY_BOUND_POLICY_V2.rules.length, 2);
    assert.ok(MONEY_BOUND_POLICY_V2.rules.every((r) => r.provider === 'anthropic'));
    assert.deepEqual(MONEY_BOUND_POLICY_V3.rules.slice(0, 2), MONEY_BOUND_POLICY_V2.rules);
    // FECHAMENTO_GEMINI_AD: v4 (Gemini + OpenAI tier terms) was published after this test; v2 and v3 stay as they were
    assert.deepEqual(Object.keys(MONEY_BOUND_POLICIES).sort(), [MONEY_BOUND_POLICY_V2.id, MONEY_BOUND_POLICY_V3.id, 'otk.money_bound_policy.v4@2026-10-03', 'otk.money_bound_policy.v5@2026-10-04'].sort());
    assert.match(String((assessMoneyBound(MONEY_BOUND_POLICY_V2, { provider: 'openai', api: 'openai.chat_completions', model: 'gpt-4o-mini', body: base, maxOutputTokens: 64n }) as { reason: string }).reason), /no bounded-cost rule/);
  });

  it('gpt-4o-mini (alias and snapshot) is admitted with the documented limits', () => {
    const d = oa({ ...base, stream: true, stream_options: { include_usage: true }, temperature: 0 });
    assert.ok(d.ok);
    if (d.ok) {
      assert.equal(d.inputBoundTokens, 128_000n);
      assert.deepEqual(d.rule.returnedModels, ['gpt-4o-mini', 'gpt-4o-mini-2024-07-18']);
      assert.equal(d.policyId, 'otk.money_bound_policy.v3@2026-10-03');
    }
    const snap = oa({ ...base, model: 'gpt-4o-mini-2024-07-18' });
    assert.ok(snap.ok && snap.rule.returnedModels.length === 1);
    assert.ok(oa(base, 16_384n).ok);
    assert.ok(!oa(base, 16_385n).ok);
  });

  it('fields and headers that may add cost outside the token bound are refused', () => {
    for (const f of ['tools', 'service_tier', 'audio', 'modalities', 'prediction', 'store', 'response_format', 'reasoning_effort', 'logit_bias']) {
      const d = oa({ ...base, [f]: 'x' });
      assert.ok(!d.ok && /field/.test(d.reason), f);
    }
    assert.ok(!oa(base, 64n, ['openai-organization']).ok);
    assert.ok(!oa({ ...base, messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'x' } }] }] }).ok);
    assert.ok(!oa({ ...base, model: 'gpt-4o' }).ok);
  });

  it('a message carrying an audio reference is outside the bound', () => {
    const d = oa({ ...base, messages: [{ role: 'assistant', audio: { id: 'audio_1' } }, { role: 'user', content: 'oi' }] });
    assert.ok(!d.ok && /audio/.test(d.reason));
  });

  it('bootstrap: OTK_MONEY_BOUND_POLICY must name a published policy exactly (blank or prototype names are errors)', async () => {
    const missing = async (env: NodeJS.ProcessEnv) => {
      try { await d1d8ProfileFromEnv('postgres://u:p@127.0.0.1:1/none', env); return []; } catch (e) { return (e as D1D8ConfigError).missing ?? []; }
    };
    const policyMissing = async (env: NodeJS.ProcessEnv) => (await missing(env)).some((m) => m.startsWith('OTK_MONEY_BOUND_POLICY'));
    assert.equal(await policyMissing({}), false, 'unset → default v2');
    assert.equal(await policyMissing({ OTK_MONEY_BOUND_POLICY: MONEY_BOUND_POLICY_V3.id }), false);
    for (const bad of ['toString', '__proto__', 'constructor', '   ', '', 'otk.money_bound_policy.v9@2026-10-03']) {
      assert.equal(await policyMissing({ OTK_MONEY_BOUND_POLICY: bad }), true, JSON.stringify(bad));
    }
  });

  it('the combined pilot price table prices both models; its worst case is the highest tariff per side', () => {
    const t = parsePriceTableV1(JSON.parse(fs.readFileSync('scripts/pilot/price_table_pilot_v3_20261003.json', 'utf8')));
    assert.deepEqual(worstCaseSidePrices(t, 'openai', 'gpt-4o-mini-2024-07-18'), { input: 150_000n, output: 600_000n });
    assert.deepEqual(worstCaseSidePrices(t, 'anthropic', 'claude-haiku-4-5-20251001'), { input: 1_250_000n, output: 5_000_000n });
  });
});
