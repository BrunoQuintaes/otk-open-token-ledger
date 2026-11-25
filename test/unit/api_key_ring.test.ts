/**
 * ApiKeyRing — unit tests for the in-memory store of provider API secrets per tenant.
 *
 * Module under test: `InMemoryApiKeyStore` from `src/security/ApiKeyRing.ts`.
 *
 * Strategy / partitions: put, get and delete of one secret (get after delete returns `null`);
 * overwriting an existing secret; deleting twice (no error); two tenants with the same key id
 * (isolated).
 *
 * Needs: nothing external (fake secret strings only).
 *
 * Run just this file: `npx tsx --test test/unit/api_key_ring.test.ts`
 *
 * @module test/unit/api_key_ring.test
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryApiKeyStore } from '../../src/security/ApiKeyRing.js';

describe('ApiKeyRing — InMemoryApiKeyStore', () => {
  it('stores and retrieves secrets', () => {
    const s = new InMemoryApiKeyStore();
    const ref = { tenantId: 't1', provider: 'openai', keyId: 'k1' };
    s.put(ref, 'secret-123');
    assert.equal(s.get(ref), 'secret-123');
    s.del(ref);
    assert.equal(s.get(ref), null);
  });

  // --- QA1 edge cases ---
  it('overwrite replaces secret', () => {
    const s = new InMemoryApiKeyStore();
    const ref = { tenantId: 't1', provider: 'openai', keyId: 'k1' };
    s.put(ref, 'old');
    s.put(ref, 'new');
    assert.equal(s.get(ref), 'new');
  });

  it('del is idempotent (no throw on second delete)', () => {
    const s = new InMemoryApiKeyStore();
    const ref = { tenantId: 't2', provider: 'anthropic', keyId: 'k2' };
    s.put(ref, 'secret');
    s.del(ref);
    assert.doesNotThrow(() => s.del(ref));
    assert.equal(s.get(ref), null);
  });

  it('different tenants with same keyId are isolated', () => {
    const s = new InMemoryApiKeyStore();
    const r1 = { tenantId: 'tenant-A', provider: 'openai', keyId: 'shared-key' };
    const r2 = { tenantId: 'tenant-B', provider: 'openai', keyId: 'shared-key' };
    s.put(r1, 'secret-A');
    s.put(r2, 'secret-B');
    assert.equal(s.get(r1), 'secret-A');
    assert.equal(s.get(r2), 'secret-B');
  });
});
