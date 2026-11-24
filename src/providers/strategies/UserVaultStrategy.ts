/**
 * UserVaultStrategy — Per-user BYOK key resolution via ProviderKeyVault (VAULT-06)
 *
 * Resolves provider API keys from the AES-256-GCM encrypted ProviderKeyVault,
 * keyed by userId (tenantId). Enables multi-tenant BYOK scenarios.
 *
 * If no key is found for the given tenant+provider combination, throws an error
 * with a descriptive message to guide the caller.
 */

import { KeyStrategy } from "./KeyStrategy.js";
import { ProviderKeyVault } from "../../security/ProviderKeyVault.js";

/** Singleton vault instance shared across strategy instances. */
const _vault = new ProviderKeyVault();

export class UserVaultStrategy implements KeyStrategy {
  private readonly vault: ProviderKeyVault;

  constructor(vault?: ProviderKeyVault) {
    this.vault = vault ?? _vault;
  }

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

  /** Expose the underlying vault for direct key management (storeKey, listKeys, etc.). */
  getVault(): ProviderKeyVault {
    return this.vault;
  }
}
