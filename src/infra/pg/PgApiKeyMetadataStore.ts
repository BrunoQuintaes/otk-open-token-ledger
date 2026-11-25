/**
 * PgApiKeyMetadataStore — PostgreSQL-backed IApiKeyMetadataStore (Wave 3C)
 *
 * Stores API key metadata in PostgreSQL for cross-instance visibility.
 * Table: otk_api_keys
 *
 * Stores only the hash of each key (`token_hash`), never the key itself. Every method first runs `init()` (create
 * table, indexes and the `created_by` column if missing, once per instance). Query errors propagate to the caller.
 * Installed by `src/infra/storeBootstrap.ts` when PostgreSQL is configured.
 *
 * @module src/infra/pg/PgApiKeyMetadataStore
 * @since Wave 3C (PACK 3C-01)
 */

import type { IApiKeyMetadataStore, ApiKeyMetadata } from '../../api/IApiKeyMetadataStore.js';
import type { TenantRole } from '../../api/tenantKeyRegistry.js';

/** The part of a `pg.Pool` this store uses. */
export interface PgPool {
  /**
   * Runs one parameterized query.
   *
   * @param text - SQL text with `$n` placeholders.
   * @param params - Parameter values.
   * @returns The result rows.
   */
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS otk_api_keys (
  key_id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  label TEXT NOT NULL,
  prefix TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'MEMBER',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  last_used_at TIMESTAMPTZ
)`;

const CREATE_TENANT_INDEX = `
CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON otk_api_keys (tenant_id)`;

const CREATE_HASH_INDEX = `
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON otk_api_keys (token_hash)`;

// H1 lane B (S05 residual): author of the key (additive migration; existing rows keep NULL = no recorded author)
const ADD_CREATED_BY = `
ALTER TABLE otk_api_keys ADD COLUMN IF NOT EXISTS created_by TEXT`;

const CREATE_CREATOR_INDEX = `
CREATE INDEX IF NOT EXISTS idx_api_keys_created_by ON otk_api_keys (created_by)`;

/** `IApiKeyMetadataStore` in the PostgreSQL table `otk_api_keys`. */
export class PgApiKeyMetadataStore implements IApiKeyMetadataStore {
  private readonly _pool: PgPool;
  private _initialized = false;

  /**
   * Wraps a pool; nothing is queried until the first call.
   *
   * @param pool - PostgreSQL pool.
   */
  constructor(pool: PgPool) {
    this._pool = pool;
  }

  /**
   * Creates the table, indexes and columns if missing (idempotent, once per instance).
   *
   * @throws {Error} When a DDL statement fails.
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    await this._pool.query(CREATE_TABLE);
    await this._pool.query(CREATE_TENANT_INDEX);
    await this._pool.query(CREATE_HASH_INDEX);
    await this._pool.query(ADD_CREATED_BY);
    await this._pool.query(CREATE_CREATOR_INDEX);
    this._initialized = true;
  }

  /**
   * Inserts the metadata of a new key.
   *
   * @param meta - Key metadata, including the token hash and role.
   * @throws {Error} When the key id already exists or the query fails.
   */
  async create(meta: ApiKeyMetadata): Promise<void> {
    await this.init();
    await this._pool.query(
      `INSERT INTO otk_api_keys (key_id, tenant_id, label, prefix, token_hash, role, created_at, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [meta.keyId, meta.tenantId, meta.label, meta.prefix, meta.tokenHash, meta.role, meta.createdAt, meta.expiresAt, meta.createdBy ?? null],
    );
  }

  /**
   * Reads one key's metadata, revoked or not.
   *
   * @param keyId - Key id.
   * @returns The metadata, or null when unknown.
   */
  async get(keyId: string): Promise<ApiKeyMetadata | null> {
    await this.init();
    const { rows } = await this._pool.query(`SELECT * FROM otk_api_keys WHERE key_id = $1`, [keyId]);
    if (rows.length === 0) return null;
    return this._toMeta(rows[0]);
  }

  /**
   * Lists a tenant's non-revoked keys, newest first.
   *
   * @param tenantId - Tenant.
   * @param opts - `limit` (default 100) and `offset` (default 0).
   * @returns The page of keys.
   */
  async listByTenant(tenantId: string, opts?: { limit?: number; offset?: number }): Promise<ApiKeyMetadata[]> {
    await this.init();
    const limit = opts?.limit ?? 100;
    const offset = opts?.offset ?? 0;
    const { rows } = await this._pool.query(
      `SELECT * FROM otk_api_keys WHERE tenant_id = $1 AND revoked_at IS NULL
       ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [tenantId, limit, offset],
    );
    return rows.map(r => this._toMeta(r));
  }

  /**
   * Lists the non-revoked keys created by one user, newest first.
   *
   * @param userId - Creator's user id.
   * @returns The keys.
   */
  async listByCreator(userId: string): Promise<ApiKeyMetadata[]> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT * FROM otk_api_keys WHERE created_by = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(r => this._toMeta(r));
  }

  /**
   * Marks a key as revoked now.
   *
   * @param keyId - Key id.
   * @returns The updated metadata, or null when the key is unknown or already revoked.
   */
  async revoke(keyId: string): Promise<ApiKeyMetadata | null> {
    await this.init();
    const { rows } = await this._pool.query(
      `UPDATE otk_api_keys SET revoked_at = NOW()
       WHERE key_id = $1 AND revoked_at IS NULL RETURNING *`,
      [keyId],
    );
    if (rows.length === 0) return null;
    return this._toMeta(rows[0]);
  }

  /**
   * H1R2 R-13: authoritative lookup by token hash (indexed: idx_api_keys_hash); revoked rows are returned too.
   *
   * When several rows share the hash, a revoked one is returned first, then the newest.
   *
   * @param tokenHash - Hash of the presented key.
   * @returns The metadata, or null when no row has that hash.
   */
  async getByHash(tokenHash: string): Promise<ApiKeyMetadata | null> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT * FROM otk_api_keys WHERE token_hash = $1 ORDER BY (revoked_at IS NULL) ASC, created_at DESC LIMIT 1`,
      [tokenHash],
    );
    return rows.length === 0 ? null : this._toMeta(rows[0]);
  }

  /**
   * Sets `last_used_at` to now.
   *
   * @param keyId - Key id.
   */
  async updateLastUsed(keyId: string): Promise<void> {
    await this.init();
    await this._pool.query(
      `UPDATE otk_api_keys SET last_used_at = NOW() WHERE key_id = $1`,
      [keyId],
    );
  }

  /**
   * Sets `last_used_at` to now for every row with this hash.
   *
   * @param tokenHash - Hash of the key.
   */
  async updateLastUsedByHash(tokenHash: string): Promise<void> {
    await this.init();
    await this._pool.query(
      `UPDATE otk_api_keys SET last_used_at = NOW() WHERE token_hash = $1`,
      [tokenHash],
    );
  }

  /** Deletes every row of `otk_api_keys` (tests; destructive). */
  async clear(): Promise<void> {
    await this.init();
    await this._pool.query(`DELETE FROM otk_api_keys`);
  }

  private _validRole(v: unknown): TenantRole {
    const VALID_ROLES = new Set(['OWNER', 'ADMIN', 'OPERATOR', 'MEMBER', 'VIEWER']);
    return VALID_ROLES.has(v as string) ? (v as TenantRole) : 'MEMBER';
  }

  private _toMeta(row: Record<string, unknown>): ApiKeyMetadata {
    return {
      keyId: row.key_id as string,
      tenantId: row.tenant_id as string,
      label: row.label as string,
      prefix: row.prefix as string,
      tokenHash: row.token_hash as string,
      role: this._validRole(row.role),
      createdAt: row.created_at ? new Date(row.created_at as string).toISOString() : new Date().toISOString(),
      expiresAt: row.expires_at ? new Date(row.expires_at as string).toISOString() : null,
      revokedAt: row.revoked_at ? new Date(row.revoked_at as string).toISOString() : null,
      lastUsedAt: row.last_used_at ? new Date(row.last_used_at as string).toISOString() : null,
      createdBy: typeof row.created_by === 'string' && row.created_by ? row.created_by : null,
    };
  }
}
