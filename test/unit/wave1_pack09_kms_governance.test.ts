/**
 * Wave 1 Pack 9 — KMS + Governance Tests (E2.1 + E2.4)
 *
 * Tests:
 *   - SecretsManager: local provider, env-based getSecret, setSecret overlay,
 *     listKeys, factory, injectable envReader
 *   - GovernanceTrail: append events, list events, filter, chain integrity,
 *     JSONL persistence, singleton
 *
 * @since Wave 1 Pack 9 (2026-03-15)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── SecretsManager Tests ────────────────────────────────────

import {
  LocalSecretsProvider,
  getSecretsProvider,
  setSecretsProviderForTest,
  type ISecretsProvider,
} from '../../src/security/SecretsManager.js';

describe('Pack 9 — SecretsManager (E2.1)', () => {
  it('LocalSecretsProvider has correct providerName', () => {
    const provider = new LocalSecretsProvider();
    assert.equal(provider.providerName, 'local-env');
  });

  it('getSecret reads from env via OTK_SECRET_ prefix', async () => {
    const fakeEnv: Record<string, string> = {
      'OTK_SECRET_DB_PASSWORD': 'hunter2',
      'OTK_SECRET_API_TOKEN': 'tok-123',
    };
    const provider = new LocalSecretsProvider({ envReader: () => fakeEnv });

    assert.equal(await provider.getSecret('DB_PASSWORD'), 'hunter2');
    assert.equal(await provider.getSecret('API_TOKEN'), 'tok-123');
  });

  it('getSecret returns undefined for missing keys', async () => {
    const provider = new LocalSecretsProvider({ envReader: () => ({}) });
    assert.equal(await provider.getSecret('MISSING'), undefined);
  });

  it('setSecret stores in overlay and takes priority over env', async () => {
    const fakeEnv: Record<string, string> = {
      'OTK_SECRET_KEY1': 'from-env',
    };
    const provider = new LocalSecretsProvider({ envReader: () => fakeEnv });

    // Before overlay
    assert.equal(await provider.getSecret('KEY1'), 'from-env');

    // Set overlay
    await provider.setSecret('KEY1', 'from-overlay');
    assert.equal(await provider.getSecret('KEY1'), 'from-overlay');
  });

  it('listKeys merges env and overlay keys', async () => {
    const fakeEnv: Record<string, string> = {
      'OTK_SECRET_A': 'val-a',
      'OTK_SECRET_B': 'val-b',
      'OTHER_VAR': 'ignored',
    };
    const provider = new LocalSecretsProvider({ envReader: () => fakeEnv });
    await provider.setSecret('C', 'val-c');

    const keys = await provider.listKeys();
    assert.ok(keys.includes('A'));
    assert.ok(keys.includes('B'));
    assert.ok(keys.includes('C'));
    assert.ok(!keys.includes('OTHER_VAR'));
  });

  it('getSecretsProvider returns singleton', () => {
    setSecretsProviderForTest(undefined);
    const a = getSecretsProvider();
    const b = getSecretsProvider();
    assert.equal(a, b);
    setSecretsProviderForTest(undefined);
  });

  it('setSecretsProviderForTest overrides singleton', () => {
    const custom: ISecretsProvider = {
      providerName: 'mock',
      getSecret: async () => 'mock-val',
      setSecret: async () => {},
      listKeys: async () => [],
    };
    setSecretsProviderForTest(custom);
    assert.equal(getSecretsProvider(), custom);
    setSecretsProviderForTest(undefined);
  });
});

// ─── GovernanceTrail Tests ───────────────────────────────────

import {
  GovernanceTrail,
  getGovernanceTrail,
  resetGovernanceTrailForTest,
  type GovernanceEvent,
} from '../../src/security/GovernanceTrail.js';

describe('Pack 9 — GovernanceTrail (E2.4)', () => {
  let trail: GovernanceTrail;

  beforeEach(() => {
    resetGovernanceTrailForTest();
    trail = new GovernanceTrail();
  });

  it('append returns entry with seq and hash', () => {
    const event: GovernanceEvent = {
      ts: new Date().toISOString(),
      tenantId: 'acme',
      actor: 'admin@acme.com',
      action: 'tenant_created',
    };
    const entry = trail.append(event);
    assert.equal(entry.seq, 0);
    assert.ok(entry.hash.length === 64, 'hash should be 64 hex chars (sha256)');
    assert.equal(entry.tenantId, 'acme');
    assert.equal(entry.action, 'tenant_created');
  });

  it('sequential appends produce chained hashes', () => {
    const e1 = trail.append({
      ts: '2026-03-15T00:00:00Z', tenantId: 'a', actor: 'sys', action: 'tenant_created',
    });
    const e2 = trail.append({
      ts: '2026-03-15T00:01:00Z', tenantId: 'b', actor: 'sys', action: 'tenant_created',
    });

    assert.equal(e1.seq, 0);
    assert.equal(e2.seq, 1);
    assert.notEqual(e1.hash, e2.hash);
  });

  it('list returns all events', () => {
    trail.append({ ts: '2026-01-01T00:00:00Z', tenantId: 'a', actor: 's', action: 'tenant_created' });
    trail.append({ ts: '2026-01-01T00:01:00Z', tenantId: 'b', actor: 's', action: 'key_rotated' });

    const all = trail.list();
    assert.equal(all.length, 2);
  });

  it('list filters by tenantId', () => {
    trail.append({ ts: '2026-01-01T00:00:00Z', tenantId: 'a', actor: 's', action: 'tenant_created' });
    trail.append({ ts: '2026-01-01T00:01:00Z', tenantId: 'b', actor: 's', action: 'key_rotated' });
    trail.append({ ts: '2026-01-01T00:02:00Z', tenantId: 'a', actor: 's', action: 'plan_changed' });

    const filtered = trail.list({ tenantId: 'a' });
    assert.equal(filtered.length, 2);
    assert.ok(filtered.every(e => e.tenantId === 'a'));
  });

  it('list filters by action', () => {
    trail.append({ ts: '2026-01-01T00:00:00Z', tenantId: 'a', actor: 's', action: 'tenant_created' });
    trail.append({ ts: '2026-01-01T00:01:00Z', tenantId: 'b', actor: 's', action: 'key_rotated' });

    const filtered = trail.list({ action: 'key_rotated' });
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].tenantId, 'b');
  });

  it('verifyIntegrity returns true for untampered chain', () => {
    trail.append({ ts: '2026-01-01T00:00:00Z', tenantId: 'a', actor: 's', action: 'tenant_created' });
    trail.append({ ts: '2026-01-01T00:01:00Z', tenantId: 'b', actor: 's', action: 'config_changed' });

    assert.equal(trail.verifyIntegrity(), true);
  });

  it('count returns number of events', () => {
    assert.equal(trail.count(), 0);
    trail.append({ ts: '2026-01-01T00:00:00Z', tenantId: 'a', actor: 's', action: 'tenant_created' });
    assert.equal(trail.count(), 1);
  });

  it('headHash updates after each append', () => {
    const h0 = trail.headHash();
    trail.append({ ts: '2026-01-01T00:00:00Z', tenantId: 'a', actor: 's', action: 'tenant_created' });
    const h1 = trail.headHash();
    assert.notEqual(h0, h1);
  });

  it('JSONL persistence: round-trip via file', () => {
    const logPath = join(tmpdir(), `otk-gov-test-${Date.now()}.jsonl`);
    try {
      // Write events
      const t1 = new GovernanceTrail({ logPath });
      t1.append({ ts: '2026-01-01T00:00:00Z', tenantId: 'a', actor: 's', action: 'tenant_created' });
      t1.append({ ts: '2026-01-01T00:01:00Z', tenantId: 'b', actor: 's', action: 'key_rotated' });

      // Read back from a fresh instance
      const t2 = new GovernanceTrail({ logPath });
      assert.equal(t2.count(), 2);
      assert.equal(t2.list()[0].tenantId, 'a');
      assert.equal(t2.list()[1].tenantId, 'b');
      assert.equal(t2.verifyIntegrity(), true);
    } finally {
      if (existsSync(logPath)) unlinkSync(logPath);
    }
  });

  it('getGovernanceTrail returns singleton', () => {
    resetGovernanceTrailForTest();
    const a = getGovernanceTrail();
    const b = getGovernanceTrail();
    assert.equal(a, b);
    resetGovernanceTrailForTest();
  });
});
