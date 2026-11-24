/**
 * ResourceProfiler — smoke tests
 * Validates that CPU/RAM deltas are numeric and CSV header is consistent.
 * @since U9.2
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshot,
  delta,
  profileAsync,
  profileSync,
  RESOURCE_CSV_HEADER,
  resourceDeltaToCsvRow,
} from '../../src/bench/ResourceProfiler.js';

describe('ResourceProfiler', () => {
  it('snapshot() returns valid structure', () => {
    const s = snapshot();
    assert.ok(typeof s.cpu.user === 'number', 'cpu.user is number');
    assert.ok(typeof s.cpu.system === 'number', 'cpu.system is number');
    assert.ok(typeof s.mem.heapUsed === 'number', 'mem.heapUsed is number');
    assert.ok(typeof s.mem.rss === 'number', 'mem.rss is number');
    assert.ok(Array.isArray(s.hrtime), 'hrtime is array');
  });

  it('delta() between two snapshots returns numeric fields', () => {
    const before = snapshot();
    // Do some work to produce non-zero deltas
    let x = 0;
    for (let i = 0; i < 10000; i++) x += i;
    const after = snapshot();
    const d = delta(before, after);

    assert.ok(typeof d.cpu_user_ms === 'number', 'cpu_user_ms is number');
    assert.ok(typeof d.cpu_sys_ms === 'number', 'cpu_sys_ms is number');
    assert.ok(typeof d.heap_used_kb === 'number', 'heap_used_kb is number');
    assert.ok(typeof d.rss_kb === 'number', 'rss_kb is number');
    assert.ok(typeof d.elapsed_ms === 'number', 'elapsed_ms is number');
    assert.ok(d.elapsed_ms >= 0, `elapsed_ms=${d.elapsed_ms} >= 0`);
    void x; // suppress unused warning
  });

  it('profileAsync() wraps an async function and returns result + resources', async () => {
    const { result, resources } = await profileAsync(async () => {
      await new Promise<void>(r => setTimeout(r, 5));
      return 42;
    });
    assert.strictEqual(result, 42);
    assert.ok(typeof resources.elapsed_ms === 'number');
    assert.ok(resources.elapsed_ms >= 0, `elapsed ≥ 0ms (got ${resources.elapsed_ms}ms)`);
  });

  it('profileSync() wraps a sync function and returns result + resources', () => {
    const { result, resources } = profileSync(() => {
      let s = 0;
      for (let i = 0; i < 1000; i++) s += i;
      return s;
    });
    assert.strictEqual(result, 499500);
    assert.ok(typeof resources.elapsed_ms === 'number');
    assert.ok(resources.elapsed_ms >= 0);
  });

  it('RESOURCE_CSV_HEADER has expected columns', () => {
    const cols = RESOURCE_CSV_HEADER.split(',');
    assert.ok(cols.includes('cpu_user_ms'), 'has cpu_user_ms');
    assert.ok(cols.includes('cpu_sys_ms'), 'has cpu_sys_ms');
    assert.ok(cols.includes('heap_used_kb'), 'has heap_used_kb');
    assert.ok(cols.includes('rss_kb'), 'has rss_kb');
    assert.ok(cols.includes('elapsed_ms'), 'has elapsed_ms');
  });

  it('resourceDeltaToCsvRow() produces comma-separated numbers', () => {
    const before = snapshot();
    const after = snapshot();
    const d = delta(before, after);
    const row = resourceDeltaToCsvRow(d);
    const parts = row.split(',');
    assert.strictEqual(parts.length, 7, `7 columns, got ${parts.length}: ${row}`);
    for (const p of parts) {
      assert.ok(!isNaN(Number(p)), `${p} is numeric`);
    }
  });
});
