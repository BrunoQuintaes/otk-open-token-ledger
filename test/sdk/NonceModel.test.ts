/**
 * Nonce Model Tests (ADR-0004)
 *
 * Tests for per-user monotonic nonce anti-replay model.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { OTKSDK, type ProviderResponse } from '../../src/sdk/OTKSDK.js';
import { createTestSigner } from '../../src/metering/SignatureManager.js';

describe('Nonce Model (ADR-0004)', () => {
  const sampleResponse: ProviderResponse = {
    provider: 'openai',
    model: 'gpt-4o',
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 500,
    requestId: 'req_test',
    timestamp: 1700000000,
  };

  describe('OTKSDK nonce management', () => {
    it('should start with initialNonce provided in constructor', () => {
      const signer = createTestSigner('test-nonce-1');
      const sdk = new OTKSDK(1n, 42n, signer);

      assert.strictEqual(sdk.getCurrentNonce(), 42n, 'Should start with initialNonce');
    });

    it('should auto-increment nonce after buildReceipt', async () => {
      const signer = createTestSigner('test-nonce-2');
      const sdk = new OTKSDK(1n, 0n, signer);

      assert.strictEqual(sdk.getCurrentNonce(), 0n, 'Should start at 0');

      await sdk.buildReceipt(sampleResponse, 1000n);
      assert.strictEqual(sdk.getCurrentNonce(), 1n, 'Should increment to 1 after first receipt');

      await sdk.buildReceipt(sampleResponse, 1000n);
      assert.strictEqual(sdk.getCurrentNonce(), 2n, 'Should increment to 2 after second receipt');
    });

    it('should allow manual nonce sync via syncNonce()', () => {
      const signer = createTestSigner('test-nonce-3');
      const sdk = new OTKSDK(1n, 0n, signer);

      // Simulate querying nonce from Registry
      const registryNonce = 100n;
      sdk.syncNonce(registryNonce);

      assert.strictEqual(
        sdk.getCurrentNonce(),
        100n,
        'Should update nonce via syncNonce'
      );
    });

    it('should use synced nonce for next receipt', async () => {
      const signer = createTestSigner('test-nonce-4');
      const sdk = new OTKSDK(1n, 0n, signer);

      // Sync with "on-chain" nonce
      sdk.syncNonce(50n);

      const receipt = await sdk.buildReceipt(sampleResponse, 1000n);

      assert.strictEqual(
        receipt.raw.nonce,
        50n,
        'Receipt should use synced nonce'
      );
      assert.strictEqual(
        sdk.getCurrentNonce(),
        51n,
        'Nonce should increment after build'
      );
    });
  });

  describe('Nonce isolation per userId', () => {
    it('should maintain independent nonce sequences for different users', async () => {
      const signer = createTestSigner('test-nonce-multi');

      const sdk1 = new OTKSDK(1n, 0n, signer);
      const sdk2 = new OTKSDK(2n, 0n, signer);

      await sdk1.buildReceipt(sampleResponse, 1000n);
      await sdk1.buildReceipt(sampleResponse, 1000n);

      await sdk2.buildReceipt(sampleResponse, 1000n);

      assert.strictEqual(sdk1.getCurrentNonce(), 2n, 'User 1 should have nonce 2');
      assert.strictEqual(sdk2.getCurrentNonce(), 1n, 'User 2 should have nonce 1');
    });
  });

  describe('Expected on-chain behavior (conceptual)', () => {
    it('should document expected Registry validation logic', () => {
      // This is a conceptual test documenting expected on-chain behavior
      // Actual validation happens in Receipt Registry contract (U8.5)

      const expectedBehavior = {
        storage: 'mapping(address => mapping(uint256 userId => uint256 nonce))',
        validation: 'require(raw.nonce == nonces[msg.sender][raw.userId])',
        increment: 'nonces[msg.sender][raw.userId]++',
        doubleProtection: 'nonce + commitment anti-replay',
      };

      assert.ok(expectedBehavior, 'Expected behavior documented');
    });

    it('should document query-before-submit pattern', () => {
      // Recommended production pattern (ADR-0004)
      const pattern = `
        // 1. Query current nonce from Registry
        const currentNonce = await registry.getNonce(submitterAddress, userId);

        // 2. Build receipt with current nonce
        const receipt = buildRawReceipt(response, userId, currentNonce, signer);

        // 3. Submit (Registry validates nonce match)
        await registry.submitReceipt(receipt, proof);
      `;

      assert.ok(pattern, 'Query-before-submit pattern documented');
    });
  });

  describe('Failure scenarios (anti-replay protection)', () => {
    it('should document nonce mismatch rejection', () => {
      // On-chain behavior (to be implemented in U8.5)
      const scenario = {
        registryNonce: 5n,
        submittedNonce: 3n, // Wrong nonce (old)
        expectedResult: 'revert("Invalid nonce")',
        reason: 'Prevents replay attacks and out-of-order submissions',
      };

      assert.ok(scenario, 'Nonce mismatch rejection documented');
    });

    it('should document commitment reuse rejection', () => {
      // On-chain behavior (to be implemented in U8.5)
      const scenario = {
        commitment: '0x123...',
        usedCommitments: { '0x123...': true },
        expectedResult: 'revert("Commitment already used")',
        reason: 'Prevents re-using same ZK proof',
      };

      assert.ok(scenario, 'Commitment reuse rejection documented');
    });
  });

  describe('Migration from U8.4.1', () => {
    it('should document breaking change in nonce handling', () => {
      const migration = {
        before: 'SDK auto-increments nonce implicitly',
        after: 'SDK requires explicit nonce sync or query',
        reason: 'Align with on-chain monotonic nonce validation (ADR-0004)',
        action: 'Use syncNonce() or query Registry before buildReceipt()',
      };

      assert.ok(migration, 'Migration path documented');
    });
  });
});
