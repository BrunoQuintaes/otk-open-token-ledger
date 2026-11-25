/**
 * U3.1 — Provider Price Table (USD per 1K tokens)
 *
 * Versioned deterministic price table.
 * No external calls. Update version tag when prices change.
 *
 * Static estimates for reports (`CostBridge.ts`), not the frozen, versioned price tables used to settle
 * money in the durable runtime (`src/pricing/priceUsage.ts`). Keys are lower case; Gemini models are listed
 * under both `google` and `gemini`.
 *
 * @module src/pricing/economics/ProviderPriceTable
 */

/** Price of one model in USD per 1000 tokens (floating point). */
export type ModelPrice = {
  inputUsdPer1K: number;
  outputUsdPer1K: number;
};

/** Version label of {@link PROVIDER_PRICE_TABLE}. */
export const PRICE_TABLE_VERSION = "2026-04";

/** Provider → model → price (lower-case keys). */
export const PROVIDER_PRICE_TABLE: Readonly<Record<string, Record<string, ModelPrice>>> = {
  openai: {
    "gpt-4o":        { inputUsdPer1K: 0.005,    outputUsdPer1K: 0.015 },
    "gpt-4o-mini":   { inputUsdPer1K: 0.00015,  outputUsdPer1K: 0.0006 },
    "gpt-4-turbo":   { inputUsdPer1K: 0.010,    outputUsdPer1K: 0.030 },
    "gpt-4":         { inputUsdPer1K: 0.030,    outputUsdPer1K: 0.060 },
    "gpt-3.5-turbo": { inputUsdPer1K: 0.0005,   outputUsdPer1K: 0.0015 },
    "o1-preview":    { inputUsdPer1K: 0.015,    outputUsdPer1K: 0.060 },
    "o1-mini":       { inputUsdPer1K: 0.003,    outputUsdPer1K: 0.012 },
  },
  anthropic: {
    "claude-opus-4":            { inputUsdPer1K: 0.015,   outputUsdPer1K: 0.075 },
    "claude-sonnet-4-20250514": { inputUsdPer1K: 0.003,   outputUsdPer1K: 0.015 },
    "claude-sonnet-4":          { inputUsdPer1K: 0.003,   outputUsdPer1K: 0.015 },
    "claude-sonnet-4-6":        { inputUsdPer1K: 0.003,   outputUsdPer1K: 0.015 },
    "claude-haiku-4":           { inputUsdPer1K: 0.00025, outputUsdPer1K: 0.00125 },
    "claude-haiku-4-5":         { inputUsdPer1K: 0.00025, outputUsdPer1K: 0.00125 },
  },
  google: {
    "gemini-2.0-flash": { inputUsdPer1K: 0.000075, outputUsdPer1K: 0.0003 },
    "gemini-1.5-pro":   { inputUsdPer1K: 0.00125,  outputUsdPer1K: 0.005 },
    "gemini-1.5-flash": { inputUsdPer1K: 0.000075, outputUsdPer1K: 0.0003 },
    "gemini-pro":       { inputUsdPer1K: 0.000125, outputUsdPer1K: 0.000375 },
    "gemini-ultra":     { inputUsdPer1K: 0.001250, outputUsdPer1K: 0.003750 },
  },
  gemini: {
    "gemini-2.0-flash": { inputUsdPer1K: 0.000075, outputUsdPer1K: 0.0003 },
    "gemini-1.5-pro":   { inputUsdPer1K: 0.00125,  outputUsdPer1K: 0.005 },
    "gemini-1.5-flash": { inputUsdPer1K: 0.000075, outputUsdPer1K: 0.0003 },
    "gemini-pro":       { inputUsdPer1K: 0.000125, outputUsdPer1K: 0.000375 },
    "gemini-ultra":     { inputUsdPer1K: 0.001250, outputUsdPer1K: 0.003750 },
  },
};
