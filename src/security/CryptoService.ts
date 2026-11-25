/**
 * CryptoService — Base abstraction for symmetric encryption of sensitive data (U7.7.4)
 *
 * Provides an interface for encrypt/decrypt operations.
 * Concrete implementations (AES-256-GCM, KMS-backed, etc.) extend this base.
 *
 * Status: Base class with abstract methods — no production implementation yet.
 *
 * Not used by the vault (`ProviderKeyVault.ts` has its own AES-256-GCM code); kept as an extension point.
 *
 * @module src/security/CryptoService
 */

/**
 * Abstract encrypt/decrypt service; implementations choose the algorithm and the text encoding.
 */
export abstract class CryptoService {
  /**
   * Encrypt plaintext data.
   * @param data - Plaintext string to encrypt
   * @returns Opaque encrypted string (implementation-defined encoding)
   */
  abstract encrypt(data: string): Promise<string>;

  /**
   * Decrypt previously encrypted data.
   * @param data - Opaque encrypted string
   * @returns Original plaintext string
   */
  abstract decrypt(data: string): Promise<string>;
}
