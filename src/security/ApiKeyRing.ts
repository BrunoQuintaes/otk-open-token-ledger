/**
 * RB-058 — API Key Management (minimum)
 *
 * In-memory KeyRing for enterprise scaffolding.
 * NEVER log real keys. This module provides interfaces for future vault backends.
 *
 * TenantId is imported from TenantIsolation (canonical source — RB-057).
 *
 * @module security/ApiKeyRing
 * @since RB-058
 */

import { type TenantId } from './TenantIsolation.js';

export type { TenantId };

/**
 * Provider name as used in key references (free text, e.g. `openai`).
 */
export type ProviderName = string;

/**
 * Reference to a stored API key: tenant, provider and key ID (never the secret itself).
 */
export type ApiKeyRef = {
  tenantId: TenantId;
  provider: ProviderName;
  keyId: string; // reference only (not the secret)
};

/**
 * Storage backend for provider API keys, keyed by {@link ApiKeyRef}.
 */
export interface IApiKeyStore {
  put(ref: ApiKeyRef, secret: string): void;
  get(ref: ApiKeyRef): string | null;
  del(ref: ApiKeyRef): void;
}

/**
 * Process-memory key store (default); contents are lost on restart and not encrypted.
 */
export class InMemoryApiKeyStore implements IApiKeyStore {
  private readonly m = new Map<string, string>();
  private k(ref: ApiKeyRef): string { return `${ref.tenantId}::${ref.provider}::${ref.keyId}`; }
  /**
   * Stores (or replaces) the secret for a reference.
   *
   * @param ref - Key reference.
   * @param secret - Key value; kept in memory as given.
   */
  put(ref: ApiKeyRef, secret: string): void { this.m.set(this.k(ref), secret); }
  /**
   * Reads a stored secret.
   *
   * @param ref - Key reference.
   * @returns The secret, or `null` when none is stored.
   */
  get(ref: ApiKeyRef): string | null { return this.m.get(this.k(ref)) ?? null; }
  /**
   * Removes a stored secret (no error when absent).
   *
   * @param ref - Key reference.
   */
  del(ref: ApiKeyRef): void { this.m.delete(this.k(ref)); }
}

// H2.2: Singleton with pluggable backend
let _keyStore: IApiKeyStore = new InMemoryApiKeyStore();

/**
 * Returns the process-wide key store.
 *
 * @returns The current store (in-memory unless replaced with {@link setApiKeyStore}).
 */
export function getApiKeyStore(): IApiKeyStore { return _keyStore; }
/**
 * Replaces the process-wide key store.
 *
 * @param store - New backend; existing keys are not copied.
 */
export function setApiKeyStore(store: IApiKeyStore): void { _keyStore = store; }
/**
 * Restores an empty in-memory key store (tests only).
 */
export function resetApiKeyStoreForTest(): void { _keyStore = new InMemoryApiKeyStore(); }
