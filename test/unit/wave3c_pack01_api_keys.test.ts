/**
 * Wave 3C Pack 01 — API Key Management Tests (NEW-3.06)
 *
 * Tests:
 *   1. Key generation and hashing
 *   2. In-memory IApiKeyMetadataStore CRUD
 *   3. API key lifecycle (create → list → get → revoke → rotate)
 *   4. Event emission on key lifecycle actions
 *   5. REST endpoint contract via handleRequest
 *
 * No PG required — uses in-memory stores.
 *
 * Modules under test: `src/api/apiKeyManager.ts`, `src/api/IApiKeyMetadataStore.ts` (in-memory store),
 * `src/api/ITokenStore.ts`, the event dispatcher of `src/publisher/runtime.ts` and the key routes of
 * `src/api/routes.ts`.
 *
 * Strategy / partitions: hashing (same and different inputs); store create, get, list per tenant, revoke and
 * revoke twice, missing key; manager create, list, revoke, rotate and missing key, each with its event; the
 * routes create, list, revoke and create without a label; the event kinds; the presence of the store, manager,
 * PostgreSQL store and migration files.
 *
 * Needs: no PostgreSQL and no network (in-memory stores, reset before each test). The mock requests send the
 * value of `OTK_ADMIN_KEY` (or a test default) as the platform key.
 *
 * Run just this file: `npx tsx --test test/unit/wave3c_pack01_api_keys.test.ts`
 *
 * @module test/unit/wave3c_pack01_api_keys.test
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ---------------------------------------------------------------------------
// API Key Manager — unit tests
// ---------------------------------------------------------------------------

import { createApiKey, getApiKey, listApiKeys, revokeApiKey, rotateApiKey, hashKey } from '../../src/api/apiKeyManager.js';
import { resetApiKeyMetadataStoreForTest, getApiKeyMetadataStore } from '../../src/api/IApiKeyMetadataStore.js';
import { resetTokenStoreForTest, getTokenStore } from '../../src/api/ITokenStore.js';
import { getDispatcher } from '../../src/publisher/runtime.js';
import { clearRegistry, clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function mockReq(method: string, url: string, body?: string, headers?: Record<string, string>): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, {
    method,
    url,
    headers: { 'x-admin-key': process.env['OTK_ADMIN_KEY'] ?? 'test-admin-key', ...headers },
  }) as unknown as IncomingMessage;
  process.nextTick(() => {
    if (body) em.emit('data', Buffer.from(body));
    em.emit('end');
  });
  return req;
}

type MockRes = ServerResponse & { body: string };

function mockRes(): MockRes {
  let body = '';
  return {
    statusCode: 200,
    setHeader: () => {},
    end: (data: string) => { body = data; },
    get body() { return body; },
  } as unknown as MockRes;
}

// ===========================================================================
// Key generation + hashing
// ===========================================================================

describe('W3C-01 — Key generation and hashing', () => {
  it('hashKey produces consistent SHA-256 hex', () => {
    const hash1 = hashKey('otk_k_test123');
    const hash2 = hashKey('otk_k_test123');
    assert.equal(hash1, hash2, 'same input must produce same hash');
    assert.equal(hash1.length, 64, 'SHA-256 hex is 64 chars');
  });

  it('hashKey produces different output for different inputs', () => {
    const h1 = hashKey('otk_k_aaa');
    const h2 = hashKey('otk_k_bbb');
    assert.notEqual(h1, h2, 'different keys must produce different hashes');
  });
});

// ===========================================================================
// MemoryApiKeyMetadataStore — CRUD
// ===========================================================================

describe('W3C-01 — MemoryApiKeyMetadataStore CRUD', () => {
  beforeEach(() => {
    resetApiKeyMetadataStoreForTest();
  });

  it('create + get returns metadata', async () => {
    const store = getApiKeyMetadataStore();
    const meta = {
      keyId: 'key_test_1',
      tenantId: 'tenant1',
      label: 'Production key',
      prefix: 'otk_k_ab',
      tokenHash: 'hash123',
      role: 'OWNER' as const,
      createdAt: new Date().toISOString(),
      expiresAt: null,
      revokedAt: null,
      lastUsedAt: null,
    };
    await store.create(meta);
    const found = await store.get('key_test_1');
    assert.ok(found, 'key should exist');
    assert.equal(found.label, 'Production key');
    assert.equal(found.tenantId, 'tenant1');
  });

  it('listByTenant returns only active keys for the tenant', async () => {
    const store = getApiKeyMetadataStore();
    const now = new Date().toISOString();
    await store.create({ keyId: 'k1', tenantId: 't1', label: 'a', prefix: 'p1', tokenHash: 'h1', role: 'MEMBER', createdAt: now, expiresAt: null, revokedAt: null, lastUsedAt: null });
    await store.create({ keyId: 'k2', tenantId: 't1', label: 'b', prefix: 'p2', tokenHash: 'h2', role: 'MEMBER', createdAt: now, expiresAt: null, revokedAt: null, lastUsedAt: null });
    await store.create({ keyId: 'k3', tenantId: 't2', label: 'c', prefix: 'p3', tokenHash: 'h3', role: 'MEMBER', createdAt: now, expiresAt: null, revokedAt: null, lastUsedAt: null });

    const t1keys = await store.listByTenant('t1');
    assert.equal(t1keys.length, 2, 'tenant1 should have 2 keys');

    const t2keys = await store.listByTenant('t2');
    assert.equal(t2keys.length, 1, 'tenant2 should have 1 key');
  });

  it('revoke marks key as revoked, excludes from list', async () => {
    const store = getApiKeyMetadataStore();
    const now = new Date().toISOString();
    await store.create({ keyId: 'kr1', tenantId: 't1', label: 'rev', prefix: 'p1', tokenHash: 'h1', role: 'MEMBER', createdAt: now, expiresAt: null, revokedAt: null, lastUsedAt: null });

    const revoked = await store.revoke('kr1');
    assert.ok(revoked, 'revoke should return metadata');
    assert.ok(revoked.revokedAt, 'revokedAt should be set');

    const list = await store.listByTenant('t1');
    assert.equal(list.length, 0, 'revoked key should not appear in list');
  });

  it('revoke returns null for already-revoked key', async () => {
    const store = getApiKeyMetadataStore();
    const now = new Date().toISOString();
    await store.create({ keyId: 'kr2', tenantId: 't1', label: 'x', prefix: 'p', tokenHash: 'h', role: 'MEMBER', createdAt: now, expiresAt: null, revokedAt: null, lastUsedAt: null });
    await store.revoke('kr2');
    const second = await store.revoke('kr2');
    assert.equal(second, null, 'second revoke should return null');
  });

  it('get returns null for non-existent key', async () => {
    const store = getApiKeyMetadataStore();
    const found = await store.get('nonexistent');
    assert.equal(found, null);
  });
});

// ===========================================================================
// API Key lifecycle — integration (manager layer)
// ===========================================================================

describe('W3C-01 — API Key Manager lifecycle', () => {
  beforeEach(() => {
    resetApiKeyMetadataStoreForTest();
    resetTokenStoreForTest();
    getDispatcher().reset();
  });

  it('createApiKey generates key with otk_k_ prefix and stores hash', async () => {
    const result = await createApiKey('tenant1', 'Test Key', 'MEMBER');
    assert.ok(result.rawKey.startsWith('otk_k_'), 'key must start with otk_k_');
    assert.ok(result.rawKey.length > 20, 'key must be long enough');
    assert.ok(result.keyId.startsWith('key_'), 'keyId must start with key_');
    assert.equal(result.tenantId, 'tenant1');
    assert.equal(result.label, 'Test Key');
    assert.equal(result.role, 'MEMBER');

    // Hash stored in token store
    const hash = hashKey(result.rawKey);
    const tokenEntry = await getTokenStore().resolve(hash);
    assert.ok(tokenEntry, 'token store should have the hash');
    assert.equal(tokenEntry.tenantId, 'tenant1');
  });

  it('createApiKey emits key_created event', async () => {
    const events: unknown[] = [];
    getDispatcher().subscribe(e => events.push(e));
    await createApiKey('t1', 'Evt Key', 'ADMIN');
    assert.equal(events.length, 1, 'should emit one event');
    assert.equal((events[0] as { eventKind: string }).eventKind, 'key_created');
  });

  it('listApiKeys returns only active keys', async () => {
    await createApiKey('t1', 'Key A', 'MEMBER');
    await createApiKey('t1', 'Key B', 'MEMBER');
    const r3 = await createApiKey('t1', 'Key C', 'MEMBER');

    let keys = await listApiKeys('t1');
    assert.equal(keys.length, 3);

    await revokeApiKey(r3.keyId);
    keys = await listApiKeys('t1');
    assert.equal(keys.length, 2, 'revoked key should be excluded');
  });

  it('revokeApiKey removes hash from token store', async () => {
    const result = await createApiKey('t1', 'Rev Key', 'MEMBER');
    const hash = hashKey(result.rawKey);

    // Verify hash resolves before revocation
    assert.ok(await getTokenStore().resolve(hash), 'hash should resolve before revoke');

    await revokeApiKey(result.keyId);

    // Verify hash no longer resolves
    const after = await getTokenStore().resolve(hash);
    assert.equal(after, null, 'hash should not resolve after revoke');
  });

  it('revokeApiKey emits key_revoked event', async () => {
    const events: unknown[] = [];
    getDispatcher().subscribe(e => events.push(e));
    const result = await createApiKey('t1', 'R', 'MEMBER');
    await revokeApiKey(result.keyId);
    const revoked = events.filter((e: any) => e.eventKind === 'key_revoked');
    assert.equal(revoked.length, 1, 'should emit key_revoked');
  });

  it('rotateApiKey revokes old key and creates new one', async () => {
    const original = await createApiKey('t1', 'Rotate Me', 'ADMIN');
    const rotated = await rotateApiKey(original.keyId);

    assert.ok(rotated, 'rotate should return new key');
    assert.notEqual(rotated.keyId, original.keyId, 'new keyId must differ');
    assert.notEqual(rotated.rawKey, original.rawKey, 'new raw key must differ');
    assert.equal(rotated.tenantId, 't1', 'same tenant');
    assert.equal(rotated.label, 'Rotate Me', 'same label');
    assert.equal(rotated.role, 'ADMIN', 'same role');

    // Old key should be revoked
    const oldMeta = await getApiKey(original.keyId);
    assert.ok(oldMeta?.revokedAt, 'old key should be revoked');

    // Old hash should not resolve
    const oldHash = hashKey(original.rawKey);
    assert.equal(await getTokenStore().resolve(oldHash), null, 'old hash should not resolve');
  });

  it('rotateApiKey emits key_rotated event', async () => {
    const events: unknown[] = [];
    getDispatcher().subscribe(e => events.push(e));
    const result = await createApiKey('t1', 'Rt', 'MEMBER');
    await rotateApiKey(result.keyId);
    const rotated = events.filter((e: any) => e.eventKind === 'key_rotated');
    assert.equal(rotated.length, 1, 'should emit key_rotated');
  });

  it('rotateApiKey returns null for non-existent key', async () => {
    const result = await rotateApiKey('nonexistent');
    assert.equal(result, null);
  });

  it('getApiKey returns null for non-existent key', async () => {
    const result = await getApiKey('nope');
    assert.equal(result, null);
  });
});

// ===========================================================================
// REST endpoint contract — /v1/keys via handleRequest
// ===========================================================================

import { handleRequest } from '../../src/api/routes.js';

describe('W3C-01 — /v1/keys REST endpoints', () => {
  beforeEach(() => {
    clearRegistry();          // reset _authEnabled + tenant token registry
    clearHashRegistryForTest(); // reset dynamic API key hash registry
    resetApiKeyMetadataStoreForTest();
    resetTokenStoreForTest();
    getDispatcher().reset();
  });

  it('POST /v1/keys creates a key and returns rawKey', async () => {
    const res = mockRes();
    const body = JSON.stringify({ label: 'My Key', role: 'MEMBER' });
    await handleRequest(mockReq('POST', '/v1/keys', body), res);
    assert.equal(res.statusCode, 201, 'should return 201');
    const json = JSON.parse(res.body);
    assert.ok(json.ok, 'ok should be true');
    assert.ok(json.key.rawKey, 'rawKey should be present');
    assert.ok(json.key.rawKey.startsWith('otk_k_'), 'rawKey should have prefix');
    assert.ok(json.key.keyId, 'keyId should be present');
  });

  it('GET /v1/keys lists keys for the tenant', async () => {
    // Create a key with OWNER role (auth disabled → legacy path; key creation re-enables auth)
    const res1 = mockRes();
    await handleRequest(mockReq('POST', '/v1/keys', JSON.stringify({ label: 'K1', role: 'OWNER' })), res1);
    assert.equal(res1.statusCode, 201);
    const rawKey = JSON.parse(res1.body).key.rawKey;

    // List keys — auth now enabled, authenticate using the created key
    const res2 = mockRes();
    await handleRequest(mockReq('GET', '/v1/keys', undefined, { 'authorization': `Bearer ${rawKey}` }), res2);
    assert.equal(res2.statusCode, 200);
    const json = JSON.parse(res2.body);
    assert.ok(json.ok);
    assert.ok(Array.isArray(json.keys));
    assert.ok(json.keys.length >= 1, 'should have at least 1 key');
  });

  it('DELETE /v1/keys/:keyId revokes a key', async () => {
    // Create a key with OWNER role
    const r1 = mockRes();
    await handleRequest(mockReq('POST', '/v1/keys', JSON.stringify({ label: 'Del', role: 'OWNER' })), r1);
    const { keyId, rawKey } = JSON.parse(r1.body).key;

    // Delete — authenticate using the created key
    const r2 = mockRes();
    await handleRequest(mockReq('DELETE', `/v1/keys/${keyId}`, undefined, { 'authorization': `Bearer ${rawKey}` }), r2);
    assert.equal(r2.statusCode, 200);
    const json = JSON.parse(r2.body);
    assert.ok(json.ok);
    assert.ok(json.revoked.revokedAt, 'revokedAt should be set');
  });

  it('POST /v1/keys without label returns error', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/v1/keys', JSON.stringify({})), res);
    assert.equal(res.statusCode, 400, 'should return 400 for missing label');
  });
});

// ===========================================================================
// Event kind types — deliveryTypes
// ===========================================================================

import type { EventKind } from '../../src/publisher/deliveryTypes.js';

describe('W3C-01 — EventKind includes key lifecycle events', () => {
  it('key_created, key_revoked, key_rotated are valid EventKind values', () => {
    const kinds: EventKind[] = ['key_created', 'key_revoked', 'key_rotated'];
    assert.equal(kinds.length, 3, 'all three key event kinds should compile');
  });
});

// ===========================================================================
// PG store file existence
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

describe('W3C-01 — File structure', () => {
  it('IApiKeyMetadataStore.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src', 'api', 'IApiKeyMetadataStore.ts')));
  });

  it('apiKeyManager.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src', 'api', 'apiKeyManager.ts')));
  });

  it('PgApiKeyMetadataStore.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src', 'infra', 'pg', 'PgApiKeyMetadataStore.ts')));
  });

  it('002_create_api_keys.sql migration exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts', 'migrations', '002_create_api_keys.sql')));
  });
});
