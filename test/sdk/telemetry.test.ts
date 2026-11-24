/**
 * W5-5D — SDK Telemetry tests (NEW-5.03)
 *
 * Verifies:
 *   1. Telemetry is opt-in (disabled by default)
 *   2. OTK_TELEMETRY_OPT_OUT=1 disables even when ENABLED=1
 *   3. recordLatency() and recordError() accumulate correctly
 *   4. p50/p95 percentiles are computed correctly
 *   5. errorRate is correct
 *   6. getSnapshot() always returns a valid structure
 *   7. resetTelemetry() clears all state
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isTelemetryEnabled,
  recordLatency,
  recordError,
  getSnapshot,
  resetTelemetry,
  SDK_VERSION,
} from '../../src/sdk/telemetry.js';

// Save and restore env vars around each test
let savedEnabled: string | undefined;
let savedOptOut: string | undefined;

beforeEach(() => {
  savedEnabled = process.env['OTK_TELEMETRY_ENABLED'];
  savedOptOut = process.env['OTK_TELEMETRY_OPT_OUT'];
  resetTelemetry();
});

afterEach(() => {
  if (savedEnabled !== undefined) process.env['OTK_TELEMETRY_ENABLED'] = savedEnabled;
  else delete process.env['OTK_TELEMETRY_ENABLED'];
  if (savedOptOut !== undefined) process.env['OTK_TELEMETRY_OPT_OUT'] = savedOptOut;
  else delete process.env['OTK_TELEMETRY_OPT_OUT'];
  resetTelemetry();
});

// ---------------------------------------------------------------------------

describe('W5-5D — isTelemetryEnabled()', () => {
  it('disabled by default (no env vars set)', () => {
    delete process.env['OTK_TELEMETRY_ENABLED'];
    delete process.env['OTK_TELEMETRY_OPT_OUT'];
    assert.equal(isTelemetryEnabled(), false, 'must be disabled by default');
  });

  it('enabled when OTK_TELEMETRY_ENABLED=1', () => {
    process.env['OTK_TELEMETRY_ENABLED'] = '1';
    delete process.env['OTK_TELEMETRY_OPT_OUT'];
    assert.equal(isTelemetryEnabled(), true);
  });

  it('OTK_TELEMETRY_OPT_OUT=1 overrides ENABLED=1', () => {
    process.env['OTK_TELEMETRY_ENABLED'] = '1';
    process.env['OTK_TELEMETRY_OPT_OUT'] = '1';
    assert.equal(isTelemetryEnabled(), false, 'opt-out must take precedence');
  });

  it('OTK_TELEMETRY_ENABLED=0 keeps it disabled', () => {
    process.env['OTK_TELEMETRY_ENABLED'] = '0';
    delete process.env['OTK_TELEMETRY_OPT_OUT'];
    assert.equal(isTelemetryEnabled(), false);
  });
});

describe('W5-5D — recordLatency() / recordError() no-op when disabled', () => {
  it('recordLatency is no-op when disabled', () => {
    delete process.env['OTK_TELEMETRY_ENABLED'];
    recordLatency('buildReceipt', 100);
    const snap = getSnapshot();
    assert.equal(snap.operations.length, 0, 'must record nothing when disabled');
  });

  it('recordError is no-op when disabled', () => {
    delete process.env['OTK_TELEMETRY_ENABLED'];
    recordError('zkProve');
    const snap = getSnapshot();
    assert.equal(snap.operations.length, 0);
  });
});

describe('W5-5D — recordLatency() accumulation', () => {
  beforeEach(() => { process.env['OTK_TELEMETRY_ENABLED'] = '1'; delete process.env['OTK_TELEMETRY_OPT_OUT']; });

  it('records latency and increments callCount', () => {
    recordLatency('buildReceipt', 50);
    recordLatency('buildReceipt', 100);
    const snap = getSnapshot();
    const op = snap.operations.find(o => o.op === 'buildReceipt');
    assert.ok(op, 'must have buildReceipt metrics');
    assert.equal(op?.callCount, 2);
    assert.equal(op?.errorCount, 0);
  });

  it('computes p50 correctly for odd-length array', () => {
    // Sorted: [10, 20, 30] → p50 = 20
    recordLatency('op', 30);
    recordLatency('op', 10);
    recordLatency('op', 20);
    const snap = getSnapshot();
    const op = snap.operations.find(o => o.op === 'op');
    assert.equal(op?.p50Ms, 20);
  });

  it('computes p95 for larger dataset', () => {
    // 20 values: 1–20. p95 = value at index ceil(20*0.95)-1 = index 18 = 19
    for (let i = 1; i <= 20; i++) recordLatency('op95', i);
    const snap = getSnapshot();
    const op = snap.operations.find(o => o.op === 'op95');
    assert.ok(op && op.p95Ms !== null && op.p95Ms >= 19, 'p95 must be near max');
  });

  it('p50/p95 are null when no latencies recorded', () => {
    recordError('errOp');
    const snap = getSnapshot();
    const op = snap.operations.find(o => o.op === 'errOp');
    assert.equal(op?.p50Ms, null);
    assert.equal(op?.p95Ms, null);
  });
});

describe('W5-5D — recordError() and errorRate', () => {
  beforeEach(() => { process.env['OTK_TELEMETRY_ENABLED'] = '1'; delete process.env['OTK_TELEMETRY_OPT_OUT']; });

  it('errorRate is 1.0 when all calls are errors', () => {
    recordError('failOp');
    recordError('failOp');
    const snap = getSnapshot();
    const op = snap.operations.find(o => o.op === 'failOp');
    assert.equal(op?.errorRate, 1.0);
  });

  it('errorRate is 0.5 when half calls are errors', () => {
    recordLatency('mixOp', 100);
    recordError('mixOp');
    const snap = getSnapshot();
    const op = snap.operations.find(o => o.op === 'mixOp');
    assert.equal(op?.errorRate, 0.5);
  });

  it('errorRate is 0 when no errors', () => {
    recordLatency('cleanOp', 50);
    const snap = getSnapshot();
    const op = snap.operations.find(o => o.op === 'cleanOp');
    assert.equal(op?.errorRate, 0);
  });
});

describe('W5-5D — getSnapshot() structure', () => {
  it('always returns valid structure even when disabled', () => {
    delete process.env['OTK_TELEMETRY_ENABLED'];
    const snap = getSnapshot();
    assert.ok(typeof snap.sdkVersion === 'string');
    assert.ok(typeof snap.enabled === 'boolean');
    assert.equal(snap.enabled, false);
    assert.ok(Array.isArray(snap.operations));
    assert.ok(typeof snap.capturedAt === 'string');
  });

  it('sdkVersion matches SDK_VERSION constant', () => {
    const snap = getSnapshot();
    assert.equal(snap.sdkVersion, SDK_VERSION);
  });
});

describe('W5-5D — resetTelemetry()', () => {
  it('clears all operation buckets', () => {
    process.env['OTK_TELEMETRY_ENABLED'] = '1';
    recordLatency('op1', 100);
    recordError('op2');
    resetTelemetry();
    const snap = getSnapshot();
    assert.equal(snap.operations.length, 0, 'must have no operations after reset');
  });
});
