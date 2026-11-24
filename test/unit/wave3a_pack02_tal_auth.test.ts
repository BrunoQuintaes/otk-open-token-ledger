/**
 * Wave 3A Pack 02 — TAL Externalization + Auth Middleware + Audit Store Wiring
 *
 * Tests:
 * - talRuntime: setAccountingLayer / getAccountingLayer / resetAccountingLayerForTest
 * - talRuntime: RedisTAL late-binding via setAccountingLayer
 * - authenticateRequest: returns AuthResult with correct fields
 * - IAuditStore: append called on storeReceipt (via MemoryAuditStore)
 * - storeBootstrap: no-env fallback does not set tal/planStore
 *
 * @since Wave 3A (PACK 3A-02)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── talRuntime: late-binding ─────────────────────────────────────

import {
  getAccountingLayer,
  setAccountingLayer,
  resetAccountingLayerForTest,
} from '../../src/security/talRuntime.js';
import { TokenAccountingLayer } from '../../src/security/TokenAccountingLayer.js';
import { RedisTAL } from '../../src/security/RedisTAL.js';

describe('Wave 3A — talRuntime: late-binding', () => {
  beforeEach(() => {
    resetAccountingLayerForTest();
  });

  it('default accounting layer is TokenAccountingLayer', () => {
    const tal = getAccountingLayer();
    assert.ok(tal instanceof TokenAccountingLayer, 'should be TokenAccountingLayer by default');
  });

  it('setAccountingLayer replaces the singleton', () => {
    const redisTal = new RedisTAL(null); // null redis → local fallback only
    setAccountingLayer(redisTal);
    const tal = getAccountingLayer();
    assert.ok(tal instanceof RedisTAL, 'should be RedisTAL after setAccountingLayer');
  });

  it('resetAccountingLayerForTest restores TokenAccountingLayer', () => {
    const redisTal = new RedisTAL(null);
    setAccountingLayer(redisTal);
    resetAccountingLayerForTest();
    const tal = getAccountingLayer();
    assert.ok(tal instanceof TokenAccountingLayer, 'should be back to TokenAccountingLayer after reset');
  });

  it('RedisTAL with null client falls back to local TAL for debit/balance', () => {
    const redisTal = new RedisTAL(null);
    setAccountingLayer(redisTal);
    const layer = getAccountingLayer() as RedisTAL;
    layer.debit({
      tenantId: 'test-tenant',
      epochId: '2025-01',
      requestId: 'req-001',
      provider: 'openai',
      model: 'gpt-4',
      cu: 100n,
      ts: Date.now(),
    });
    const bal = layer.balance('test-tenant', '2025-01');
    assert.equal(bal.totalCU, 100n);
    assert.equal(bal.entryCount, 1);
    assert.equal(layer.isDistributed, false);
  });

  it('RedisTAL with null client: debitAsync does not throw', async () => {
    const redisTal = new RedisTAL(null);
    await redisTal.debitAsync({
      tenantId: 'test-tenant',
      epochId: '2025-01',
      requestId: 'req-async-001',
      provider: 'openai',
      model: 'gpt-4',
      cu: 50n,
      ts: Date.now(),
    });
    const bal = await redisTal.balanceAsync('test-tenant', '2025-01');
    assert.equal(bal.totalCU, 50n);
  });
});

// ── authenticateRequest ──────────────────────────────────────────

import { authenticateRequest } from '../../src/auth/authMiddleware.js';
import { loadTenantsFromString } from '../../src/api/tenantKeyRegistry.js';
import type { IncomingMessage } from 'node:http';

function mockReqWithAuth(authHeader?: string): IncomingMessage {
  return {
    headers: authHeader ? { authorization: authHeader } : {},
  } as unknown as IncomingMessage;
}

describe('Wave 3A — authenticateRequest', () => {
  it('returns authenticated=true when auth is disabled in dev/test mode', () => {
    // Non-production: auth-disabled = OWNER context (backward compat)
    loadTenantsFromString('');
    try {
      const result = authenticateRequest(mockReqWithAuth());
      assert.equal(result.authenticated, true);
      assert.equal(result.tenantId, 'default');
      assert.equal(result.role, 'OWNER');
      assert.equal(result.method, 'none');
    } finally {
      loadTenantsFromString(''); // restore disabled state
    }
  });

  it('returns authenticated=false when auth enabled and no token', () => {
    // Enable auth by loading a real tenant entry
    loadTenantsFromString('tenant1:token-abc');
    try {
      const result = authenticateRequest(mockReqWithAuth());
      assert.equal(result.authenticated, false);
      assert.equal(result.method, 'none');
    } finally {
      loadTenantsFromString(''); // restore disabled state
    }
  });

  it('resolves API key when auth enabled and valid token provided', () => {
    // Enable auth and register a tenant with a specific token
    loadTenantsFromString('acme/OWNER:secret-token-xyz');
    try {
      const result = authenticateRequest(mockReqWithAuth('Bearer secret-token-xyz'));
      assert.equal(result.authenticated, true);
      assert.equal(result.tenantId, 'acme');
      assert.equal(result.role, 'OWNER');
      assert.equal(result.method, 'api_key');
    } finally {
      loadTenantsFromString(''); // restore disabled state
    }
  });

  it('returns AuthResult shape with all required fields', () => {
    const result = authenticateRequest(mockReqWithAuth());
    assert.ok('authenticated' in result, 'must have authenticated');
    assert.ok('tenantId' in result, 'must have tenantId');
    assert.ok('role' in result, 'must have role');
    assert.ok('method' in result, 'must have method');
  });
});

// ── IAuditStore wiring in receiptStore ───────────────────────────

import {
  setAuditStore,
  resetAuditStoreForTest,
  MemoryAuditStore,
} from '../../src/security/IAuditStore.js';
import { storeReceipt, flushBatch, awaitLastDispatch } from '../../src/api/receiptStore.js';
import type { RawReceipt } from '../../src/types/receipt.js';

function makeReceipt(overrides?: Partial<RawReceipt>): RawReceipt {
  return {
    provider: 'openai',
    model: 'gpt-4',
    inputTokens: 100,
    outputTokens: 50,
    costUnits: 150,
    latencyMs: 200,
    timestamp: Math.floor(Date.now() / 1000),
    requestId: `req-${Math.random().toString(36).slice(2)}`,
    userId: 42n,
    nonce: BigInt(Math.floor(Math.random() * 1e9)),
    tenantId: 'test-tenant',
    ...overrides,
  };
}

describe('Wave 3A — IAuditStore wiring in receiptStore', () => {
  let auditStore: MemoryAuditStore;

  beforeEach(() => {
    resetAuditStoreForTest();
    auditStore = new MemoryAuditStore();
    setAuditStore(auditStore);
    // Disable prover dispatch to isolate audit store writes
    process.env['PROVER_URL'] = 'disabled';
  });

  it('storeReceipt appends to IAuditStore', async () => {
    const receipt = makeReceipt();
    storeReceipt(receipt, 'test-tenant');
    await awaitLastDispatch();

    const entries = await auditStore.list();
    assert.ok(entries.length >= 1, 'should have at least 1 audit entry');
    const metered = entries.find(e => e.record.action === 'metered');
    assert.ok(metered, 'should have metered action');
    assert.equal(metered!.record.tenantId, 'test-tenant');
    assert.equal(metered!.record.actor, '42');
  });

  it('storeReceipt: duplicate requestId does NOT append to audit store', async () => {
    const receipt = makeReceipt();
    storeReceipt(receipt, 'test-tenant');
    await awaitLastDispatch();
    const countAfterFirst = (await auditStore.list()).length;

    // Duplicate
    storeReceipt(receipt, 'test-tenant');
    await awaitLastDispatch();
    const countAfterDup = (await auditStore.list()).length;

    assert.equal(countAfterFirst, countAfterDup, 'duplicate should not add audit entry');
  });

  it('flushBatch appends batch_finalized to IAuditStore', async () => {
    const receipt1 = makeReceipt();
    const receipt2 = makeReceipt();
    storeReceipt(receipt1, 'test-tenant');
    storeReceipt(receipt2, 'test-tenant');
    await awaitLastDispatch();

    flushBatch({ tenantId: 'test-tenant' });

    const entries = await auditStore.list();
    const batchEntry = entries.find(e => e.record.action === 'batch_finalized');
    assert.ok(batchEntry, 'should have batch_finalized action');
    assert.equal(batchEntry!.record.tenantId, 'test-tenant');
  });

  it('IAuditStore.head() advances after storeReceipt', async () => {
    resetAuditStoreForTest();
    const freshStore = new MemoryAuditStore();
    setAuditStore(freshStore);

    const headBefore = await freshStore.head();
    storeReceipt(makeReceipt(), 'test-tenant');
    await awaitLastDispatch();
    const headAfter = await freshStore.head();
    assert.notEqual(headBefore, headAfter, 'head should change after append');
  });
});

// ── storeBootstrap: no-env does not set tal/planStore ────────────

import { bootstrapStores } from '../../src/infra/storeBootstrap.js';

describe('Wave 3A Pack 02 — storeBootstrap no-env: tal uses memory fallback', () => {
  it('tal store key absent when no Redis URL configured', async () => {
    const origRedis = process.env['OTK_REDIS_URL'];
    const origDb = process.env['OTK_DB_URL'];
    delete process.env['OTK_REDIS_URL'];
    delete process.env['OTK_DB_URL'];
    try {
      resetAccountingLayerForTest();
      const result = await bootstrapStores();
      // When no Redis, tal store key should be absent (not set)
      assert.equal(result.stores['tal'], undefined, 'tal should not be set without Redis');
      // TAL should still be the default TokenAccountingLayer
      const tal = getAccountingLayer();
      assert.ok(tal instanceof TokenAccountingLayer, 'should still be TokenAccountingLayer');
    } finally {
      if (origRedis) process.env['OTK_REDIS_URL'] = origRedis;
      if (origDb) process.env['OTK_DB_URL'] = origDb;
      resetAccountingLayerForTest();
    }
  });

  it('planStore key absent when no PG URL configured', async () => {
    const origRedis = process.env['OTK_REDIS_URL'];
    const origDb = process.env['OTK_DB_URL'];
    delete process.env['OTK_REDIS_URL'];
    delete process.env['OTK_DB_URL'];
    try {
      const result = await bootstrapStores();
      assert.equal(result.stores['planStore'], undefined, 'planStore should not be set without PG');
    } finally {
      if (origRedis) process.env['OTK_REDIS_URL'] = origRedis;
      if (origDb) process.env['OTK_DB_URL'] = origDb;
    }
  });
});
