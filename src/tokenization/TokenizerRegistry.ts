/**
 * TokenizerRegistry — Client-side Deterministic Token Counter (Oracle Level C)
 *
 * Deterministic local token counting of text strings with tiktoken (js-tiktoken). It is an
 * auxiliary observation by the operator: it counts the text it was given with one encoding;
 * it does not reproduce the provider's message/tool assembly, is not independent of the
 * operator, and does not prove the provider's usage or invoice (D1, D8).
 *
 * - Level A: receipt includes commitment to what was declared (promptHash, completionHash)
 * - Level C: local count of the given text, compared with the provider-reported count
 *
 * Coverage of the encoding by provider (no calibrated precision exists; see D8):
 * - OpenAI: tiktoken encodings documented for the listed models (text only, no envelope)
 * - DeepSeek, Anthropic, Gemini: their own tokenizers; cl100k_base is an approximation
 *   (an OpenAI-compatible API does not imply an identical tokenizer)
 *
 * Legacy module kept for historical receipts and current consumers. New code uses
 * src/tokenization/localCounter.ts + conferenceReport.ts (versioned identity, coverage states).
 *
 * @module tokenization/TokenizerRegistry
 * @since U12-oracle-level-c
 */

import { getEncoding, type TiktokenEncoding } from 'js-tiktoken';
import { ethers } from 'ethers';
import { resolveModelSupport } from '../providers/catalog/modelCatalog.js';

// ---------------------------------------------------------------------------
// Versioning — increment when encoding schema changes
// ---------------------------------------------------------------------------

/**
 * Version suffix of the legacy tokenizer IDs (`tiktoken@<encoding>@v1`).
 */
export const TOKENIZER_SCHEMA_VERSION = 'v1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of client-side token counting */
export interface ClientTokenCount {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** Stable tokenizer identifier: 'tiktoken@{encoding}@{version}' */
  tokenizerId: string;
}

/** Discrepancy report between provider-reported and client-counted tokens */
export interface TokenDiscrepancy {
  providerInput: number;
  clientInput: number;
  /** providerInput - clientInput (positive = provider reported more) */
  deltaInput: number;
  /** |deltaInput| / providerInput × 100 */
  deltaInputPct: number;
  providerOutput: number;
  clientOutput: number;
  deltaOutput: number;
  deltaOutputPct: number;
  /** true if any delta exceeds threshold */
  flagged: boolean;
  threshold: number;
}

// ---------------------------------------------------------------------------
// ITokenizer interface
// ---------------------------------------------------------------------------

/**
 * A text tokenizer with a stable identifier.
 */
export interface ITokenizer {
  /** Stable identifier: 'tiktoken@{encoding}@{schemaVersion}' */
  readonly tokenizerId: string;
  /** Count tokens in text. Empty/null → 0 */
  countTokens(text: string): number;
  /** Compute keccak256 commitment over raw text bytes */
  hashText(text: string): string;
}

// ---------------------------------------------------------------------------
// TiktokenTokenizer — backed by js-tiktoken
// ---------------------------------------------------------------------------

/**
 * Deterministic tokenizer using js-tiktoken (pure JS BPE implementation).
 * Same text always produces the same token count on any platform.
 */
export class TiktokenTokenizer implements ITokenizer {
  readonly tokenizerId: string;
  private enc: ReturnType<typeof getEncoding>;

  constructor(encodingName: TiktokenEncoding) {
    this.enc = getEncoding(encodingName);
    this.tokenizerId = `tiktoken@${encodingName}@${TOKENIZER_SCHEMA_VERSION}`;
  }

  /**
   * Counts tokens; special-token strings follow js-tiktoken defaults.
   *
   * @param text - Text to count.
   * @returns Token count; 0 for an empty string.
   */
  countTokens(text: string): number {
    if (!text || text.length === 0) return 0;
    return this.enc.encode(text).length;
  }

  /**
   * Commitment to a text: keccak256 of its UTF-8 bytes.
   *
   * @param text - Text to hash (empty for none).
   * @returns `0x`-prefixed hex digest.
   */
  hashText(text: string): string {
    const bytes = text ? ethers.toUtf8Bytes(text) : new Uint8Array(0);
    return ethers.keccak256(bytes);
  }
}

// ---------------------------------------------------------------------------
// TokenizerRegistry
// ---------------------------------------------------------------------------

/**
 * Registry mapping provider/model keys to deterministic tokenizers.
 *
 * Encoding per provider:
 * - 'openai'    → cl100k_base for the GPT-3.5/4 family, o200k_base for GPT-4o (registered
 *                 separately); explicitly listed dated snapshots resolve to their family (U2-01)
 * - 'deepseek'  → cl100k_base  (approximation — DeepSeek documents its own tokenizer)
 * - 'anthropic' → cl100k_base  (approximation — no public Claude tokenizer)
 * - 'gemini'    → cl100k_base  (approximation — Gemini uses SentencePiece)
 */
export class TokenizerRegistry {
  private tokenizers = new Map<string, ITokenizer>();
  private defaultTokenizer: ITokenizer;

  constructor() {
    // cl100k_base: GPT-3.5, GPT-4, Claude (approx), Gemini (approx), DeepSeek
    const cl100k = new TiktokenTokenizer('cl100k_base');
    // o200k_base: GPT-4o, GPT-4o-mini
    const o200k = new TiktokenTokenizer('o200k_base');

    // --- OpenAI ---
    this.tokenizers.set('openai', cl100k);
    this.tokenizers.set('openai:gpt-4', cl100k);
    this.tokenizers.set('openai:gpt-4-turbo', cl100k);
    this.tokenizers.set('openai:gpt-3.5-turbo', cl100k);
    this.tokenizers.set('openai:gpt-4o', o200k);
    this.tokenizers.set('openai:gpt-4o-mini', o200k);

    // --- Anthropic (approximation — cl100k_base ≈ Claude's BPE) ---
    this.tokenizers.set('anthropic', cl100k);
    this.tokenizers.set('anthropic:claude-3-opus-20240229', cl100k);
    this.tokenizers.set('anthropic:claude-3-sonnet-20240229', cl100k);
    this.tokenizers.set('anthropic:claude-3-haiku-20240307', cl100k);
    this.tokenizers.set('anthropic:claude-opus-4', cl100k);
    this.tokenizers.set('anthropic:claude-sonnet-4', cl100k);

    // --- Gemini (approximation — uses SentencePiece, not BPE) ---
    this.tokenizers.set('gemini', cl100k);
    this.tokenizers.set('gemini:gemini-pro', cl100k);
    this.tokenizers.set('gemini:gemini-2.0-flash', cl100k);

    // --- DeepSeek (approximation — own tokenizer, see api-docs.deepseek.com) ---
    this.tokenizers.set('deepseek', cl100k);
    this.tokenizers.set('deepseek:deepseek-chat', cl100k);
    this.tokenizers.set('deepseek:deepseek-coder', cl100k);

    this.defaultTokenizer = cl100k;
  }

  /**
   * Resolve tokenizer by provider (and optionally model).
   * Falls back to defaultTokenizer (cl100k_base) if no match found.
   *
   * @param provider - Provider ID (exact, lowercase expected).
   * @param model - Optional model ID.
   * @returns The tokenizer for the model, else the provider's, else cl100k_base.
   */
  resolve(provider: string, model?: string): ITokenizer {
    if (model) {
      const modelKey = `${provider}:${model}`;
      if (this.tokenizers.has(modelKey)) return this.tokenizers.get(modelKey)!;
      // U2-01: an explicitly catalogued dated snapshot (gpt-4o-mini-2024-07-18) uses its
      // family's encoding instead of silently falling back to the provider default.
      if (provider === 'openai') {
        const family = resolveModelSupport('openai', 'openai.chat_completions', model);
        if (family.support === 'alias_known' && family.catalogKey) {
          const familyKey = `openai:${family.catalogKey}`;
          if (this.tokenizers.has(familyKey)) return this.tokenizers.get(familyKey)!;
        }
      }
    }
    return this.tokenizers.get(provider) ?? this.defaultTokenizer;
  }

  /**
   * Count tokens client-side for a prompt+completion pair.
   *
   * @param provider - Provider identifier (e.g., 'openai', 'anthropic')
   * @param model    - Model identifier (e.g., 'gpt-4', 'claude-opus-4')
   * @param promptText     - Raw prompt text sent to provider
   * @param completionText - Raw completion text received from provider
   * @returns Input, output and total counts with the tokenizer ID used.
   */
  countClientTokens(
    provider: string,
    model: string,
    promptText: string,
    completionText: string,
  ): ClientTokenCount {
    const tokenizer = this.resolve(provider, model);
    const inputTokens = tokenizer.countTokens(promptText);
    const outputTokens = tokenizer.countTokens(completionText);
    return {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      tokenizerId: tokenizer.tokenizerId,
    };
  }

  /**
   * Detect discrepancy between provider-reported and client-counted tokens.
   *
   * @param providerInput  - Input tokens as reported by provider API
   * @param providerOutput - Output tokens as reported by provider API
   * @param clientCount    - Client-side count from countClientTokens()
   * @param thresholdPct   - Flag if delta exceeds this % of provider count (default: 20%;
   *                         heuristic, not a calibrated precision). A provider count of 0 with
   *                         a positive local count is always flagged.
   * @returns The deltas, percentages and the `flagged` result.
   */
  detectDiscrepancy(
    providerInput: number,
    providerOutput: number,
    clientCount: ClientTokenCount,
    thresholdPct = 20,
  ): TokenDiscrepancy {
    const deltaInput = providerInput - clientCount.inputTokens;
    const deltaOutput = providerOutput - clientCount.outputTokens;
    // Percentages are not applicable when the provider reports 0 (reported as 0 for type
    // compatibility); the flag below still uses the absolute difference in that case (U2-02).
    const deltaInputPct = providerInput > 0
      ? Math.abs(deltaInput) / providerInput * 100 : 0;
    const deltaOutputPct = providerOutput > 0
      ? Math.abs(deltaOutput) / providerOutput * 100 : 0;
    const zeroWithLocal = (providerInput === 0 && clientCount.inputTokens > 0)
      || (providerOutput === 0 && clientCount.outputTokens > 0);
    return {
      providerInput,
      clientInput: clientCount.inputTokens,
      deltaInput,
      deltaInputPct,
      providerOutput,
      clientOutput: clientCount.outputTokens,
      deltaOutput,
      deltaOutputPct,
      flagged: deltaInputPct > thresholdPct || deltaOutputPct > thresholdPct || zeroWithLocal,
      threshold: thresholdPct,
    };
  }

  /**
   * Compute a stable commitment to client-side token counts.
   *
   * Commitment = keccak256(UTF-8("{inputTokens}|{outputTokens}|{tokenizerId}"))
   *
   * This commitment is included in CanonicalReceiptV2.oracle.tokenCountCommitment
   * and can be independently verified by any party with access to the same data.
   *
   * @param inputTokens - Local input count.
   * @param outputTokens - Local output count.
   * @param tokenizerId - Tokenizer ID.
   * @returns `0x`-prefixed keccak256 hex digest.
   */
  static computeTokenCountCommitment(
    inputTokens: number,
    outputTokens: number,
    tokenizerId: string,
  ): string {
    const data = `${inputTokens}|${outputTokens}|${tokenizerId}`;
    return ethers.keccak256(ethers.toUtf8Bytes(data));
  }
}

/**
 * Singleton default registry — safe to use across modules
 *
 *
 * Building it loads the encodings at import time.
 */
export const defaultTokenizerRegistry = new TokenizerRegistry();
