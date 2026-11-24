/**
 * SecretsManager — abstract secrets provider with local adapter (E2.1)
 *
 * Interface: ISecretsProvider { getSecret, setSecret, listKeys }
 * LocalSecretsProvider: reads from env vars with OTK_SECRET_ prefix.
 * Future: AWS KMS, HashiCorp Vault adapters via the same interface.
 *
 * Design constraints:
 * - NEVER logs secret values
 * - NEVER returns secrets in error messages
 * - Local provider is env-based (zero external deps)
 *
 * @module security/SecretsManager
 * @since Wave 1 Pack 9 (E2.1)
 */

/** Prefix for env-based secret keys. */
const ENV_PREFIX = 'OTK_SECRET_';

/**
 * Abstract secrets provider interface.
 * Implementations MUST NOT leak secret values in logs/errors.
 */
export interface ISecretsProvider {
  /** Retrieve a secret by key. Returns undefined if not found. */
  getSecret(key: string): Promise<string | undefined>;

  /** Store a secret. Local provider stores in-memory (not persisted to env). */
  setSecret(key: string, value: string): Promise<void>;

  /** List all known secret keys (NOT values). */
  listKeys(): Promise<string[]>;

  /** Provider name (for diagnostics). */
  readonly providerName: string;
}

/**
 * LocalSecretsProvider — reads secrets from environment variables.
 *
 * Env var format: OTK_SECRET_<KEY> = value
 * Keys are normalized to uppercase with OTK_SECRET_ prefix when reading from env.
 * setSecret() stores in-memory overlay (does NOT mutate process.env).
 */
export class LocalSecretsProvider implements ISecretsProvider {
  readonly providerName = 'local-env';

  /** In-memory overlay — set via setSecret(), takes priority over env. */
  private readonly overlay = new Map<string, string>();

  /** Optional env reader (injectable for testing). */
  private readonly envReader: () => Record<string, string | undefined>;

  constructor(options?: { envReader?: () => Record<string, string | undefined> }) {
    this.envReader = options?.envReader ?? (() => process.env as Record<string, string | undefined>);
  }

  async getSecret(key: string): Promise<string | undefined> {
    // Overlay first (set via setSecret)
    const overlayValue = this.overlay.get(key);
    if (overlayValue !== undefined) return overlayValue;

    // Then env vars
    const envKey = ENV_PREFIX + key.toUpperCase();
    const env = this.envReader();
    return env[envKey];
  }

  async setSecret(key: string, value: string): Promise<void> {
    this.overlay.set(key, value);
  }

  async listKeys(): Promise<string[]> {
    const env = this.envReader();
    const envKeys = Object.keys(env)
      .filter(k => k.startsWith(ENV_PREFIX) && env[k] !== undefined)
      .map(k => k.slice(ENV_PREFIX.length));

    const overlayKeys = Array.from(this.overlay.keys());

    // Merge and deduplicate
    const allKeys = new Set([...envKeys, ...overlayKeys.map(k => k.toUpperCase())]);
    return Array.from(allKeys).sort();
  }

  /** Clear overlay (for testing only). */
  clearOverlayForTest(): void {
    this.overlay.clear();
  }
}

// ── Singleton ───────────────────────────────────────────────

let _provider: ISecretsProvider | undefined;

/**
 * Get or create the process-level secrets provider singleton.
 * Defaults to LocalSecretsProvider.
 */
export function getSecretsProvider(): ISecretsProvider {
  if (!_provider) {
    _provider = new LocalSecretsProvider();
  }
  return _provider;
}

/**
 * Override the singleton provider (for testing or advanced configuration).
 */
export function setSecretsProviderForTest(provider: ISecretsProvider | undefined): void {
  _provider = provider;
}
