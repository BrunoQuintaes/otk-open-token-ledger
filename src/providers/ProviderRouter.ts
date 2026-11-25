/**
 * Provider Router — Multi-provider orchestration
 * Part of U7 multi-provider integration (skeleton implementation)
 *
 * Routes a prompt to a registered `IProviderClient`, optionally falling back to another one, and passes
 * each response's metering event to the registered hooks. In-memory only; it reads no configuration.
 * Note that `rateLimitPerProvider` and `cacheEnabled` in the policy are stored but not used by this class.
 *
 * @module src/providers/ProviderRouter
 */

import { IProviderClient } from "./IProviderClient.js";
import { ProviderResponse } from "./types.js";

/**
 * Routing policy for `ProviderRouter`.
 */
export interface RouterPolicy {
  fallbackEnabled: boolean;
  fallbackOrder?: string[]; // provider names in fallback order
  rateLimitPerProvider?: Record<string, number>; // requests per minute
  cacheEnabled?: boolean;
}

/**
 * Routes prompts to named provider clients, with an optional single-step fallback.
 *
 * Metering hooks are called synchronously, in registration order, with the response's `meteringEvent`
 * (only when the response carries one).
 */
export class ProviderRouter {
  private providers: Map<string, IProviderClient> = new Map();
  private policy: RouterPolicy;
  private meteringHooks: ((event: any) => void)[] = [];

  constructor(policy: RouterPolicy = { fallbackEnabled: false }) {
    this.policy = policy;
  }

  /**
   * Register a provider client
   * @param provider - Client to register under `provider.getName()`; a client with the same name is replaced.
   */
  registerProvider(provider: IProviderClient): void {
    this.providers.set(provider.getName(), provider);
  }

  /**
   * Register a metering hook (called after each request)
   * @param hook - Callback that receives each response's `meteringEvent`.
   */
  onMetering(hook: (event: any) => void): void {
    this.meteringHooks.push(hook);
  }

  /**
   * Route a request to the appropriate provider (with fallback)
   * @param providerName - Name of the registered provider to try first.
   * @param prompt - Prompt text, passed unchanged to the provider.
   * @param options - Provider-specific options, passed unchanged.
   * @returns The provider response, or the fallback provider's response when the first one failed and
   *   fallback is enabled (a `{ success: false, error }` object when no fallback provider is usable).
   * @throws {Error} When `providerName` is not registered (checked before any fallback), or when the provider
   *   throws and fallback is disabled.
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
   * @param failedProvider - Name of the provider that failed; it is skipped.
   * @param prompt - Prompt text to resend.
   * @param options - Provider-specific options to resend.
   * @returns The first other provider's response from `fallbackOrder`; only one fallback attempt is made.
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
   * @returns An object keyed by provider name with each provider's `getMetrics()` result.
   */
  getAggregatedMetrics(): Record<string, any> {
    const metrics: Record<string, any> = {};
    this.providers.forEach((provider, name) => {
      metrics[name] = provider.getMetrics();
    });
    return metrics;
  }
}
