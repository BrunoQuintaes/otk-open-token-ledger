/**
 * OTKSDK Unit Tests
 *
 * Tests for receipt construction and dual receipt binding validation.
 *
 * Modules under test: `src/sdk/OTKSDK.ts` (raw and dual receipt builders, binding validation,
 * the `OTKSDK` class, `defaultCostNormalizer`), with `deriveEpoch`/`deriveUsage` from
 * `src/types/receipt.ts` and the test signer from `src/metering/SignatureManager.ts`.
 *
 * Strategy / partitions: raw receipt from a fixed provider response with the default and a
 * custom cost normalizer; dual receipt with a signature; binding validation for a correct pair,
 * a mismatched epoch and a mismatched signature hash; the class increments its nonce per
 * receipt; the default normalizer with normal and zero token counts.
 *
 * Needs: nothing external (fixed timestamps, in-memory test signer, no network).
 *
 * Run just this file: `npx tsx --test test/unit/OTKSDK.test.ts`
 *
 * @module test/unit/OTKSDK.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  buildRawReceipt,
  buildDualReceipt,
  validateDualReceiptBinding,
  OTKSDK,
  defaultCostNormalizer,
  type ProviderResponse,
} from '../../src/sdk/OTKSDK.js';
import { createTestSigner } from '../../src/metering/SignatureManager.js';
import { deriveEpoch, deriveUsage } from '../../src/types/receipt.js';

describe('OTKSDK', () => {
  // Test fixture: sample provider response
  const sampleResponse: ProviderResponse = {
    provider: 'anthropic',
    model: 'claude-opus-4',
    inputTokens: 200,
    outputTokens: 100,
    latencyMs: 850,
    requestId: 'req_abc123',
    timestamp: 1700000000, // Unix seconds
    metadata: {
      sessionId: 'session_xyz',
      endpoint: '/v1/messages',
      tags: ['test', 'unit'],
    },
  };

  describe('buildRawReceipt', () => {
    it('should build raw receipt from provider response', () => {
      const userId = 999n;
      const nonce = 5n;

      const raw = buildRawReceipt(sampleResponse, userId, nonce);

      assert.strictEqual(raw.provider, 'anthropic', 'Provider should match');
      assert.strictEqual(raw.model, 'claude-opus-4', 'Model should match');
      assert.strictEqual(raw.inputTokens, 200, 'Input tokens should match');
      assert.strictEqual(raw.outputTokens, 100, 'Output tokens should match');
      assert.strictEqual(raw.latencyMs, 850, 'Latency should match');
      assert.strictEqual(raw.requestId, 'req_abc123', 'Request ID should match');
      assert.strictEqual(raw.timestamp, 1700000000, 'Timestamp should match');
      assert.strictEqual(raw.userId, 999n, 'User ID should match');
      assert.strictEqual(raw.nonce, 5n, 'Nonce should match');

      // Cost units: Anthropic (1.1) × Claude Opus 4 (2.0) × 300 tokens = 660 (exact, by hand).
      // S4 (D5-G04/N5, B HANDOFF §6): the receipt carries the exact CU; the public bucket (700)
      // belongs to the public layer only and no longer replaces the accounting value.
      assert.strictEqual(raw.costUnits, 660, 'Cost units are the exact server-side CU (no bucket)');

      // Metadata should be preserved
      assert.deepStrictEqual(raw.metadata, sampleResponse.metadata, 'Metadata should be preserved');
    });

    it('should use custom cost normalizer', () => {
      const customNormalizer = (
        _provider: string,
        _model: string,
        inputTokens: number,
        outputTokens: number
      ) => {
        // Example: weighted cost (input costs 2x output)
        return inputTokens * 2 + outputTokens;
      };

      const raw = buildRawReceipt(sampleResponse, 1n, 1n, customNormalizer);

      assert.strictEqual(raw.costUnits, 500, 'Cost units should use custom normalizer (200*2 + 100)');
    });
  });

  describe('buildDualReceipt', () => {
    it('should build dual receipt with signature', async () => {
      const signer = createTestSigner('test-signer-dual');
      const userId = 123n;
      const nonce = 10n;
      const maxUsage = 1000n;

      const dual = await buildDualReceipt(
        sampleResponse,
        userId,
        nonce,
        signer,
        maxUsage
      );

      // Check raw receipt
      assert.strictEqual(dual.raw.userId, 123n, 'Raw receipt should have correct userId');
      assert.strictEqual(dual.raw.nonce, 10n, 'Raw receipt should have correct nonce');

      // Check signature
      assert.ok(dual.signature.rawHash, 'Signature should have rawHash');
      assert.ok(dual.signature.r, 'Signature should have r');
      assert.ok(dual.signature.s, 'Signature should have s');
      assert.strictEqual(typeof dual.signature.v, 'number', 'Signature should have v');

      // Check ZK receipt (should have correct epoch and maxUsage)
      const expectedEpoch = deriveEpoch(sampleResponse.timestamp);
      assert.strictEqual(dual.zk.epoch, expectedEpoch, 'ZK epoch should be derived correctly');
      assert.strictEqual(dual.zk.maxUsage, 1000n, 'ZK maxUsage should match');

      // Commitment and proof are placeholder in MVP (not generated here)
      assert.strictEqual(dual.zk.commitment, 0n, 'Commitment is placeholder in MVP');
    });
  });

  describe('validateDualReceiptBinding', () => {
    it('should validate correct dual receipt binding', async () => {
      const signer = createTestSigner('test-validator');
      const dual = await buildDualReceipt(sampleResponse, 1n, 1n, signer, 1000n);

      const isValid = validateDualReceiptBinding(dual);
      assert.strictEqual(isValid, true, 'Valid dual receipt should pass binding check');
    });

    it('should reject dual receipt with mismatched epoch', async () => {
      const signer = createTestSigner('test-validator-2');
      const dual = await buildDualReceipt(sampleResponse, 1n, 1n, signer, 1000n);

      // Tamper with ZK epoch
      dual.zk.epoch = 999999n;

      const isValid = validateDualReceiptBinding(dual);
      assert.strictEqual(isValid, false, 'Mismatched epoch should fail binding check');
    });

    it('should reject dual receipt with mismatched signature hash', async () => {
      const signer = createTestSigner('test-validator-3');
      const dual = await buildDualReceipt(sampleResponse, 1n, 1n, signer, 1000n);

      // Tamper with signature hash
      dual.signature.rawHash = '0x' + '0'.repeat(64);

      const isValid = validateDualReceiptBinding(dual);
      assert.strictEqual(isValid, false, 'Mismatched signature hash should fail binding check');
    });
  });

  describe('OTKSDK class', () => {
    it('should build receipts with auto-incrementing nonce', async () => {
      const signer = createTestSigner('sdk-test-1');
      const sdk = new OTKSDK(42n, 0n, signer);

      assert.strictEqual(sdk.getCurrentNonce(), 0n, 'Initial nonce should be 0');
      assert.strictEqual(sdk.getUserId(), 42n, 'User ID should match');

      // Build first receipt
      const dual1 = await sdk.buildReceipt(sampleResponse, 1000n);
      assert.strictEqual(dual1.raw.nonce, 0n, 'First receipt should have nonce 0');
      assert.strictEqual(sdk.getCurrentNonce(), 1n, 'Nonce should increment after build');

      // Build second receipt
      const dual2 = await sdk.buildReceipt(sampleResponse, 1000n);
      assert.strictEqual(dual2.raw.nonce, 1n, 'Second receipt should have nonce 1');
      assert.strictEqual(sdk.getCurrentNonce(), 2n, 'Nonce should increment again');
    });

    it('should use custom cost normalizer', async () => {
      const signer = createTestSigner('sdk-test-2');
      const customNormalizer = (_p: string, _m: string, i: number, o: number) => i * 3 + o * 2;
      const sdk = new OTKSDK(1n, 0n, signer, customNormalizer);

      const dual = await sdk.buildReceipt(sampleResponse, 1000n);

      // sampleResponse: inputTokens=200, outputTokens=100
      // Expected: 200*3 + 100*2 = 800
      assert.strictEqual(dual.raw.costUnits, 800, 'Should use custom cost normalizer');
    });
  });

  describe('deriveEpoch and deriveUsage helpers', () => {
    it('should derive epoch correctly', () => {
      // EPOCH_WINDOW_SECONDS = 3600 (1 hour)
      const timestamp1 = 3600; // Epoch 1
      const timestamp2 = 7200; // Epoch 2
      const timestamp3 = 3599; // Epoch 0

      assert.strictEqual(deriveEpoch(timestamp1), 1n, 'Timestamp 3600 should be epoch 1');
      assert.strictEqual(deriveEpoch(timestamp2), 2n, 'Timestamp 7200 should be epoch 2');
      assert.strictEqual(deriveEpoch(timestamp3), 0n, 'Timestamp 3599 should be epoch 0');
    });

    it('should derive usage from raw receipt', () => {
      const raw = buildRawReceipt(sampleResponse, 1n, 1n);
      const usage = deriveUsage(raw);

      assert.strictEqual(usage, BigInt(raw.costUnits), 'Usage should equal costUnits (MVP mapping)');
    });
  });

  describe('defaultCostNormalizer', () => {
    it('should use enterprise weighted calculation', () => {
      // OpenAI (1.0) × GPT-4 (2.0) × 150 tokens = 300
      const cost = defaultCostNormalizer('openai', 'gpt-4', 100, 50);
      assert.strictEqual(cost, 300, 'Default normalizer should use enterprise weights');
    });

    it('should work with zero tokens', () => {
      const cost = defaultCostNormalizer('anthropic', 'claude-opus-4', 0, 0);
      assert.strictEqual(cost, 0, 'Default normalizer should handle zero tokens');
    });
  });
});
