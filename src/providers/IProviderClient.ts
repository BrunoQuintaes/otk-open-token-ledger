/**
 * Provider Adapter Layer — Interface Definition
 * Part of U7 multi-provider integration (skeleton implementation)
 *
 * Contract for a provider client that both sends a prompt and reports metrics. It belongs to an
 * early multi-provider skeleton: only `ProviderRouter` and `gateway/ProviderGateway` refer to it; the
 * metered proxy path uses the adapters in `adapters/` and the proxy modules instead.
 *
 * @module src/providers/IProviderClient
 */

import { ProviderConfig, ProviderResponse, ProviderMetrics } from "./types.js";

/**
 * A provider client: sends prompts to one AI provider and reports its own health and metrics.
 *
 * Implementations own the network call and the API key; this interface says nothing about retries,
 * streaming or how metering events are computed.
 */
export interface IProviderClient {
  /**
   * Initialize the provider client with configuration
   */
  initialize(config: ProviderConfig): Promise<void>;

  /**
   * Send a request to the AI provider
   * @param prompt - The user prompt/message
   * @param options - Provider-specific options (model, temperature, etc.)
   */
  request(prompt: string, options?: Record<string, any>): Promise<ProviderResponse>;

  /**
   * Get current metrics for this provider
   */
  getMetrics(): ProviderMetrics;

  /**
   * Health check - verify provider is accessible
   */
  healthCheck(): Promise<boolean>;

  /**
   * Get provider name/identifier
   */
  getName(): string;
}
