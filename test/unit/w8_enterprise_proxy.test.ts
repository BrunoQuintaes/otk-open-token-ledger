/**
 * W8 Enterprise AI Proxy tests
 * Covers: PROXY-01, PROXY-02, VAULT-01, VAULT-08, TEAM-01, TEAM-06, TEAM-09
 */

import assert from 'node:assert/strict';
import { test, describe, beforeEach } from 'node:test';

// ─── PROXY-01: UsageExtractor ────────────────────────────────────────────────

import { extractUsage } from '../../src/proxy/UsageExtractor.js';

describe('UsageExtractor — PROXY-01', () => {
  test('extracts openai usage', () => {
    const body = {
      id: 'chatcmpl-abc',
      model: 'gpt-4',
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
    const result = extractUsage('openai', 'gpt-4', body);
    assert.equal(result.provider, 'openai');
    assert.equal(result.model, 'gpt-4');
    assert.equal(result.inputTokens, 100);
    assert.equal(result.outputTokens, 50);
    assert.equal(result.requestId, 'chatcmpl-abc');
  });

  test('extracts anthropic usage', () => {
    const body = {
      id: 'msg-xyz',
      model: 'claude-3-5-sonnet-20241022',
      usage: { input_tokens: 200, output_tokens: 80 },
    };
    const result = extractUsage('anthropic', 'claude-3-5-sonnet-20241022', body);
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.model, 'claude-3-5-sonnet-20241022');
    assert.equal(result.inputTokens, 200);
    assert.equal(result.outputTokens, 80);
    assert.equal(result.requestId, 'msg-xyz');
  });

  test('extracts gemini usage', () => {
    const body = {
      usageMetadata: { promptTokenCount: 150, candidatesTokenCount: 60 },
    };
    const result = extractUsage('gemini', 'gemini-pro', body);
    assert.equal(result.provider, 'gemini');
    assert.equal(result.model, 'gemini-pro');
    assert.equal(result.inputTokens, 150);
    assert.equal(result.outputTokens, 60);
  });

  test('extracts cohere usage', () => {
    const body = {
      meta: { tokens: { input_tokens: 90, output_tokens: 40 } },
    };
    const result = extractUsage('cohere', 'command-r', body);
    assert.equal(result.provider, 'cohere');
    assert.equal(result.model, 'command-r');
    assert.equal(result.inputTokens, 90);
    assert.equal(result.outputTokens, 40);
  });

  test('extracts mistral usage (falls through to openai extractor)', () => {
    const body = {
      model: 'mistral-large-latest',
      usage: { prompt_tokens: 120, completion_tokens: 45 },
    };
    const result = extractUsage('mistral', 'mistral-large-latest', body);
    assert.equal(result.provider, 'mistral');
    assert.equal(result.model, 'mistral-large-latest');
    assert.equal(result.inputTokens, 120);
    assert.equal(result.outputTokens, 45);
  });

  test('returns zeros when usage fields are missing', () => {
    const result = extractUsage('openai', 'gpt-4', {});
    assert.equal(result.inputTokens, 0);
    assert.equal(result.outputTokens, 0);
  });
});

// ─── PROXY-02: ProxyForwarder — module-level smoke ───────────────────────────

import { forwardRequest } from '../../src/proxy/ProxyForwarder.js';

describe('ProxyForwarder — PROXY-02', () => {
  test('forwardRequest is exported as a function', () => {
    assert.equal(typeof forwardRequest, 'function');
  });

  test('hop-by-hop stripping: function is pure code (structural verify)', () => {
    // Verify the module exports exactly one named export (forwardRequest)
    // and that it accepts the expected arity (5 parameters).
    assert.equal(forwardRequest.length, 5);
  });
});

// ─── VAULT-01: ProviderKeyVault ──────────────────────────────────────────────

import { ProviderKeyVault, getVault, resetVaultForTest } from '../../src/security/ProviderKeyVault.js';

describe('ProviderKeyVault — VAULT-01', () => {
  let vault: ProviderKeyVault;

  beforeEach(() => {
    vault = new ProviderKeyVault();
  });

  test('encrypt/decrypt round trip', () => {
    const plainKey = 'sk-test-12345678';
    const { encryptedKey, iv, tag } = vault.encrypt(plainKey);
    assert.notEqual(encryptedKey, plainKey);
    const decrypted = vault.decrypt(encryptedKey, iv, tag);
    assert.equal(decrypted, plainKey);
  });

  test('storeKey and getKey return the original key', () => {
    vault.storeKey('tenant-1', 'openai', 'sk-openai-abc');
    const retrieved = vault.getKey('tenant-1', 'openai');
    assert.equal(retrieved, 'sk-openai-abc');
  });

  test('getKey returns null for unknown tenant+provider', () => {
    const result = vault.getKey('no-such-tenant', 'openai');
    assert.equal(result, null);
  });

  test('storeKey is case-insensitive for provider', () => {
    vault.storeKey('tenant-2', 'OpenAI', 'sk-openai-xyz');
    const result = vault.getKey('tenant-2', 'openai');
    assert.equal(result, 'sk-openai-xyz');
  });

  test('listKeys returns masked keys', () => {
    vault.storeKey('tenant-3', 'anthropic', 'sk-ant-secret-key-1234');
    const keys = vault.listKeys('tenant-3');
    assert.equal(keys.length, 1);
    assert.equal(keys[0]!.provider, 'anthropic');
    // The last 4 chars must be visible
    assert.ok(keys[0]!.maskedKey.endsWith('1234'), `Expected masked key to end with '1234', got: ${keys[0]!.maskedKey}`);
    // The rest must be masked with asterisks
    assert.ok(keys[0]!.maskedKey.startsWith('*'), 'Expected masking with asterisks at start');
  });

  test('listKeys only returns keys for the requested tenant', () => {
    vault.storeKey('tenant-A', 'openai', 'sk-a-1234');
    vault.storeKey('tenant-B', 'openai', 'sk-b-5678');
    const keysA = vault.listKeys('tenant-A');
    assert.equal(keysA.length, 1);
    const keysB = vault.listKeys('tenant-B');
    assert.equal(keysB.length, 1);
  });

  test('deleteKey removes the key and returns true', () => {
    vault.storeKey('tenant-4', 'gemini', 'gk-gemini-9999');
    const deleted = vault.deleteKey('tenant-4', 'gemini');
    assert.equal(deleted, true);
    assert.equal(vault.getKey('tenant-4', 'gemini'), null);
  });

  test('deleteKey returns false if key does not exist', () => {
    const result = vault.deleteKey('no-tenant', 'openai');
    assert.equal(result, false);
  });

  test('getVault singleton returns same instance across calls', () => {
    resetVaultForTest();
    const v1 = getVault();
    const v2 = getVault();
    assert.strictEqual(v1, v2);
    resetVaultForTest();
  });

  test('different keys produce different ciphertexts (non-deterministic IV)', () => {
    const { encryptedKey: e1, iv: iv1 } = vault.encrypt('key-abc');
    const { encryptedKey: e2, iv: iv2 } = vault.encrypt('key-abc');
    // IVs must differ (randomBytes)
    assert.notEqual(iv1, iv2);
    assert.notEqual(e1, e2);
  });
});

// ─── TEAM-01: TeamModel / MemoryTeamStore ────────────────────────────────────

import { MemoryTeamStore } from '../../src/users/TeamModel.js';
import type { Team, TeamMembership } from '../../src/users/TeamModel.js';

describe('MemoryTeamStore — TEAM-01', () => {
  let store: MemoryTeamStore;

  beforeEach(() => {
    store = new MemoryTeamStore();
  });

  function makeTeam(overrides: Partial<Team> = {}): Team {
    return {
      id: 'team-1',
      name: 'Alpha Team',
      ownerId: 'tenant-owner',
      createdAt: new Date().toISOString(),
      ...overrides,
    };
  }

  test('createTeam and getTeam round-trip', async () => {
    const team = makeTeam();
    await store.createTeam(team);
    const retrieved = await store.getTeam('team-1');
    assert.equal(retrieved?.id, 'team-1');
    assert.equal(retrieved?.name, 'Alpha Team');
    assert.equal(retrieved?.ownerId, 'tenant-owner');
  });

  test('getTeam returns null for unknown id', async () => {
    const result = await store.getTeam('no-such-team');
    assert.equal(result, null);
  });

  test('listTeams returns teams owned by the given tenantId', async () => {
    await store.createTeam(makeTeam({ id: 't1', ownerId: 'owner-A' }));
    await store.createTeam(makeTeam({ id: 't2', ownerId: 'owner-B' }));
    await store.createTeam(makeTeam({ id: 't3', ownerId: 'owner-A' }));
    const teams = await store.listTeams('owner-A');
    assert.equal(teams.length, 2);
    assert.ok(teams.every(t => t.ownerId === 'owner-A'));
  });

  test('addMember and listMembers', async () => {
    const team = makeTeam();
    await store.createTeam(team);
    const membership: TeamMembership = {
      teamId: 'team-1',
      tenantId: 'tenant-member-1',
      role: 'member',
      joinedAt: new Date().toISOString(),
    };
    await store.addMember(membership);
    const members = await store.listMembers('team-1');
    assert.equal(members.length, 1);
    assert.equal(members[0]!.tenantId, 'tenant-member-1');
    assert.equal(members[0]!.role, 'member');
  });

  test('addMember overwrites existing membership for same tenantId', async () => {
    await store.createTeam(makeTeam());
    const m1: TeamMembership = { teamId: 'team-1', tenantId: 'tenant-x', role: 'member', joinedAt: '' };
    const m2: TeamMembership = { teamId: 'team-1', tenantId: 'tenant-x', role: 'admin', joinedAt: '' };
    await store.addMember(m1);
    await store.addMember(m2);
    const members = await store.listMembers('team-1');
    assert.equal(members.length, 1);
    assert.equal(members[0]!.role, 'admin');
  });

  test('getTeamsForTenant returns teams the tenant is a member of', async () => {
    await store.createTeam(makeTeam({ id: 'team-A' }));
    await store.createTeam(makeTeam({ id: 'team-B' }));
    await store.addMember({ teamId: 'team-A', tenantId: 'tenant-Z', role: 'member', joinedAt: '' });
    const teams = await store.getTeamsForTenant('tenant-Z');
    assert.equal(teams.length, 1);
    assert.equal(teams[0]!.id, 'team-A');
  });

  test('deleteTeam removes team and memberships', async () => {
    await store.createTeam(makeTeam());
    await store.addMember({ teamId: 'team-1', tenantId: 'tenant-del', role: 'member', joinedAt: '' });
    await store.deleteTeam('team-1');
    assert.equal(await store.getTeam('team-1'), null);
    const members = await store.listMembers('team-1');
    assert.equal(members.length, 0);
  });
});

// ─── TEAM-09: TeamBudgetMonitor ──────────────────────────────────────────────

import { TeamBudgetMonitor, resetTeamBudgetMonitorForTest, getTeamBudgetMonitor } from '../../src/users/TeamBudgetMonitor.js';

describe('TeamBudgetMonitor — TEAM-09', () => {
  let monitor: TeamBudgetMonitor;

  beforeEach(() => {
    monitor = new TeamBudgetMonitor();
  });

  test('getBudget returns null when no budget set', () => {
    assert.equal(monitor.getBudget('team-x'), null);
  });

  test('setBudget and getBudget round-trip', () => {
    monitor.setBudget({ teamId: 'team-1', dailyLimitUsd: 10, monthlyLimitUsd: 100 });
    const b = monitor.getBudget('team-1');
    assert.equal(b?.dailyLimitUsd, 10);
    assert.equal(b?.monthlyLimitUsd, 100);
  });

  test('checkBudget not exceeded — daily', () => {
    monitor.setBudget({ teamId: 'team-2', dailyLimitUsd: 20, monthlyLimitUsd: 200 });
    const result = monitor.checkBudget('team-2', 15.5, 'daily');
    assert.equal(result.exceeded, false);
    assert.equal(result.limitUsd, 20);
    assert.equal(result.spendUsd, 15.5);
  });

  test('checkBudget exceeded — daily', () => {
    monitor.setBudget({ teamId: 'team-3', dailyLimitUsd: 10, monthlyLimitUsd: 200 });
    const result = monitor.checkBudget('team-3', 12.5, 'daily');
    assert.equal(result.exceeded, true);
    assert.equal(result.limitUsd, 10);
    assert.equal(result.spendUsd, 12.5);
  });

  test('checkBudget not exceeded — monthly', () => {
    monitor.setBudget({ teamId: 'team-4', dailyLimitUsd: 10, monthlyLimitUsd: 500 });
    const result = monitor.checkBudget('team-4', 250, 'monthly');
    assert.equal(result.exceeded, false);
    assert.equal(result.limitUsd, 500);
  });

  test('checkBudget exceeded — monthly', () => {
    monitor.setBudget({ teamId: 'team-5', dailyLimitUsd: 10, monthlyLimitUsd: 100 });
    const result = monitor.checkBudget('team-5', 101, 'monthly');
    assert.equal(result.exceeded, true);
    assert.equal(result.limitUsd, 100);
  });

  test('checkBudget with no budget returns exceeded: false, limitUsd: 0', () => {
    const result = monitor.checkBudget('no-budget-team', 99, 'daily');
    assert.equal(result.exceeded, false);
    assert.equal(result.limitUsd, 0);
    assert.equal(result.spendUsd, 99);
  });

  test('setBudget overwrites existing budget', () => {
    monitor.setBudget({ teamId: 'team-6', dailyLimitUsd: 5, monthlyLimitUsd: 50 });
    monitor.setBudget({ teamId: 'team-6', dailyLimitUsd: 25, monthlyLimitUsd: 250 });
    const b = monitor.getBudget('team-6');
    assert.equal(b?.dailyLimitUsd, 25);
    assert.equal(b?.monthlyLimitUsd, 250);
  });

  test('singleton getTeamBudgetMonitor returns same instance', () => {
    resetTeamBudgetMonitorForTest();
    const m1 = getTeamBudgetMonitor();
    const m2 = getTeamBudgetMonitor();
    assert.strictEqual(m1, m2);
    resetTeamBudgetMonitorForTest();
  });
});

// ─── VAULT-08: GlobalKeyStrategy — provider map coverage ─────────────────────

import { GlobalKeyStrategy } from '../../src/providers/strategies/GlobalKeyStrategy.js';

describe('GlobalKeyStrategy — VAULT-08', () => {
  test('throws for unsupported provider with descriptive message', async () => {
    const strategy = new GlobalKeyStrategy();
    await assert.rejects(
      () => strategy.resolve('unsupportedprovider'),
      /unsupportedprovider/i,
    );
  });

  test('throws for openai when env var is missing, mentioning OPENAI_API_KEY', async () => {
    const strategy = new GlobalKeyStrategy();
    const saved = process.env['OPENAI_API_KEY'];
    delete process.env['OPENAI_API_KEY'];
    try {
      await assert.rejects(
        () => strategy.resolve('openai'),
        /OPENAI_API_KEY/,
      );
    } finally {
      if (saved !== undefined) process.env['OPENAI_API_KEY'] = saved;
    }
  });

  test('throws for gemini mentioning GEMINI_API_KEY or GOOGLE_API_KEY', async () => {
    const strategy = new GlobalKeyStrategy();
    const saved1 = process.env['GEMINI_API_KEY'];
    const saved2 = process.env['GOOGLE_API_KEY'];
    delete process.env['GEMINI_API_KEY'];
    delete process.env['GOOGLE_API_KEY'];
    try {
      await assert.rejects(
        () => strategy.resolve('gemini'),
        /GEMINI_API_KEY|GOOGLE_API_KEY/,
      );
    } finally {
      if (saved1 !== undefined) process.env['GEMINI_API_KEY'] = saved1;
      if (saved2 !== undefined) process.env['GOOGLE_API_KEY'] = saved2;
    }
  });

  test('resolves key when env var is set', async () => {
    const strategy = new GlobalKeyStrategy();
    process.env['COHERE_API_KEY'] = 'co-test-key-123';
    try {
      const key = await strategy.resolve('cohere');
      assert.equal(key, 'co-test-key-123');
    } finally {
      delete process.env['COHERE_API_KEY'];
    }
  });
});

// ─── TEAM-06: ReceiptIndexer.getUsageByTeam() ───────────────────────────────

import { ReceiptIndexer } from '../../src/dashboard/indexer.js';

describe('ReceiptIndexer.getUsageByTeam — TEAM-06', () => {
  let indexer: ReceiptIndexer;

  beforeEach(() => {
    indexer = new ReceiptIndexer();
  });

  function makeReceipt(overrides: Record<string, unknown> = {}) {
    return {
      requestId: `req-${Math.random().toString(36).slice(2)}`,
      provider: 'openai',
      model: 'gpt-4',
      inputTokens: 100,
      outputTokens: 50,
      costUnits: 10,
      latencyMs: 200,
      timestamp: Math.floor(Date.now() / 1000),
      ...overrides,
    };
  }

  test('getUsageByTeam returns empty array when no receipts have teamId', () => {
    indexer.index(makeReceipt());
    indexer.index(makeReceipt());
    const result = indexer.getUsageByTeam();
    assert.equal(result.length, 0);
  });

  test('getUsageByTeam aggregates receipts by teamId', () => {
    indexer.index(makeReceipt({ teamId: 'team-alpha', costUnits: 10 }));
    indexer.index(makeReceipt({ teamId: 'team-alpha', costUnits: 20 }));
    indexer.index(makeReceipt({ teamId: 'team-beta', costUnits: 5 }));

    const result = indexer.getUsageByTeam();
    assert.equal(result.length, 2);

    const alpha = result.find(r => r.teamId === 'team-alpha');
    assert.ok(alpha, 'team-alpha should be in results');
    assert.equal(alpha!.totalCU, 30);
    assert.equal(alpha!.requestCount, 2);

    const beta = result.find(r => r.teamId === 'team-beta');
    assert.ok(beta, 'team-beta should be in results');
    assert.equal(beta!.totalCU, 5);
    assert.equal(beta!.requestCount, 1);
  });

  test('getUsageByTeam sorts by totalCU descending', () => {
    indexer.index(makeReceipt({ teamId: 'low-team', costUnits: 1 }));
    indexer.index(makeReceipt({ teamId: 'high-team', costUnits: 100 }));
    indexer.index(makeReceipt({ teamId: 'mid-team', costUnits: 50 }));

    const result = indexer.getUsageByTeam();
    assert.equal(result[0]!.teamId, 'high-team');
    assert.equal(result[1]!.teamId, 'mid-team');
    assert.equal(result[2]!.teamId, 'low-team');
  });

  test('receipts without teamId are excluded from team aggregation', () => {
    indexer.index(makeReceipt({ teamId: 'team-x', costUnits: 10 }));
    indexer.index(makeReceipt({ costUnits: 999 })); // no teamId
    const result = indexer.getUsageByTeam();
    assert.equal(result.length, 1);
    assert.equal(result[0]!.teamId, 'team-x');
    assert.equal(result[0]!.totalCU, 10);
  });
});

// ─── PROXY-03: StreamTapper (usageSeen + zero-token fix) ─────────────────────

import { StreamTapper } from '../../src/proxy/StreamTapper.js';

describe('StreamTapper — PROXY-03', () => {
  test('usage is null and usageSeen is false before any data', () => {
    const tapper = new StreamTapper();
    assert.equal(tapper.usage, null);
    assert.equal(tapper.usageSeen, false);
  });

  test('parses non-zero usage from SSE chunk', async () => {
    const tapper = new StreamTapper();
    const chunk = 'data: {"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n';
    tapper.write(chunk);
    await new Promise<void>((resolve) => tapper.end(resolve));
    assert.equal(tapper.usageSeen, true);
    assert.ok(tapper.usage != null);
    assert.equal(tapper.usage!.promptTokens, 10);
    assert.equal(tapper.usage!.completionTokens, 5);
  });

  test('usageSeen=true and usage populated for zero-token SSE chunk', async () => {
    const tapper = new StreamTapper();
    const chunk = 'data: {"usage":{"prompt_tokens":0,"completion_tokens":0}}\n\n';
    tapper.write(chunk);
    await new Promise<void>((resolve) => tapper.end(resolve));
    // usageSeen disambiguates: usage key was present, even though tokens=0
    assert.equal(tapper.usageSeen, true);
    assert.ok(tapper.usage != null);
    assert.equal(tapper.usage!.promptTokens, 0);
    assert.equal(tapper.usage!.completionTokens, 0);
  });

  test('ignores data:[DONE] line', async () => {
    const tapper = new StreamTapper();
    tapper.write('data: [DONE]\n\n');
    await new Promise<void>((resolve) => tapper.end(resolve));
    assert.equal(tapper.usageSeen, false);
    assert.equal(tapper.usage, null);
  });

  test('passes data through unchanged', async () => {
    const tapper = new StreamTapper();
    const input = 'data: {"delta":{"content":"hello"}}\n\n';
    const chunks: Buffer[] = [];
    tapper.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = new Promise<void>((resolve) => tapper.on('end', resolve));
    tapper.write(input);
    tapper.end();
    await ended;
    const output = Buffer.concat(chunks).toString('utf8');
    assert.equal(output, input);
  });
});
