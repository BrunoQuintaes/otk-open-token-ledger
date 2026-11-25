/**
 * KeyStrategy — Interface for API key resolution strategies (U7.7.1)
 *
 * Separates key acquisition from provider usage.
 * Implementations: GlobalKeyStrategy, UserVaultStrategy (future).
 *
 * @module src/providers/strategies/KeyStrategy
 */

/**
 * Strategy that turns a provider name (and optionally a user) into an API key.
 */
export interface KeyStrategy {
  /**
   * Resolve the API key for a given provider.
   *
   * @param provider - Canonical provider name ('openai', 'anthropic', etc.)
   * @param userId   - Optional user ID for BYOK strategies
   * @returns Resolved API key string
   * @throws Error if key cannot be resolved
   */
  resolve(provider: string, userId?: string): Promise<string>;
}
