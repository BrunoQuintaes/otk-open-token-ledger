/**
 * MetricsCollector — unit tests for the per-provider and per-model usage metrics kept in memory.
 *
 * Module under test: `MetricsCollector` from `src/observability/MetricsCollector.ts`.
 *
 * Strategy / partitions: first record and several successes; errors below 50% (healthy) and at or
 * above 50% (degraded); no requests (unknown health); two providers and two models of one
 * provider kept apart; injected snapshot time; reset; average latency over three records.
 *
 * Needs: nothing external (a fresh collector per test).
 *
 * Run just this file: `npx tsx --test test/unit/metrics_collector.test.ts`
 *
 * @module test/unit/metrics_collector.test
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { MetricsCollector } from '../../src/observability/MetricsCollector.js';
import type { NormalizedUsageEvent } from '../../src/providers/types.js';

function evt(provider: string, model: string, latencyMs: number, costUnits: number, timestamp = 1_000_000): NormalizedUsageEvent {
  return { provider, model, inputTokens: 10, outputTokens: 5, totalTokens: 15, latencyMs, costUnits, timestamp, requestId: 'r1' };
}

describe('MetricsCollector', () => {
  let col: MetricsCollector;

  beforeEach(() => { col = new MetricsCollector(); });

  it('creates entry on first record (success)', () => {
    col.record(evt('openai', 'gpt-4o', 100, 500));
    const snap = col.snapshot(2_000_000);
    assert.equal(snap.providers.length, 1);
    const e = snap.providers[0];
    assert.equal(e.provider, 'openai');
    assert.equal(e.model, 'gpt-4o');
    assert.equal(e.requestCount, 1);
    assert.equal(e.successCount, 1);
    assert.equal(e.errorCount, 0);
    assert.equal(e.totalLatencyMs, 100);
    assert.equal(e.avgLatencyMs, 100);
    assert.equal(e.totalCostUnits, 500);
    assert.equal(e.lastSeenAt, 1_000_000);
    assert.equal(e.healthStatus, 'healthy');
  });

  it('accumulates multiple successes', () => {
    col.record(evt('openai', 'gpt-4o', 100, 200));
    col.record(evt('openai', 'gpt-4o', 300, 400, 1_000_001));
    const e = col.snapshot().providers[0];
    assert.equal(e.requestCount, 2);
    assert.equal(e.successCount, 2);
    assert.equal(e.totalLatencyMs, 400);
    assert.equal(e.avgLatencyMs, 200);
    assert.equal(e.totalCostUnits, 600);
    assert.equal(e.lastSeenAt, 1_000_001);
  });

  it('tracks errors separately; health stays healthy at error rate <50%', () => {
    col.record(evt('openai', 'gpt-4o', 100, 200), false);
    col.record(evt('openai', 'gpt-4o', 50, 0), true);
    col.record(evt('openai', 'gpt-4o', 80, 300), false);
    const e = col.snapshot().providers[0];
    assert.equal(e.requestCount, 3);
    assert.equal(e.successCount, 2);
    assert.equal(e.errorCount, 1);
    assert.equal(e.healthStatus, 'healthy');  // 1/3 ≈ 33% < 50%
  });

  it('health becomes degraded at error rate >=50%', () => {
    col.record(evt('anthropic', 'claude-sonnet', 100, 100), true);
    col.record(evt('anthropic', 'claude-sonnet', 100, 0), true);
    const e = col.snapshot().providers[0];
    assert.equal(e.healthStatus, 'degraded');
  });

  it('unknown health when no requests exist (empty collector)', () => {
    const snap = col.snapshot(1_000_000);
    assert.equal(snap.providers.length, 0);
  });

  it('tracks two providers independently', () => {
    col.record(evt('openai', 'gpt-4o', 100, 200));
    col.record(evt('anthropic', 'claude-sonnet', 50, 150));
    const snap = col.snapshot();
    assert.equal(snap.providers.length, 2);
    const providers = snap.providers.map(p => p.provider).sort();
    assert.deepEqual(providers, ['anthropic', 'openai']);
  });

  it('tracks two models of same provider independently', () => {
    col.record(evt('openai', 'gpt-4o', 100, 200));
    col.record(evt('openai', 'gpt-4o-mini', 30, 50));
    const snap = col.snapshot();
    assert.equal(snap.providers.length, 2);
  });

  it('snapshot capturedAt is injectable for determinism', () => {
    const snap = col.snapshot(9_999_999);
    assert.equal(snap.capturedAt, 9_999_999);
  });

  it('reset clears all data', () => {
    col.record(evt('openai', 'gpt-4o', 100, 200));
    col.reset();
    assert.equal(col.snapshot().providers.length, 0);
  });

  it('avgLatencyMs is correct after 3 records with different latencies', () => {
    col.record(evt('gemini', 'gemini-pro', 60, 100));
    col.record(evt('gemini', 'gemini-pro', 120, 100));
    col.record(evt('gemini', 'gemini-pro', 180, 100));
    const e = col.snapshot().providers[0];
    assert.equal(e.totalLatencyMs, 360);
    assert.equal(e.avgLatencyMs, 120);
    assert.equal(e.requestCount, 3);
  });
});
