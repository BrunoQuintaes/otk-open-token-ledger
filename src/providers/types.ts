/**
 * Provider Adapter Layer — Type Definitions
 * Part of U7 multi-provider integration (skeleton implementation)
 */

export interface ProviderConfig {
  name: string;
  apiKey?: string;
  baseURL?: string;
  timeout?: number;
  retryAttempts?: number;
}

export interface MeteringEvent {
  timestamp: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUnits: number; // normalized cost metric
  requestId: string;
  userId?: string;
}

export interface ProviderResponse {
  success: boolean;
  data?: any;
  error?: string;
  meteringEvent?: MeteringEvent;
}

export interface ProviderMetrics {
  totalRequests: number;
  successRate: number;
  avgLatency: number;
  totalCostUnits: number;
}

/**
 * Normalized Usage Event — canonical output from all provider adapters (U7.5)
 *
 * Every provider adapter MUST produce this exact shape.
 * CU is computed via CostUnits.ts (deterministic bigint engine).
 */
export interface NormalizedUsageEvent {
  /** Provider identifier (lowercase canonical: 'openai', 'anthropic', etc.) */
  provider: string;
  /** Model identifier (lowercase canonical: 'gpt-4o', 'claude-sonnet-4', etc.) */
  model: string;
  /** Input tokens consumed */
  inputTokens: number;
  /** Output tokens generated */
  outputTokens: number;
  /** Total tokens (inputTokens + outputTokens) */
  totalTokens: number;
  /** Request latency in milliseconds */
  latencyMs: number;
  /** Normalized cost units (from CostUnits.ts) */
  costUnits: number;
  /** Unix timestamp in seconds */
  timestamp: number;
  /** Provider-assigned request identifier (if available) */
  requestId: string;
}

/**
 * Adapter parse error — stable error for malformed provider responses
 */
export class AdapterParseError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdapterParseError';
    this.code = code;
  }
}

export const ADAPTER_ERROR = {
  MISSING_USAGE: 'ADAPTER_MISSING_USAGE',
  MISSING_MODEL: 'ADAPTER_MISSING_MODEL',
  INVALID_TOKENS: 'ADAPTER_INVALID_TOKENS',
} as const;

/**
 * IProviderAdapter — contract every provider adapter MUST implement (U11.1)
 *
 * Decouples provider-specific parsing from calling code.
 * All adapters return a NormalizedUsageEvent with CU computed via CostUnits.ts.
 */
export interface IProviderAdapter {
  /** Canonical provider ID (lowercase, e.g. 'openai', 'anthropic', 'gemini') */
  readonly providerId: string;
  /**
   * Parse a raw API response into a NormalizedUsageEvent.
   * @param raw       Raw JSON object from provider API
   * @param latencyMs Round-trip latency in milliseconds
   * @param timestamp Unix timestamp in seconds (required by adapters that lack it in response)
   */
  parseResponse(raw: unknown, latencyMs: number, timestamp: number): NormalizedUsageEvent;
}

/**
 * Minimal usage input shape for stub adapters (Gemini, DeepSeek — U11.1 stubs).
 * Real API response shapes will replace this in U12.
 */
export interface GenericUsageInput {
  id: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * ProviderRegistry error — thrown on unregistered or duplicate providers
 */
export class RegistryError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RegistryError';
    this.code = code;
  }
}

export const REGISTRY_ERROR = {
  PROVIDER_NOT_FOUND: 'REGISTRY_PROVIDER_NOT_FOUND',
  DUPLICATE_PROVIDER: 'REGISTRY_DUPLICATE_PROVIDER',
} as const;
