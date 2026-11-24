/**
 * Provider Router — Multi-provider orchestration
 * Part of U7 multi-provider integration (skeleton implementation)
 */

import { IProviderClient } from "./IProviderClient.js";
import { ProviderResponse } from "./types.js";

export interface RouterPolicy {
  fallbackEnabled: boolean;
  fallbackOrder?: string[]; // provider names in fallback order
  rateLimitPerProvider?: Record<string, number>; // requests per minute
  cacheEnabled?: boolean;
}

export class ProviderRouter {
  private providers: Map<string, IProviderClient> = new Map();
  private policy: RouterPolicy;
  private meteringHooks: ((event: any) => void)[] = [];

  constructor(policy: RouterPolicy = { fallbackEnabled: false }) {
    this.policy = policy;
  }

  /**
   * Register a provider client
   */
  registerProvider(provider: IProviderClient): void {
    this.providers.set(provider.getName(), provider);
  }

  /**
   * Register a metering hook (called after each request)
   */
  onMetering(hook: (event: any) => void): void {
    this.meteringHooks.push(hook);
  }

  /**
   * Route a request to the appropriate provider (with fallback)
   */
  async route(
    providerName: string,
    prompt: string,
    options?: Record<string, any>
  ): Promise<ProviderResponse> {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider not registered: ${providerName}`);
    }

    try {
      const response = await provider.request(prompt, options);

      // Emit metering event if present
      if (response.meteringEvent) {
        this.meteringHooks.forEach((hook) => hook(response.meteringEvent));
      }

      // If request failed and fallback enabled, try fallback
      if (!response.success && this.policy.fallbackEnabled) {
        return this.fallback(providerName, prompt, options);
      }

      return response;
    } catch (error) {
      // On error, try fallback if enabled
      if (this.policy.fallbackEnabled) {
        return this.fallback(providerName, prompt, options);
      }
      throw error;
    }
  }

  /**
   * Fallback to next available provider
   */
  private async fallback(
    failedProvider: string,
    prompt: string,
    options?: Record<string, any>
  ): Promise<ProviderResponse> {
    const fallbackOrder = this.policy.fallbackOrder || [];
    const nextProvider = fallbackOrder.find((name) => name !== failedProvider);

    if (!nextProvider) {
      return {
        success: false,
        error: "All providers failed, no fallback available",
      };
    }

    const provider = this.providers.get(nextProvider);
    if (!provider) {
      return {
        success: false,
        error: `Fallback provider not found: ${nextProvider}`,
      };
    }

    return provider.request(prompt, options);
  }

  /**
   * Get aggregated metrics across all providers
   */
  getAggregatedMetrics(): Record<string, any> {
    const metrics: Record<string, any> = {};
    this.providers.forEach((provider, name) => {
      metrics[name] = provider.getMetrics();
    });
    return metrics;
  }
}
