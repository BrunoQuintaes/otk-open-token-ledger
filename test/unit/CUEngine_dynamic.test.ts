/**
 * PACK B — CUEngine dynamic weights tests (ADR-0203 Phase 1)
 *
 * Tests computePublishedCUWithCW() and verifyCWSignature() integration.
 * Since D5/S0-F01 a v1 table is refused (see the block below).
 *
 * Modules under test: `src/economics/CUEngine.ts` (published CU computed with an optional signed
 * weights table) and `src/economics/CUWeightsLoader.ts` (`buildSignedMessage`, `verifyCWSignature`).
 *
 * Strategy / partitions: no table (`null`, must equal the static `computePublishedCU`); a v1
 * weighted-sum table for each provider (must throw `CU_WEIGHTS_V1_REJECTED`), for both the bigint
 * and the Number variant; the signed message is deterministic; a placeholder signature is rejected.
 *
 * Needs: nothing external (in-memory fixture tables, no network).
 *
 * Run just this file: `npx tsx --test test/unit/CUEngine_dynamic.test.ts`
 *
 * @module test/unit/CUEngine_dynamic.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computePublishedCUWithCW, computePublishedCUWithCWNumber, computePublishedCU, CU_WEIGHTS_V1_REJECTED } from '../../src/economics/CUEngine.js';
import { verifyCWSignature, buildSignedMessage, type CWJson } from '../../src/economics/CUWeightsLoader.js';

const VALID_CW: CWJson = {
  version: '2.0.0',
  validFrom: '2020-01-01T00:00:00Z',
  validUntil: '2099-12-31T23:59:59Z',
  weights: {
    openai: {
      'gpt-4': { inputWeight: 2.0, outputWeight: 4.0, latencyWeight: 0.001 },
    },
    anthropic: {
      'claude-opus-4': { inputWeight: 1.8, outputWeight: 3.6, latencyWeight: 0.001 },
    },
  },
  signedBy: '0x0000000000000000000000000000000000000001',
  signature: '0x0000',
};

const INPUT_OPENAI = { provider: 'openai', model: 'gpt-4', inputTokens: 100, outputTokens: 50 };
const INPUT_ANTHROPIC = { provider: 'anthropic', model: 'claude-opus-4', inputTokens: 100, outputTokens: 50 };

describe('CUEngine dynamic — null cwJson falls back to static', () => {
  it('returns same value as computePublishedCU when cwJson=null', () => {
    const dyn = computePublishedCUWithCW(INPUT_OPENAI, null);
    const stat = computePublishedCU(INPUT_OPENAI);
    assert.equal(dyn, stat);
  });
});

// D5 / S0-F01: the v1 table was applied as round((tIn×inputWeight + tOut×outputWeight)/1000)
// (here 100×2.0 + 50×4.0 = 400 CU, a weighted sum) and unknown models fell back to static
// constants. Those acceptance tests characterized the defect; the function now refuses a v1
// table. The multiplicative v2 path is tested in test/unit/d1d8_b_cu_price.test.ts.
describe('CUEngine dynamic — v1 (weighted-sum) tables are refused (S0-F01)', () => {
  for (const [label, input] of [
    ['catalogued openai/gpt-4', INPUT_OPENAI],
    ['catalogued anthropic/claude-opus-4', INPUT_ANTHROPIC],
    ['model missing from the table (formerly silent static fallback)', { provider: 'openai', model: 'gpt-3.5-turbo', inputTokens: 100, outputTokens: 50 }],
    ['provider missing from the table (formerly silent static fallback)', { provider: 'gemini', model: 'gemini-pro', inputTokens: 100, outputTokens: 50 }],
  ] as const) {
    it(`${label}: throws CU_WEIGHTS_V1_REJECTED`, () => {
      assert.throws(() => computePublishedCUWithCW(input, VALID_CW), (e: unknown) => (e as { code?: string }).code === CU_WEIGHTS_V1_REJECTED);
    });
  }

  it('Number variant refuses the same way', () => {
    assert.throws(() => computePublishedCUWithCWNumber(INPUT_OPENAI, VALID_CW), (e: unknown) => (e as { code?: string }).code === CU_WEIGHTS_V1_REJECTED);
  });

  it('Number variant with null table equals the static value', () => {
    assert.equal(computePublishedCUWithCWNumber(INPUT_OPENAI, null), Number(computePublishedCU(INPUT_OPENAI)));
  });
});

describe('CUWeightsLoader — buildSignedMessage', () => {
  it('produces deterministic canonical message', () => {
    const m1 = buildSignedMessage(VALID_CW);
    const m2 = buildSignedMessage(VALID_CW);
    assert.equal(m1, m2);
    assert.ok(m1.startsWith('CW-WEIGHTS-V2:'));
    assert.ok(m1.includes('"version":"2.0.0"'));
  });
});

describe('CUWeightsLoader — verifyCWSignature', () => {
  it('returns false for invalid/placeholder signature', async () => {
    const result = await verifyCWSignature(VALID_CW);
    // Placeholder '0x0000' signature will not recover to the expected address
    assert.equal(result, false);
  });
});
