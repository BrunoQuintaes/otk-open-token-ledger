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

export type ProviderName = string;

export type ApiKeyRef = {
  tenantId: TenantId;
  provider: ProviderName;
  keyId: string; // reference only (not the secret)
};

export interface IApiKeyStore {
  put(ref: ApiKeyRef, secret: string): void;
  get(ref: ApiKeyRef): string | null;
  del(ref: ApiKeyRef): void;
}

export class InMemoryApiKeyStore implements IApiKeyStore {
  private readonly m = new Map<string, string>();
  private k(ref: ApiKeyRef): string { return `${ref.tenantId}::${ref.provider}::${ref.keyId}`; }
  put(ref: ApiKeyRef, secret: string): void { this.m.set(this.k(ref), secret); }
  get(ref: ApiKeyRef): string | null { return this.m.get(this.k(ref)) ?? null; }
  del(ref: ApiKeyRef): void { this.m.delete(this.k(ref)); }
}

// H2.2: Singleton with pluggable backend
let _keyStore: IApiKeyStore = new InMemoryApiKeyStore();

export function getApiKeyStore(): IApiKeyStore { return _keyStore; }
export function setApiKeyStore(store: IApiKeyStore): void { _keyStore = store; }
export function resetApiKeyStoreForTest(): void { _keyStore = new InMemoryApiKeyStore(); }
