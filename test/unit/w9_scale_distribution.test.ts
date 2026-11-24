/**
 * W9 Scale & Distribution — Unit Tests
 *
 * Covers:
 *  1. ProviderPaymentRouter — addPayout, markPaid, getPendingPayouts, getTotalOwedUsd
 *  2. ProviderBillingImporter — importOpenAIUsage returns empty result when no key
 *  3. signRefreshToken/verifyRefreshToken — round trip, type field = 'refresh'
 *  4. getChainTarget() — defaults to 'besu', returns 'sepolia' when env set
 *  5. getRegionFromLatLng — basic geographic routing
 *  6. isClusterEnabled — defaults false
 *  7. getProverMetrics — returns object with expected fields
 *
 * @since W9 (2026-04-07)
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ProviderPaymentRouter,
  getPaymentRouter,
  resetPaymentRouterForTest,
} from '../../src/billing/ProviderPaymentRouter.js';

import {
  importOpenAIUsage,
  importAnthropicUsage,
} from '../../src/billing/ProviderBillingImporter.js';

import {
  signToken,
  signRefreshToken,
  verifyRefreshToken,
} from '../../src/auth/jwt.js';

import {
  getChainTarget,
  getChainConfig,
  CHAIN_TARGETS,
} from '../../src/infra/chain/SepoliaConfig.js';

import {
  getRegionFromLatLng,
  routeToRegion,
  getLocalRegion,
  REGION_ENDPOINTS,
} from '../../src/infra/routing/RegionRouter.js';

import {
  isClusterEnabled,
  getClusterNodes,
} from '../../src/infra/redis/RedisClusterConfig.js';

import {
  ProverDaemonManager,
} from '../../src/prover/ProverDaemonManager.js';

// ── 1. ProviderPaymentRouter ──────────────────────────────────────────

describe('ProviderPaymentRouter', () => {
  it('addPayout + getPendingPayouts + getTotalOwedUsd', () => {
    const router = new ProviderPaymentRouter();
    router.addPayout({
      provider: 'openai',
      cycleStart: '2026-04-01',
      cycleEnd: '2026-04-30',
      providerCostUsd: 12.50,
      status: 'pending',
    });
    router.addPayout({
      provider: 'anthropic',
      cycleStart: '2026-04-01',
      cycleEnd: '2026-04-30',
      providerCostUsd: 7.25,
      status: 'pending',
    });
    const pending = router.getPendingPayouts();
    assert.equal(pending.length, 2, 'should have 2 pending payouts');
    assert.ok(
      Math.abs(router.getTotalOwedUsd() - 19.75) < 0.001,
      `total owed should be ~19.75, got ${router.getTotalOwedUsd()}`,
    );
  });

  it('markPaid changes status and sets paidAt', () => {
    const router = new ProviderPaymentRouter();
    router.addPayout({
      provider: 'openai',
      cycleStart: '2026-04-01',
      cycleEnd: '2026-04-30',
      providerCostUsd: 5.00,
      status: 'pending',
    });
    router.markPaid('openai', '2026-04-01');
    const all = router.getAllPayouts();
    const entry = all.find(p => p.provider === 'openai');
    assert.ok(entry, 'entry should exist');
    assert.equal(entry!.status, 'paid');
    assert.ok(entry!.paidAt, 'paidAt should be set after markPaid');
  });

  it('markPaid on non-existent entry is a no-op', () => {
    const router = new ProviderPaymentRouter();
    assert.doesNotThrow(() => router.markPaid('unknown', '2026-01-01'));
  });

  it('getPendingPayouts excludes paid entries', () => {
    const router = new ProviderPaymentRouter();
    router.addPayout({ provider: 'openai', cycleStart: '2026-03-01', cycleEnd: '2026-03-31', providerCostUsd: 3.00, status: 'pending' });
    router.addPayout({ provider: 'anthropic', cycleStart: '2026-03-01', cycleEnd: '2026-03-31', providerCostUsd: 2.00, status: 'paid' });
    const pending = router.getPendingPayouts();
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.provider, 'openai');
  });

  it('getTotalOwedUsd is 0 when no pending payouts', () => {
    const router = new ProviderPaymentRouter();
    assert.equal(router.getTotalOwedUsd(), 0);
  });

  it('getPaymentRouter returns singleton', () => {
    resetPaymentRouterForTest();
    const r1 = getPaymentRouter();
    const r2 = getPaymentRouter();
    assert.strictEqual(r1, r2, 'should return the same instance');
    resetPaymentRouterForTest();
  });
});

// ── 2. ProviderBillingImporter ────────────────────────────────────────

describe('ProviderBillingImporter', () => {
  it('importOpenAIUsage returns empty result when apiKey is empty', async () => {
    const result = await importOpenAIUsage('', '2026-04-01', '2026-04-30');
    assert.equal(result.provider, 'openai');
    assert.equal(result.records.length, 0);
    assert.equal(result.totalUsd, 0);
    assert.ok(result.importedAt, 'importedAt should be set');
  });

  it('importAnthropicUsage returns empty result when apiKey is empty', async () => {
    const result = await importAnthropicUsage('', '2026-04-01', '2026-04-30');
    assert.equal(result.provider, 'anthropic');
    assert.equal(result.records.length, 0);
    assert.equal(result.totalUsd, 0);
  });
});

// ── 3. signRefreshToken / verifyRefreshToken ──────────────────────────

describe('JWT refresh tokens (OPS-02)', () => {
  const SECRET = 'test-refresh-secret-w9-unit';

  it('round-trip: sign then verify returns tenantId', () => {
    const token = signRefreshToken('tenant-abc', SECRET);
    assert.ok(token.split('.').length === 3, 'should be 3-part JWT');
    const decoded = verifyRefreshToken(token, SECRET);
    assert.ok(decoded !== null, 'should decode successfully');
    assert.equal(decoded!.tenantId, 'tenant-abc');
  });

  it('token payload contains type=refresh', () => {
    const token = signRefreshToken('tenant-xyz', SECRET);
    const parts = token.split('.');
    const padded = parts[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    const payload = JSON.parse(Buffer.from(padded + pad, 'base64').toString());
    assert.equal(payload.type, 'refresh', 'payload.type should be refresh');
  });

  it('verifyRefreshToken rejects access token (wrong type)', () => {
    const accessToken = signToken({ sub: 'tenant-abc', role: 'MEMBER' }, SECRET, 3600);
    const decoded = verifyRefreshToken(accessToken, SECRET);
    assert.equal(decoded, null, 'access token should not pass refresh verification');
  });

  it('verifyRefreshToken rejects tampered token', () => {
    const token = signRefreshToken('tenant-abc', SECRET);
    const tampered = token.slice(0, -4) + 'XXXX';
    const decoded = verifyRefreshToken(tampered, SECRET);
    assert.equal(decoded, null, 'tampered token should be rejected');
  });

  it('verifyRefreshToken rejects wrong secret', () => {
    const token = signRefreshToken('tenant-abc', SECRET);
    const decoded = verifyRefreshToken(token, 'wrong-secret');
    assert.equal(decoded, null, 'wrong secret should be rejected');
  });
});

// ── 4. getChainTarget / getChainConfig ────────────────────────────────

describe('SepoliaConfig (OPS-07)', () => {
  it('getChainTarget defaults to besu when OTK_CHAIN_TARGET unset', () => {
    const orig = process.env['OTK_CHAIN_TARGET'];
    delete process.env['OTK_CHAIN_TARGET'];
    assert.equal(getChainTarget(), 'besu');
    if (orig !== undefined) process.env['OTK_CHAIN_TARGET'] = orig;
  });

  it('getChainTarget returns sepolia when env=sepolia', () => {
    const orig = process.env['OTK_CHAIN_TARGET'];
    process.env['OTK_CHAIN_TARGET'] = 'sepolia';
    assert.equal(getChainTarget(), 'sepolia');
    if (orig !== undefined) process.env['OTK_CHAIN_TARGET'] = orig;
    else delete process.env['OTK_CHAIN_TARGET'];
  });

  it('getChainConfig besu chainId = 1337', () => {
    const orig = process.env['OTK_CHAIN_TARGET'];
    delete process.env['OTK_CHAIN_TARGET'];
    const cfg = getChainConfig();
    assert.equal(cfg.chainId, 1337);
    assert.ok(cfg.name.includes('Besu'));
    if (orig !== undefined) process.env['OTK_CHAIN_TARGET'] = orig;
  });

  it('getChainConfig sepolia chainId = 11155111', () => {
    const orig = process.env['OTK_CHAIN_TARGET'];
    process.env['OTK_CHAIN_TARGET'] = 'sepolia';
    const cfg = getChainConfig();
    assert.equal(cfg.chainId, 11155111);
    if (orig !== undefined) process.env['OTK_CHAIN_TARGET'] = orig;
    else delete process.env['OTK_CHAIN_TARGET'];
  });

  it('CHAIN_TARGETS has both besu and sepolia keys', () => {
    assert.ok('besu' in CHAIN_TARGETS);
    assert.ok('sepolia' in CHAIN_TARGETS);
  });
});

// ── 5. getRegionFromLatLng ────────────────────────────────────────────

describe('RegionRouter (MR-01)', () => {
  it('New York (40.71, -74.01) → us-east', () => {
    assert.equal(getRegionFromLatLng(40.71, -74.01), 'us-east');
  });

  it('London (51.51, -0.13) → eu-west', () => {
    assert.equal(getRegionFromLatLng(51.51, -0.13), 'eu-west');
  });

  it('Singapore (1.35, 103.82) → ap-southeast', () => {
    assert.equal(getRegionFromLatLng(1.35, 103.82), 'ap-southeast');
  });

  it('routeToRegion builds correct URL with leading slash', () => {
    const url = routeToRegion('eu-west', '/v1/receipts');
    assert.equal(url, 'https://otk-eu.example.com/v1/receipts');
  });

  it('routeToRegion normalises path without leading slash', () => {
    const url = routeToRegion('us-east', 'health');
    assert.equal(url, 'https://otk-us.example.com/health');
  });

  it('getLocalRegion defaults to us-east when OTK_REGION unset', () => {
    const orig = process.env['OTK_REGION'];
    delete process.env['OTK_REGION'];
    assert.equal(getLocalRegion(), 'us-east');
    if (orig !== undefined) process.env['OTK_REGION'] = orig;
  });

  it('getLocalRegion returns eu-west when OTK_REGION=eu-west', () => {
    const orig = process.env['OTK_REGION'];
    process.env['OTK_REGION'] = 'eu-west';
    assert.equal(getLocalRegion(), 'eu-west');
    if (orig !== undefined) process.env['OTK_REGION'] = orig;
    else delete process.env['OTK_REGION'];
  });

  it('REGION_ENDPOINTS has 3 regions', () => {
    assert.equal(Object.keys(REGION_ENDPOINTS).length, 3);
  });
});

// ── 6. isClusterEnabled ───────────────────────────────────────────────

describe('RedisClusterConfig (MR-02)', () => {
  it('isClusterEnabled defaults to false when OTK_REDIS_CLUSTER unset', () => {
    const orig = process.env['OTK_REDIS_CLUSTER'];
    delete process.env['OTK_REDIS_CLUSTER'];
    assert.equal(isClusterEnabled(), false);
    if (orig !== undefined) process.env['OTK_REDIS_CLUSTER'] = orig;
  });

  it('isClusterEnabled returns true when OTK_REDIS_CLUSTER=true', () => {
    const orig = process.env['OTK_REDIS_CLUSTER'];
    process.env['OTK_REDIS_CLUSTER'] = 'true';
    assert.equal(isClusterEnabled(), true);
    if (orig !== undefined) process.env['OTK_REDIS_CLUSTER'] = orig;
    else delete process.env['OTK_REDIS_CLUSTER'];
  });

  it('isClusterEnabled returns false for OTK_REDIS_CLUSTER=false', () => {
    process.env['OTK_REDIS_CLUSTER'] = 'false';
    assert.equal(isClusterEnabled(), false);
    delete process.env['OTK_REDIS_CLUSTER'];
  });

  it('getClusterNodes parses two host:port pairs', () => {
    const orig = process.env['OTK_REDIS_CLUSTER_NODES'];
    process.env['OTK_REDIS_CLUSTER_NODES'] = 'redis-0.example.com:6380,redis-1.example.com:6381';
    const nodes = getClusterNodes();
    assert.equal(nodes.length, 2);
    assert.equal(nodes[0]!.host, 'redis-0.example.com');
    assert.equal(nodes[0]!.port, 6380);
    assert.equal(nodes[1]!.host, 'redis-1.example.com');
    assert.equal(nodes[1]!.port, 6381);
    if (orig !== undefined) process.env['OTK_REDIS_CLUSTER_NODES'] = orig;
    else delete process.env['OTK_REDIS_CLUSTER_NODES'];
  });

  it('getClusterNodes returns empty array when env unset', () => {
    const orig = process.env['OTK_REDIS_CLUSTER_NODES'];
    delete process.env['OTK_REDIS_CLUSTER_NODES'];
    assert.equal(getClusterNodes().length, 0);
    if (orig !== undefined) process.env['OTK_REDIS_CLUSTER_NODES'] = orig;
  });
});

// ── 7. getProverMetrics ───────────────────────────────────────────────

describe('ProverDaemonManager.getProverMetrics (OPS-01)', () => {
  it('returns object with all expected fields', () => {
    const mgr = new ProverDaemonManager({ scriptPath: '/nonexistent', maxRestarts: 0 });
    const metrics = mgr.getProverMetrics();
    assert.ok('activeProvers' in metrics, 'should have activeProvers');
    assert.ok('queueDepth' in metrics, 'should have queueDepth');
    assert.ok('exhaustionEvents' in metrics, 'should have exhaustionEvents');
    assert.ok('lastExhaustionAt' in metrics, 'should have lastExhaustionAt');
    assert.equal(typeof metrics.activeProvers, 'number');
    assert.equal(typeof metrics.queueDepth, 'number');
    assert.equal(typeof metrics.exhaustionEvents, 'number');
  });

  it('activeProvers is 0 when daemon is not started', () => {
    const mgr = new ProverDaemonManager({ scriptPath: '/nonexistent', maxRestarts: 0 });
    const metrics = mgr.getProverMetrics();
    assert.equal(metrics.activeProvers, 0);
  });

  it('queueDepth is 0 (managed by ProductionQueue)', () => {
    const mgr = new ProverDaemonManager({ scriptPath: '/nonexistent', maxRestarts: 0 });
    assert.equal(mgr.getProverMetrics().queueDepth, 0);
  });
});
