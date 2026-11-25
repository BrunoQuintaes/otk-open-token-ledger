/**
 * ProviderGateway — Centralized key resolution and provider access control (U7.7.5)
 *
 * The ProviderGateway is the single entry point for obtaining API keys.
 * It delegates to a pluggable KeyStrategy (GlobalKeyStrategy, UserVaultStrategy, etc.)
 * and ensures no direct process.env access occurs in provider or adapter code.
 *
 * Usage:
 *   const gateway = new ProviderGateway(new GlobalKeyStrategy());
 *   const key = await gateway.resolveKey('openai');
 *   // Use key to configure IProviderClient — never log it
 *
 * Note: the metered proxy (`src/proxy/ProxyGateway.ts`) uses `GlobalKeyStrategy` directly, not this class.
 *
 * @module src/providers/gateway/ProviderGateway
 */

import { KeyStrategy } from "../strategies/KeyStrategy.js";

/**
 * Resolves provider API keys through one injected {@link KeyStrategy}; it holds no keys itself.
 */
export class ProviderGateway {
  private readonly keyStrategy: KeyStrategy;

  constructor(keyStrategy: KeyStrategy) {
    this.keyStrategy = keyStrategy;
  }

  /**
   * Resolve the API key for a provider.
   *
   * @param provider - Canonical provider name ('openai', 'anthropic', etc.)
   * @param userId   - Optional user ID (for future BYOK strategies)
   * @returns Resolved API key
   * @throws Error if the strategy cannot resolve the key
   */
  async resolveKey(provider: string, userId?: string): Promise<string> {
    return this.keyStrategy.resolve(provider, userId);
  }
}
