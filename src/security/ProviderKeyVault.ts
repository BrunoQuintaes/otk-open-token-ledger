/**
 * VAULT-01 — ProviderKeyVault
 * AES-256-GCM encrypted storage for per-tenant provider API keys.
 *
 * Master key source: OTK_VAULT_MASTER_KEY env var (32-byte hex string or base64).
 * If the env var is absent, a deterministic dev-mode key is used with a console warning.
 *
 * In-memory store: Map<vaultKey(tenantId, provider), ProviderKey>. M24-DYN-10 (H1 lane B / S11): the composite key used
 * to be `${tenantId}:${provider}` without escaping and listing used startsWith(`${tenantId}:`), so tenant "A" reached the
 * entries of a tenant "A:eu" (list, overwrite via provider "eu:openai", delete). The key is now an unambiguous encoding
 * and listing compares the stored tenant id. The map is in memory only (the PostgreSQL table of migration 009 has
 * separate tenant_id/provider columns), so no stored data changes format.
 * Persistence to PostgreSQL is handled by migration 009_provider_keys.sql (VAULT-02).
 *
 * SECURITY: Never log or expose plaintext keys. The only egress of a plaintext key
 * is through `getKey()`, which returns it directly to the caller for immediate use.
 *
 * @module security/ProviderKeyVault
 * @since W8-B VAULT-01
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { getVaultMasterKey } from '../infra/secretsBootstrap.js';

/** Unambiguous map key of (tenant, provider): JSON array encoding, no delimiter collision. */
function vaultKey(tenantId: string, provider: string): string {
  return JSON.stringify([tenantId, provider.toLowerCase()]);
}

/** Stored shape for a single encrypted provider key entry. */
export interface ProviderKey {
  tenantId: string;
  provider: string;
  /** Base64-encoded AES-256-GCM ciphertext */
  encryptedKey: string;
  /** Base64-encoded 16-byte IV */
  iv: string;
  /** Base64-encoded 16-byte GCM authentication tag */
  tag: string;
  createdAt: string;
}

// ─── Dev-mode fallback key (deterministic, NOT secure — only for local dev) ───
const DEV_MODE_KEY = Buffer.alloc(32, 0x42); // 32 bytes of 0x42
const DEV_MODE_WARN =
  '[ProviderKeyVault] WARNING: OTK_VAULT_MASTER_KEY not set — using insecure dev-mode key. DO NOT use in production.';

/**
 * Derive a 32-byte master key from the OTK_VAULT_MASTER_KEY secret.
 * Read via getVaultMasterKey() (secretsBootstrap) — never process.env directly.
 * Accepts hex strings (64 chars) or base64 strings (≥32 bytes decoded).
 * Falls back to a fixed dev-mode key if the secret is absent.
 */
function loadMasterKey(): Buffer {
  const raw = getVaultMasterKey();
  if (!raw) {
    // eslint-disable-next-line no-console
    console.warn(DEV_MODE_WARN);
    return DEV_MODE_KEY;
  }

  // Try hex first (64 hex chars = 32 bytes)
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, 'hex');
  }

  // Try base64
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length >= 32) {
      return decoded.subarray(0, 32);
    }
    // Pad with zeros if shorter than 32 bytes (not recommended — warn)
    // eslint-disable-next-line no-console
    console.warn('[ProviderKeyVault] WARNING: OTK_VAULT_MASTER_KEY decoded to <32 bytes — padding with zeros. Use a 32-byte key.');
    const padded = Buffer.alloc(32);
    decoded.copy(padded);
    return padded;
  } catch {
    // eslint-disable-next-line no-console
    console.warn('[ProviderKeyVault] WARNING: OTK_VAULT_MASTER_KEY is not valid hex or base64 — using dev-mode key.');
    return DEV_MODE_KEY;
  }
}

/**
 * ProviderKeyVault — AES-256-GCM encrypted key storage.
 *
 * Usage:
 *   const vault = new ProviderKeyVault();
 *   vault.storeKey('tenant-42', 'openai', 'sk-...');
 *   const key = vault.getKey('tenant-42', 'openai'); // 'sk-...'
 */
export class ProviderKeyVault {
  private readonly masterKey: Buffer;
  private readonly store: Map<string, ProviderKey> = new Map();

  constructor() {
    this.masterKey = loadMasterKey();
  }

  // ── Encryption primitives ───────────────────────────────────────────────────

  /**
   * Encrypt a plaintext API key with AES-256-GCM.
   * Returns base64-encoded encryptedKey, iv, and tag.
   */
  encrypt(plainKey: string): { encryptedKey: string; iv: string; tag: string } {
    const iv = randomBytes(16);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(plainKey, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return {
      encryptedKey: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
    };
  }

  /**
   * Decrypt a base64-encoded AES-256-GCM ciphertext.
   * Throws if authentication fails (tampered data or wrong key).
   */
  decrypt(encryptedKey: string, iv: string, tag: string): string {
    const ivBuf = Buffer.from(iv, 'base64');
    const tagBuf = Buffer.from(tag, 'base64');
    const cipherBuf = Buffer.from(encryptedKey, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, ivBuf);
    decipher.setAuthTag(tagBuf);
    const decrypted = Buffer.concat([decipher.update(cipherBuf), decipher.final()]);
    return decrypted.toString('utf8');
  }

  // ── Vault CRUD ──────────────────────────────────────────────────────────────

  /**
   * Encrypt and store an API key for a given tenant+provider.
   * Overwrites any existing key for the same tenant+provider.
   */
  storeKey(tenantId: string, provider: string, plainKey: string): void {
    const { encryptedKey, iv, tag } = this.encrypt(plainKey);
    const entry: ProviderKey = {
      tenantId,
      provider: provider.toLowerCase(),
      encryptedKey,
      iv,
      tag,
      createdAt: new Date().toISOString(),
    };
    this.store.set(vaultKey(tenantId, provider), entry);
  }

  /**
   * Retrieve and decrypt the API key for a given tenant+provider.
   * Returns null if no key exists for the combination.
   */
  getKey(tenantId: string, provider: string): string | null {
    const entry = this.store.get(vaultKey(tenantId, provider));
    if (!entry) return null;
    return this.decrypt(entry.encryptedKey, entry.iv, entry.tag);
  }

  /**
   * List all stored providers for a tenant, with keys masked (last 4 chars visible).
   * Safe for display in admin UIs.
   */
  listKeys(tenantId: string): { provider: string; maskedKey: string }[] {
    const results: { provider: string; maskedKey: string }[] = [];
    for (const entry of this.store.values()) {
      if (entry.tenantId !== tenantId) continue;
      let maskedKey = '****';
      try {
        const plain = this.decrypt(entry.encryptedKey, entry.iv, entry.tag);
        maskedKey = plain.length > 4
          ? `${'*'.repeat(plain.length - 4)}${plain.slice(-4)}`
          : '****';
      } catch {
        // If decrypt fails, show redacted placeholder
        maskedKey = '****[error]';
      }
      results.push({ provider: entry.provider, maskedKey });
    }
    return results;
  }

  /**
   * Delete the key for a given tenant+provider.
   * Returns true if a key was found and deleted, false if not found.
   */
  deleteKey(tenantId: string, provider: string): boolean {
    return this.store.delete(vaultKey(tenantId, provider));
  }
}

// ── Module-level singleton ───────────────────────────────────────────────────

let _vaultInstance: ProviderKeyVault | undefined;

/**
 * Return the module-level ProviderKeyVault singleton.
 * The instance is created lazily on first call.
 */
export function getVault(): ProviderKeyVault {
  if (!_vaultInstance) {
    _vaultInstance = new ProviderKeyVault();
  }
  return _vaultInstance;
}

/** Reset the singleton (for tests). */
export function resetVaultForTest(): void {
  _vaultInstance = undefined;
}
