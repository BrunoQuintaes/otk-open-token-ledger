/**
 * H-PACK-04 Tests — H2.6-H2.9 Storage Migration
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// H2.6: GovernanceTrail Store
import { MemoryGovernanceStore } from '../../src/security/IGovernanceStore.js';
import type { GovernanceEvent } from '../../src/security/GovernanceTrail.js';

// H2.7: Token Store
import { MemoryTokenStore } from '../../src/api/ITokenStore.js';

// H2.8: Dead Letter Store
import { MemoryDeadLetterStore } from '../../src/api/IDeadLetterStore.js';

// H2.9: Indexer Store
import { MemoryIndexerStore } from '../../src/dashboard/IIndexerStore.js';

// ═══════════════════════════════════════════
// H2.6 — GovernanceTrail Store
// ═══════════════════════════════════════════
describe('H2.6 — GovernanceTrail Storage', () => {
  const event: GovernanceEvent = { ts: '2026-03-30T00:00:00Z', tenantId: 't1', actor: 'admin', action: 'tenant_created' };

  it('append returns entry with hash and seq', async () => {
    const store = new MemoryGovernanceStore();
    const entry = await store.append(event, '');
    assert.equal(entry.seq, 1);
    assert.ok(entry.hash.length > 0);
  });

  it('head returns latest hash', async () => {
    const store = new MemoryGovernanceStore();
    const e = await store.append(event, '');
    assert.equal(await store.head(), e.hash);
  });

  it('count tracks entries', async () => {
    const store = new MemoryGovernanceStore();
    await store.append(event, '');
    await store.append({ ...event, action: 'plan_changed' }, '');
    assert.equal(await store.count(), 2);
  });

  it('verifyIntegrity passes on valid chain', async () => {
    const store = new MemoryGovernanceStore();
    await store.append(event, '');
    await store.append({ ...event, action: 'key_rotated' }, '');
    assert.deepEqual(await store.verifyIntegrity(), { valid: true });
  });

  it('list with pagination', async () => {
    const store = new MemoryGovernanceStore();
    for (let i = 0; i < 5; i++) await store.append({ ...event, action: `tenant_created` }, '');
    const page = await store.list({ limit: 2, offset: 2 });
    assert.equal(page.length, 2);
    assert.equal(page[0].seq, 3);
  });

  it('clear resets everything', async () => {
    const store = new MemoryGovernanceStore();
    await store.append(event, '');
    await store.clear();
    assert.equal(await store.count(), 0);
  });
});

// ═══════════════════════════════════════════
// H2.7 — Token Store
// ═══════════════════════════════════════════
describe('H2.7 — Token Storage', () => {
  it('register and resolve', async () => {
    const store = new MemoryTokenStore();
    await store.register('hash-abc', { tenantId: 't1', role: 'OPERATOR', registeredAt: '2026-03-30' });
    const entry = await store.resolve('hash-abc');
    assert.ok(entry);
    assert.equal(entry!.tenantId, 't1');
    assert.equal(entry!.role, 'OPERATOR');
  });

  it('returns null for unknown hash', async () => {
    const store = new MemoryTokenStore();
    assert.equal(await store.resolve('unknown'), null);
  });

  it('revoke removes entry', async () => {
    const store = new MemoryTokenStore();
    await store.register('hash-abc', { tenantId: 't1', role: 'ADMIN', registeredAt: '2026-03-30' });
    await store.revoke('hash-abc');
    assert.equal(await store.resolve('hash-abc'), null);
  });

  it('clear removes all', async () => {
    const store = new MemoryTokenStore();
    await store.register('h1', { tenantId: 't1', role: 'VIEWER', registeredAt: '2026-03-30' });
    await store.register('h2', { tenantId: 't2', role: 'OWNER', registeredAt: '2026-03-30' });
    await store.clear();
    assert.equal(await store.resolve('h1'), null);
    assert.equal(await store.resolve('h2'), null);
  });
});

// ═══════════════════════════════════════════
// H2.8 — Dead Letter Store
// ═══════════════════════════════════════════
describe('H2.8 — Dead Letter Storage', () => {
  it('add creates entry with id and pending status', async () => {
    const store = new MemoryDeadLetterStore();
    const entry = await store.add({ originalPayload: '{}', error: 'fail', reason: 'validation', source: 'test' });
    assert.ok(entry.id.startsWith('dl-'));
    assert.equal(entry.status, 'pending');
    assert.ok(entry.createdAt);
  });

  it('get returns stored entry', async () => {
    const store = new MemoryDeadLetterStore();
    const added = await store.add({ originalPayload: '{}', error: 'fail', reason: 'test', source: 'test' });
    const got = await store.get(added.id);
    assert.ok(got);
    assert.equal(got!.id, added.id);
  });

  it('list with status filter', async () => {
    const store = new MemoryDeadLetterStore();
    const e1 = await store.add({ originalPayload: '1', error: 'e', reason: 'r', source: 's' });
    await store.add({ originalPayload: '2', error: 'e', reason: 'r', source: 's' });
    await store.markRetried(e1.id);
    const pending = await store.list({ status: 'pending' });
    assert.equal(pending.length, 1);
  });

  it('list with pagination', async () => {
    const store = new MemoryDeadLetterStore();
    for (let i = 0; i < 5; i++) await store.add({ originalPayload: `${i}`, error: 'e', reason: 'r', source: 's' });
    const page = await store.list({ limit: 2, offset: 2 });
    assert.equal(page.length, 2);
  });

  it('markRetried updates status', async () => {
    const store = new MemoryDeadLetterStore();
    const e = await store.add({ originalPayload: '{}', error: 'e', reason: 'r', source: 's' });
    const updated = await store.markRetried(e.id);
    assert.ok(updated);
    assert.equal(updated!.status, 'retried');
    assert.ok(updated!.retriedAt);
  });

  it('markDiscarded updates status', async () => {
    const store = new MemoryDeadLetterStore();
    const e = await store.add({ originalPayload: '{}', error: 'e', reason: 'r', source: 's' });
    const updated = await store.markDiscarded(e.id);
    assert.equal(updated!.status, 'discarded');
  });

  it('count and pendingCount', async () => {
    const store = new MemoryDeadLetterStore();
    await store.add({ originalPayload: '1', error: 'e', reason: 'r', source: 's' });
    const e2 = await store.add({ originalPayload: '2', error: 'e', reason: 'r', source: 's' });
    await store.markRetried(e2.id);
    assert.equal(await store.count(), 2);
    assert.equal(await store.pendingCount(), 1);
  });
});

// ═══════════════════════════════════════════
// H2.9 — Indexer Store
// ═══════════════════════════════════════════
describe('H2.9 — Indexer Storage', () => {
  const receipt = {
    requestId: 'r1', provider: 'openai', model: 'gpt-4',
    inputTokens: 100, outputTokens: 50, costUnits: 10,
    latencyMs: 200, timestamp: 1711800000, tenantId: 't1',
    indexedAt: Date.now(),
  };

  it('index and getRecentReceipts', async () => {
    const store = new MemoryIndexerStore();
    await store.index(receipt);
    const recent = await store.getRecentReceipts();
    assert.equal(recent.length, 1);
    assert.equal(recent[0].requestId, 'r1');
  });

  it('getRecentReceipts returns newest first', async () => {
    const store = new MemoryIndexerStore();
    await store.index({ ...receipt, requestId: 'r1', indexedAt: 1 });
    await store.index({ ...receipt, requestId: 'r2', indexedAt: 2 });
    const recent = await store.getRecentReceipts();
    assert.equal(recent[0].requestId, 'r2');
  });

  it('getRecentReceipts with tenantId filter', async () => {
    const store = new MemoryIndexerStore();
    await store.index({ ...receipt, tenantId: 't1' });
    await store.index({ ...receipt, requestId: 'r2', tenantId: 't2' });
    const t1Only = await store.getRecentReceipts({ tenantId: 't1' });
    assert.equal(t1Only.length, 1);
  });

  it('getTenantSummary aggregates per tenant', async () => {
    const store = new MemoryIndexerStore();
    await store.index({ ...receipt, tenantId: 't1', costUnits: 10 });
    await store.index({ ...receipt, requestId: 'r2', tenantId: 't1', costUnits: 20 });
    await store.index({ ...receipt, requestId: 'r3', tenantId: 't2', costUnits: 5 });
    const summaries = await store.getTenantSummary();
    const t1 = summaries.find(s => s.tenantId === 't1');
    assert.ok(t1);
    assert.equal(t1!.totalReceipts, 2);
    assert.equal(t1!.totalCU, 30);
  });

  it('bounded at maxSize (evicts oldest)', async () => {
    const store = new MemoryIndexerStore(3);
    for (let i = 0; i < 5; i++) await store.index({ ...receipt, requestId: `r${i}` });
    assert.equal(await store.size(), 3);
    const recent = await store.getRecentReceipts();
    assert.equal(recent[0].requestId, 'r4'); // newest
  });

  it('pagination with limit+offset', async () => {
    const store = new MemoryIndexerStore();
    for (let i = 0; i < 10; i++) await store.index({ ...receipt, requestId: `r${i}` });
    const page = await store.getRecentReceipts({ limit: 3, offset: 2 });
    assert.equal(page.length, 3);
  });
});
