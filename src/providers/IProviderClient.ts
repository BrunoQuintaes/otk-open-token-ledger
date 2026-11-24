/**
 * Provider Adapter Layer — Interface Definition
 * Part of U7 multi-provider integration (skeleton implementation)
 */

import { ProviderConfig, ProviderResponse, ProviderMetrics } from "./types.js";

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
