/**
 * Tests — BillingToken (RB-053) — QA1 edge cases
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canDebit, debitToken, createBillingToken } from '../../src/economics/BillingToken.js';

const NOW = 1_000_000;

describe('BillingToken — canDebit', () => {
  it('allows debit when balance sufficient', () => {
    const t = createBillingToken('u1', 500n);
    const r = canDebit(t, 100n, NOW);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.remaining, 400n);
  });

  it('denies when insufficient balance', () => {
    const t = createBillingToken('u1', 50n);
    const r = canDebit(t, 100n, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'insufficient_balance');
  });

  it('denies when token expired', () => {
    const t = createBillingToken('u1', 1000n, NOW - 1); // expired 1s ago
    const r = canDebit(t, 100n, NOW);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'expired');
  });

  it('allows when no expiry (expiryEpoch=0)', () => {
    const t = createBillingToken('u1', 1000n, 0);
    const r = canDebit(t, 100n, NOW);
    assert.equal(r.ok, true);
  });

  it('allows debit of exact balance (remaining == 0n)', () => {
    const t = createBillingToken('u1', 100n);
    const r = canDebit(t, 100n, NOW);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.remaining, 0n);
  });

  it('allows debit of 0 CU (no-op)', () => {
    const t = createBillingToken('u1', 100n);
    const r = canDebit(t, 0n, NOW);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.remaining, 100n);
  });
});

describe('BillingToken — debitToken', () => {
  it('returns new token with reduced balance (immutable)', () => {
    const t = createBillingToken('u1', 500n);
    const t2 = debitToken(t, 200n, NOW);
    assert.equal(t2.balanceCU, 300n);
    assert.equal(t.balanceCU, 500n); // original unchanged
  });

  it('throws on expired token', () => {
    const t = createBillingToken('u1', 1000n, NOW - 1);
    assert.throws(() => debitToken(t, 100n, NOW), /expired/);
  });

  it('throws on insufficient balance', () => {
    const t = createBillingToken('u1', 10n);
    assert.throws(() => debitToken(t, 100n, NOW), /insufficient_balance/);
  });
});

// --- ARCH2: determinism tests ---
describe('BillingToken — createBillingToken determinism', () => {
  it('deterministic when opts provided (same id + createdAt)', () => {
    const opts = { nowIso: '2026-01-01T00:00:00Z', idSeed: 'seed-42' };
    const t1 = createBillingToken('u1', 100n, 0, opts);
    const t2 = createBillingToken('u1', 100n, 0, opts);
    assert.equal(t1.id, t2.id);
    assert.equal(t1.createdAt, t2.createdAt);
    assert.equal(t1.createdAt, '2026-01-01T00:00:00Z');
  });
});
