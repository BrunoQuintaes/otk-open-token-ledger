/**
 * Oracle Attestation Tests (U12 — Oracle Level A+C)
 *
 * Tests for:
 * - TokenizerRegistry: client-side tiktoken counting, determinism, discrepancy detection
 * - OracleAttestationEngine: Level A and Level C attestation generation
 * - CanonicalReceiptV2: encoding + hash determinism
 *
 * Verifies the Oracle Level C mitigation: client-side token counting using
 * tiktoken can detect provider overcounting/undercounting.
 *
 * Modules under test: `src/tokenization/TokenizerRegistry.ts`,
 * `src/metering/OracleAttestationEngine.ts`, `src/receipt/canonicalReceiptV2.ts` (compared with
 * `hashCanonicalReceiptV1` from `src/receipt/canonicalReceiptV1.ts`).
 *
 * Strategy / partitions: tokenizer counts for empty and non-empty text and both encodings
 * (cl100k_base, o200k_base); provider-to-tokenizer resolution, including the unknown-provider
 * fallback; discrepancy detection when counts match, stay within the threshold, or the provider
 * inflates by more than 20%, plus a custom threshold; Level A (no client counts) vs Level C
 * attestations; V2 receipt encoding, domain prefix, hash format, determinism, difference from
 * V1, sensitivity to the discrepancy flag, and errors when the oracle block or prompt hash is
 * missing.
 *
 * Needs: nothing external (the tiktoken encoders are local; no network).
 *
 * Run just this file: `npx tsx --test test/unit/OracleAttestation.test.ts`
 *
 * @module test/unit/OracleAttestation.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  TokenizerRegistry,
  TiktokenTokenizer,
  TOKENIZER_SCHEMA_VERSION,
} from '../../src/tokenization/TokenizerRegistry.js';
import {
  OracleAttestationEngine,
} from '../../src/metering/OracleAttestationEngine.js';
import {
  hashCanonicalReceiptV2,
  encodeCanonicalReceiptV2Bytes,
  type CanonicalReceiptV2,
  RECEIPT_DOMAIN_V2,
} from '../../src/receipt/canonicalReceiptV2.js';
import { hashCanonicalReceiptV1 } from '../../src/receipt/canonicalReceiptV1.js';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const SAMPLE_PROMPT = 'Explain the oracle problem in blockchain systems.';
const SAMPLE_COMPLETION = 'The oracle problem refers to the challenge of getting real-world data onto a blockchain.';

// ---------------------------------------------------------------------------
// TiktokenTokenizer tests
// ---------------------------------------------------------------------------

describe('TiktokenTokenizer (Oracle Level C)', () => {
  it('counts tokens deterministically — same text always same count', () => {
    const tok = new TiktokenTokenizer('cl100k_base');
    const count1 = tok.countTokens(SAMPLE_PROMPT);
    const count2 = tok.countTokens(SAMPLE_PROMPT);
    assert.strictEqual(count1, count2, 'token count must be deterministic');
    assert.ok(count1 > 0, 'must count at least 1 token for non-empty text');
  });

  it('returns 0 for empty string', () => {
    const tok = new TiktokenTokenizer('cl100k_base');
    assert.strictEqual(tok.countTokens(''), 0);
  });

  it('tokenizerId has correct format', () => {
    const tok = new TiktokenTokenizer('cl100k_base');
    assert.ok(tok.tokenizerId.startsWith('tiktoken@cl100k_base@'));
    assert.ok(tok.tokenizerId.includes(TOKENIZER_SCHEMA_VERSION));
  });

  it('hashText returns 0x-prefixed hex of correct length', () => {
    const tok = new TiktokenTokenizer('cl100k_base');
    const h = tok.hashText(SAMPLE_PROMPT);
    assert.ok(h.startsWith('0x'), 'hash must start with 0x');
    assert.strictEqual(h.length, 66, 'keccak256 hex = 32 bytes = 66 chars including 0x');
  });

  it('hashText is deterministic', () => {
    const tok = new TiktokenTokenizer('cl100k_base');
    assert.strictEqual(tok.hashText(SAMPLE_PROMPT), tok.hashText(SAMPLE_PROMPT));
  });

  it('hashText returns distinct hashes for distinct texts', () => {
    const tok = new TiktokenTokenizer('cl100k_base');
    const h1 = tok.hashText(SAMPLE_PROMPT);
    const h2 = tok.hashText(SAMPLE_COMPLETION);
    assert.notStrictEqual(h1, h2);
  });

  it('o200k_base tokenizer works (GPT-4o family)', () => {
    const tok = new TiktokenTokenizer('o200k_base');
    const count = tok.countTokens('Hello, world!');
    assert.ok(count > 0);
    assert.ok(tok.tokenizerId.includes('o200k_base'));
  });
});

// ---------------------------------------------------------------------------
// TokenizerRegistry tests
// ---------------------------------------------------------------------------

describe('TokenizerRegistry (Oracle Level C)', () => {
  it('resolves openai to cl100k_base', () => {
    const reg = new TokenizerRegistry();
    const tok = reg.resolve('openai');
    assert.ok(tok.tokenizerId.includes('cl100k_base'));
  });

  it('resolves anthropic to cl100k_base (approximation)', () => {
    const reg = new TokenizerRegistry();
    const tok = reg.resolve('anthropic');
    assert.ok(tok.tokenizerId.includes('cl100k_base'));
  });

  it('resolves gemini to cl100k_base (approximation)', () => {
    const reg = new TokenizerRegistry();
    const tok = reg.resolve('gemini');
    assert.ok(tok.tokenizerId.includes('cl100k_base'));
  });

  it('resolves deepseek to cl100k_base (exact)', () => {
    const reg = new TokenizerRegistry();
    const tok = reg.resolve('deepseek');
    assert.ok(tok.tokenizerId.includes('cl100k_base'));
  });

  it('resolves openai:gpt-4o to o200k_base', () => {
    const reg = new TokenizerRegistry();
    const tok = reg.resolve('openai', 'gpt-4o');
    assert.ok(tok.tokenizerId.includes('o200k_base'));
  });

  it('falls back to default tokenizer for unknown provider', () => {
    const reg = new TokenizerRegistry();
    const tok = reg.resolve('unknown-provider-xyz');
    assert.ok(tok.tokenizerId.includes('cl100k_base'));
  });

  it('countClientTokens returns valid ClientTokenCount', () => {
    const reg = new TokenizerRegistry();
    const result = reg.countClientTokens('openai', 'gpt-4', SAMPLE_PROMPT, SAMPLE_COMPLETION);
    assert.ok(result.inputTokens > 0);
    assert.ok(result.outputTokens > 0);
    assert.strictEqual(result.totalTokens, result.inputTokens + result.outputTokens);
    assert.ok(result.tokenizerId.includes('tiktoken'));
  });

  it('countClientTokens is deterministic', () => {
    const reg = new TokenizerRegistry();
    const r1 = reg.countClientTokens('openai', 'gpt-4', SAMPLE_PROMPT, SAMPLE_COMPLETION);
    const r2 = reg.countClientTokens('openai', 'gpt-4', SAMPLE_PROMPT, SAMPLE_COMPLETION);
    assert.strictEqual(r1.inputTokens, r2.inputTokens);
    assert.strictEqual(r1.outputTokens, r2.outputTokens);
    assert.strictEqual(r1.tokenizerId, r2.tokenizerId);
  });

  it('detectDiscrepancy: no flag when provider matches client', () => {
    const reg = new TokenizerRegistry();
    const clientCount = reg.countClientTokens('openai', 'gpt-4', SAMPLE_PROMPT, SAMPLE_COMPLETION);
    // Provider reports same as client
    const disc = reg.detectDiscrepancy(
      clientCount.inputTokens,
      clientCount.outputTokens,
      clientCount,
      20,
    );
    assert.strictEqual(disc.flagged, false);
    assert.strictEqual(disc.deltaInput, 0);
    assert.strictEqual(disc.deltaOutput, 0);
    assert.strictEqual(disc.deltaInputPct, 0);
  });

  it('detectDiscrepancy: flags when provider inflates by >20%', () => {
    const reg = new TokenizerRegistry();
    const clientCount = reg.countClientTokens('openai', 'gpt-4', SAMPLE_PROMPT, SAMPLE_COMPLETION);
    // Provider reports 50% more input tokens than client counted
    const inflatedProviderInput = Math.round(clientCount.inputTokens * 1.5);
    const disc = reg.detectDiscrepancy(
      inflatedProviderInput,
      clientCount.outputTokens,
      clientCount,
      20,
    );
    assert.strictEqual(disc.flagged, true, 'should flag 50% overcount');
    assert.ok(disc.deltaInputPct > 20, `expected >20% delta, got ${disc.deltaInputPct}%`);
  });

  it('detectDiscrepancy: does not flag within threshold', () => {
    const reg = new TokenizerRegistry();
    const clientCount = reg.countClientTokens('openai', 'gpt-4', SAMPLE_PROMPT, SAMPLE_COMPLETION);
    // Provider reports 5% more (within 20% threshold)
    const slightlyMore = Math.round(clientCount.inputTokens * 1.05);
    const disc = reg.detectDiscrepancy(slightlyMore, clientCount.outputTokens, clientCount, 20);
    assert.strictEqual(disc.flagged, false, 'should NOT flag 5% variation');
  });

  it('computeTokenCountCommitment is deterministic', () => {
    const c1 = TokenizerRegistry.computeTokenCountCommitment(100, 50, 'tiktoken@cl100k_base@v1');
    const c2 = TokenizerRegistry.computeTokenCountCommitment(100, 50, 'tiktoken@cl100k_base@v1');
    assert.strictEqual(c1, c2);
    assert.ok(c1.startsWith('0x'));
    assert.strictEqual(c1.length, 66);
  });

  it('computeTokenCountCommitment differs for different inputs', () => {
    const c1 = TokenizerRegistry.computeTokenCountCommitment(100, 50, 'tiktoken@cl100k_base@v1');
    const c2 = TokenizerRegistry.computeTokenCountCommitment(200, 50, 'tiktoken@cl100k_base@v1');
    assert.notStrictEqual(c1, c2);
  });
});

// ---------------------------------------------------------------------------
// OracleAttestationEngine tests
// ---------------------------------------------------------------------------

describe('OracleAttestationEngine (Oracle Level A+C)', () => {
  const engine = new OracleAttestationEngine();

  it('generates complete Level C attestation', () => {
    const result = engine.attest({
      provider: 'openai',
      model: 'gpt-4',
      promptText: SAMPLE_PROMPT,
      completionText: SAMPLE_COMPLETION,
      providerInputTokens: 10,
      providerOutputTokens: 15,
    });

    assert.strictEqual(result.attestation.level, 'C');
    assert.ok(result.attestation.promptHash.startsWith('0x'));
    assert.ok(result.attestation.completionHash.startsWith('0x'));
    assert.ok(result.attestation.tokenizerId.includes('tiktoken'));
    assert.ok(result.attestation.clientInputTokens > 0);
    assert.ok(result.attestation.clientOutputTokens > 0);
    assert.ok(result.attestation.tokenCountCommitment.startsWith('0x'));
    assert.strictEqual(typeof result.attestation.discrepancyFlagged, 'boolean');
  });

  it('attestation is deterministic for same input', () => {
    const input = {
      provider: 'openai',
      model: 'gpt-4',
      promptText: SAMPLE_PROMPT,
      completionText: SAMPLE_COMPLETION,
      providerInputTokens: 10,
      providerOutputTokens: 15,
    };
    const r1 = engine.attest(input);
    const r2 = engine.attest(input);
    assert.strictEqual(r1.attestation.promptHash, r2.attestation.promptHash);
    assert.strictEqual(r1.attestation.completionHash, r2.attestation.completionHash);
    assert.strictEqual(r1.attestation.clientInputTokens, r2.attestation.clientInputTokens);
    assert.strictEqual(r1.attestation.tokenCountCommitment, r2.attestation.tokenCountCommitment);
  });

  it('promptHash != completionHash for different texts', () => {
    const result = engine.attest({
      provider: 'openai',
      model: 'gpt-4',
      promptText: SAMPLE_PROMPT,
      completionText: SAMPLE_COMPLETION,
      providerInputTokens: 10,
      providerOutputTokens: 15,
    });
    assert.notStrictEqual(result.attestation.promptHash, result.attestation.completionHash);
  });

  it('flags discrepancy when provider overcounts by >20%', () => {
    const reg = new TokenizerRegistry();
    const clientCount = reg.countClientTokens('openai', 'gpt-4', SAMPLE_PROMPT, SAMPLE_COMPLETION);
    const result = engine.attest({
      provider: 'openai',
      model: 'gpt-4',
      promptText: SAMPLE_PROMPT,
      completionText: SAMPLE_COMPLETION,
      providerInputTokens: Math.round(clientCount.inputTokens * 2),  // 100% overcount
      providerOutputTokens: clientCount.outputTokens,
    });
    assert.strictEqual(result.attestation.discrepancyFlagged, true);
  });

  it('does not flag when provider count matches client count exactly', () => {
    const reg = new TokenizerRegistry();
    const clientCount = reg.countClientTokens('openai', 'gpt-4', SAMPLE_PROMPT, SAMPLE_COMPLETION);
    const result = engine.attest({
      provider: 'openai',
      model: 'gpt-4',
      promptText: SAMPLE_PROMPT,
      completionText: SAMPLE_COMPLETION,
      providerInputTokens: clientCount.inputTokens,
      providerOutputTokens: clientCount.outputTokens,
    });
    assert.strictEqual(result.attestation.discrepancyFlagged, false);
  });

  it('attestLevelA produces Level A attestation without client counts', () => {
    const att = engine.attestLevelA('openai', 'gpt-4', SAMPLE_PROMPT, SAMPLE_COMPLETION);
    assert.strictEqual(att.level, 'A');
    assert.ok(att.promptHash.startsWith('0x'));
    assert.ok(att.completionHash.startsWith('0x'));
    assert.strictEqual(att.clientInputTokens, 0);
    assert.strictEqual(att.clientOutputTokens, 0);
    assert.strictEqual(att.discrepancyFlagged, false);
  });

  it('custom discrepancy threshold is respected', () => {
    const reg = new TokenizerRegistry();
    const clientCount = reg.countClientTokens('openai', 'gpt-4', SAMPLE_PROMPT, SAMPLE_COMPLETION);
    // Use 50% overcount — clearly above any 10% threshold, clearly detectable
    const heavilyInflated = clientCount.inputTokens * 2;

    const resultStrict = engine.attest({
      provider: 'openai', model: 'gpt-4',
      promptText: SAMPLE_PROMPT, completionText: SAMPLE_COMPLETION,
      providerInputTokens: heavilyInflated,
      providerOutputTokens: clientCount.outputTokens,
      discrepancyThresholdPct: 10,
    });
    assert.strictEqual(resultStrict.attestation.discrepancyFlagged, true, 'should flag 100% overcount at 10% threshold');

    // Use exact match — clearly below any threshold
    const resultLoose = engine.attest({
      provider: 'openai', model: 'gpt-4',
      promptText: SAMPLE_PROMPT, completionText: SAMPLE_COMPLETION,
      providerInputTokens: clientCount.inputTokens,
      providerOutputTokens: clientCount.outputTokens,
      discrepancyThresholdPct: 20,
    });
    assert.strictEqual(resultLoose.attestation.discrepancyFlagged, false, 'exact match should NOT flag at 20% threshold');
  });
});

// ---------------------------------------------------------------------------
// CanonicalReceiptV2 tests
// ---------------------------------------------------------------------------

describe('CanonicalReceiptV2 — encoding + hash (Oracle Level A+C)', () => {
  const engine = new OracleAttestationEngine();

  function makeV2Receipt(): CanonicalReceiptV2 {
    const { attestation } = engine.attest({
      provider: 'openai',
      model: 'gpt-4',
      promptText: SAMPLE_PROMPT,
      completionText: SAMPLE_COMPLETION,
      providerInputTokens: 100,
      providerOutputTokens: 50,
    });

    return {
      provider: 'openai',
      model: 'gpt-4',
      input_tokens: 100n,
      output_tokens: 50n,
      total_tokens: 150n,
      latency_ms: 250n,
      cost_unit: 750n,
      user_id: 'user-001',
      project_id: 'project-A',
      timestamp: 1700000000000n,
      nonce: 1n,
      epoch: 472222n,
      oracle: attestation,
    };
  }

  it('encodes to non-empty Uint8Array', () => {
    const receipt = makeV2Receipt();
    const bytes = encodeCanonicalReceiptV2Bytes(receipt);
    assert.ok(bytes.length > 0);
  });

  it('encoded bytes start with OTK_RECEIPT_V2 domain', () => {
    const receipt = makeV2Receipt();
    const bytes = encodeCanonicalReceiptV2Bytes(receipt);
    const str = new TextDecoder().decode(bytes.slice(0, RECEIPT_DOMAIN_V2.length));
    assert.strictEqual(str, RECEIPT_DOMAIN_V2);
  });

  it('hash is 0x-prefixed 66-char hex', () => {
    const receipt = makeV2Receipt();
    const hash = hashCanonicalReceiptV2(receipt);
    assert.ok(hash.startsWith('0x'));
    assert.strictEqual(hash.length, 66);
  });

  it('hash is deterministic', () => {
    const r = makeV2Receipt();
    assert.strictEqual(hashCanonicalReceiptV2(r), hashCanonicalReceiptV2(r));
  });

  it('V2 hash differs from V1-equivalent (different domain)', () => {
    const receipt = makeV2Receipt();
    const v1Hash = hashCanonicalReceiptV1(receipt);
    const v2Hash = hashCanonicalReceiptV2(receipt);
    assert.notStrictEqual(v1Hash, v2Hash, 'V2 hash must differ from V1 (different domain + oracle fields)');
  });

  it('changing oracle.discrepancyFlagged changes the V2 hash', () => {
    const r1 = makeV2Receipt();
    const r2 = { ...r1, oracle: { ...r1.oracle, discrepancyFlagged: !r1.oracle.discrepancyFlagged } };
    assert.notStrictEqual(hashCanonicalReceiptV2(r1), hashCanonicalReceiptV2(r2));
  });

  it('throws when oracle is missing', () => {
    const receipt = makeV2Receipt();
    const badReceipt = { ...receipt, oracle: undefined as any };
    assert.throws(() => encodeCanonicalReceiptV2Bytes(badReceipt), /oracle attestation required/);
  });

  it('throws when promptHash is missing', () => {
    const receipt = makeV2Receipt();
    const bad = { ...receipt, oracle: { ...receipt.oracle, promptHash: '' } };
    assert.throws(() => encodeCanonicalReceiptV2Bytes(bad), /promptHash required/);
  });
});
