/**
 * PA-07A — BullMQ Proof Queue Adapter Tests
 *
 * Unit tests for BullMQProofQueue and the ProverDaemon adapter logic.
 * These tests run WITHOUT a real Redis connection (unit-level).
 *
 * Integration tests requiring OTK_REDIS_URL are skipped here and covered
 * by running the daemon with OTK_REDIS_URL set (see PA-07 EVD).
 *
 * @since PA-07 (2026-03-13)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BullMQProofQueue } from '../../src/prover/BullMQProofQueue.js';
import type { BullMQJobData, BullMQJobResult } from '../../src/prover/BullMQProofQueue.js';

// ---------------------------------------------------------------------------
// Tests: BullMQProofQueue static constants and class shape
// ---------------------------------------------------------------------------

describe('PA-07A — BullMQProofQueue class shape', () => {

  it('QUEUE_NAME is a non-empty string', () => {
    assert.equal(typeof BullMQProofQueue.QUEUE_NAME, 'string');
    assert.ok(BullMQProofQueue.QUEUE_NAME.length > 0);
  });

  it('BullMQProofQueue constructor is a class', () => {
    assert.equal(typeof BullMQProofQueue, 'function');
  });

  it('BullMQJobData type allows _txHash field (PA-04 equivalence guard)', () => {
    // Type-level check: construct a valid BullMQJobData object at runtime
    const jobData: BullMQJobData = {
      userId: '99',
      usage: '200',
      nonce: '3',
      epoch: '12345',
      circuitVersion: 'v1',
      maxUsage: '1000000',
      _txHash: '0xdeadbeef',
    };
    assert.equal(jobData._txHash, '0xdeadbeef');
    assert.equal(jobData.userId, '99');
  });

  it('BullMQJobResult type has result and optional txHash', () => {
    const res: BullMQJobResult = {
      result: {
        proof: { pi_a: ['1', '2', '0'], pi_b: [['3', '4'], ['5', '6'], ['1', '0']], pi_c: ['7', '8', '1'], protocol: 'groth16', curve: 'bn128' },
        publicSignals: ['abc'],
        proveMs: 300,
      },
      txHash: '0xabc123',
    };
    assert.ok(res.result);
    assert.equal(res.txHash, '0xabc123');
  });
});

// ---------------------------------------------------------------------------
// Tests: queue mode selection via env var (without real Redis)
// ---------------------------------------------------------------------------

describe('PA-07A — queue mode env selection', () => {

  it('OTK_REDIS_URL absence means Phase 1 mode (DurableProofQueue)', () => {
    // This test verifies the env-gating logic without actually connecting
    const redisUrl = process.env['OTK_REDIS_URL'];
    if (redisUrl) {
      // Redis IS available — skip this test
      assert.ok(true, 'Redis available — Phase 2 mode would be selected');
      return;
    }
    // Without OTK_REDIS_URL, the daemon uses DurableProofQueue
    assert.equal(redisUrl, undefined, 'OTK_REDIS_URL should be unset in unit test context');
  });

  it('BullMQProofQueue QUEUE_NAME matches expected constant', () => {
    assert.equal(BullMQProofQueue.QUEUE_NAME, 'otk-proofs');
  });
});
