/**
 * OracleAttestationEngine — Generates Oracle Attestation for Receipts (Level A+C)
 *
 * Takes a provider event (NormalizedUsageEvent or raw receipt fields) +
 * the actual prompt/completion text, and produces an OracleAttestation
 * ready to embed into CanonicalReceiptV2.
 *
 * Workflow:
 *  1. Hash prompt and completion → promptHash, completionHash (Level A)
 *  2. Count tokens locally via TokenizerRegistry (Level C, auxiliary; not a provider proof)
 *  3. Compare client count vs provider-reported count → discrepancy detection
 *  4. Compute tokenCountCommitment (binding client count into receipt hash)
 *  5. Return complete OracleAttestation
 *
 * @module metering/OracleAttestationEngine
 * @since U12-oracle-level-ac
 */

import {
  defaultTokenizerRegistry,
  type ClientTokenCount,
  type TokenDiscrepancy,
  TokenizerRegistry,
} from '../tokenization/TokenizerRegistry.js';
import type { OracleAttestation } from '../receipt/canonicalReceiptV2.js';

// ---------------------------------------------------------------------------
// Input/Output types
// ---------------------------------------------------------------------------

export interface OracleAttestationInput {
  /** Provider identifier (e.g., 'openai', 'anthropic', 'gemini', 'deepseek') */
  provider: string;
  /** Model identifier (e.g., 'gpt-4', 'claude-opus-4') */
  model: string;
  /** Raw prompt text sent to provider (used for promptHash + client token count) */
  promptText: string;
  /** Raw completion text received from provider (used for completionHash + client count) */
  completionText: string;
  /** Input tokens as reported by provider API */
  providerInputTokens: number;
  /** Output tokens as reported by provider API */
  providerOutputTokens: number;
  /**
   * Discrepancy threshold (%).
   * Default: 20% — if provider reports >20% more/fewer tokens than client count,
   * discrepancyFlagged=true.
   * Set lower for stricter detection, higher for providers with known approximations.
   *
   * These percentages are heuristics, not measured precision (no calibration exists yet; D8).
   * Only OpenAI models have their documented encoding locally; DeepSeek, Anthropic and Gemini
   * are counted with an approximate encoding. New code: tokenization/conferenceReport.ts.
   */
  discrepancyThresholdPct?: number;
}

export interface OracleAttestationResult {
  attestation: OracleAttestation;
  clientCount: ClientTokenCount;
  discrepancy: TokenDiscrepancy;
}

// ---------------------------------------------------------------------------
// OracleAttestationEngine
// ---------------------------------------------------------------------------

/**
 * Engine that produces Oracle Level A+C attestations.
 *
 * Level A: Commits to what was sent/received (promptHash, completionHash).
 * Level C: Counts tokens independently and detects discrepancies.
 *
 * Instance is stateless — same input always produces same output.
 */
export class OracleAttestationEngine {
  private registry: TokenizerRegistry;

  constructor(registry: TokenizerRegistry = defaultTokenizerRegistry) {
    this.registry = registry;
  }

  /**
   * Generate a complete OracleAttestation from prompt+completion+provider data.
   *
   * @param input - Provider event + raw texts
   * @returns Attestation + supporting data (clientCount, discrepancy)
   */
  attest(input: OracleAttestationInput): OracleAttestationResult {
    const threshold = input.discrepancyThresholdPct ?? 20;
    const tokenizer = this.registry.resolve(input.provider, input.model);

    // Level A: cryptographic commitments to text content
    const promptHash = tokenizer.hashText(input.promptText);
    const completionHash = tokenizer.hashText(input.completionText);

    // Level C: operator-side local recount (auxiliary; D1-G07 wording)
    const clientCount = this.registry.countClientTokens(
      input.provider,
      input.model,
      input.promptText,
      input.completionText,
    );

    // Discrepancy detection
    const discrepancy = this.registry.detectDiscrepancy(
      input.providerInputTokens,
      input.providerOutputTokens,
      clientCount,
      threshold,
    );

    // Token count commitment (binds client count into receipt)
    const tokenCountCommitment = TokenizerRegistry.computeTokenCountCommitment(
      clientCount.inputTokens,
      clientCount.outputTokens,
      clientCount.tokenizerId,
    );

    const attestation: OracleAttestation = {
      level: 'C',
      promptHash,
      completionHash,
      tokenizerId: clientCount.tokenizerId,
      clientInputTokens: clientCount.inputTokens,
      clientOutputTokens: clientCount.outputTokens,
      tokenCountCommitment,
      discrepancyFlagged: discrepancy.flagged,
      discrepancyDeltaInputPct: discrepancy.deltaInputPct,
      discrepancyDeltaOutputPct: discrepancy.deltaOutputPct,
      discrepancyThresholdPct: threshold,
    };

    return { attestation, clientCount, discrepancy };
  }

  /**
   * Level A only — generate attestation without client token counting.
   * Use when prompt/completion text is available but not for token comparison.
   * Only promptHash + completionHash are populated; token fields default to 0.
   */
  attestLevelA(
    provider: string,
    model: string,
    promptText: string,
    completionText: string,
  ): OracleAttestation {
    const tokenizer = this.registry.resolve(provider, model);
    const promptHash = tokenizer.hashText(promptText);
    const completionHash = tokenizer.hashText(completionText);
    const tokenCountCommitment = TokenizerRegistry.computeTokenCountCommitment(0, 0, 'none');

    return {
      level: 'A',
      promptHash,
      completionHash,
      tokenizerId: 'none',
      clientInputTokens: 0,
      clientOutputTokens: 0,
      tokenCountCommitment,
      discrepancyFlagged: false,
      discrepancyDeltaInputPct: 0,
      discrepancyDeltaOutputPct: 0,
      discrepancyThresholdPct: 0,
    };
  }
}

/** Default singleton engine */
export const defaultOracleEngine = new OracleAttestationEngine();
