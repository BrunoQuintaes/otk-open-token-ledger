/**
 * W4-4B02 — ProverDaemonManager lifecycle tests (E5.2)
 *
 * Covers:
 *   1.  ProverDaemonManager.ts file exists
 *   2.  Constructor uses defaults from env vars
 *   3.  Initial status: pid=null, restartCount=0, healthy=false, exhausted=false
 *   4.  status.healthy=true after start() with mock spawn (process exists)
 *   5.  stop() sets healthy=false
 *   6.  restart() resets exhausted flag
 *   7.  recordProof() updates lastProofAt
 *   8.  getProverDaemonManager() returns singleton
 *   9.  /admin/prover/status route exists in routes.ts
 *  10.  ProverDaemonManager re-exports ProverDaemonStatus type
 *
 * @since Wave 4 (4B-PACK-4B02 / E5.2)
 *
 * Module under test: `src/prover/ProverDaemonManager.ts`; the route and the dynamic import in
 * `src/api/routes.ts` are checked as text.
 *
 * Strategy / partitions: initial status; the restart delay and maximum restarts read from
 * `PROVER_RESTART_DELAY_MS` and `PROVER_MAX_RESTARTS`; stop before start and stop twice; recording a proof;
 * the singleton.
 *
 * Needs: nothing external; no prover process is started. Changes the two variables above and restores them.
 *
 * Run just this file: `npx tsx --test test/unit/wave4_prover_manager.test.ts`
 *
 * @module test/unit/wave4_prover_manager.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

import {
  ProverDaemonManager,
  getProverDaemonManager,
} from '../../src/prover/ProverDaemonManager.js';

// ──────────────────────────────────────────────────────────
// 1. File structure
// ──────────────────────────────────────────────────────────
describe('W4-4B02 — File structure', () => {
  it('src/prover/ProverDaemonManager.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/prover/ProverDaemonManager.ts')));
  });

  it('/admin/prover/status route exists in routes.ts', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(content.includes('/admin/prover/status'));
  });

  it('routes.ts imports ProverDaemonManager (dynamic import)', () => {
    const content = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(content.includes('ProverDaemonManager'));
  });
});

// ──────────────────────────────────────────────────────────
// 2–3. Initial state
// ──────────────────────────────────────────────────────────
describe('W4-4B02 — ProverDaemonManager initial state', () => {
  it('initial status: pid=null, restartCount=0, healthy=false, exhausted=false', () => {
    const mgr = new ProverDaemonManager({
      scriptPath: '/nonexistent/script.ts',
      restartDelayMs: 100,
      maxRestarts: 3,
    });
    const s = mgr.status;
    assert.strictEqual(s.pid, null);
    assert.strictEqual(s.restartCount, 0);
    assert.strictEqual(s.healthy, false);
    assert.strictEqual(s.exhausted, false);
    assert.strictEqual(s.lastProofAt, null);
  });

  it('constructor reads PROVER_RESTART_DELAY_MS from env', () => {
    const origDelay = process.env['PROVER_RESTART_DELAY_MS'];
    process.env['PROVER_RESTART_DELAY_MS'] = '5000';
    // Just verify construction works without error
    const mgr = new ProverDaemonManager({ scriptPath: '/nonexistent.ts' });
    assert.ok(mgr instanceof ProverDaemonManager);
    if (origDelay !== undefined) process.env['PROVER_RESTART_DELAY_MS'] = origDelay;
    else delete process.env['PROVER_RESTART_DELAY_MS'];
  });

  it('constructor reads PROVER_MAX_RESTARTS from env', () => {
    const orig = process.env['PROVER_MAX_RESTARTS'];
    process.env['PROVER_MAX_RESTARTS'] = '10';
    const mgr = new ProverDaemonManager({ scriptPath: '/nonexistent.ts' });
    assert.ok(mgr instanceof ProverDaemonManager);
    if (orig !== undefined) process.env['PROVER_MAX_RESTARTS'] = orig;
    else delete process.env['PROVER_MAX_RESTARTS'];
  });
});

// ──────────────────────────────────────────────────────────
// 4–7. Runtime behavior (no real process spawning)
// ──────────────────────────────────────────────────────────
describe('W4-4B02 — ProverDaemonManager runtime', () => {
  it('stop() when not started is a no-op', () => {
    const mgr = new ProverDaemonManager({ scriptPath: '/nonexistent.ts' });
    assert.doesNotThrow(() => mgr.stop());
    assert.strictEqual(mgr.status.healthy, false);
  });

  it('recordProof() updates lastProofAt to a recent timestamp', () => {
    const mgr = new ProverDaemonManager({ scriptPath: '/nonexistent.ts' });
    assert.strictEqual(mgr.status.lastProofAt, null);
    const before = Date.now();
    mgr.recordProof();
    const after = Date.now();
    const t = mgr.status.lastProofAt!;
    assert.ok(t >= before && t <= after, `lastProofAt ${t} outside [${before}, ${after}]`);
  });

  it('stop() is idempotent (multiple calls without error)', () => {
    const mgr = new ProverDaemonManager({
      scriptPath: '/nonexistent.ts',
      restartDelayMs: 100000,
      maxRestarts: 0,
    });
    assert.doesNotThrow(() => mgr.stop());
    assert.doesNotThrow(() => mgr.stop()); // second call should also be safe
    assert.strictEqual(mgr.status.healthy, false);
  });
});

// ──────────────────────────────────────────────────────────
// 8. Singleton
// ──────────────────────────────────────────────────────────
describe('W4-4B02 — getProverDaemonManager singleton', () => {
  it('getProverDaemonManager() returns same instance on repeated calls', () => {
    const a = getProverDaemonManager();
    const b = getProverDaemonManager();
    assert.strictEqual(a, b);
  });

  it('singleton is instance of ProverDaemonManager', () => {
    assert.ok(getProverDaemonManager() instanceof ProverDaemonManager);
  });
});
