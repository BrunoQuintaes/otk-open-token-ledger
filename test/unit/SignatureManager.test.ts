/**
 * SignatureManager Unit Tests
 *
 * Tests for ECDSA signing and verification of raw receipts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  canonicalHash,
  sign,
  verify,
  createTestSigner,
} from '../../src/metering/SignatureManager.js';
import type { RawReceipt } from '../../src/types/receipt.js';

describe('SignatureManager', () => {
  // Test fixture: sample raw receipt
  const sampleReceipt: RawReceipt = {
    provider: 'openai',
    model: 'gpt-4',
    inputTokens: 100,
    outputTokens: 50,
    costUnits: 150,
    latencyMs: 1234,
    timestamp: 1700000000,
    requestId: 'req_test_001',
    userId: 12345n,
    nonce: 1n,
  };

  describe('canonicalHash', () => {
    it('should produce deterministic hash for same input', () => {
      const hash1 = canonicalHash(sampleReceipt);
      const hash2 = canonicalHash(sampleReceipt);

      assert.strictEqual(hash1, hash2, 'Hash should be deterministic');
      assert.match(hash1, /^0x[0-9a-f]{64}$/i, 'Hash should be 32-byte hex');
    });

    it('should produce different hash for different inputs', () => {
      const receipt2 = { ...sampleReceipt, nonce: 2n };

      const hash1 = canonicalHash(sampleReceipt);
      const hash2 = canonicalHash(receipt2);

      assert.notStrictEqual(hash1, hash2, 'Different receipts should have different hashes');
    });

    it('should be sensitive to field order independence', () => {
      // Internal implementation uses alphabetical order, so field order in object shouldn't matter
      const receipt1: RawReceipt = {
        provider: 'test',
        model: 'm1',
        inputTokens: 10,
        outputTokens: 20,
        costUnits: 30,
        latencyMs: 100,
        timestamp: 1000,
        requestId: 'r1',
        userId: 1n,
        nonce: 1n,
      };

      const receipt2: RawReceipt = {
        nonce: 1n,
        userId: 1n,
        requestId: 'r1',
        timestamp: 1000,
        latencyMs: 100,
        costUnits: 30,
        outputTokens: 20,
        inputTokens: 10,
        model: 'm1',
        provider: 'test',
      };

      const hash1 = canonicalHash(receipt1);
      const hash2 = canonicalHash(receipt2);

      assert.strictEqual(hash1, hash2, 'Hash should be independent of object field order');
    });
  });

  describe('sign and verify', () => {
    it('should sign and verify a receipt correctly', async () => {
      const signer = createTestSigner('test-seed-001');

      const signature = await sign(sampleReceipt, signer);

      // Verify signature
      const isValid = verify(sampleReceipt, signature);
      assert.strictEqual(isValid, true, 'Signature should be valid');

      // Verify with expected signer
      const signerAddress = await signer.getAddress();
      const isValidWithSigner = verify(sampleReceipt, signature, signerAddress);
      assert.strictEqual(isValidWithSigner, true, 'Signature should match expected signer');
    });

    it('should reject invalid signature', async () => {
      const signer = createTestSigner('test-seed-002');
      const signature = await sign(sampleReceipt, signer);

      // Tamper with receipt
      const tamperedReceipt = { ...sampleReceipt, costUnits: 999 };

      const isValid = verify(tamperedReceipt, signature);
      assert.strictEqual(isValid, false, 'Tampered receipt should fail verification');
    });

    it('should reject signature from wrong signer', async () => {
      const signer1 = createTestSigner('signer-1');
      const signer2 = createTestSigner('signer-2');

      const signature = await sign(sampleReceipt, signer1);
      const signer2Address = await signer2.getAddress();

      const isValid = verify(sampleReceipt, signature, signer2Address);
      assert.strictEqual(isValid, false, 'Signature from wrong signer should fail');
    });

    it('should have correct signature components', async () => {
      const signer = createTestSigner('test-seed-003');
      const signature = await sign(sampleReceipt, signer);

      // Check signature structure
      assert.ok(signature.rawHash, 'Signature should have rawHash');
      assert.match(signature.rawHash, /^0x[0-9a-f]{64}$/i, 'rawHash should be 32-byte hex');

      assert.ok(signature.r, 'Signature should have r component');
      assert.match(signature.r, /^0x[0-9a-f]{64}$/i, 'r should be 32-byte hex');

      assert.ok(signature.s, 'Signature should have s component');
      assert.match(signature.s, /^0x[0-9a-f]{64}$/i, 's should be 32-byte hex');

      assert.ok(typeof signature.v === 'number', 'v should be a number');

      assert.ok(signature.signer, 'Signature should have signer address');
      assert.match(signature.signer, /^0x[0-9a-f]{40}$/i, 'Signer should be Ethereum address');
    });
  });

  describe('createTestSigner', () => {
    it('should create deterministic signer from seed', () => {
      const signer1a = createTestSigner('seed-alpha');
      const signer1b = createTestSigner('seed-alpha');

      assert.strictEqual(
        signer1a.privateKey,
        signer1b.privateKey,
        'Same seed should produce same private key'
      );
    });

    it('should create different signers from different seeds', () => {
      const signer1 = createTestSigner('seed-1');
      const signer2 = createTestSigner('seed-2');

      assert.notStrictEqual(
        signer1.privateKey,
        signer2.privateKey,
        'Different seeds should produce different private keys'
      );
    });
  });
});
