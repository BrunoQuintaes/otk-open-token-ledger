/**
 * Cost Weights — Compatibility Facade (U5.2)
 *
 * This module is a backward-compatible facade over CostUnits.ts.
 * All CU computation now delegates to the deterministic bigint engine.
 *
 * Legacy float weight tables are retained for reference/display only.
 * The canonical source-of-truth for computation is CostUnits.ts.
 *
 * @deprecated Import from CostUnits.ts for new code.
 */

import {
  calculateCostUnitsV1Number,
  isProviderSupported as _isProviderSupported,
  isModelSupported as _isModelSupported,
  getSupportedProviders as _getSupportedProviders,
  getSupportedModels as _getSupportedModels,
} from './CostUnits.js';

// ---------------------------------------------------------------------------
// Legacy float weight tables (retained for display / backward compat)
// ---------------------------------------------------------------------------

/** @deprecated Use PROVIDER_WEIGHTS_INT from CostUnits.ts for computation. */
export const PROVIDER_WEIGHTS: Record<string, number> = {
  openai: 1.0,
  anthropic: 1.1,
  gemini: 0.9,
  deepseek: 0.8,
  cohere: 0.85,
  mistral: 0.9,
  meta: 0.75,
};

/** @deprecated Use MODEL_WEIGHTS_INT from CostUnits.ts for computation. */
export const MODEL_WEIGHTS: Record<string, number> = {
  // OpenAI
  'gpt-4o': 1.0,
  'gpt-4o-mini': 0.4,
  'gpt-4-turbo': 1.5,
  'gpt-4': 2.0,
  'gpt-3.5-turbo': 0.5,
  'o1-preview': 2.5,
  'o1-mini': 1.2,
  'o1': 2.0,           // o1 stable
  'o3': 3.0,           // o3 — high-tier reasoning
  'o3-mini': 1.5,      // o3-mini — mid-tier reasoning

  // Anthropic
  'claude-opus-4': 2.0,
  'claude-opus-4-5': 2.0,   // v4.5
  'claude-opus-4-6': 2.0,   // v4.6
  'claude-sonnet-4': 1.5,
  'claude-sonnet-4-5': 1.5, // v4.5
  'claude-sonnet-4-6': 1.5, // v4.6 — current production model
  'claude-haiku-4': 0.8,
  'claude-haiku-4-5': 0.8,  // v4.5
  'claude-3-opus': 1.8,
  'claude-3-sonnet': 1.3,
  'claude-3-haiku': 0.7,

  // Google Gemini
  'gemini-2.0-flash': 0.6,
  'gemini-pro': 1.2,
  'gemini-ultra': 2.2,

  // DeepSeek
  'deepseek-coder': 1.0,
  'deepseek-chat': 0.9,

  // Cohere
  'command-r-plus': 1.4,
  'command-r': 1.0,
  'command': 0.8,

  // Mistral
  'mistral-large': 1.6,
  'mistral-medium': 1.2,
  'mistral-small': 0.9,

  // Meta Llama
  'llama-3-70b': 1.1,
  'llama-3-8b': 0.6,
};

// ---------------------------------------------------------------------------
// Facade functions (delegate to CostUnits.ts)
// ---------------------------------------------------------------------------

/**
 * Calculate enterprise cost units (facade — delegates to CostUnits.ts bigint engine).
 *
 * @param provider Provider identifier
 * @param model Model identifier
 * @param inputTokens Input token count
 * @param outputTokens Output token count
 * @returns Cost units (integer)
 * @throws Error if provider or model is unknown
 */
export function calculateCostUnits(
  provider: string,
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  return calculateCostUnitsV1Number({ provider, model, inputTokens, outputTokens });
}

/** Check if provider is supported */
export function isProviderSupported(provider: string): boolean {
  return _isProviderSupported(provider);
}

/** Check if model is supported */
export function isModelSupported(model: string): boolean {
  return _isModelSupported(model);
}

/** Get all supported providers */
export function getSupportedProviders(): string[] {
  return _getSupportedProviders();
}

/** Get all supported models */
export function getSupportedModels(): string[] {
  return _getSupportedModels();
}
