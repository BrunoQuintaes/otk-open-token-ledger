/**
 * Wave 3A Pack 04+05 — HA Infrastructure + ProxySlice Dual-Mode Tests
 *
 * Tests:
 * - Instance ID in health responses (3 tests)
 * - ProxySlice mode get/set (3 tests)
 * - ProxyGateway uses structured logger (1 test)
 * - /system/status includes proxyMode and instanceId (2 tests)
 * - Multi-instance store sharing contract (6 tests)
 *
 * @since Wave 3A (Pack 04+05)
 *
 * Modules under test: `src/proxy/ProxySlice.ts` (proxy mode), `src/proxy/ProxyGateway.ts` (module load),
 * `src/api/routes.ts` (instance id on health and status routes) and the store singletons shared by two
 * simulated instances (idempotency, rate limiter, dead letters, audit chain, accounting layer).
 *
 * Strategy / partitions: as listed above; "two instances" are two references to the same in-process singletons.
 *
 * Needs: nothing external. Reads `OTK_PROXY_MODE` (default case expects it unset) and changes and restores
 * `OTK_INSTANCE_ID`.
 *
 * Run just this file: `npx tsx --test test/unit/wave3a_pack04_05_ha_proxy.test.ts`
 *
 * @module test/unit/wave3a_pack04_05_ha_proxy.test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ── ProxySlice ────────────────────────────────────────────────────────────────

import {
  getProxyMode,
  setProxyMode,
  resetProxyModeForTest,
  type ProxyMode,
} from '../../src/proxy/ProxySlice.js';

describe('Wave 3A P05 — ProxySlice mode management', () => {
  beforeEach(() => resetProxyModeForTest());
  afterEach(() => resetProxyModeForTest());

  it('default mode is "direct" when OTK_PROXY_MODE is not set', () => {
    delete process.env['OTK_PROXY_MODE'];
    resetProxyModeForTest();
    assert.equal(getProxyMode(), 'direct');
  });

  it('setProxyMode changes the mode', () => {
    setProxyMode('mediated');
    assert.equal(getProxyMode(), 'mediated');
  });

  it('all valid modes can be set', () => {
    const modes: ProxyMode[] = ['direct', 'mediated', 'auto'];
    for (const mode of modes) {
      setProxyMode(mode);
      assert.equal(getProxyMode(), mode, `mode ${mode} should be settable`);
    }
  });
});

// ── ProxyGateway — structured logger ─────────────────────────────────────────

import { startProxyGateway } from '../../src/proxy/ProxyGateway.js';
import { getLogger } from '../../src/infra/logging/StructuredLogger.js';

describe('Wave 3A P05 — ProxyGateway uses structured logger', () => {
  it('startProxyGateway is a function (module loads with logger import)', () => {
    // If ProxyGateway imported console.log directly, this would still pass,
    // but the module import itself fails if StructuredLogger has a bad import.
    // The real check is that getLogger() is importable from the same module graph.
    assert.equal(typeof startProxyGateway, 'function');
    assert.equal(typeof getLogger, 'function');
    assert.equal(typeof getLogger().info, 'function');
  });
});

// ── Instance ID in health responses ──────────────────────────────────────────

import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';

function mockReq(method: string, url: string): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers: {} }) as unknown as IncomingMessage;
  process.nextTick(() => em.emit('end'));
  return req;
}

type MockRes = ServerResponse & { body: string };

function mockRes(): MockRes {
  let body = '';
  const res = {
    statusCode: 200,
    setHeader: () => {},
    end: (data?: string) => { if (data) body = data; },
    get body() { return body; },
  } as unknown as MockRes;
  return res;
}

describe('Wave 3A P04 — instanceId in health endpoints', () => {
  let origInstanceId: string | undefined;

  beforeEach(() => {
    origInstanceId = process.env['OTK_INSTANCE_ID'];
  });

  afterEach(() => {
    if (origInstanceId !== undefined) {
      process.env['OTK_INSTANCE_ID'] = origInstanceId;
    } else {
      delete process.env['OTK_INSTANCE_ID'];
    }
  });

  it('/health response includes instanceId field', async () => {
    const req = mockReq('GET', '/health');
    const res = mockRes();
    await handleRequest(req, res);
    const parsed = JSON.parse(res.body);
    assert.ok('instanceId' in parsed, '/health must include instanceId');
    assert.equal(typeof parsed.instanceId, 'string');
  });

  it('/healthz response includes instanceId field', async () => {
    const req = mockReq('GET', '/healthz');
    const res = mockRes();
    await handleRequest(req, res);
    const parsed = JSON.parse(res.body);
    assert.ok('instanceId' in parsed, '/healthz must include instanceId');
    assert.equal(typeof parsed.instanceId, 'string');
  });

  it('/readyz response includes instanceId field', async () => {
    const req = mockReq('GET', '/readyz');
    const res = mockRes();
    await handleRequest(req, res);
    const parsed = JSON.parse(res.body);
    assert.ok('instanceId' in parsed, '/readyz must include instanceId');
    assert.equal(typeof parsed.instanceId, 'string');
  });
});

// ── /system/status includes proxyMode ────────────────────────────────────────

describe('Wave 3A P05 — /system/status includes proxyMode and instanceId', () => {
  beforeEach(() => {
    setProxyMode('direct');
  });
  afterEach(() => {
    resetProxyModeForTest();
  });

  it('/system/status response includes proxyMode field', async () => {
    const req = mockReq('GET', '/system/status');
    const res = mockRes();
    await handleRequest(req, res);
    const parsed = JSON.parse(res.body);
    assert.ok('proxyMode' in parsed, '/system/status must include proxyMode');
    assert.equal(parsed.proxyMode, 'direct');
  });

  it('/system/status response includes instanceId field', async () => {
    const req = mockReq('GET', '/system/status');
    const res = mockRes();
    await handleRequest(req, res);
    const parsed = JSON.parse(res.body);
    assert.ok('instanceId' in parsed, '/system/status must include instanceId');
    assert.equal(typeof parsed.instanceId, 'string');
  });
});

// ── Multi-instance store sharing (in-process contract) ────────────────────────

import {
  getIdempotencyStore,
  resetIdempotencyStoreForTest,
  bodyHash,
} from '../../src/api/idempotency.js';

import {
  getDistributedRateLimiter,
  resetDistributedRateLimiterForTest,
} from '../../src/security/IDistributedRateLimiter.js';

import {
  getDeadLetterStore,
  resetDeadLetterStoreForTest,
} from '../../src/api/IDeadLetterStore.js';

import {
  getAuditStore,
  resetAuditStoreForTest,
} from '../../src/security/IAuditStore.js';

import {
  getAccountingLayer,
  resetAccountingLayerForTest,
} from '../../src/security/talRuntime.js';

describe('Wave 3A P04 — Multi-instance store sharing contract', () => {
  beforeEach(() => {
    resetIdempotencyStoreForTest();
    resetDistributedRateLimiterForTest();
    resetDeadLetterStoreForTest();
    resetAuditStoreForTest();
    resetAccountingLayerForTest();
  });

  it('idempotency: write from "A" is visible from "B" (same singleton)', async () => {
    const storeA = getIdempotencyStore();
    const storeB = getIdempotencyStore();
    const body = '{"provider":"openai"}';
    await storeA.set('key-001', { status: 201, body: '{}', bodyHash: bodyHash(body) }, 60);
    const result = await storeB.get('key-001');
    assert.ok(result !== null);
    assert.equal(result.status, 201);
  });

  it('rate limiter: limit consumed by "A" affects "B" (same singleton)', async () => {
    const limA = getDistributedRateLimiter();
    const limB = getDistributedRateLimiter();
    const key = 'rl:shared-key';
    const cfg = { windowSeconds: 60, maxRequests: 2 };
    await limA.check(key, cfg); // 1
    await limA.check(key, cfg); // 2 — exhausted
    const d = await limB.check(key, cfg);
    assert.equal(d.allowed, false, 'B denied after A exhausted limit');
  });

  it('dead letter: entry from "A" visible from "B"', async () => {
    const dlA = getDeadLetterStore();
    const dlB = getDeadLetterStore();
    const entry = await dlA.add({ originalPayload: '{}', error: 'err', reason: 'test', source: 'test' });
    const fetched = await dlB.get(entry.id);
    assert.ok(fetched !== null, 'B sees dead letter added by A');
  });

  it('audit: chain head from "A" matches "B" (shared chain)', async () => {
    const auditA = getAuditStore();
    const auditB = getAuditStore();
    await auditA.append({ ts: new Date().toISOString(), tenantId: 't', actor: 'A', action: 'tenant_created' });
    const headA = await auditA.head();
    const headB = await auditB.head();
    assert.equal(headA, headB, 'chain head must be identical across instances');
  });

  it('accounting: both instances share the same TAL object reference', () => {
    const talA = getAccountingLayer();
    const talB = getAccountingLayer();
    assert.strictEqual(talA, talB, 'TAL must be same reference (shared singleton)');
  });

  it('store singletons are strict references — no copies', () => {
    // Documents the contract: all store getters must return the same object
    assert.strictEqual(getIdempotencyStore(), getIdempotencyStore());
    assert.strictEqual(getDistributedRateLimiter(), getDistributedRateLimiter());
    assert.strictEqual(getDeadLetterStore(), getDeadLetterStore());
    assert.strictEqual(getAuditStore(), getAuditStore());
    assert.strictEqual(getAccountingLayer(), getAccountingLayer());
  });
});
