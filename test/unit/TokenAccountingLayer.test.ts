/**
 * TokenAccountingLayer — Unit Tests
 *
 * Checks the in-memory ledger of CU debits per tenant and epoch and its reconciliation against the
 * amount recorded on chain.
 *
 * Module under test: `src/security/TokenAccountingLayer.ts`.
 *
 * Strategy / partitions: empty ledger; one debit and several debits; the same request id twice
 * (counted once); isolation by tenant and by epoch; reconciliation when the on-chain total
 * matches and when it is behind; listing the entries of one tenant and epoch.
 *
 * Needs: nothing external (a fresh ledger per test).
 *
 * Run just this file: `npx tsx --test test/unit/TokenAccountingLayer.test.ts`
 *
 * @module test/unit/TokenAccountingLayer.test
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TokenAccountingLayer, type TALEntry } from '../../src/security/TokenAccountingLayer.js';

// Fixture builder: a 100-CU debit for tenant-a in epoch 709; tests override single fields.
function entry(overrides: Partial<TALEntry> = {}): TALEntry {
  return {
    tenantId: 'tenant-a',
    epochId: '709',
    requestId: 'req-001',
    provider: 'openai',
    model: 'gpt-4o',
    cu: 100n,
    ts: Date.now(),
    ...overrides,
  };
}

describe('TokenAccountingLayer', () => {
  let tal: TokenAccountingLayer;

  beforeEach(() => { tal = new TokenAccountingLayer(); });

  it('starts empty', () => {
    assert.equal(tal.size(), 0);
    const b = tal.balance('t', 'e');
    assert.equal(b.totalCU, 0n);
    assert.equal(b.entryCount, 0);
  });

  it('records a debit', () => {
    tal.debit(entry({ cu: 150n }));
    assert.equal(tal.size(), 1);
    const b = tal.balance('tenant-a', '709');
    assert.equal(b.totalCU, 150n);
    assert.equal(b.entryCount, 1);
  });

  it('accumulates multiple debits', () => {
    tal.debit(entry({ requestId: 'req-001', cu: 100n }));
    tal.debit(entry({ requestId: 'req-002', cu: 200n }));
    tal.debit(entry({ requestId: 'req-003', cu: 50n }));
    const b = tal.balance('tenant-a', '709');
    assert.equal(b.totalCU, 350n);
    assert.equal(b.entryCount, 3);
  });

  it('is idempotent by requestId within (tenantId, epochId)', () => {
    tal.debit(entry({ requestId: 'req-dup', cu: 100n }));
    tal.debit(entry({ requestId: 'req-dup', cu: 100n })); // duplicate
    assert.equal(tal.size(), 1);
    assert.equal(tal.balance('tenant-a', '709').totalCU, 100n);
  });

  it('isolates by tenantId', () => {
    tal.debit(entry({ tenantId: 'tenant-a', cu: 100n }));
    tal.debit(entry({ tenantId: 'tenant-b', requestId: 'req-002', cu: 200n }));
    assert.equal(tal.balance('tenant-a', '709').totalCU, 100n);
    assert.equal(tal.balance('tenant-b', '709').totalCU, 200n);
  });

  it('isolates by epochId', () => {
    tal.debit(entry({ epochId: '709', requestId: 'req-e1', cu: 100n }));
    tal.debit(entry({ epochId: '710', requestId: 'req-e2', cu: 200n }));
    assert.equal(tal.balance('tenant-a', '709').totalCU, 100n);
    assert.equal(tal.balance('tenant-a', '710').totalCU, 200n);
  });

  it('reconcile returns ok=true when on-chain matches', () => {
    tal.debit(entry({ cu: 100n }));
    tal.debit(entry({ requestId: 'req-002', cu: 200n }));
    const r = tal.reconcile('tenant-a', '709', 300n);
    assert.equal(r.ok, true);
    assert.equal(r.delta, 0n);
  });

  it('reconcile returns delta when on-chain is behind (unsubmitted)', () => {
    tal.debit(entry({ cu: 300n }));
    const r = tal.reconcile('tenant-a', '709', 100n);
    assert.equal(r.ok, false);
    assert.equal(r.delta, 200n); // 300 off-chain - 100 on-chain = 200 unsubmitted
  });

  it('entries() lists all entries for tenant+epoch', () => {
    tal.debit(entry({ requestId: 'req-001' }));
    tal.debit(entry({ requestId: 'req-002' }));
    tal.debit(entry({ tenantId: 'tenant-b', requestId: 'req-b' }));
    const es = tal.entries('tenant-a', '709');
    assert.equal(es.length, 2);
  });
});
