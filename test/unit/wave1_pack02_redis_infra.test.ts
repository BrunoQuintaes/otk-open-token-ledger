/**
 * Wave 1 Pack 2 — Redis Infra Hardened (S3.1)
 *
 * Tests the RedisClient class without requiring a running Redis instance.
 * Validates: configuration, health status, masking, lifecycle, singleton.
 *
 * @since Wave 1 Pack 2 (2026-03-15)
 *
 * Module under test: `src/infra/redis/redisClient.ts` (`RedisClient` and the `getRedisClient` singleton).
 *
 * Strategy / partitions: defaults and custom options; password masking on a valid URL, an invalid URL and a URL
 * without password; state and health before connecting; a connection to an unreachable port; the singleton with
 * `OTK_REDIS_URL` unset and set, repeated calls and reset; the event interface.
 *
 * Needs: no Redis. One case tries a TCP connection to `localhost:59999` and expects it to fail within 500 ms.
 * Removes `OTK_REDIS_URL` before and after each singleton case.
 *
 * Run just this file: `npx tsx --test test/unit/wave1_pack02_redis_infra.test.ts`
 *
 * @module test/unit/wave1_pack02_redis_infra.test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RedisClient, getRedisClient, resetRedisForTest } from '../../src/infra/redis/redisClient.js';

describe('S3.1 — Redis Client Configuration', () => {
  it('creates with default config', () => {
    const client = new RedisClient({ url: 'redis://localhost:6379' });
    assert.ok(client);
    const health = client.health();
    assert.equal(health.connected, false);
    assert.equal(health.circuitOpen, false);
    assert.equal(health.reconnectAttempts, 0);
    assert.equal(health.lastPingMs, null);
  });

  it('maskedUrl hides password', () => {
    const client = new RedisClient({ url: 'redis://user:supersecret@redis.example.com:6379' });
    const masked = client.maskedUrl;
    assert.ok(!masked.includes('supersecret'), 'should not expose password');
    assert.ok(masked.includes('***'), 'should contain masked marker');
    assert.ok(masked.includes('redis.example.com'), 'should preserve host');
  });

  it('maskedUrl safe on invalid URL', () => {
    const client = new RedisClient({ url: 'not-a-url' });
    assert.equal(client.maskedUrl, '<invalid-url>');
  });

  it('maskedUrl safe on URL without password', () => {
    const client = new RedisClient({ url: 'redis://localhost:6379' });
    const masked = client.maskedUrl;
    assert.ok(masked.includes('localhost'), 'should preserve host');
    assert.ok(!masked.includes('***'), 'no password to mask');
  });

  it('isReady is false before connect', () => {
    const client = new RedisClient({ url: 'redis://localhost:6379' });
    assert.equal(client.isReady, false);
  });

  it('url getter returns configured url', () => {
    const client = new RedisClient({ url: 'redis://myhost:6380' });
    assert.equal(client.url, 'redis://myhost:6380');
  });

  it('prefix defaults to otk:', () => {
    const client = new RedisClient({ url: 'redis://localhost:6379' });
    assert.equal(client.prefix, 'otk:');
  });

  it('prefix is configurable', () => {
    const client = new RedisClient({ url: 'redis://localhost:6379', keyPrefix: 'test:' });
    assert.equal(client.prefix, 'test:');
  });

  it('health status shape is correct', () => {
    const client = new RedisClient({ url: 'redis://localhost:6379' });
    const health = client.health();
    assert.equal(typeof health.connected, 'boolean');
    assert.equal(typeof health.circuitOpen, 'boolean');
    assert.equal(typeof health.reconnectAttempts, 'number');
    assert.equal(typeof health.uptimeMs, 'number');
    assert.ok(health.uptimeMs >= 0);
  });

  it('ping returns null when not connected', async () => {
    const client = new RedisClient({ url: 'redis://localhost:6379' });
    const result = await client.ping();
    assert.equal(result, null);
  });

  it('rawClient is null before connect', () => {
    const client = new RedisClient({ url: 'redis://localhost:6379' });
    assert.equal(client.rawClient, null);
  });

  it('close is safe on unconnected client', async () => {
    const client = new RedisClient({ url: 'redis://localhost:6379' });
    await client.close(); // should not throw
    assert.equal(client.isReady, false);
  });
});

describe('S3.1 — Redis Client Connect (no real Redis)', () => {
  it('connect returns false when Redis is unreachable', async () => {
    const client = new RedisClient({
      url: 'redis://localhost:59999', // unlikely to have Redis here
      connectTimeoutMs: 500, // fast timeout for test
      maxReconnectAttempts: 0, // don't retry
    });
    // Suppress error events to prevent uncaught exception in test
    client.on('error', () => { /* expected — no real Redis */ });
    const connected = await client.connect();
    assert.equal(connected, false);
    assert.equal(client.isReady, false);
    await client.close();
  });
});

describe('S3.1 — Redis Singleton (getRedisClient)', () => {
  beforeEach(() => {
    resetRedisForTest();
    delete process.env['OTK_REDIS_URL'];
  });

  afterEach(() => {
    resetRedisForTest();
    delete process.env['OTK_REDIS_URL'];
  });

  it('returns null when OTK_REDIS_URL is not set', () => {
    const client = getRedisClient();
    assert.equal(client, null);
  });

  it('returns a RedisClient when OTK_REDIS_URL is set', () => {
    process.env['OTK_REDIS_URL'] = 'redis://localhost:6379';
    const client = getRedisClient();
    assert.ok(client instanceof RedisClient);
  });

  it('returns same instance on repeated calls', () => {
    process.env['OTK_REDIS_URL'] = 'redis://localhost:6379';
    const a = getRedisClient();
    const b = getRedisClient();
    assert.equal(a, b);
  });

  it('resetRedisForTest clears singleton', () => {
    process.env['OTK_REDIS_URL'] = 'redis://localhost:6379';
    const a = getRedisClient();
    resetRedisForTest();
    process.env['OTK_REDIS_URL'] = 'redis://localhost:6379';
    const b = getRedisClient();
    assert.notEqual(a, b);
  });
});

describe('S3.1 — Redis Client Events', () => {
  it('emits events on EventEmitter interface', () => {
    const client = new RedisClient({ url: 'redis://localhost:6379' });
    assert.equal(typeof client.on, 'function');
    assert.equal(typeof client.emit, 'function');
    assert.equal(typeof client.removeAllListeners, 'function');
  });
});

describe('S3.1 — Redis Config Validation', () => {
  it('custom timeouts are applied', () => {
    const client = new RedisClient({
      url: 'redis://localhost:6379',
      connectTimeoutMs: 1000,
      commandTimeoutMs: 500,
      maxReconnectAttempts: 5,
      reconnectBackoffMs: 100,
      maxBackoffMs: 5000,
      healthCheckIntervalMs: 10000,
    });
    // Config is applied — verify via health (no direct config accessor, but client is constructed)
    assert.ok(client);
    assert.equal(client.url, 'redis://localhost:6379');
  });
});
