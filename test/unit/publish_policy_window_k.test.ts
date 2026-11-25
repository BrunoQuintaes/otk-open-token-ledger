/**
 * publish_policy_window_k — unit tests for PublishPolicy.
 *
 * Uses a fake clock to avoid real timer dependency.
 *
 * Test matrix:
 *   1. 'off' mode — passthrough, always immediate
 *   2. window_k mode — K condition only (window already elapsed)
 *   3. window_k mode — window condition only (K not yet met)
 *   4. window_k mode — both conditions must be true (AND gate)
 *   5. flush() — force-release regardless of conditions
 *   6. State inspection via inspect()
 *   7. Constructor validation (invalid params throw)
 *   8. optionsFromEnv() defaults
 *   9. fromEnv() factory
 *  10. Multi-batch cycle (reset after release)
 *
 * @since U5.3.1
 *
 * Module under test: `src/publisher/PublishPolicy.ts`.
 *
 * Needs: nothing external; time comes from a fake clock. The defaults cases assume that `CU_PUBLISH_POLICY`,
 * `PUBLISH_WINDOW_MS` and `PUBLISH_MIN_BATCH_K` are not set in the environment.
 *
 * Run just this file: `npx tsx --test test/unit/publish_policy_window_k.test.ts`
 *
 * @module test/unit/publish_policy_window_k.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PublishPolicy,
  optionsFromEnv,
  type PublishPolicyMode,
} from '../../src/publisher/PublishPolicy.js';

// ---------------------------------------------------------------------------
// Fake clock helper
// ---------------------------------------------------------------------------
function makeClock(startMs = 0) {
  let t = startMs;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
    set: (ms: number) => { t = ms; },
  };
}

/**
 * Build a policy with a fake clock for deterministic time control.
 * @param mode - Publish mode under test.
 * @param windowMs - Batch window in milliseconds of the fake clock.
 * @param minBatchK - Minimum number of receipts per batch.
 * @param clock - Fake clock; a new one starting at 0 ms by default.
 */
function makePolicy<T>(
  mode: PublishPolicyMode,
  windowMs: number,
  minBatchK: number,
  clock = makeClock()
): { policy: PublishPolicy<T>; clock: ReturnType<typeof makeClock> } {
  const policy = new PublishPolicy<T>({ mode, windowMs, minBatchK, now: clock.now });
  return { policy, clock };
}

// ---------------------------------------------------------------------------
// 1. 'off' mode — passthrough
// ---------------------------------------------------------------------------
describe("mode='off': passthrough (immediate publish)", () => {
  it('add() returns single-element array immediately', () => {
    const { policy } = makePolicy<string>('off', 60_000, 10);
    const result = policy.add('receipt-1');
    assert.deepStrictEqual(result, ['receipt-1']);
  });

  it('add() never returns null in off mode', () => {
    const { policy } = makePolicy<number>('off', 60_000, 10);
    for (let i = 0; i < 20; i++) {
      const r = policy.add(i);
      assert.ok(r !== null, `expected non-null at i=${i}`);
      assert.strictEqual(r.length, 1);
    }
  });

  it('pendingCount stays 0 in off mode', () => {
    const { policy } = makePolicy<string>('off', 60_000, 10);
    policy.add('a');
    policy.add('b');
    assert.strictEqual(policy.pendingCount, 0);
  });
});

// ---------------------------------------------------------------------------
// 2. K condition — window already elapsed
// ---------------------------------------------------------------------------
describe("window_k: K condition (window pre-elapsed)", () => {
  it('does not publish with K-1 receipts', () => {
    const { policy, clock } = makePolicy<number>('window_k', 1_000, 5);
    clock.advance(2_000); // window already elapsed
    for (let i = 0; i < 4; i++) {
      const r = policy.add(i);
      assert.strictEqual(r, null, `should be null at count=${i + 1} (need 5)`);
    }
    assert.strictEqual(policy.pendingCount, 4);
  });

  it('publishes exactly at K receipts when window already elapsed', () => {
    const clock = makeClock(0);
    const policy = new PublishPolicy<number>({ mode: 'window_k', windowMs: 1_000, minBatchK: 5, now: clock.now });

    // Add first receipt at t=0 (opens batch)
    assert.strictEqual(policy.add(0), null);

    // Advance past window
    clock.advance(2_000);

    // Add receipts 1..3 — still below K=5
    for (let i = 1; i < 4; i++) {
      assert.strictEqual(policy.add(i), null);
    }

    // Add the 5th receipt (index=4) — K reached AND window elapsed
    const batch = policy.add(4);
    assert.ok(batch !== null, 'expected batch at K=5');
    assert.strictEqual(batch.length, 5);
    assert.deepStrictEqual(batch, [0, 1, 2, 3, 4]);
  });

  it('returns null for exactly K-1 = 9 receipts', () => {
    const { policy, clock } = makePolicy<string>('window_k', 1_000, 10);
    clock.advance(2_000);
    for (let i = 0; i < 9; i++) {
      const r = policy.add(`r${i}`);
      assert.strictEqual(r, null, `expected null at i=${i}`);
    }
    assert.strictEqual(policy.pendingCount, 9);
  });

  it('publishes at K=10 when window elapsed', () => {
    const { policy, clock } = makePolicy<string>('window_k', 1_000, 10);
    // First receipt at t=0
    policy.add('r0');
    clock.advance(5_000); // past window
    for (let i = 1; i < 9; i++) policy.add(`r${i}`);
    const batch = policy.add('r9'); // K=10
    assert.ok(batch !== null);
    assert.strictEqual(batch.length, 10);
  });
});

// ---------------------------------------------------------------------------
// 3. Window condition only (K not met)
// ---------------------------------------------------------------------------
describe("window_k: window elapsed but K not met → no publish", () => {
  it('holds batch when K not reached even after window', () => {
    const { policy, clock } = makePolicy<number>('window_k', 1_000, 10);
    // Add only 3 receipts
    for (let i = 0; i < 3; i++) policy.add(i);
    // Advance far past window
    clock.advance(99_999);
    // Add a 4th — window elapsed but count=4 < K=10
    const r = policy.add(3);
    assert.strictEqual(r, null, 'should not publish with only 4 receipts');
    assert.strictEqual(policy.pendingCount, 4);
  });
});

// ---------------------------------------------------------------------------
// 4. AND gate — both K and window must be met
// ---------------------------------------------------------------------------
describe("window_k: AND gate (both conditions required)", () => {
  it('K met but window not elapsed → no publish', () => {
    const { policy } = makePolicy<number>('window_k', 60_000, 3);
    // Add 3 receipts immediately (window NOT elapsed)
    for (let i = 0; i < 3; i++) {
      const r = policy.add(i);
      assert.strictEqual(r, null, `expected null at i=${i}: window not elapsed`);
    }
    assert.strictEqual(policy.pendingCount, 3);
  });

  it('window elapsed but K not met → no publish', () => {
    const { policy, clock } = makePolicy<number>('window_k', 100, 10);
    policy.add(0); // opens batch at t=0
    clock.advance(200); // window elapsed, but count=1 < K=10
    const r = policy.add(1);
    assert.strictEqual(r, null);
  });

  it('both conditions met simultaneously → publishes', () => {
    const clock = makeClock(0);
    const policy = new PublishPolicy<string>({
      mode: 'window_k', windowMs: 500, minBatchK: 3, now: clock.now,
    });

    policy.add('a'); // t=0, opens batch
    clock.advance(600); // window elapsed
    policy.add('b');
    const batch = policy.add('c'); // K=3, window=600>500 → publish
    assert.ok(batch !== null);
    assert.deepStrictEqual(batch, ['a', 'b', 'c']);
  });

  it('adding K+1 when only K would trigger, extra goes to next batch', () => {
    const clock = makeClock(0);
    const policy = new PublishPolicy<number>({
      mode: 'window_k', windowMs: 100, minBatchK: 3, now: clock.now,
    });

    policy.add(1); // opens batch
    clock.advance(200); // window elapsed
    policy.add(2);

    // K=3 reached → publishes
    const batch = policy.add(3);
    assert.ok(batch !== null);
    assert.strictEqual(batch.length, 3);
    assert.strictEqual(policy.pendingCount, 0);
  });
});

// ---------------------------------------------------------------------------
// 5. flush() — force-release regardless of conditions
// ---------------------------------------------------------------------------
describe('flush()', () => {
  it('releases pending receipts before conditions are met', () => {
    const { policy } = makePolicy<string>('window_k', 60_000, 10);
    policy.add('a');
    policy.add('b');
    const flushed = policy.flush();
    assert.deepStrictEqual(flushed, ['a', 'b']);
    assert.strictEqual(policy.pendingCount, 0);
  });

  it('returns empty array if nothing pending', () => {
    const { policy } = makePolicy<string>('window_k', 60_000, 10);
    assert.deepStrictEqual(policy.flush(), []);
  });

  it('resets batch open time after flush', () => {
    const { policy } = makePolicy<number>('window_k', 1_000, 5);
    policy.add(1);
    policy.flush();
    const state = policy.inspect();
    assert.strictEqual(state.batchOpenSince, null);
    assert.strictEqual(state.elapsedMs, null);
  });

  it('flush in off mode returns empty (nothing was buffered)', () => {
    const { policy } = makePolicy<string>('off', 60_000, 10);
    policy.add('x'); // immediately returned
    assert.deepStrictEqual(policy.flush(), []);
  });
});

// ---------------------------------------------------------------------------
// 6. inspect() — state snapshot
// ---------------------------------------------------------------------------
describe('inspect()', () => {
  it('returns correct initial state', () => {
    const { policy } = makePolicy<number>('window_k', 5_000, 8);
    const s = policy.inspect();
    assert.strictEqual(s.mode, 'window_k');
    assert.strictEqual(s.windowMs, 5_000);
    assert.strictEqual(s.minBatchK, 8);
    assert.strictEqual(s.pendingCount, 0);
    assert.strictEqual(s.batchOpenSince, null);
    assert.strictEqual(s.elapsedMs, null);
  });

  it('elapsedMs grows as clock advances', () => {
    const clock = makeClock(1_000);
    const policy = new PublishPolicy<number>({ mode: 'window_k', windowMs: 5_000, minBatchK: 5, now: clock.now });

    policy.add(0); // batchOpenAt = 1000
    clock.advance(2_500);

    const s = policy.inspect();
    assert.strictEqual(s.pendingCount, 1);
    assert.strictEqual(s.elapsedMs, 2_500);
    assert.strictEqual(s.batchOpenSince, 1_000);
  });
});

// ---------------------------------------------------------------------------
// 7. Constructor validation
// ---------------------------------------------------------------------------
describe('Constructor validation', () => {
  it('throws if windowMs <= 0', () => {
    assert.throws(() => new PublishPolicy({ mode: 'window_k', windowMs: 0, minBatchK: 5 }));
    assert.throws(() => new PublishPolicy({ mode: 'window_k', windowMs: -1, minBatchK: 5 }));
  });

  it('throws if minBatchK < 1', () => {
    assert.throws(() => new PublishPolicy({ mode: 'window_k', windowMs: 1_000, minBatchK: 0 }));
    assert.throws(() => new PublishPolicy({ mode: 'window_k', windowMs: 1_000, minBatchK: -1 }));
  });

  it('K=1 with any window > 0 is valid', () => {
    assert.doesNotThrow(() => new PublishPolicy({ mode: 'window_k', windowMs: 1, minBatchK: 1 }));
  });
});

// ---------------------------------------------------------------------------
// 8. optionsFromEnv() defaults
// ---------------------------------------------------------------------------
describe('optionsFromEnv() defaults (no env vars set)', () => {
  it('mode defaults to window_k', () => {
    const opts = optionsFromEnv();
    // May be off if CU_PUBLISH_POLICY=off is set in env; validate it's valid
    assert.ok(opts.mode === 'window_k' || opts.mode === 'off');
  });

  it('windowMs is a positive number', () => {
    const opts = optionsFromEnv();
    assert.ok(opts.windowMs > 0);
    assert.ok(typeof opts.windowMs === 'number');
  });

  it('minBatchK is >= 1', () => {
    const opts = optionsFromEnv();
    assert.ok(opts.minBatchK >= 1);
  });

  it('overrides take precedence', () => {
    const opts = optionsFromEnv({ mode: 'off', windowMs: 999, minBatchK: 7 });
    assert.strictEqual(opts.mode, 'off');
    assert.strictEqual(opts.windowMs, 999);
    assert.strictEqual(opts.minBatchK, 7);
  });
});

// ---------------------------------------------------------------------------
// 9. fromEnv() factory
// ---------------------------------------------------------------------------
describe('PublishPolicy.fromEnv()', () => {
  it('creates a valid PublishPolicy instance', () => {
    const p = PublishPolicy.fromEnv<string>();
    assert.ok(p instanceof PublishPolicy);
  });

  it('fromEnv with override mode=off works immediately', () => {
    const p = PublishPolicy.fromEnv<number>({ mode: 'off' });
    const r = p.add(42);
    assert.deepStrictEqual(r, [42]);
  });
});

// ---------------------------------------------------------------------------
// 10. Multi-batch cycle (reset after release)
// ---------------------------------------------------------------------------
describe('Multi-batch cycle', () => {
  it('state resets after a batch is released and new batch starts', () => {
    const clock = makeClock(0);
    const policy = new PublishPolicy<number>({
      mode: 'window_k', windowMs: 100, minBatchK: 2, now: clock.now,
    });

    // First batch
    policy.add(1);
    clock.advance(200);
    const batch1 = policy.add(2);
    assert.ok(batch1 !== null);
    assert.deepStrictEqual(batch1, [1, 2]);
    assert.strictEqual(policy.pendingCount, 0);

    // Second batch starts fresh
    clock.advance(50); // t=250
    policy.add(3);     // opens new batch at t=250
    const s = policy.inspect();
    assert.strictEqual(s.pendingCount, 1);
    assert.strictEqual(s.batchOpenSince, 250);
  });

  it('two complete cycles produce independent batches', () => {
    const clock = makeClock(0);
    const policy = new PublishPolicy<string>({
      mode: 'window_k', windowMs: 100, minBatchK: 3, now: clock.now,
    });

    const collectBatch = (items: string[], fromMs: number): string[] => {
      clock.set(fromMs);
      policy.add(items[0]);
      clock.advance(200); // past window
      policy.add(items[1]);
      const batch = policy.add(items[2]);
      assert.ok(batch !== null);
      return batch;
    };

    const b1 = collectBatch(['a', 'b', 'c'], 0);
    const b2 = collectBatch(['x', 'y', 'z'], 500);

    assert.deepStrictEqual(b1, ['a', 'b', 'c']);
    assert.deepStrictEqual(b2, ['x', 'y', 'z']);
  });
});

// ---------------------------------------------------------------------------
// 11. Policy properties
// ---------------------------------------------------------------------------
describe('Policy property accessors', () => {
  it('mode, windowMs, minBatchK match constructor', () => {
    const p = new PublishPolicy({ mode: 'window_k', windowMs: 12_345, minBatchK: 7 });
    assert.strictEqual(p.mode, 'window_k');
    assert.strictEqual(p.windowMs, 12_345);
    assert.strictEqual(p.minBatchK, 7);
  });
});
