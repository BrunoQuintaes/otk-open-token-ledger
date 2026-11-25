/**
 * PILOTO_V3 — canonical ledger settlement: only a provider-reported usage settles; a partial or absent
 * measurement, a missing category or a non-200 status keeps the reservation (uncertain).
 *
 * Modules under test: `scripts/pilot/anthropic/pilotV3Settlement.ts` (which usage settles a reservation) and
 * `scripts/pilot/anthropic/budgetLedger.ts` (the settlement it feeds).
 *
 * Strategy / partitions: complete response; deliberate disconnect with a final, partial or unsettled OTK
 * measurement; an absent category; a stream without its final event and a non-200 status; the OpenAI and the
 * Gemini usage shapes, including missing and malformed fields.
 *
 * Needs: nothing external; ledgers are written in temporary directories.
 *
 * Run just this file: `npx tsx --test test/unit/pilot_v3_settlement.test.ts`
 *
 * @module test/unit/pilot_v3_settlement.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BudgetLedger } from '../../scripts/pilot/anthropic/budgetLedger.js';
import { settlementFor, type SettlementInput } from '../../scripts/pilot/anthropic/pilotV3Settlement.js';

const MODEL = 'claude-haiku-4-5-20251001';
const full = { input_tokens: 20, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const cats = (cw: string | null) => [{ name: 'input', count: '30' }, { name: 'output', count: '120' }, { name: 'input_cache_write', count: cw }, { name: 'input_cache_read', count: '0' }];
const base: SettlementInput = { httpStatus: 200, clientComplete: true, clientUsage: full, otkMeasurement: 'final', otkMoneyState: 'settled', otkCategories: cats('0') };

function outcome(s: SettlementInput) {
  const ledger = new BudgetLedger(path.join(mkdtempSync(path.join(tmpdir(), 'pv3-settle-')), 'ledger.jsonl'));
  const r = ledger.reserve('t', MODEL, 200_000, 160);
  const st = settlementFor(s);
  return { source: st.source, ...ledger.settle(r.id, { httpStatus: st.httpStatus, usage: st.usage }) };
}

describe('PILOTO_V3 ledger settlement', () => {
  it('complete response: provider usage as received → ok at the provider price', () => {
    const o = outcome(base);
    assert.deepEqual([o.source, o.outcome, o.costUsd], ['provider_response', 'ok', 0.000045]);
  });

  it('after a deliberate disconnect: the OTK final measurement settles; partial or unsettled does not', () => {
    const d = { ...base, clientComplete: false, clientUsage: { input_tokens: 30, output_tokens: 1 } };
    const o = outcome(d);
    assert.deepEqual([o.source, o.outcome], ['otk_final_measurement', 'ok']);
    assert.ok(Math.abs(o.costUsd! - 0.00063) < 1e-12);
    assert.equal(outcome({ ...d, otkMeasurement: 'partial' }).outcome, 'uncertain');
    assert.equal(outcome({ ...d, otkMoneyState: 'held_uncertain' }).outcome, 'uncertain');
  });

  it('an absent category is never priced as zero', () => {
    assert.equal(outcome({ ...base, clientComplete: false, otkCategories: cats(null) }).outcome, 'uncertain');
    assert.equal(outcome({ ...base, clientUsage: { input_tokens: 20, output_tokens: 5 } }).outcome, 'uncertain');
  });

  it('a stream that ended without its final event, or a non-200 status, keeps the reservation', () => {
    assert.equal(outcome({ ...base, clientComplete: false, otkMeasurement: 'partial', otkMoneyState: 'held_uncertain' }).outcome, 'uncertain');
    assert.equal(outcome({ ...base, httpStatus: 502 }).outcome, 'uncertain');
    assert.equal(outcome({ ...base, httpStatus: undefined }).outcome, 'uncertain');
  });

  it('OpenAI: cached tokens are carved out of the prompt; missing cached_tokens is unknown, not zero', () => {
    const ledgerFor = (s: SettlementInput, model = 'gpt-4o-mini-2024-07-18') => {
      const ledger = new BudgetLedger(path.join(mkdtempSync(path.join(tmpdir(), 'pv3-settle-oa-')), 'ledger.jsonl'));
      const r = ledger.reserve('t', model, 128_000, 64);
      const st = settlementFor(s);
      return { source: st.source, ...ledger.settle(r.id, { httpStatus: st.httpStatus, usage: st.usage }) };
    };
    const oa: SettlementInput = { provider: 'openai', httpStatus: 200, clientComplete: true, otkMeasurement: 'final', otkMoneyState: 'settled', otkCategories: null,
      clientUsage: { prompt_tokens: 1500, completion_tokens: 40, total_tokens: 1540, prompt_tokens_details: { cached_tokens: 1024, audio_tokens: 0 } } };
    const ok = ledgerFor(oa);
    // 476 × 0.15 + 1024 × 0.075 + 40 × 0.60 = 71.4 + 76.8 + 24 = 172.2 µUSD
    assert.deepEqual([ok.source, ok.outcome], ['provider_response', 'ok']);
    assert.ok(Math.abs(ok.costUsd! - 0.0001722) < 1e-12, String(ok.costUsd));
    assert.equal(ledgerFor({ ...oa, clientUsage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }).outcome, 'uncertain');
    const viaOtk = ledgerFor({ ...oa, clientComplete: false, otkCategories: [{ name: 'input', count: '1500' }, { name: 'output', count: '40' }, { name: 'input_cache_read', count: '1024' }] });
    assert.deepEqual([viaOtk.source, viaOtk.outcome], ['otk_final_measurement', 'ok']);
    assert.ok(Math.abs(viaOtk.costUsd! - 0.0001722) < 1e-12);
    assert.equal(ledgerFor({ ...oa, clientComplete: false, otkCategories: [{ name: 'input', count: '1500' }, { name: 'output', count: '40' }, { name: 'input_cache_read', count: null }] }).outcome, 'uncertain');
    // malformed usage (cached above the prompt, negative or fractional counts) is unknown, never under-priced
    assert.equal(ledgerFor({ ...oa, clientUsage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 20 } } }).outcome, 'uncertain');
    assert.equal(ledgerFor({ ...oa, clientUsage: { prompt_tokens: 10, completion_tokens: -5, prompt_tokens_details: { cached_tokens: 0 } } }).outcome, 'uncertain');
    assert.equal(ledgerFor({ ...oa, clientUsage: { prompt_tokens: 10.5, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 0 } } }).outcome, 'uncertain');
  });

  it('Gemini (FECHAMENTO_GEMINI_AD): cache inside the prompt, thoughts as output, proto3 zero omission; malformed → uncertain', () => {
    const ledgerFor = (s: SettlementInput) => {
      const ledger = new BudgetLedger(path.join(mkdtempSync(path.join(tmpdir(), 'pv3-settle-gem-')), 'ledger.jsonl'));
      const r = ledger.reserve('t', 'gemini-2.5-flash-lite', 1_048_576, 64);
      // reservation by hand: 1 048 576 × 0.10 + 64 × 0.40 = 104 857.6 + 25.6 = 104 883.2 µUSD
      assert.ok(Math.abs(r.reservedUsd - 0.1048832) < 1e-12, String(r.reservedUsd));
      const st = settlementFor(s);
      return { source: st.source, ...ledger.settle(r.id, { httpStatus: st.httpStatus, usage: st.usage }) };
    };
    const g: SettlementInput = { provider: 'gemini', httpStatus: 200, clientComplete: true, otkMeasurement: 'final', otkMoneyState: 'settled', otkCategories: null,
      clientUsage: { promptTokenCount: 3000, cachedContentTokenCount: 2048, candidatesTokenCount: 40, totalTokenCount: 3040 } };
    // 952 × 0.10 + 2048 × 0.01 + 40 × 0.40 = 95.2 + 20.48 + 16 = 131.68 µUSD
    const ok = ledgerFor(g);
    assert.deepEqual([ok.source, ok.outcome], ['provider_response', 'ok']);
    assert.ok(Math.abs(ok.costUsd! - 0.00013168) < 1e-12, String(ok.costUsd));
    // omitted zero counts (proto3): no cache field, no candidates field → candidates = total − prompt − thoughts
    const omitted = ledgerFor({ ...g, clientUsage: { promptTokenCount: 10, totalTokenCount: 74, thoughtsTokenCount: 0 } });
    assert.ok(Math.abs(omitted.costUsd! - (10 * 0.1 + 64 * 0.4) / 1e6) < 1e-15, String(omitted.costUsd));
    // thoughts billed as output: 20 × 0.10 + (5 + 7) × 0.40 = 6.8 µUSD
    assert.ok(Math.abs(ledgerFor({ ...g, clientUsage: { promptTokenCount: 20, candidatesTokenCount: 5, thoughtsTokenCount: 7, totalTokenCount: 32 } }).costUsd! - 0.0000068) < 1e-15);
    for (const bad of [
      { candidatesTokenCount: 5, totalTokenCount: 5 },
      { promptTokenCount: 10, candidatesTokenCount: 5 },
      { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 99 },
      { promptTokenCount: 10, cachedContentTokenCount: 11, candidatesTokenCount: 5, totalTokenCount: 15 },
      { promptTokenCount: -1, candidatesTokenCount: 5, totalTokenCount: 4 },
      { promptTokenCount: 10.5, candidatesTokenCount: 5, totalTokenCount: 15.5 },
      { promptTokenCount: 10, toolUsePromptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 18 },
    ]) assert.equal(ledgerFor({ ...g, clientUsage: bad }).outcome, 'uncertain', JSON.stringify(bad));
    // after a disconnect: OTK categories (input includes the cache; reasoning absent = 0)
    const viaOtk = ledgerFor({ ...g, clientComplete: false, otkCategories: [{ name: 'input', count: '3000' }, { name: 'output', count: '40' }, { name: 'input_cache_read', count: '2048' }, { name: 'output_reasoning', count: null }] });
    assert.deepEqual([viaOtk.source, viaOtk.outcome], ['otk_final_measurement', 'ok']);
    assert.ok(Math.abs(viaOtk.costUsd! - 0.00013168) < 1e-12);
  });
});
