/**
 * API Key Manager — key generation, hashing, CRUD orchestration (NEW-3.06)
 *
 * Keys are generated with format: otk_k_<32 hex chars>
 * Stored as SHA-256 hash in ITokenStore for auth resolution.
 * Metadata (public info only) stored in IApiKeyMetadataStore.
 *
 * @module api/apiKeyManager
 * @since Wave 3C (PACK 3C-01)
 */

import crypto from 'node:crypto';
import type { TenantRole } from './tenantKeyRegistry.js';
import { registerTokenByHash, revokeTokenByHash } from './tenantKeyRegistry.js';
import { getTokenStore } from './ITokenStore.js';
import { getApiKeyMetadataStore, type ApiKeyMetadata } from './IApiKeyMetadataStore.js';
import { getDispatcher } from '../publisher/runtime.js';
import { buildEnvelope } from '../publisher/deliveryTypes.js';

const KEY_PREFIX = 'otk_k_';
const KEY_RANDOM_BYTES = 32;

/** Result of creating a new API key — includes the raw key (shown once). */
export interface ApiKeyCreateResult {
  keyId: string;
  rawKey: string;       // full key — returned ONLY at creation time
  prefix: string;
  tenantId: string;
  label: string;
  role: TenantRole;
  createdAt: string;
  expiresAt: string | null;
}

/** Generate a new API key string. */
function generateRawKey(): string {
  return KEY_PREFIX + crypto.randomBytes(KEY_RANDOM_BYTES).toString('hex');
}

/** SHA-256 hash of a raw key (for token store lookup). */
export function hashKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/** Extract display prefix from a raw key. */
function keyPrefix(rawKey: string): string {
  return rawKey.slice(0, KEY_PREFIX.length + 8);
}

/** Generate a unique key ID (collision-free UUID). */
function generateKeyId(): string {
  return `key_${crypto.randomUUID()}`;
}

/**
 * Create a new API key for a tenant.
 * Returns the raw key — this is the ONLY time it is available in plaintext.
 */
export async function createApiKey(
  tenantId: string,
  label: string,
  role: TenantRole,
  expiresAt?: string | null,
  /** H1 lane B (S05 residual): user id of the JWT that mints the key; omitted/null = no user author */
  createdBy?: string | null,
): Promise<ApiKeyCreateResult> {
  const rawKey = generateRawKey();
  const hash = hashKey(rawKey);
  const keyId = generateKeyId();
  const now = new Date().toISOString();

  // Store hash in token store for auth resolution (persistent / Redis-backed)
  await getTokenStore().register(hash, {
    tenantId,
    role,
    registeredAt: now,
  });

  // Register in synchronous hash registry for fast in-process auth lookup
  registerTokenByHash(hash, { tenantId, role, expiresAt: expiresAt ?? null, createdAt: now, createdBy: createdBy ?? null });

  // Store metadata (no raw key, no hash exposure)
  const meta: ApiKeyMetadata = {
    keyId,
    tenantId,
    label,
    prefix: keyPrefix(rawKey),
    tokenHash: hash,
    role,
    createdAt: now,
    expiresAt: expiresAt ?? null,
    revokedAt: null,
    lastUsedAt: null,
    createdBy: createdBy ?? null,
  };
  await getApiKeyMetadataStore().create(meta);

  // Emit event
  getDispatcher().emit(buildEnvelope('key_created', 'api_key_manager', {
    keyId, tenantId, label, role,
  }));

  return {
    keyId,
    rawKey,
    prefix: meta.prefix,
    tenantId,
    label,
    role,
    createdAt: now,
    expiresAt: expiresAt ?? null,
  };
}

/** Public projection — strips tokenHash from API responses. */
function toPublic(meta: ApiKeyMetadata): Omit<ApiKeyMetadata, 'tokenHash'> {
  const { tokenHash: _, ...pub } = meta;
  return pub;
}

/** Get key metadata by keyId (public projection, no tokenHash). */
export async function getApiKey(keyId: string): Promise<Omit<ApiKeyMetadata, 'tokenHash'> | null> {
  const meta = await getApiKeyMetadataStore().get(keyId);
  return meta ? toPublic(meta) : null;
}

/** List active keys for a tenant (public projection, no tokenHash). */
export async function listApiKeys(
  tenantId: string,
  opts?: { limit?: number; offset?: number },
): Promise<Omit<ApiKeyMetadata, 'tokenHash'>[]> {
  const list = await getApiKeyMetadataStore().listByTenant(tenantId, opts);
  return list.map(toPublic);
}

/** Revoke a key — soft-delete in metadata, remove from token store. */
export async function revokeApiKey(keyId: string): Promise<Omit<ApiKeyMetadata, 'tokenHash'> | null> {
  const meta = await getApiKeyMetadataStore().revoke(keyId);
  if (!meta) return null;

  // Remove from token store + synchronous hash registry
  await getTokenStore().revoke(meta.tokenHash);
  revokeTokenByHash(meta.tokenHash);

  getDispatcher().emit(buildEnvelope('key_revoked', 'api_key_manager', {
    keyId, tenantId: meta.tenantId,
  }));

  return toPublic(meta);
}

/**
 * Rotate a key — revoke old, create new with same tenant/label/role. The author of the new key is the caller that
 * rotates it (`createdBy`, H1 lane B), not the author of the old key: the new raw key is revealed to the caller only.
 */
export async function rotateApiKey(keyId: string, createdBy?: string | null): Promise<ApiKeyCreateResult | null> {
  const oldMeta = await getApiKeyMetadataStore().get(keyId);
  if (!oldMeta || oldMeta.revokedAt) return null;

  // Revoke the old key
  await revokeApiKey(keyId);

  // Create a new key with the same parameters
  const result = await createApiKey(
    oldMeta.tenantId,
    oldMeta.label,
    oldMeta.role as TenantRole,
    oldMeta.expiresAt,
    createdBy ?? null,
  );

  getDispatcher().emit(buildEnvelope('key_rotated', 'api_key_manager', {
    oldKeyId: keyId, newKeyId: result.keyId, tenantId: oldMeta.tenantId,
  }));

  return result;
}

/**
 * H1 lane B (S05 residual): revoke every active key whose author is `userId` (SCIM deprovisioning). Durable: the
 * metadata store (PostgreSQL when configured) is the source of the list; each key is revoked in the metadata store, the
 * token store and the local hash registry. Other replicas refuse the keys through the author status (auth/subjectStatus).
 * Returns the revoked key ids.
 */
export async function revokeApiKeysCreatedBy(userId: string): Promise<string[]> {
  const revoked: string[] = [];
  for (const meta of await getApiKeyMetadataStore().listByCreator(userId)) {
    if (await revokeApiKey(meta.keyId)) revoked.push(meta.keyId);
  }
  return revoked;
}

/**
 * H1 lane B (S05 residual): active keys of a tenant without a recorded author (registry-token keys, keys minted before
 * authorship was recorded). Deprovisioning never guesses their author; they are listed for operator review.
 */
export async function listUnattributedApiKeys(tenantId: string): Promise<Omit<ApiKeyMetadata, 'tokenHash'>[]> {
  const out: Omit<ApiKeyMetadata, 'tokenHash'>[] = [];
  const page = 100;
  for (let offset = 0; ; offset += page) {
    const list = await getApiKeyMetadataStore().listByTenant(tenantId, { limit: page, offset });
    for (const m of list) if (!m.createdBy) out.push(toPublic(m));
    if (list.length < page) break;
  }
  return out;
}

/**
 * H1 lane B, POLICY PENDING (D4): revoke (durably) the active keys of a tenant minted at or before `throughIso` — the
 * deactivation instant — when the tenant is reactivated without restoreKeys. Second granularity, conservative (a key
 * minted in the same second as the deactivation is revoked). Returns the revoked key ids.
 */
export async function revokeApiKeysOfTenantThrough(tenantId: string, throughIso: string): Promise<string[]> {
  const throughS = Math.floor(Date.parse(throughIso) / 1000);
  if (!Number.isFinite(throughS)) return [];
  const victims: string[] = [];
  const page = 100;
  for (let offset = 0; ; offset += page) {
    const list = await getApiKeyMetadataStore().listByTenant(tenantId, { limit: page, offset });
    for (const m of list) if (Math.floor(Date.parse(m.createdAt) / 1000) <= throughS) victims.push(m.keyId);
    if (list.length < page) break;
  }
  const revoked: string[] = [];
  for (const id of victims) if (await revokeApiKey(id)) revoked.push(id);
  return revoked;
}
