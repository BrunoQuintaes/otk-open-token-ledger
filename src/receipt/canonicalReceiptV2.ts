/**
 * Canonical Receipt V2 — Oracle Attestation Layer (OTK_RECEIPT_V2)
 *
 * Extends CanonicalReceiptV1 with Oracle Level A+C mitigation fields:
 *
 * Level A — Usage Attestation Spec:
 *   The receipt includes cryptographic commitments to the prompt and completion
 *   (promptHash, completionHash). Any party with access to the raw text can
 *   verify these hashes without revealing the content to the prover.
 *
 * Level C — Client-side Token Counter:
 *   The operator (OTK side) recounts tokens locally with tiktoken (js-tiktoken). This is a
 *   second observation by the same operator, not an independent party and not a provider signature.
 *   discrepancyFlagged=true if provider-reported tokens deviate > threshold%
 *   from client-counted tokens. The tokenCountCommitment binds the client
 *   count into the receipt hash.
 *
 * What the V2 hash gives: integrity of the listed fields under the signer's key, once signed.
 * Hashing a value does not prove how it was computed (D1-G07, corrected 2026-09-30; the previous
 * text claimed the circuit proved the CU formula and the tokenizer count, which it never did).
 *
 * What the ZK circuits (metering_v1/v2/v3) prove: knowledge of a usage value opening the public
 * commitment and lying in the public range. They take usage as an INPUT. They do NOT prove:
 *   - that CU = round(totalTokens × W_m × W_p) was computed correctly (no formula in the circuit);
 *   - that any token count was derived by a tokenizer (no text or tokenizer in the circuit);
 *   - that the provider processed the prompt, or that completionText is the model response;
 *   - that the provider reported its usage honestly.
 * Level C fields are the operator's local recount, not a provider signature. promptHash /
 * completionHash are deterministic hashes of possibly small-domain texts: they can be guessed and
 * linked (D2 §6). otk.receipt.v3 (src/receipt/v3/) carries no content digests.
 *
 * @module receipt/canonicalReceiptV2
 * @since U12-oracle-level-ac
 */

import { ethers } from 'ethers';
import {
  type CanonicalReceiptV1,
  FIELD_SEPARATOR,
} from './canonicalReceiptV1.js';

// ---------------------------------------------------------------------------
// Domain constant (increment if V2 encoding changes)
// ---------------------------------------------------------------------------

/**
 * Domain separator (ASCII) that starts every V2 encoding; frozen.
 */
export const RECEIPT_DOMAIN_V2 = 'OTK_RECEIPT_V2';

// ---------------------------------------------------------------------------
// Oracle Attestation Types
// ---------------------------------------------------------------------------

/**
 * Oracle Level A+C attestation embedded in CanonicalReceiptV2.
 *
 * Level A fields: promptHash, completionHash
 *   → Commitment to what was sent/received (text-level binding).
 *   → Any verifier with the raw texts can check: keccak256(text) == promptHash
 *
 * Level C fields: tokenizerId, clientInputTokens, clientOutputTokens,
 *                 tokenCountCommitment, discrepancy*
 *   → Local recount by the operator using tiktoken (deterministic for a given text and encoding;
 *     an approximation of the provider count, which may differ for messages, tools and media).
 *   → discrepancyFlagged=true → the two counts differ beyond a heuristic, uncalibrated threshold;
 *     not by itself evidence of provider over/undercounting.
 */
export interface OracleAttestation {
  /** Attestation level: 'A' = hashes only, 'C' = hashes + client token count */
  level: 'A' | 'C';

  /** keccak256(UTF-8 bytes of prompt text sent to provider) */
  promptHash: string;

  /** keccak256(UTF-8 bytes of completion text received from provider) */
  completionHash: string;

  /**
   * Stable tokenizer identifier used for client-side counting.
   * Format: 'tiktoken@{encoding}@{schemaVersion}'
   * e.g.: 'tiktoken@cl100k_base@v1'
   */
  tokenizerId: string;

  /** Local (operator-side) input token recount — not independent of the operator */
  clientInputTokens: number;

  /** Local (operator-side) output token recount — not independent of the operator */
  clientOutputTokens: number;

  /**
   * Token count commitment: keccak256("{clientInput}|{clientOutput}|{tokenizerId}")
   * Binds the client token count into the receipt hash for tamper detection.
   */
  tokenCountCommitment: string;

  /**
   * true if |provider_tokens - client_tokens| / provider_tokens > discrepancyThresholdPct
   * for either input or output tokens.
   */
  discrepancyFlagged: boolean;

  /** Delta percentage for input tokens: |provider - client| / provider × 100 */
  discrepancyDeltaInputPct: number;

  /** Delta percentage for output tokens: |provider - client| / provider × 100 */
  discrepancyDeltaOutputPct: number;

  /** Threshold used for flagging (default: 20%) */
  discrepancyThresholdPct: number;
}

// ---------------------------------------------------------------------------
// CanonicalReceiptV2
// ---------------------------------------------------------------------------

/**
 * Canonical Receipt V2 — CanonicalReceiptV1 + OracleAttestation.
 *
 * All V1 fields are preserved unchanged (backward compatible hash roots).
 * The V2 hash commits to both V1 fields AND oracle attestation.
 */
export interface CanonicalReceiptV2 extends CanonicalReceiptV1 {
  oracle: OracleAttestation;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function appendUtf8(arr: number[], s: string): void {
  const bytes = ethers.toUtf8Bytes(s);
  for (const byte of bytes) arr.push(byte);
}

/**
 * Encode a CanonicalReceiptV2 to its canonical byte representation.
 *
 * Format: OTK_RECEIPT_V2 + 0x1f + [all V1 fields] + 0x1f + [oracle fields]
 *
 * Oracle field order (FROZEN — do not reorder):
 *   promptHash | completionHash | tokenizerId |
 *   clientInputTokens | clientOutputTokens | tokenCountCommitment |
 *   discrepancyFlagged | discrepancyThresholdPct
 *
 * Note: the encoded oracle list starts with `level`, before `promptHash` (the order above omits it), and
 * `discrepancyDeltaInputPct`/`discrepancyDeltaOutputPct` are not encoded. Unlike V1, the V1 fields are not
 * validated here (no non-empty check, no total check, a negative bigint is written with a minus sign).
 *
 * @param r - Receipt fields plus the oracle attestation (not modified).
 * @returns The canonical bytes.
 * @throws {Error} When `oracle` or one of `promptHash`, `completionHash`, `tokenizerId`,
 *   `tokenCountCommitment` is missing or empty.
 */
export function encodeCanonicalReceiptV2Bytes(r: CanonicalReceiptV2): Uint8Array {
  if (!r.oracle) throw new Error('CanonicalReceiptV2: oracle attestation required');
  if (!r.oracle.promptHash) throw new Error('CanonicalReceiptV2: oracle.promptHash required');
  if (!r.oracle.completionHash) throw new Error('CanonicalReceiptV2: oracle.completionHash required');
  if (!r.oracle.tokenizerId) throw new Error('CanonicalReceiptV2: oracle.tokenizerId required');
  if (!r.oracle.tokenCountCommitment) throw new Error('CanonicalReceiptV2: oracle.tokenCountCommitment required');

  const v1Fields: string[] = [
    r.provider,
    r.model,
    r.input_tokens.toString(10),
    r.output_tokens.toString(10),
    r.total_tokens.toString(10),
    r.latency_ms.toString(10),
    r.cost_unit.toString(10),
    r.user_id,
    r.project_id,
    r.timestamp.toString(10),
    r.nonce.toString(10),
    r.epoch.toString(10),
  ];

  const oracleFields: string[] = [
    r.oracle.level,
    r.oracle.promptHash,
    r.oracle.completionHash,
    r.oracle.tokenizerId,
    r.oracle.clientInputTokens.toString(10),
    r.oracle.clientOutputTokens.toString(10),
    r.oracle.tokenCountCommitment,
    r.oracle.discrepancyFlagged ? '1' : '0',
    r.oracle.discrepancyThresholdPct.toString(10),
  ];

  const out: number[] = [];
  appendUtf8(out, RECEIPT_DOMAIN_V2);
  for (const field of [...v1Fields, ...oracleFields]) {
    out.push(FIELD_SEPARATOR);
    appendUtf8(out, field);
  }

  return Uint8Array.from(out);
}

/**
 * Compute keccak256 hash of a CanonicalReceiptV2.
 *
 * This hash covers BOTH the provider-reported data (V1 fields)
 * AND the oracle attestation (client token counts, discrepancy flag).
 *
 * @returns 0x-prefixed hex string (66 chars)
 * @param r - Receipt fields plus the oracle attestation.
 * @throws {Error} The validation errors of {@link encodeCanonicalReceiptV2Bytes}.
 */
export function hashCanonicalReceiptV2(r: CanonicalReceiptV2): string {
  const bytes = encodeCanonicalReceiptV2Bytes(r);
  return ethers.keccak256(bytes);
}
