/**
 * H1R2 R-13 / A3 (H1 final closure run): authoritative per-request freshness of dynamic keys and of the subject status.
 *
 * "Replica A" is simulated by writing straight to the SHARED stores (key metadata, subject status) without touching this
 * process's caches — exactly what another replica does. This process plays replica B. The same scenarios run against
 * two real server processes and PostgreSQL in test/integration/h1r2_r13_two_replicas_pg.test.ts.
 *
 * Each "stale" assertion documents the defect: without refreshCredential() the per-process hash registry and the TTL
 * snapshot keep admitting what replica A already revoked.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';

import { authenticateRequest } from '../../src/auth/authMiddleware.js';
import {
  setKeyAuthority, refreshCredential, isStrictRoute, credentialAuthorityStats, resetCredentialAuthorityStatsForTest,
  presentedCredential, resetKeyLookupLimiterForTest,
} from '../../src/auth/credentialAuthority.js';
import { createApiKey, hashKey } from '../../src/api/apiKeyManager.js';
import {
  MemoryApiKeyMetadataStore, setApiKeyMetadataStore, resetApiKeyMetadataStoreForTest, type ApiKeyMetadata,
} from '../../src/api/IApiKeyMetadataStore.js';
import { registerToken, clearRegistry, clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';
import {
  MemorySubjectStatusStore, setSubjectStatusStore, resetSubjectStatusStoreForTest, clearTenantStatusForTest,
  clearUserStatusForTest, type SubjectStatusRecord,
} from '../../src/auth/subjectStatus.js';

const req = (token: string): IncomingMessage => ({ headers: { authorization: `Bearer ${token}` } }) as unknown as IncomingMessage;
const authed = (token: string) => authenticateRequest(req(token)).authenticated;
const STATIC = 'static-registry-token-h1r2-r13-0123456789abcdef';

function rawKeyRow(tenantId: string, over: Partial<ApiKeyMetadata> = {}): { raw: string; meta: ApiKeyMetadata } {
  const raw = `otk_k_${'ab'.repeat(16)}${Math.random().toString(16).slice(2).padEnd(32, '0').slice(0, 32)}`;
  return {
    raw,
    meta: {
      keyId: `key_${Math.random().toString(36).slice(2)}`, tenantId, label: 'replica-a', prefix: raw.slice(0, 14),
      tokenHash: hashKey(raw), role: 'OWNER', createdAt: new Date(Date.now() - 5_000).toISOString(), expiresAt: null,
      revokedAt: null, lastUsedAt: null, createdBy: null, ...over,
    },
  };
}

describe('H1R2 R-13: dynamic keys are decided by the shared key store on every request', () => {
  let store: MemoryApiKeyMetadataStore;
  let status: MemorySubjectStatusStore;
  const prevTtl = process.env['OTK_SUBJECT_STATUS_TTL_MS'];

  beforeEach(async () => {
    process.env['OTK_SUBJECT_STATUS_TTL_MS'] = '600000'; // the TTL snapshot must NOT be what makes these tests pass
    clearRegistry(); clearHashRegistryForTest(); clearTenantStatusForTest(); clearUserStatusForTest();
    resetSubjectStatusStoreForTest(); resetCredentialAuthorityStatsForTest(); resetKeyLookupLimiterForTest();
    registerToken(STATIC, 'acme', 'OWNER'); // auth enabled
    store = new MemoryApiKeyMetadataStore();
    setApiKeyMetadataStore(store);
    setKeyAuthority(store);
    status = new MemorySubjectStatusStore();
    await setSubjectStatusStore(status);
  });

  afterEach(() => {
    setKeyAuthority(null); resetApiKeyMetadataStoreForTest(); resetSubjectStatusStoreForTest();
    clearRegistry(); clearHashRegistryForTest(); clearTenantStatusForTest(); clearUserStatusForTest();
    if (prevTtl === undefined) delete process.env['OTK_SUBJECT_STATUS_TTL_MS']; else process.env['OTK_SUBJECT_STATUS_TTL_MS'] = prevTtl;
  });

  it('a key created on replica A authenticates on B (before: unknown to B until restart)', async () => {
    const { raw, meta } = rawKeyRow('acme');
    await store.create(meta); // replica A
    assert.equal(authed(raw), false, 'defect reproduced: B does not know a key created on A');
    assert.deepEqual(await refreshCredential(raw, { strict: true }), { ok: true });
    assert.equal(authed(raw), true);
  });

  it('a key revoked on replica A is refused on B for the next request, without restart and without TTL', async () => {
    const k = await createApiKey('acme', 'b-local', 'OWNER'); // created on B: B's registry holds it
    assert.deepEqual(await refreshCredential(k.rawKey, { strict: false }), { ok: true });
    assert.equal(authed(k.rawKey), true);
    await store.revoke(k.keyId); // replica A revokes: only the shared store changes
    assert.equal(authed(k.rawKey), true, 'defect reproduced: B\'s registry still admits the revoked key');
    assert.deepEqual(await refreshCredential(k.rawKey, { strict: false }), { ok: true });
    assert.equal(authed(k.rawKey), false, 'refused on B, read-only route included');
    assert.equal(credentialAuthorityStats().keysRefusedRevoked, 1);
  });

  it('rotation on replica A: old key refused on B, new key accepted on B', async () => {
    const old = await createApiKey('acme', 'rot', 'OWNER');
    await refreshCredential(old.rawKey, { strict: true });
    assert.equal(authed(old.rawKey), true);
    // replica A: rotateApiKey = revoke old + create new (shared store only)
    await store.revoke(old.keyId);
    const { raw: fresh, meta } = rawKeyRow('acme', { label: 'rot' });
    await store.create(meta);
    await refreshCredential(old.rawKey, { strict: true });
    await refreshCredential(fresh, { strict: true });
    assert.equal(authed(old.rawKey), false);
    assert.equal(authed(fresh), true);
  });

  it('an expired key in the store is refused even if B cached it without expiry', async () => {
    const { raw, meta } = rawKeyRow('acme');
    await store.create(meta);
    await refreshCredential(raw, { strict: true });
    assert.equal(authed(raw), true);
    // replica A shortens the expiry (direct row change): the store is the authority
    (store as unknown as { _map: Map<string, ApiKeyMetadata> })._map.set(meta.keyId, { ...meta, expiresAt: new Date(Date.now() - 1000).toISOString() });
    await refreshCredential(raw, { strict: false });
    assert.equal(authed(raw), false);
  });

  it('tenant deactivated on replica A: strict request on B refused at once; plain read keeps the TTL snapshot (documented)', async () => {
    const k = await createApiKey('acme', 'x', 'OWNER');
    await refreshCredential(k.rawKey, { strict: true });
    assert.equal(authed(k.rawKey), true);
    const row: SubjectStatusRecord = { kind: 'tenant', id: 'acme', inactive: true, notBeforeS: Math.floor(Date.now() / 1000), keysNotBeforeS: 0 };
    await status.put(row); // replica A
    // plain read (not strict): the snapshot (TTL 600 s here) is still used — residual for reads only
    await refreshCredential(k.rawKey, { strict: false });
    assert.equal(authed(k.rawKey), true, 'non-strict read keeps the TTL snapshot (bounded staleness, documented residual)');
    // strict (privileged or spending): read now
    await refreshCredential(k.rawKey, { strict: true });
    assert.equal(authed(k.rawKey), false);
    assert.equal(authed(STATIC), false, 'registry token of the tenant refused too');
  });

  it('author deprovisioned (SCIM) on replica A: the author\'s key is refused on B for strict requests', async () => {
    const { raw, meta } = rawKeyRow('acme', { createdBy: 'usr_scim_1' });
    await store.create(meta);
    await refreshCredential(raw, { strict: true });
    assert.equal(authed(raw), true);
    await status.put({ kind: 'user', id: 'usr_scim_1', inactive: true, notBeforeS: Math.floor(Date.now() / 1000), keysNotBeforeS: 0 });
    await refreshCredential(raw, { strict: true });
    assert.equal(authed(raw), false);
  });

  it('restart of B (empty registry): keys come back from the store; revoked keys do not', async () => {
    const live = rawKeyRow('acme'); const dead = rawKeyRow('acme', { revokedAt: new Date().toISOString() });
    await store.create(live.meta); await store.create(dead.meta);
    clearHashRegistryForTest(); registerToken(STATIC, 'acme', 'OWNER');
    await refreshCredential(live.raw, { strict: true }); await refreshCredential(dead.raw, { strict: true });
    assert.equal(authed(live.raw), true);
    assert.equal(authed(dead.raw), false);
  });

  it('key store down: 503 for any request with a dynamic key, and a cached positive entry is dropped (fail closed)', async () => {
    const k = await createApiKey('acme', 'x', 'OWNER');
    await refreshCredential(k.rawKey, { strict: false });
    assert.equal(authed(k.rawKey), true);
    setKeyAuthority({ async getByHash() { throw new Error('ECONNREFUSED'); } });
    for (const strict of [false, true]) {
      const r = await refreshCredential(k.rawKey, { strict });
      assert.equal(r.ok, false);
      assert.equal(!r.ok && r.status, 503);
      assert.equal(!r.ok && r.error, 'credential_status_unavailable');
    }
    assert.equal(authed(k.rawKey), false, 'the stale positive entry did not survive the outage');
    assert.equal(credentialAuthorityStats().keyLookupFailures, 2);
  });

  it('A3/N-D4: subject store down → strict request refused (503) even for a subject never seen inactive; plain read served', async () => {
    const failing = new MemorySubjectStatusStore();
    await setSubjectStatusStore(failing);
    failing.getMany = async () => { throw new Error('ECONNREFUSED'); };
    const strict = await refreshCredential(STATIC, { strict: true });
    assert.equal(strict.ok, false);
    assert.equal(!strict.ok && strict.status, 503);
    assert.deepEqual(await refreshCredential(STATIC, { strict: false }), { ok: true }, 'reads keep availability (documented)');
    assert.equal(credentialAuthorityStats().subjectCheckFailures, 1);
  });

  it('only otk_k_ values are looked up (a SCIM bearer or a guess costs no store round trip)', async () => {
    let calls = 0;
    setKeyAuthority({ async getByHash() { calls++; return null; } });
    await refreshCredential('scim-bearer-not-a-key', { strict: true });
    await refreshCredential('otk_k_' + '0'.repeat(64), { strict: true });
    await refreshCredential('otk_k_' + 'Z'.repeat(64), { strict: true }); // review MED-1: not the minted format
    await refreshCredential('otk_k_' + '0'.repeat(63), { strict: true });
    assert.equal(calls, 1);
  });

  it('without a key authority (single process) the local registry stays the authority (behaviour unchanged)', async () => {
    setKeyAuthority(null);
    const k = await createApiKey('acme', 'x', 'OWNER');
    await store.revoke(k.keyId); // only the store
    assert.deepEqual(await refreshCredential(k.rawKey, { strict: true }), { ok: true });
    assert.equal(authed(k.rawKey), true, 'no authority configured: nothing is consulted (development/tests)');
  });
});

describe('H1R2 review MED-1 / LOW-1: bounded lookups per source and no stale re-registration', () => {
  let store: MemoryApiKeyMetadataStore;
  beforeEach(() => {
    clearRegistry(); clearHashRegistryForTest(); resetKeyLookupLimiterForTest(); resetCredentialAuthorityStatsForTest();
    registerToken(STATIC, 'acme', 'OWNER');
    store = new MemoryApiKeyMetadataStore(); setApiKeyMetadataStore(store);
  });
  afterEach(() => { setKeyAuthority(null); resetApiKeyMetadataStoreForTest(); clearRegistry(); clearHashRegistryForTest(); resetKeyLookupLimiterForTest(); });

  it('a source that keeps presenting unknown keys stops costing lookups (and its keys are refused) after 20 misses; other sources unaffected', async () => {
    let calls = 0;
    const real = rawKeyRow('acme'); await store.create(real.meta);
    setKeyAuthority({ async getByHash(h: string) { calls++; return store.getByHash(h); } });
    for (let i = 0; i < 30; i++) await refreshCredential('otk_k_' + i.toString(16).padStart(64, 'f'), { strict: false, source: 'ip:203.0.113.9' });
    assert.equal(calls, 20, 'lookups stop at the miss limit');
    assert.equal(credentialAuthorityStats().keyLookupsThrottled, 10);
    await refreshCredential(real.raw, { strict: false, source: 'ip:203.0.113.9' });
    assert.equal(authed(real.raw), false, 'throttled source: even a valid key is refused (fail closed, no lookup)');
    await refreshCredential(real.raw, { strict: false, source: 'ip:198.51.100.7' });
    assert.equal(authed(real.raw), true, 'another source is served');
  });

  it('a slow positive answer that started before a revocation does not re-register the key after it', async () => {
    const { raw, meta } = rawKeyRow('acme'); await store.create(meta);
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>((r) => { releaseSlow = r; });
    let first = true;
    setKeyAuthority({ async getByHash(h: string) {
      if (first) { first = false; const snap = await store.getByHash(h); await slowGate; return snap; } // read BEFORE the revocation
      return store.getByHash(h);
    } });
    const slow = refreshCredential(raw, { strict: false });           // R1: lookup starts, answer delayed
    await new Promise((r) => setTimeout(r, 5));
    await store.revoke(meta.keyId);                                      // revocation commits
    await refreshCredential(raw, { strict: false });                    // R2: sees revoked → drops
    releaseSlow(); await slow;                                           // R1's stale "active" arrives late
    assert.equal(authed(raw), false, 'R1 must not re-register a key revoked meanwhile');
  });
});

describe('H1R2 R-13: route classification and credential extraction', () => {
  it('isStrictRoute: every write, and reads under sensitive prefixes', () => {
    for (const [m, p] of [['POST', '/receipts'], ['DELETE', '/keys/x'], ['PUT', '/admin/tenants/t'], ['PATCH', '/scim/v2/Users/u'],
      ['GET', '/keys'], ['GET', '/admin/tenants'], ['GET', '/data/export/status/j'], ['GET', '/billing/usage'], ['GET', '/webhooks'],
      // review LOW-2 / MED-2: routes declared with a literal /v1/ (reached as /v1/v1/...), provider keys, reports, the stream
      ['GET', '/v1/admin/prices'], ['GET', '/v1/tenants/t/provider-keys'], ['GET', '/v1/reconciliation/reports'],
      ['GET', '/v1/reports/teams'], ['GET', '/v1/webhooks/e/deliveries'], ['GET', '/stream']] as const) {
      assert.equal(isStrictRoute(m, p), true, `${m} ${p}`);
    }
    for (const [m, p] of [['GET', '/receipts'], ['GET', '/analytics/cu-trend'], ['GET', '/keysmith'], ['HEAD', '/receipts/abc']] as const) {
      assert.equal(isStrictRoute(m, p), false, `${m} ${p}`);
    }
  });
  it('presentedCredential: Bearer first; x-api-key only when asked (proxy)', () => {
    assert.equal(presentedCredential({ authorization: 'Bearer abc' }), 'abc');
    assert.equal(presentedCredential({ 'x-api-key': 'k' }), '');
    assert.equal(presentedCredential({ 'x-api-key': 'k' }, { apiKeyHeaders: true }), 'k');
    assert.equal(presentedCredential(undefined), '');
  });
});

describe('H1R2 R-13 / A3: PostgreSQL queries of the authority (fake pool, always runs)', () => {
  it('PgApiKeyMetadataStore.getByHash: indexed lookup by hash, a revoked row wins, maps the row', async () => {
    const { PgApiKeyMetadataStore } = await import('../../src/infra/pg/PgApiKeyMetadataStore.js');
    const seen: Array<{ text: string; params?: unknown[] }> = [];
    const pool = { async query(text: string, params?: unknown[]) {
      seen.push({ text, params });
      if (text.includes('WHERE token_hash = $1')) {
        return { rows: [{ key_id: 'k1', tenant_id: 't1', label: 'l', prefix: 'otk_k_aaaa', token_hash: 'h', role: 'OWNER',
          created_at: '2026-10-13T00:00:00Z', expires_at: null, revoked_at: '2026-10-13T01:00:00Z', last_used_at: null, created_by: 'usr_1' }] };
      }
      return { rows: [] };
    } };
    const s = new PgApiKeyMetadataStore(pool);
    const m = await s.getByHash('h');
    const q = seen.find((x) => x.text.includes('WHERE token_hash = $1'))!;
    assert.match(q.text, /ORDER BY \(revoked_at IS NULL\) ASC/);
    assert.deepEqual(q.params, ['h']);
    assert.equal(m?.revokedAt, '2026-10-13T01:00:00.000Z');
    assert.equal(m?.createdBy, 'usr_1');
  });

  it('PgSubjectStatusStore.getMany: one query for the listed subjects only', async () => {
    const { PgSubjectStatusStore } = await import('../../src/infra/pg/PgSubjectStatusStore.js');
    const seen: Array<{ text: string; params?: unknown[] }> = [];
    const pool = { async query(text: string, params?: unknown[]) {
      seen.push({ text, params });
      if (text.includes('unnest')) return { rows: [{ kind: 'user', id: 'u1', inactive: true, not_before_s: '5', keys_not_before_s: '0' }] };
      return { rows: [] };
    } };
    const s = new PgSubjectStatusStore(pool);
    assert.deepEqual(await s.getMany([]), []);
    const rows = await s.getMany([{ kind: 'tenant', id: 't1' }, { kind: 'user', id: 'u1' }]);
    assert.deepEqual(rows, [{ kind: 'user', id: 'u1', inactive: true, notBeforeS: 5, keysNotBeforeS: 0 }]);
    assert.deepEqual(seen.find((x) => x.text.includes('unnest'))!.params, [['tenant', 'user'], ['t1', 'u1']]);
  });
});
