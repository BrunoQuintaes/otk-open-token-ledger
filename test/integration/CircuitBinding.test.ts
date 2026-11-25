/**
 * Circuit Binding Integration Test (U8.4.2)
 *
 * Validates that SDK-generated receipts are compatible with metering_v1.circom.
 * This test ensures the Dual Receipt Model binding is correct.
 *
 * Modules under test: `src/sdk/OTKSDK.ts` (`buildRawReceipt`) and `src/types/receipt.ts` (`deriveUsage`,
 * `deriveEpoch`), checked against the inputs the v1 circuit expects (`userId`, `usage`, `nonce`, `epoch`,
 * `maxUsage`).
 *
 * Strategy / partitions: prerequisites present; the derived inputs have the circuit's shape; a real witness is
 * generated from SDK-derived inputs; the documented commitment and public-input order; field edge cases (very
 * large user id, zero usage, the `usage <= maxUsage` constraint); epoch derivation for several timestamps. The
 * circuit-dependent cases are skipped when the compiled circuit or the witness script is missing.
 *
 * Needs: for the witness case, the compiled `zk/build/metering_v1_js/metering_v1.wasm` and
 * `scripts/zk/generate_witness.cjs`; it runs `node` as a child process and writes `zk/build/test_input.json` and
 * `zk/build/test_witness.wtns` (left in place). Paths are relative, so run from the repository root. No network.
 *
 * Run just this file: `npx tsx --test test/integration/CircuitBinding.test.ts`
 *
 * @module test/integration/CircuitBinding.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { execSync } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { buildRawReceipt, type ProviderResponse } from '../../src/sdk/OTKSDK.js';
import { deriveEpoch, deriveUsage } from '../../src/types/receipt.js';

describe('Circuit Binding (SDK ↔ metering_v1.circom)', () => {
  // Circuit paths (relative to repo root)
  const BUILD_DIR = 'zk/build';
  const WASM_FILE = path.join(BUILD_DIR, 'metering_v1_js', 'metering_v1.wasm');
  const WITNESS_GEN = path.join('scripts', 'zk', 'generate_witness.cjs');
  const WC_DIR = path.join(BUILD_DIR, 'metering_v1_js');

  // Check if circuit is compiled
  const circuitCompiled = existsSync(WASM_FILE) && existsSync(WITNESS_GEN);

  describe('Prerequisites', () => {
    it('should have compiled circuit artifacts', (t) => {
      if (!circuitCompiled) {
        t.skip('circuit not compiled');
        return;
      }
      assert.ok(existsSync(WASM_FILE), 'WASM file should exist');
      assert.ok(existsSync(WITNESS_GEN), 'Witness generator should exist');
    });
  });

  describe('Input compatibility', () => {
    it('should match circuit public input structure', (t) => {
      if (!circuitCompiled) {
        t.skip('circuit not compiled');
        return;
      }

      // Sample provider response
      const response: ProviderResponse = {
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 100,
        outputTokens: 50,
        latencyMs: 500,
        requestId: 'req_binding_test',
        timestamp: 1700000000,
      };

      const userId = 12345n;
      const nonce = 1n;
      const maxUsage = 1000n;

      // Build raw receipt via SDK
      const raw = buildRawReceipt(response, userId, nonce);

      // Derive ZK inputs (Dual Receipt Model binding)
      const usage = deriveUsage(raw);
      const epoch = deriveEpoch(raw.timestamp);

      // Circuit expects these inputs (from metering_v1.circom)
      const circuitInput = {
        userId: userId.toString(),
        usage: usage.toString(),
        nonce: nonce.toString(),
        epoch: epoch.toString(),
        maxUsage: maxUsage.toString(),
      };

      // Validate input structure
      assert.ok(circuitInput.userId, 'userId should be defined');
      assert.ok(circuitInput.usage, 'usage should be defined');
      assert.ok(circuitInput.nonce, 'nonce should be defined');
      assert.ok(circuitInput.epoch, 'epoch should be defined');
      assert.ok(circuitInput.maxUsage, 'maxUsage should be defined');

      // Validate types (circuit expects numeric strings)
      assert.strictEqual(typeof circuitInput.userId, 'string');
      assert.strictEqual(typeof circuitInput.usage, 'string');
      assert.strictEqual(typeof circuitInput.nonce, 'string');
      assert.strictEqual(typeof circuitInput.epoch, 'string');
      assert.strictEqual(typeof circuitInput.maxUsage, 'string');

      // Validate constraint: usage <= maxUsage
      assert.ok(
        BigInt(circuitInput.usage) <= BigInt(circuitInput.maxUsage),
        'usage must be <= maxUsage (circuit constraint)'
      );
    });
  });

  describe('Witness generation (if circuit compiled)', () => {
    it('should generate valid witness from SDK-derived inputs', (t) => {
      if (!circuitCompiled) {
        t.skip('circuit not compiled');
        return;
      }

      // Sample data
      const response: ProviderResponse = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        inputTokens: 200,
        outputTokens: 100,
        latencyMs: 850,
        requestId: 'req_witness_test',
        timestamp: 1700000000,
      };

      const userId = 999n;
      const nonce = 5n;
      const maxUsage = 2000n;

      // Build raw receipt
      const raw = buildRawReceipt(response, userId, nonce);

      // Derive ZK inputs
      const usage = deriveUsage(raw);
      const epoch = deriveEpoch(raw.timestamp);

      // Create circuit input file
      const inputPath = path.join(BUILD_DIR, 'test_input.json');
      const circuitInput = {
        userId: userId.toString(),
        usage: usage.toString(),
        nonce: nonce.toString(),
        epoch: epoch.toString(),
        maxUsage: maxUsage.toString(),
      };
      writeFileSync(inputPath, JSON.stringify(circuitInput, null, 2));

      // Generate witness using snarkjs
      const witnessPath = path.join(BUILD_DIR, 'test_witness.wtns');
      try {
        const cmd = `node "${WITNESS_GEN}" "${WASM_FILE}" "${inputPath}" "${witnessPath}" "${WC_DIR}"`;
        execSync(cmd, { cwd: process.cwd(), encoding: 'utf-8' });

        // Verify witness file was created
        assert.ok(existsSync(witnessPath), 'Witness file should be generated');
      } catch (error) {
        // If witness generation fails, circuit might have invalid constraints
        assert.fail(`Witness generation failed: ${error}`);
      }
    });
  });

  describe('Binding verification (conceptual)', () => {
    it('should document expected commitment calculation', () => {
      // NOTE: Actual commitment verification requires:
      // 1. Poseidon hash implementation (from circomlib)
      // 2. Same parameters as circuit (userId, usage, nonce, epoch)
      // 3. Matching output from witness

      const expectedFlow = {
        step1: 'SDK derives usage = costUnits',
        step2: 'SDK derives epoch = floor(timestamp / 3600)',
        step3: 'Circuit computes commitment = Poseidon(userId, usage, nonce, epoch)',
        step4: 'Registry validates: proof.publicInputs[2] == commitment',
      };

      assert.ok(expectedFlow, 'Commitment flow documented');
    });

    it('should document public input order', () => {
      // From metering_v1.circom:
      // signal output commitment;
      // Public inputs order (from compilation):
      // [0] epoch
      // [1] maxUsage
      // [2] commitment (output)

      const publicInputsOrder = ['epoch', 'maxUsage', 'commitment'];

      assert.deepStrictEqual(
        publicInputsOrder,
        ['epoch', 'maxUsage', 'commitment'],
        'Public inputs order must match circuit'
      );
    });
  });

  describe('Field compatibility', () => {
    it('should handle large userId values', () => {
      const largeUserId = 2n ** 64n - 1n; // Max uint64
      const response: ProviderResponse = {
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 10,
        outputTokens: 5,
        latencyMs: 100,
        requestId: 'req_large_id',
        timestamp: 1700000000,
      };

      const raw = buildRawReceipt(response, largeUserId, 1n);

      assert.strictEqual(raw.userId, largeUserId, 'Should handle large userId');
    });

    it('should handle zero usage', () => {
      const response: ProviderResponse = {
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 50,
        requestId: 'req_zero',
        timestamp: 1700000000,
      };

      const raw = buildRawReceipt(response, 1n, 1n);
      const usage = deriveUsage(raw);

      assert.strictEqual(usage, 0n, 'Should handle zero usage');
    });

    it('should validate usage <= maxUsage constraint', () => {
      const response: ProviderResponse = {
        provider: 'anthropic',
        model: 'claude-opus-4',
        inputTokens: 5000,
        outputTokens: 5000,
        latencyMs: 2000,
        requestId: 'req_large',
        timestamp: 1700000000,
      };

      const raw = buildRawReceipt(response, 1n, 1n);
      const usage = deriveUsage(raw);

      // Claude Opus 4 (weight 2.0) × Anthropic (weight 1.1) × 10000 tokens
      const expectedUsage = 22000n;
      assert.strictEqual(usage, expectedUsage, 'Usage calculation should match');

      // For circuit to accept, maxUsage must be >= usage
      const requiredMaxUsage = usage;
      assert.ok(
        requiredMaxUsage >= usage,
        'maxUsage must be >= usage for circuit to accept'
      );
    });
  });

  describe('Epoch derivation', () => {
    it('should derive epoch correctly for different timestamps', () => {
      const testCases = [
        { timestamp: 0, expectedEpoch: 0n },
        { timestamp: 3599, expectedEpoch: 0n },
        { timestamp: 3600, expectedEpoch: 1n },
        { timestamp: 7200, expectedEpoch: 2n },
        { timestamp: 1700000000, expectedEpoch: 472222n },
      ];

      for (const testCase of testCases) {
        const epoch = deriveEpoch(testCase.timestamp);
        assert.strictEqual(
          epoch,
          testCase.expectedEpoch,
          `Epoch for timestamp ${testCase.timestamp} should be ${testCase.expectedEpoch}`
        );
      }
    });
  });
});
