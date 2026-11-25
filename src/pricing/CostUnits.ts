/**
 * CostUnits — Deterministic Cost Units Engine (v1)
 *
 * Canonical, float-free CU computation for ZK-compatible metering.
 * All arithmetic uses bigint to guarantee cross-platform determinism.
 *
 * Formula (CU_MODEL_v1):
 *   CU(p, m, t_in, t_out) = round( (t_in + t_out) × W_m(m) × W_p(p) )
 *   round(x) = floor(x + 0.5)
 *
 * Weights are stored as integer millis (× 1000) to avoid floating point.
 * Example: weight 1.1 → 1100, weight 0.85 → 850
 *
 * This is the legacy integer formula (CU_MODEL_v1) with static, unsigned weight tables. It is used by legacy
 * receipts, the legacy measurement adapters (`src/operations/measurementPorts.ts`) and the known-CU path
 * (`src/operations/knownCu.ts`); the durable profile uses signed weight tables instead. Reads the environment
 * variable CU_PUBLISH_MODE once, at import (see {@link CU_PUBLISH_MODE}).
 *
 * @module src/pricing/CostUnits
 * @since U5.2
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Weight scale factor: all weights are stored as integer × WEIGHT_SCALE */
const WEIGHT_SCALE = 1000n;

/** Max uint64 value (2^64 - 1) */
const MAX_UINT64 = (1n << 64n) - 1n;

// ---------------------------------------------------------------------------
// Weight Tables (integer millis — multiply by 1000)
// ---------------------------------------------------------------------------

/**
 * Provider weights as integer millis.
 * Baseline: openai = 1000 (≡ 1.0)
 */
export const PROVIDER_WEIGHTS_INT: Readonly<Record<string, bigint>> = {
  openai: 1000n,
  anthropic: 1100n,
  gemini: 900n,
  deepseek: 800n,
  cohere: 850n,
  mistral: 900n,
  meta: 750n,
};

/**
 * Model weights as integer millis.
 * Baseline: gpt-4o = 1000 (≡ 1.0)
 */
export const MODEL_WEIGHTS_INT: Readonly<Record<string, bigint>> = {
  // OpenAI
  'gpt-4o': 1000n,
  'gpt-4o-mini': 400n,
  'gpt-4-turbo': 1500n,
  'gpt-4': 2000n,
  'gpt-3.5-turbo': 500n,
  'o1-preview': 2500n,
  'o1-mini': 1200n,
  'o1': 2000n,           // o1 stable — same tier as gpt-4
  'o3': 3000n,           // o3 — high-tier reasoning
  'o3-mini': 1500n,      // o3-mini — mid-tier reasoning

  // Anthropic
  'claude-opus-4': 2000n,
  'claude-opus-4-5': 2000n,   // v4.5 — same tier as claude-opus-4
  'claude-opus-4-6': 2000n,   // v4.6 — same tier as claude-opus-4
  'claude-sonnet-4': 1500n,
  'claude-sonnet-4-5': 1500n, // v4.5 — same tier as claude-sonnet-4
  'claude-sonnet-4-6': 1500n, // v4.6 — current production model
  'claude-haiku-4': 800n,
  'claude-haiku-4-5': 800n,   // v4.5 — same tier as claude-haiku-4
  'claude-3-opus': 1800n,
  'claude-3-sonnet': 1300n,
  'claude-3-haiku': 700n,

  // Google Gemini
  'gemini-2.0-flash': 600n,
  'gemini-pro': 1200n,
  'gemini-ultra': 2200n,

  // DeepSeek
  'deepseek-coder': 1000n,
  'deepseek-chat': 900n,

  // Cohere
  'command-r-plus': 1400n,
  'command-r': 1000n,
  'command': 800n,

  // Mistral
  'mistral-large': 1600n,
  'mistral-medium': 1200n,
  'mistral-small': 900n,

  // Meta Llama
  'llama-3-70b': 1100n,
  'llama-3-8b': 600n,
};

// ---------------------------------------------------------------------------
// Error Codes (stable, for programmatic matching)
// ---------------------------------------------------------------------------

/** Stable error codes carried by {@link CUError}. */
export const CU_ERROR = {
  UNKNOWN_PROVIDER: 'CU_UNKNOWN_PROVIDER',
  UNKNOWN_MODEL: 'CU_UNKNOWN_MODEL',
  NEGATIVE_TOKENS: 'CU_NEGATIVE_TOKENS',
  NON_INTEGER_TOKENS: 'CU_NON_INTEGER_TOKENS',
  UINT64_OVERFLOW: 'CU_UINT64_OVERFLOW',
} as const;

// ---------------------------------------------------------------------------
// Input Type
// ---------------------------------------------------------------------------

/** Inputs of the CU_MODEL_v1 computation. */
export interface CostUnitsInput {
  /** Provider id (case-insensitive key of {@link PROVIDER_WEIGHTS_INT}). */
  provider: string;
  /** Model id (case-insensitive key of {@link MODEL_WEIGHTS_INT}); dated ids are not mapped here. */
  model: string;
  /** Input tokens (integer >= 0). */
  inputTokens: number;
  /** Output tokens (integer >= 0). */
  outputTokens: number;
}

// ---------------------------------------------------------------------------
// Core: Deterministic CU Calculation (bigint)
// ---------------------------------------------------------------------------

/**
 * Calculate Cost Units using pure bigint arithmetic (deterministic).
 *
 * Formula: CU = round( (t_in + t_out) × W_m × W_p )
 * where round(x) = floor(x + 0.5), implemented as:
 *   round(num / denom) = (num * 2 + denom) / (2 * denom)
 *
 * Weight lookup is case-insensitive.
 *
 * @param input - Provider, model and token counts.
 * @returns Whole CU (bigint).
 * @throws {@link CUError} with stable code on unknown provider/model, negative tokens,
 *         non-integer tokens, or uint64 overflow.
 * @example
 * calculateCostUnitsV1({ provider: 'anthropic', model: 'claude-haiku-4-5', inputTokens: 1000, outputTokens: 500 }); // 1320n
 */
export function calculateCostUnitsV1(input: CostUnitsInput): bigint {
  const { provider, model, inputTokens, outputTokens } = input;

  // --- Input validation ---
  if (!Number.isInteger(inputTokens)) {
    throw new CUError(
      CU_ERROR.NON_INTEGER_TOKENS,
      `inputTokens must be an integer, got ${inputTokens}`
    );
  }
  if (!Number.isInteger(outputTokens)) {
    throw new CUError(
      CU_ERROR.NON_INTEGER_TOKENS,
      `outputTokens must be an integer, got ${outputTokens}`
    );
  }
  if (inputTokens < 0) {
    throw new CUError(
      CU_ERROR.NEGATIVE_TOKENS,
      `inputTokens must be >= 0, got ${inputTokens}`
    );
  }
  if (outputTokens < 0) {
    throw new CUError(
      CU_ERROR.NEGATIVE_TOKENS,
      `outputTokens must be >= 0, got ${outputTokens}`
    );
  }

  // --- Weight lookup (case-insensitive) ---
  const providerKey = provider.toLowerCase();
  const modelKey = model.toLowerCase();

  const wp = PROVIDER_WEIGHTS_INT[providerKey];
  if (wp === undefined) {
    throw new CUError(
      CU_ERROR.UNKNOWN_PROVIDER,
      `Unknown provider: ${provider}. Known providers: ${Object.keys(PROVIDER_WEIGHTS_INT).join(', ')}`
    );
  }

  const wm = MODEL_WEIGHTS_INT[modelKey];
  if (wm === undefined) {
    throw new CUError(
      CU_ERROR.UNKNOWN_MODEL,
      `Unknown model: ${model}. Known models: ${Object.keys(MODEL_WEIGHTS_INT).join(', ')}`
    );
  }

  // --- Bigint arithmetic ---
  const totalTokens = BigInt(inputTokens) + BigInt(outputTokens);

  // numerator = totalTokens × W_m × W_p
  // denominator = WEIGHT_SCALE² (since both weights are scaled by 1000)
  const numerator = totalTokens * wm * wp;
  const denominator = WEIGHT_SCALE * WEIGHT_SCALE; // 1_000_000n

  // round-half-up: floor((numerator * 2 + denominator) / (2 * denominator))
  const cu = (numerator * 2n + denominator) / (denominator * 2n);

  // --- Bounds check ---
  if (cu > MAX_UINT64) {
    throw new CUError(
      CU_ERROR.UINT64_OVERFLOW,
      `CU value ${cu} exceeds uint64 max (${MAX_UINT64})`
    );
  }

  return cu;
}

/**
 * Calculate Cost Units and return as number.
 *
 * Convenience wrapper for contexts that need a JS number (e.g., RawReceipt.costUnits).
 * Throws if the result exceeds Number.MAX_SAFE_INTEGER.
 *
 * @param input - Provider, model and token counts.
 * @returns Whole CU as a number.
 * @throws {@link CUError} For the same reasons as {@link calculateCostUnitsV1}, or code `CU_UINT64_OVERFLOW`
 *   above `Number.MAX_SAFE_INTEGER`.
 */
export function calculateCostUnitsV1Number(input: CostUnitsInput): number {
  const cu = calculateCostUnitsV1(input);

  if (cu > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new CUError(
      CU_ERROR.UINT64_OVERFLOW,
      `CU value ${cu} exceeds MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER})`
    );
  }

  return Number(cu);
}

// ---------------------------------------------------------------------------
// Utility: Provider/Model queries
// ---------------------------------------------------------------------------

/**
 * Check if a provider is supported (case-insensitive).
 *
 * @param provider - Provider id.
 * @returns Whether it has a static weight.
 */
export function isProviderSupported(provider: string): boolean {
  return PROVIDER_WEIGHTS_INT[provider.toLowerCase()] !== undefined;
}

/**
 * Check if a model is supported (case-insensitive).
 *
 * @param model - Model id.
 * @returns Whether it has a static weight.
 */
export function isModelSupported(model: string): boolean {
  return MODEL_WEIGHTS_INT[model.toLowerCase()] !== undefined;
}

/**
 * N8: weight-table key for a model id reported by a provider.
 * Anthropic returns dated snapshot ids (claude-haiku-4-5-20251001) where the table lists
 * the family (claude-haiku-4-5). Only for Anthropic, only an exact `-YYYYMMDD` suffix, and
 * only when the family is in the table; anything else is returned unchanged, so an unknown
 * model still fails explicitly instead of being mapped to another one. Callers keep the
 * original id in the receipt.
 *
 * @param provider - Provider id.
 * @param model - Model id as reported or requested.
 * @returns The family id for a dated Anthropic snapshot whose family is listed; otherwise `model` unchanged.
 */
export function weightModelKey(provider: string, model: string): string {
  if (provider.toLowerCase() !== 'anthropic' || isModelSupported(model)) return model;
  const family = model.replace(/-\d{8}$/, '');
  return family !== model && isModelSupported(family) ? family : model;
}

/**
 * Get all supported provider keys.
 *
 * @returns Lower-case provider ids.
 */
export function getSupportedProviders(): string[] {
  return Object.keys(PROVIDER_WEIGHTS_INT);
}

/**
 * Get all supported model keys.
 *
 * @returns Lower-case model ids.
 */
export function getSupportedModels(): string[] {
  return Object.keys(MODEL_WEIGHTS_INT);
}

// ---------------------------------------------------------------------------
// CUError class (stable error codes for programmatic matching)
// ---------------------------------------------------------------------------

/** Error of the CU engine; match on `code` (a value of {@link CU_ERROR}), not on the message. */
export class CUError extends Error {
  readonly code: string;

  /**
   * Builds the error.
   *
   * @param code - Stable code from {@link CU_ERROR}.
   * @param message - Human-readable detail.
   */
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CUError';
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// CU Bucketing / Quantization (U8.6.3)
// Reduces fingerprinting surface for on-chain publication.
// ---------------------------------------------------------------------------

/** Default bucket size: CU values are rounded to nearest multiple of CU_DEFAULT_BUCKET */
export const CU_DEFAULT_BUCKET = 100n;

/** Publish mode for on-chain CU value */
export type CUPublishMode = 'raw' | 'bucketed';

/** Current publish mode — can be overridden via env CU_PUBLISH_MODE (only the exact value `raw`; read once at import) */
export const CU_PUBLISH_MODE: CUPublishMode =
  (process.env['CU_PUBLISH_MODE'] as CUPublishMode | undefined) === 'raw' ? 'raw' : 'bucketed';

/**
 * Bucket a CU value to the nearest multiple of bucketSize (round-half-up).
 *
 * Example (bucketSize=100):
 *   1000 → 1000, 1049 → 1000, 1050 → 1100, 1500 → 1500
 *
 * Invariants:
 *   - result >= 0
 *   - result is a multiple of bucketSize
 *   - result == 0 iff cu == 0
 *
 * Note: the last invariant above does not hold for small values: with bucketSize 100, any cu from 1 to 49
 * rounds to 0 (only cu >= bucketSize/2 gives a non-zero bucket).
 *
 * @param cu - CU value (>= 0).
 * @param bucketSize - Bucket width (> 0).
 * @returns The nearest multiple of `bucketSize`, halves rounded up.
 * @throws {@link CUError} When `bucketSize` <= 0 or `cu` < 0 (code `CU_NEGATIVE_TOKENS` in both cases).
 */
export function bucketCU(cu: bigint, bucketSize: bigint = CU_DEFAULT_BUCKET): bigint {
  if (bucketSize <= 0n) throw new CUError(CU_ERROR.NEGATIVE_TOKENS, `bucketSize must be > 0, got ${bucketSize}`);
  if (cu < 0n) throw new CUError(CU_ERROR.NEGATIVE_TOKENS, `CU must be >= 0, got ${cu}`);
  if (cu === 0n) return 0n;
  // round-half-up: (cu + bucketSize/2) / bucketSize * bucketSize
  // For integer division with round-half-up:
  //   = ((cu * 2 + bucketSize) / (bucketSize * 2)) * bucketSize
  const doubled = cu * 2n;
  const rounded = (doubled + bucketSize) / (bucketSize * 2n);
  return rounded * bucketSize;
}

/**
 * Apply publish mode: return raw or bucketed CU based on CU_PUBLISH_MODE.
 *
 * @param cu - CU value.
 * @param bucketSize - Bucket width used in bucketed mode.
 * @returns `cu` unchanged in raw mode, else {@link bucketCU}.
 * @throws {@link CUError} In bucketed mode, for the reasons of {@link bucketCU}.
 */
export function publishCU(cu: bigint, bucketSize: bigint = CU_DEFAULT_BUCKET): bigint {
  return CU_PUBLISH_MODE === 'raw' ? cu : bucketCU(cu, bucketSize);
}
