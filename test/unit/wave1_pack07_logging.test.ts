/**
 * Wave 1 Pack 7 — Structured JSON Logging Tests (E1.1)
 *
 * Tests:
 *   - Logger creation and factory
 *   - Log levels (debug, info, warn, error)
 *   - Structured JSON output shape
 *   - Sensitive field masking
 *   - CorrelationId and tenantId propagation
 *   - Min-level filtering
 *   - Child logger inheritance
 *   - Singleton behavior
 *
 * @since Wave 1 Pack 7 (2026-03-15)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  StructuredLogger,
  createLogger,
  getLogger,
  resetLoggerForTest,
  maskSensitiveFields,
  type LogEntry,
} from '../../src/infra/logging/StructuredLogger.js';

/** Capture sink: collects all emitted lines for assertion. */
function createCaptureSink(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line: string) => lines.push(line) };
}

/** Parse the first captured line as a LogEntry. */
function parseFirst(lines: string[]): LogEntry {
  assert.ok(lines.length > 0, 'expected at least one log line');
  return JSON.parse(lines[0]) as LogEntry;
}

describe('Pack 7 — StructuredLogger', () => {
  beforeEach(() => {
    resetLoggerForTest();
  });

  it('createLogger returns a StructuredLogger instance', () => {
    const log = createLogger('test-service');
    assert.ok(log instanceof StructuredLogger);
  });

  it('emits structured JSON with required fields', () => {
    const { lines, sink } = createCaptureSink();
    const log = createLogger('api-server', { sink });

    log.info('hello world');

    const entry = parseFirst(lines);
    assert.equal(entry.level, 'info');
    assert.equal(entry.message, 'hello world');
    assert.equal(entry.service, 'api-server');
    assert.ok(entry.timestamp, 'should have timestamp');
    // Timestamp should be ISO-8601
    assert.ok(!isNaN(Date.parse(entry.timestamp)), 'timestamp should be ISO-8601');
  });

  it('emits all four log levels', () => {
    const { lines, sink } = createCaptureSink();
    const log = createLogger('test', { sink });

    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    assert.equal(lines.length, 4);
    assert.equal((JSON.parse(lines[0]) as LogEntry).level, 'debug');
    assert.equal((JSON.parse(lines[1]) as LogEntry).level, 'info');
    assert.equal((JSON.parse(lines[2]) as LogEntry).level, 'warn');
    assert.equal((JSON.parse(lines[3]) as LogEntry).level, 'error');
  });

  it('respects minLevel filter', () => {
    const { lines, sink } = createCaptureSink();
    const log = createLogger('test', { sink, minLevel: 'warn' });

    log.debug('should be suppressed');
    log.info('should be suppressed');
    log.warn('visible');
    log.error('visible');

    assert.equal(lines.length, 2);
    assert.equal((JSON.parse(lines[0]) as LogEntry).level, 'warn');
    assert.equal((JSON.parse(lines[1]) as LogEntry).level, 'error');
  });

  it('includes extra fields in output', () => {
    const { lines, sink } = createCaptureSink();
    const log = createLogger('test', { sink });

    log.info('request', { method: 'POST', path: '/receipts', status: 201 });

    const entry = parseFirst(lines);
    assert.equal(entry['method'], 'POST');
    assert.equal(entry['path'], '/receipts');
    assert.equal(entry['status'], 201);
  });

  it('masks sensitive fields in extra', () => {
    const { lines, sink } = createCaptureSink();
    const log = createLogger('test', { sink });

    log.info('auth attempt', {
      user: 'alice',
      token: 'sk-secret-123',
      apiKey: 'key-456',
      password: 'hunter2',
    });

    const entry = parseFirst(lines);
    assert.equal(entry['user'], 'alice');
    assert.equal(entry['token'], '***REDACTED***');
    assert.equal(entry['apiKey'], '***REDACTED***');
    assert.equal(entry['password'], '***REDACTED***');
  });

  it('masks nested sensitive fields', () => {
    const masked = maskSensitiveFields({
      config: { token: 'abc', name: 'test' },
      normal: 'ok',
    });

    const nested = masked['config'] as Record<string, unknown>;
    assert.equal(nested['token'], '***REDACTED***');
    assert.equal(nested['name'], 'test');
    assert.equal(masked['normal'], 'ok');
  });

  it('includes correlationId and tenantId when set', () => {
    const { lines, sink } = createCaptureSink();
    const log = createLogger('test', { sink, correlationId: 'req-001', tenantId: 'acme' });

    log.info('test');

    const entry = parseFirst(lines);
    assert.equal(entry.correlationId, 'req-001');
    assert.equal(entry.tenantId, 'acme');
  });

  it('setCorrelationId and setTenantId update subsequent logs', () => {
    const { lines, sink } = createCaptureSink();
    const log = createLogger('test', { sink });

    log.info('before');
    log.setCorrelationId('cid-123');
    log.setTenantId('tenant-a');
    log.info('after');

    const before = JSON.parse(lines[0]) as LogEntry;
    const after = JSON.parse(lines[1]) as LogEntry;

    assert.equal(before.correlationId, undefined);
    assert.equal(after.correlationId, 'cid-123');
    assert.equal(after.tenantId, 'tenant-a');
  });

  it('child logger inherits service and overrides ids', () => {
    const { lines, sink } = createCaptureSink();
    const parent = createLogger('parent', { sink, correlationId: 'parent-cid' });
    const child = parent.child({ correlationId: 'child-cid', tenantId: 'child-tenant' });

    child.info('from child');

    const entry = parseFirst(lines);
    assert.equal(entry.service, 'parent');
    assert.equal(entry.correlationId, 'child-cid');
    assert.equal(entry.tenantId, 'child-tenant');
  });

  it('getLogger returns singleton', () => {
    const a = getLogger();
    const b = getLogger();
    assert.equal(a, b);
  });

  it('resetLoggerForTest clears singleton', () => {
    const a = getLogger();
    resetLoggerForTest();
    const b = getLogger();
    assert.notEqual(a, b);
  });
});
