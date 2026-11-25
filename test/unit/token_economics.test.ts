/**
 * G3 — Token Economics behavioral tests
 *
 * Validates the core invariants of the token economics contract:
 *   - CU != USD (types are distinct: bigint vs number)
 *   - evaluateTokenValuation is pure and deterministic
 *   - DEFAULT_VALUATION_POLICY is fixed-mode (no oracle dependency)
 *   - assertCUInvariant enforces non-negativity
 *   - convertValuation applies rate correctly
 *
 * Modules under test: `src/economics/tokenEconomicsPolicy.ts` and `src/economics/tokenEconomicsTypes.ts`.
 *
 * Strategy / partitions: the default policy mode; the valuation for several amounts (linear, exact rate,
 * reference rate kept); the CU invariant on zero, positive and negative amounts; currency conversion with a
 * positive and a non-positive rate.
 *
 * Needs: nothing external (pure functions).
 *
 * Run just this file: `npx tsx --test test/unit/token_economics.test.ts`
 *
 * @module test/unit/token_economics.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VALUATION_POLICY,
  type ReferenceRate,
} from '../../src/economics/tokenEconomicsTypes.js';
import {
  evaluateTokenValuation,
  assertCUInvariant,
  convertValuation,
} from '../../src/economics/tokenEconomicsPolicy.js';

// Stable reference rate fixture (injectable, deterministic)
const FIXED_RATE: ReferenceRate = {
  pair: 'USD_BRL',
  rate: 5.10,
  snapshotEpoch: 1_740_873_600,
  source: 'fixed',
  version: '2026-02',
};

describe('Token Economics — CU/USD separation invariants', () => {
  it('DEFAULT_VALUATION_POLICY has mode: fixed (no oracle dependency)', () => {
    assert.equal(DEFAULT_VALUATION_POLICY.mode, 'fixed');
  });

  it('amountCU is bigint, valuationUsd is number (type separation)', () => {
    const result = evaluateTokenValuation(1000n, FIXED_RATE);
    assert.equal(typeof result.amountCU, 'bigint', 'amountCU must be bigint');
    assert.equal(typeof result.valuationUsd, 'number', 'valuationUsd must be number');
  });

  it('valuationUsd scales linearly with amountCU', () => {
    const r1 = evaluateTokenValuation(1000n, FIXED_RATE);
    const r2 = evaluateTokenValuation(2000n, FIXED_RATE);
    assert.equal(r2.valuationUsd, r1.valuationUsd * 2);
  });

  it('valuationUsd = amountCU × usdPerCU at default policy', () => {
    const amountCU = 1_000_000n;
    const result = evaluateTokenValuation(amountCU, FIXED_RATE);
    const expected = Number(amountCU) * DEFAULT_VALUATION_POLICY.usdPerCU;
    assert.equal(result.valuationUsd, expected);
  });

  it('referenceRate is preserved in output (rate injected, not mutated)', () => {
    const result = evaluateTokenValuation(500n, FIXED_RATE, DEFAULT_VALUATION_POLICY, 9999);
    assert.equal(result.referenceRate.rate, FIXED_RATE.rate);
    assert.equal(result.referenceRate.source, 'fixed');
    assert.equal(result.computedAt, 9999);
  });
});

describe('Token Economics — CU invariant enforcement', () => {
  it('assertCUInvariant passes on zero', () => {
    assert.doesNotThrow(() => assertCUInvariant(0n));
  });

  it('assertCUInvariant passes on positive CU', () => {
    assert.doesNotThrow(() => assertCUInvariant(1_000_000n));
  });

  it('assertCUInvariant throws on negative CU', () => {
    assert.throws(() => assertCUInvariant(-1n), /CU invariant violation/);
  });
});

describe('Token Economics — convertValuation', () => {
  it('convertValuation applies USD→BRL rate correctly', () => {
    const usd = 2.0;
    const rate = 5.10;
    const brl = convertValuation(usd, rate);
    assert.ok(Math.abs(brl - 10.20) < 1e-10, `Expected ~10.20, got ${brl}`);
  });

  it('convertValuation throws on non-positive rate', () => {
    assert.throws(() => convertValuation(1.0, 0), /rate=0 must be > 0/);
    assert.throws(() => convertValuation(1.0, -1), /rate=-1 must be > 0/);
  });
});
