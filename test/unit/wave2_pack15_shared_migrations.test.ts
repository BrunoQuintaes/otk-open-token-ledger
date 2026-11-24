/**
 * Wave 2 Pack 15 — SharedStateManager + Migrations/Backup tests (E3.2 + E3.3)
 *
 * Tests:
 *   - SharedStateManager key-value operations (in-memory fallback)
 *   - Distributed lock (acquire/release)
 *   - Session tracking (set/get)
 *   - Worker coordination (claim/release/list)
 *   - Migration script existence and format
 *   - Backup script existence
 *
 * @since Wave 2 Pack 15 (2026-03-15)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { SharedStateManager, resetSharedStateForTest, getSharedState } from '../../src/infra/redis/sharedState.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');

describe('E3.2 — SharedStateManager (in-memory fallback)', () => {
  let sm: SharedStateManager;

  beforeEach(() => {
    resetSharedStateForTest();
    sm = new SharedStateManager(null); // null = no Redis → in-memory
  });

  it('isRedisMode is false without Redis client', () => {
    assert.equal(sm.isRedisMode, false);
  });

  it('set/get round-trip works', async () => {
    await sm.set('foo', 'bar');
    const val = await sm.get('foo');
    assert.equal(val, 'bar');
  });

  it('get returns null for missing key', async () => {
    const val = await sm.get('nonexistent');
    assert.equal(val, null);
  });

  it('del removes a key', async () => {
    await sm.set('key1', 'val1');
    const deleted = await sm.del('key1');
    assert.equal(deleted, true);
    const val = await sm.get('key1');
    assert.equal(val, null);
  });

  it('del returns false for missing key', async () => {
    const deleted = await sm.del('nonexistent');
    assert.equal(deleted, false);
  });

  it('TTL expiration works in-memory', async () => {
    await sm.set('ephemeral', 'data', 50); // 50ms TTL
    const before = await sm.get('ephemeral');
    assert.equal(before, 'data');
    // Wait for expiration
    await new Promise(r => setTimeout(r, 100));
    const after = await sm.get('ephemeral');
    assert.equal(after, null, 'should be expired');
  });
});

describe('E3.2 — Distributed Lock (in-memory)', () => {
  let sm: SharedStateManager;

  beforeEach(() => {
    sm = new SharedStateManager(null);
  });

  it('acquireLock succeeds on free key', async () => {
    const result = await sm.acquireLock('mylock', 5000);
    assert.equal(result.acquired, true);
    assert.equal(result.key, 'mylock');
    assert.equal(result.ttlMs, 5000);
  });

  it('acquireLock fails on already-held lock', async () => {
    await sm.acquireLock('mylock', 5000);
    const result = await sm.acquireLock('mylock', 5000);
    assert.equal(result.acquired, false);
  });

  it('releaseLock frees the lock for re-acquisition', async () => {
    await sm.acquireLock('mylock', 5000);
    const released = await sm.releaseLock('mylock');
    assert.equal(released, true);
    const result = await sm.acquireLock('mylock', 5000);
    assert.equal(result.acquired, true);
  });
});

describe('E3.2 — Session Tracking (in-memory)', () => {
  let sm: SharedStateManager;

  beforeEach(() => {
    sm = new SharedStateManager(null);
  });

  it('setSession/getSession round-trip', async () => {
    await sm.setSession('tenant1', { plan: 'pro', limit: 1000 }, 60_000);
    const session = await sm.getSession('tenant1');
    assert.ok(session);
    assert.equal(session!.tenantId, 'tenant1');
    assert.equal(session!.data.plan, 'pro');
    assert.equal(session!.data.limit, 1000);
    assert.ok(session!.expiresAt > Date.now());
  });

  it('getSession returns null for missing tenant', async () => {
    const session = await sm.getSession('nonexistent');
    assert.equal(session, null);
  });
});

describe('E3.2 — Worker Coordination (in-memory)', () => {
  let sm: SharedStateManager;

  beforeEach(() => {
    sm = new SharedStateManager(null);
  });

  it('claimWorkerSlot returns true', async () => {
    const claimed = await sm.claimWorkerSlot('worker-1');
    assert.equal(claimed, true);
  });

  it('listActiveWorkers shows claimed workers', async () => {
    await sm.claimWorkerSlot('worker-1');
    await sm.claimWorkerSlot('worker-2');
    const workers = await sm.listActiveWorkers();
    assert.equal(workers.length, 2);
    const ids = workers.map(w => w.workerId).sort();
    assert.deepEqual(ids, ['worker-1', 'worker-2']);
  });

  it('releaseWorkerSlot removes worker', async () => {
    await sm.claimWorkerSlot('worker-1');
    const released = await sm.releaseWorkerSlot('worker-1');
    assert.equal(released, true);
    const workers = await sm.listActiveWorkers();
    assert.equal(workers.length, 0);
  });
});

describe('E3.2 — SharedState Singleton', () => {
  beforeEach(() => {
    resetSharedStateForTest();
  });

  it('getSharedState returns a SharedStateManager', () => {
    const sm = getSharedState();
    assert.ok(sm instanceof SharedStateManager);
  });

  it('getSharedState returns same instance on repeated calls', () => {
    const a = getSharedState();
    const b = getSharedState();
    assert.equal(a, b);
  });

  it('resetSharedStateForTest clears singleton', () => {
    const a = getSharedState();
    resetSharedStateForTest();
    const b = getSharedState();
    assert.notEqual(a, b);
  });
});

describe('E3.3 — Migration + Backup scripts exist', () => {
  it('migrate.js exists', () => {
    assert.ok(existsSync(resolve(REPO_ROOT, 'scripts/ops/migrate.js')));
  });

  it('backup.sh exists', () => {
    assert.ok(existsSync(resolve(REPO_ROOT, 'scripts/ops/backup.sh')));
  });

  it('migration SQL file exists', () => {
    assert.ok(existsSync(resolve(REPO_ROOT, 'scripts/migrations/001_create_receipt_archive.sql')));
  });
});
