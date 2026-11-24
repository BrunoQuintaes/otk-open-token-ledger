/**
 * CanonicalReceiptV1 Determinism Tests (U2.2)
 *
 * Golden-vector tests: same input → same bytes → same hash across all runs.
 * Vectors frozen in test/receipt/vectors/receipt_v1_vectors.json.
 *
 * Runs via: npm test (tsx --test)
 * CI: Node 24 / ubuntu-latest (see .github/workflows/ci.yml)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  encodeCanonicalReceiptV1Bytes,
  hashCanonicalReceiptV1,
  RECEIPT_DOMAIN_V1,
  FIELD_SEPARATOR,
  type CanonicalReceiptV1,
} from '../../src/receipt/canonicalReceiptV1.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadVectors(): any[] {
  const p = join(__dirname, 'vectors', 'receipt_v1_vectors.json');
  return JSON.parse(readFileSync(p, 'utf8'));
}

function toBigint(r: any): CanonicalReceiptV1 {
  return {
    ...r,
    input_tokens:  BigInt(r.input_tokens),
    output_tokens: BigInt(r.output_tokens),
    total_tokens:  BigInt(r.total_tokens),
    latency_ms:    BigInt(r.latency_ms),
    cost_unit:     BigInt(r.cost_unit),
    timestamp:     BigInt(r.timestamp),
    nonce:         BigInt(r.nonce),
    epoch:         BigInt(r.epoch),
  };
}

function bytesToHex(u8: Uint8Array): string {
  return '0x' + Array.from(u8).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CanonicalReceiptV1 determinism (U2.2)', () => {

  // =========================================================================
  // 1. Golden vectors — hash + bytes_length frozen
  // =========================================================================
  describe('Golden vectors', () => {
    const vectors = loadVectors();

    for (const v of vectors) {
      it(`${v.name}: hash matches frozen expected_hash`, () => {
        const receipt = toBigint(v.receipt);
        const hash = hashCanonicalReceiptV1(receipt);
        assert.strictEqual(
          hash,
          v.expected_hash,
          `Hash mismatch for ${v.name}.\n  got:      ${hash}\n  expected: ${v.expected_hash}`
        );
      });

      it(`${v.name}: bytes_length matches frozen expected_bytes_length`, () => {
        const receipt = toBigint(v.receipt);
        const bytes = encodeCanonicalReceiptV1Bytes(receipt);
        assert.strictEqual(
          bytes.length,
          v.expected_bytes_length,
          `Bytes length mismatch for ${v.name}: got ${bytes.length}, expected ${v.expected_bytes_length}`
        );
      });
    }
  });

  // =========================================================================
  // 2. Determinism — same input, 100 iterations, identical output
  // =========================================================================
  describe('Determinism (100 iterations)', () => {
    it('hash is stable across 100 calls with same input', () => {
      const receipt = toBigint(loadVectors()[0].receipt);
      const first = hashCanonicalReceiptV1(receipt);
      for (let i = 0; i < 100; i++) {
        assert.strictEqual(
          hashCanonicalReceiptV1(receipt),
          first,
          `Diverged at iteration ${i}`
        );
      }
    });

    it('bytes are stable across 100 calls with same input', () => {
      const receipt = toBigint(loadVectors()[0].receipt);
      const first = bytesToHex(encodeCanonicalReceiptV1Bytes(receipt));
      for (let i = 0; i < 100; i++) {
        assert.strictEqual(
          bytesToHex(encodeCanonicalReceiptV1Bytes(receipt)),
          first,
          `Bytes diverged at iteration ${i}`
        );
      }
    });
  });

  // =========================================================================
  // 3. Encoding structure invariants
  // =========================================================================
  describe('Encoding structure', () => {
    it('bytes start with DOMAIN (OTK_RECEIPT_V1)', () => {
      const receipt = toBigint(loadVectors()[0].receipt);
      const bytes = encodeCanonicalReceiptV1Bytes(receipt);
      const domainBytes = Buffer.from(RECEIPT_DOMAIN_V1, 'utf8');
      for (let i = 0; i < domainBytes.length; i++) {
        assert.strictEqual(bytes[i], domainBytes[i], `Domain byte mismatch at position ${i}`);
      }
      // byte after domain is separator
      assert.strictEqual(bytes[domainBytes.length], FIELD_SEPARATOR, 'First separator missing after domain');
    });

    it('hash is 0x-prefixed 32-byte hex (66 chars)', () => {
      const receipt = toBigint(loadVectors()[0].receipt);
      const hash = hashCanonicalReceiptV1(receipt);
      assert.ok(hash.startsWith('0x'), 'hash must start with 0x');
      assert.strictEqual(hash.length, 66, `hash must be 66 chars, got ${hash.length}`);
    });

    it('different receipts produce different hashes', () => {
      const vectors = loadVectors();
      const h1 = vectors[0].expected_hash;
      const h2 = vectors[1].expected_hash;
      const h3 = vectors[2].expected_hash;
      assert.notStrictEqual(h1, h2);
      assert.notStrictEqual(h1, h3);
      assert.notStrictEqual(h2, h3);
    });
  });

  // =========================================================================
  // 4. Validation errors
  // =========================================================================
  describe('Validation errors', () => {
    it('throws on empty provider', () => {
      assert.throws(() => {
        hashCanonicalReceiptV1({
          provider: '', model: 'gpt-4o', input_tokens: 0n, output_tokens: 0n,
          total_tokens: 0n, latency_ms: 0n, cost_unit: 0n,
          user_id: 'u1', project_id: 'p1', timestamp: 1n, nonce: 0n, epoch: 0n,
        });
      }, /provider.*must be non-empty/i);
    });

    it('throws on total_tokens mismatch', () => {
      assert.throws(() => {
        hashCanonicalReceiptV1({
          provider: 'openai', model: 'gpt-4o',
          input_tokens: 10n, output_tokens: 5n, total_tokens: 999n, // wrong
          latency_ms: 100n, cost_unit: 15n,
          user_id: 'u1', project_id: 'p1', timestamp: 1n, nonce: 0n, epoch: 0n,
        });
      }, /total_tokens/i);
    });

    it('throws on negative bigint', () => {
      assert.throws(() => {
        hashCanonicalReceiptV1({
          provider: 'openai', model: 'gpt-4o',
          input_tokens: -1n, output_tokens: 5n, total_tokens: 4n,
          latency_ms: 100n, cost_unit: 4n,
          user_id: 'u1', project_id: 'p1', timestamp: 1n, nonce: 0n, epoch: 0n,
        });
      }, /non-negative/i);
    });
  });
});
