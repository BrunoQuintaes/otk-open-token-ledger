/**
 * H1.6 — Idempotency Keys
 *
 * Idempotency-Key header support for POST endpoints.
 * Duplicate requests with same key return cached response.
 *
 * @module api/idempotency
 * @since Wave 2H (H1.6)
 */

import { createHash } from 'node:crypto';

export interface CachedResponse {
  status: number;
  body: string;
  /** Legacy 32-bit fingerprint (see bodyHash). Still written so older replicas keep working during a rolling deploy. */
  bodyHash: string;
  /**
   * H1R2 C3 (S24-F09): versioned cryptographic fingerprint, `v2:` + SHA-256 (hex) of the UTF-8 body.
   * Authoritative when present; absent on entries written by older replicas (legacy comparison until they expire).
   */
  bodyHashV2?: string;
}

export interface IIdempotencyStore {
  get(key: string): Promise<CachedResponse | null>;
  set(key: string, response: CachedResponse, ttlS: number): Promise<void>;
}

/** In-memory store (fallback when no Redis). */
export class MemoryIdempotencyStore implements IIdempotencyStore {
  private _cache = new Map<string, { response: CachedResponse; expiresAt: number }>();

  async get(key: string): Promise<CachedResponse | null> {
    const entry = this._cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      this._cache.delete(key);
      return null;
    }
    return entry.response;
  }

  async set(key: string, response: CachedResponse, ttlS: number): Promise<void> {
    this._cache.set(key, { response, expiresAt: Date.now() + ttlS * 1000 });
  }

  clear(): void {
    this._cache.clear();
  }
}

const DEFAULT_TTL_S = 86_400; // 24 hours

let _store: IIdempotencyStore = new MemoryIdempotencyStore();

export function getIdempotencyStore(): IIdempotencyStore {
  return _store;
}

export function setIdempotencyStore(store: IIdempotencyStore): void {
  _store = store;
}

/** @deprecated Use setIdempotencyStore */
export const setIdempotencyStoreForTest = setIdempotencyStore;

export function resetIdempotencyStoreForTest(): void {
  _store = new MemoryIdempotencyStore();
}

export function getIdempotencyTtl(): number {
  return Number(process.env['OTK_IDEMPOTENCY_TTL_S'] ?? DEFAULT_TTL_S);
}

/**
 * LEGACY (v1) fingerprint of the request body, kept bit-for-bit for compatibility with stored entries and older
 * replicas. H1R2 C3 (S24-F09): 32 bits and NOT standard FNV-1a (the float64 multiply loses low bits above 2^53), so
 * different bodies collide far more often than 2^-32 per pair; never use it alone to decide a replay — see bodyHashV2.
 */
export function bodyHash(body: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < body.length; i++) {
    h ^= body.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/** H1R2 C3 (S24-F09): versioned collision-resistant fingerprint: `v2:` + SHA-256 hex of the UTF-8 body. */
export function bodyHashV2(body: string): string {
  return `v2:${createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

/** H1R2 C3: v2 decides when the entry has it; otherwise (entry from an older replica) fall back to the legacy hash. */
function sameBody(existing: CachedResponse, requestBody: string): boolean {
  if (typeof existing.bodyHashV2 === 'string' && existing.bodyHashV2.startsWith('v2:')) {
    return existing.bodyHashV2 === bodyHashV2(requestBody);
  }
  return existing.bodyHash === bodyHash(requestBody);
}

/**
 * Check idempotency for a request. Returns:
 * - { cached: true, response } if the key was seen before with same body
 * - { cached: false } if this is a new request (caller should proceed)
 * - { conflict: true } if key was seen with a DIFFERENT body
 */
export async function checkIdempotency(
  key: string | undefined,
  requestBody: string,
): Promise<
  | { cached: true; response: CachedResponse }
  | { cached: false; conflict: false }
  | { cached: false; conflict: true }
> {
  if (!key) return { cached: false, conflict: false };

  const existing = await _store.get(key);
  if (!existing) return { cached: false, conflict: false };

  if (sameBody(existing, requestBody)) {
    return { cached: true, response: existing };
  }
  return { cached: false, conflict: true };
}

/**
 * Store the response for future idempotency checks.
 */
export async function storeIdempotencyResponse(
  key: string | undefined,
  status: number,
  responseBody: string,
  requestBody: string,
): Promise<void> {
  if (!key) return;
  await _store.set(key, {
    status,
    body: responseBody,
    bodyHash: bodyHash(requestBody),
    bodyHashV2: bodyHashV2(requestBody),
  }, getIdempotencyTtl());
}
