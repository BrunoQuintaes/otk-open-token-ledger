/**
 * UserVaultStrategy — Per-user BYOK key resolution via ProviderKeyVault (VAULT-06)
 *
 * Resolves provider API keys from the AES-256-GCM encrypted ProviderKeyVault,
 * keyed by userId (tenantId). Enables multi-tenant BYOK scenarios.
 *
 * If no key is found for the given tenant+provider combination, throws an error
 * with a descriptive message to guide the caller.
 *
 * Side effect at import: creates one shared `ProviderKeyVault`, whose constructor loads the vault master
 * key (see `src/security/ProviderKeyVault.ts`). The proxy does not use this strategy.
 *
 * @module src/providers/strategies/UserVaultStrategy
 */

import { KeyStrategy } from "./KeyStrategy.js";
import { ProviderKeyVault } from "../../security/ProviderKeyVault.js";

/** Singleton vault instance shared across strategy instances. */
const _vault = new ProviderKeyVault();

/**
 * Key strategy that reads a per-tenant key from a {@link ProviderKeyVault} (bring-your-own-key).
 */
export class UserVaultStrategy implements KeyStrategy {
  private readonly vault: ProviderKeyVault;

  constructor(vault?: ProviderKeyVault) {
    this.vault = vault ?? _vault;
  }

  /**
   * Returns the decrypted key stored for this tenant and provider.
   *
   * @param provider - Provider name, passed to the vault as given.
   * @param userId - Tenant ID; when absent the tenant `default` is used.
   * @returns The decrypted API key; callers must never log it.
   * @throws {Error} When the vault has no key for that tenant and provider.
   */
  async resolve(provider: string, userId?: string): Promise<string> {
    const tenantId = userId ?? 'default';
    const key = this.vault.getKey(tenantId, provider);
    if (key === null) {
      throw new Error(
        `UserVaultStrategy: no key stored for tenant '${tenantId}' / provider '${provider}'. ` +
        `Store a key via vault.storeKey('${tenantId}', '${provider}', '<api-key>').`
      );
    }
    return key;
  }

  /**
   * Expose the underlying vault for direct key management (storeKey, listKeys, etc.).
   *
   * @returns The vault this strategy reads from (the injected one or the shared one).
   */
  getVault(): ProviderKeyVault {
    return this.vault;
  }
}
