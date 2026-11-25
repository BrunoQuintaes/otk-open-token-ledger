/**
 * Wave 2 Pack 17 — CrashRecoveryManager tests (S4.4)
 *
 * Tests:
 *   - Recovery with no log files (clean start)
 *   - Recovery with JSONL receipt log
 *   - TAL consistency check (pass and fail)
 *   - Chain head validation (pass and fail)
 *   - Auto-loop resume
 *   - Error collection
 *   - Recovery summary shape
 *
 * @since Wave 2 Pack 17 (2026-03-15)
 *
 * Module under test: `src/automation/CrashRecovery.ts` (`CrashRecoveryManager`), with every dependency passed in
 * as a stub (counts, chain head, log paths, auto-loop flag).
 *
 * Strategy / partitions: as listed above; empty log paths, a log with duplicate request ids, a missing log file,
 * a store count below the log count, a matching and a mismatching chain head, the auto-loop flag on and off.
 *
 * Needs: a temporary directory for the receipt log (files removed after each test); no network.
 *
 * Run just this file: `npx tsx --test test/unit/wave2_pack17_crash_recovery.test.ts`
 *
 * @module test/unit/wave2_pack17_crash_recovery.test
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CrashRecoveryManager } from '../../src/automation/CrashRecovery.js';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('S4.4 — CrashRecoveryManager (clean start)', () => {
  it('recover() with no logs returns clean summary', () => {
    const mgr = new CrashRecoveryManager({
      receiptLogPath: '',
      proofQueueLogPath: '',
      getReceiptCount: () => 0,
      getTalEntryCount: () => 0,
      getChainHead: () => '00'.repeat(32),
      persistedChainHead: '',
      autoLoopWasActive: false,
    });
    const summary = mgr.recover();
    assert.equal(summary.receiptsRestored, 0);
    assert.equal(summary.jobsRestored, 0);
    assert.equal(summary.talConsistent, true);
    assert.equal(summary.chainHeadValid, true);
    assert.equal(summary.autoLoopResumed, false);
    assert.equal(summary.errors.length, 0);
    assert.equal(typeof summary.recoveredAt, 'string');
    assert.equal(typeof summary.durationMs, 'number');
  });

  it('lastSummary is null before recover()', () => {
    const mgr = new CrashRecoveryManager({
      receiptLogPath: '',
      proofQueueLogPath: '',
      getReceiptCount: () => 0,
      getTalEntryCount: () => 0,
      getChainHead: () => '00'.repeat(32),
      persistedChainHead: '',
      autoLoopWasActive: false,
    });
    assert.equal(mgr.lastSummary, null);
  });

  it('lastSummary is set after recover()', () => {
    const mgr = new CrashRecoveryManager({
      receiptLogPath: '',
      proofQueueLogPath: '',
      getReceiptCount: () => 0,
      getTalEntryCount: () => 0,
      getChainHead: () => '00'.repeat(32),
      persistedChainHead: '',
      autoLoopWasActive: false,
    });
    mgr.recover();
    assert.ok(mgr.lastSummary !== null);
  });
});

describe('S4.4 — JSONL receipt log recovery', () => {
  let tmpDir: string;
  let receiptLog: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'otk-test-'));
    receiptLog = join(tmpDir, 'receipts.jsonl');
  });

  afterEach(() => {
    try { unlinkSync(receiptLog); } catch { /* ok */ }
  });

  it('counts unique receipts from JSONL log', () => {
    const lines = [
      JSON.stringify({ requestId: 'r1', provider: 'openai' }),
      JSON.stringify({ requestId: 'r2', provider: 'anthropic' }),
      JSON.stringify({ requestId: 'r1', provider: 'openai' }), // duplicate
    ].join('\n');
    writeFileSync(receiptLog, lines + '\n');

    const mgr = new CrashRecoveryManager({
      receiptLogPath: receiptLog,
      proofQueueLogPath: '',
      getReceiptCount: () => 2,
      getTalEntryCount: () => 2,
      getChainHead: () => '00'.repeat(32),
      persistedChainHead: '',
      autoLoopWasActive: false,
    });
    const summary = mgr.recover();
    assert.equal(summary.receiptsRestored, 2, 'should count 2 unique requestIds');
    assert.equal(summary.talConsistent, true);
  });

  it('handles missing receipt log gracefully', () => {
    const mgr = new CrashRecoveryManager({
      receiptLogPath: join(tmpDir, 'nonexistent.jsonl'),
      proofQueueLogPath: '',
      getReceiptCount: () => 0,
      getTalEntryCount: () => 0,
      getChainHead: () => '00'.repeat(32),
      persistedChainHead: '',
      autoLoopWasActive: false,
    });
    const summary = mgr.recover();
    assert.equal(summary.receiptsRestored, 0);
    assert.equal(summary.errors.length, 0);
  });
});

describe('S4.4 — TAL consistency check', () => {
  it('detects TAL inconsistency (store < log)', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'otk-test-'));
    const receiptLog = join(tmpDir, 'receipts.jsonl');
    const lines = [
      JSON.stringify({ requestId: 'r1' }),
      JSON.stringify({ requestId: 'r2' }),
      JSON.stringify({ requestId: 'r3' }),
    ].join('\n');
    writeFileSync(receiptLog, lines + '\n');

    const mgr = new CrashRecoveryManager({
      receiptLogPath: receiptLog,
      proofQueueLogPath: '',
      getReceiptCount: () => 1, // only 1 in store, but 3 in log
      getTalEntryCount: () => 1,
      getChainHead: () => '00'.repeat(32),
      persistedChainHead: '',
      autoLoopWasActive: false,
    });
    const summary = mgr.recover();
    assert.equal(summary.talConsistent, false);
    assert.ok(summary.errors.length > 0);
    assert.ok(summary.errors.some(e => e.includes('TAL inconsistency')));

    try { unlinkSync(receiptLog); } catch { /* ok */ }
  });
});

describe('S4.4 — Chain head validation', () => {
  it('validates chain head matches persisted', () => {
    const head = 'ab'.repeat(32);
    const mgr = new CrashRecoveryManager({
      receiptLogPath: '',
      proofQueueLogPath: '',
      getReceiptCount: () => 0,
      getTalEntryCount: () => 0,
      getChainHead: () => head,
      persistedChainHead: head,
      autoLoopWasActive: false,
    });
    const summary = mgr.recover();
    assert.equal(summary.chainHeadValid, true);
  });

  it('detects chain head mismatch', () => {
    const mgr = new CrashRecoveryManager({
      receiptLogPath: '',
      proofQueueLogPath: '',
      getReceiptCount: () => 0,
      getTalEntryCount: () => 0,
      getChainHead: () => 'aa'.repeat(32),
      persistedChainHead: 'bb'.repeat(32),
      autoLoopWasActive: false,
    });
    const summary = mgr.recover();
    assert.equal(summary.chainHeadValid, false);
    assert.ok(summary.errors.some(e => e.includes('Chain head mismatch')));
  });
});

describe('S4.4 — Auto-loop resume', () => {
  it('resumes auto-loop when flag is set', () => {
    let resumed = false;
    const mgr = new CrashRecoveryManager({
      receiptLogPath: '',
      proofQueueLogPath: '',
      getReceiptCount: () => 0,
      getTalEntryCount: () => 0,
      getChainHead: () => '00'.repeat(32),
      persistedChainHead: '',
      autoLoopWasActive: true,
      startAutoLoop: () => { resumed = true; },
    });
    const summary = mgr.recover();
    assert.equal(resumed, true);
    assert.equal(summary.autoLoopResumed, true);
  });

  it('does not resume auto-loop when flag is false', () => {
    let resumed = false;
    const mgr = new CrashRecoveryManager({
      receiptLogPath: '',
      proofQueueLogPath: '',
      getReceiptCount: () => 0,
      getTalEntryCount: () => 0,
      getChainHead: () => '00'.repeat(32),
      persistedChainHead: '',
      autoLoopWasActive: false,
      startAutoLoop: () => { resumed = true; },
    });
    const summary = mgr.recover();
    assert.equal(resumed, false);
    assert.equal(summary.autoLoopResumed, false);
  });
});
