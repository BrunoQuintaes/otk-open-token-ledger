/**
 * LatencySimulator — unit tests
 *
 * Checks the simulated network latency used by the benchmarks (per-hop delay, consensus delay,
 * estimated block time and throughput).
 *
 * Module under test: `src/bench/LatencySimulator.ts` (`LatencySimulator`, `latencyConfigFromEnv`).
 *
 * Strategy / partitions: disabled (base 0 ms) vs enabled; jitter 0 (exact delay) vs jitter > 0
 * (delay stays within the jitter band); estimates at zero and at positive latency; reading the
 * configuration from the environment when no variable is set.
 *
 * Needs: real timers (a few short awaited delays). `latencyConfigFromEnv` reads
 * `NET_LATENCY_MS`, `NET_LATENCY_JITTER` and `IBFT_ROUNDS`; the test only asserts valid ranges,
 * so it passes whether or not they are set.
 *
 * Run just this file: `npx tsx --test test/unit/LatencySimulator.test.ts`
 *
 * @since U9.5
 * @module test/unit/LatencySimulator.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { LatencySimulator, latencyConfigFromEnv } from '../../src/bench/LatencySimulator.js';

describe('LatencySimulator', () => {
  it('isActive is false when baseMs=0', () => {
    const sim = new LatencySimulator({ baseMs: 0 });
    assert.ok(!sim.isActive);
  });

  it('isActive is true when baseMs>0', () => {
    const sim = new LatencySimulator({ baseMs: 10 });
    assert.ok(sim.isActive);
  });

  it('computeHopDelay() returns 0 when disabled', () => {
    const sim = new LatencySimulator({ baseMs: 0 });
    assert.strictEqual(sim.computeHopDelay(), 0);
  });

  it('computeHopDelay() returns baseMs when jitter=0', () => {
    const sim = new LatencySimulator({ baseMs: 50, jitter: 0 });
    // No jitter → exact value
    assert.strictEqual(sim.computeHopDelay(), 50);
    assert.strictEqual(sim.computeHopDelay(), 50);
  });

  it('computeHopDelay() stays within [base*(1-j), base*(1+j)] with jitter', () => {
    const sim = new LatencySimulator({ baseMs: 100, jitter: 0.2 });
    for (let i = 0; i < 50; i++) {
      const d = sim.computeHopDelay();
      assert.ok(d >= 100 * 0.8 - 0.001, `d=${d} >= 80`);
      assert.ok(d <= 100 * 1.2 + 0.001, `d=${d} <= 120`);
    }
  });

  it('simulateHop() resolves quickly when disabled', async () => {
    const sim = new LatencySimulator({ baseMs: 0 });
    const t0 = Date.now();
    await sim.simulateHop();
    assert.ok(Date.now() - t0 < 50, 'resolves in <50ms when disabled');
  });

  it('simulateHop() adds latency when enabled', async () => {
    const sim = new LatencySimulator({ baseMs: 20, jitter: 0 });
    const t0 = Date.now();
    await sim.simulateHop();
    assert.ok(Date.now() - t0 >= 15, 'takes at least 15ms');
  });

  it('estimatedBlockTimeMs() with no latency returns overhead', () => {
    const sim = new LatencySimulator({ baseMs: 0 });
    assert.strictEqual(sim.estimatedBlockTimeMs(500), 500);
  });

  it('estimatedBlockTimeMs() increases with latency', () => {
    const sim10  = new LatencySimulator({ baseMs: 10,  jitter: 0, ibftRounds: 3 });
    const sim100 = new LatencySimulator({ baseMs: 100, jitter: 0, ibftRounds: 3 });
    assert.ok(sim100.estimatedBlockTimeMs() > sim10.estimatedBlockTimeMs());
  });

  it('estimatedThroughput() at 0 latency is ~loopback max', () => {
    const sim = new LatencySimulator({ baseMs: 0 });
    // receiptsPerBlock = floor(12e6 / 290620) = 41
    // blockTime = 500ms → 41 / 0.5 = 82 receipts/s
    const thr = sim.estimatedThroughput();
    assert.ok(thr > 0);
    assert.ok(thr <= 100, `thr=${thr} reasonable`);
  });

  it('estimatedThroughput() decreases with latency', () => {
    const sim0   = new LatencySimulator({ baseMs: 0 });
    const sim100 = new LatencySimulator({ baseMs: 100, jitter: 0, ibftRounds: 3 });
    assert.ok(sim0.estimatedThroughput() > sim100.estimatedThroughput());
  });

  it('withConsensusDelay() returns result and simulatedDelayMs', async () => {
    const sim = new LatencySimulator({ baseMs: 0 });
    const { result, simulatedDelayMs } = await sim.withConsensusDelay(async () => 42);
    assert.strictEqual(result, 42);
    assert.strictEqual(simulatedDelayMs, 0);
  });

  it('toString() describes active simulator', () => {
    const sim = new LatencySimulator({ baseMs: 50, jitter: 0.1, ibftRounds: 3 });
    const s = sim.toString();
    assert.ok(s.includes('50ms'));
  });
});

describe('latencyConfigFromEnv', () => {
  it('returns defaults when no env vars set', () => {
    const config = latencyConfigFromEnv();
    // In test environment, likely no NET_LATENCY_MS set
    assert.ok(typeof config.baseMs === 'number');
    assert.ok(typeof config.jitter === 'number');
    assert.ok(config.baseMs >= 0);
    assert.ok(config.jitter >= 0 && config.jitter <= 1);
  });
});
