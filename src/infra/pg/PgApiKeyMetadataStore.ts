/**
 * PgApiKeyMetadataStore — PostgreSQL-backed IApiKeyMetadataStore (Wave 3C)
 *
 * Stores API key metadata in PostgreSQL for cross-instance visibility.
 * Table: otk_api_keys
 *
 * @module infra/pg/PgApiKeyMetadataStore
 * @since Wave 3C (PACK 3C-01)
 */

import type { IApiKeyMetadataStore, ApiKeyMetadata } from '../../api/IApiKeyMetadataStore.js';
import type { TenantRole } from '../../api/tenantKeyRegistry.js';

export interface PgPool {
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

export class PgApiKeyMetadataStore implements IApiKeyMetadataStore {
  private readonly _pool: PgPool;
  private _initialized = false;

  constructor(pool: PgPool) {
    this._pool = pool;
  }

  async init(): Promise<void> {
    if (this._initialized) return;
    await this._pool.query(CREATE_TABLE);
    await this._pool.query(CREATE_TENANT_INDEX);
    await this._pool.query(CREATE_HASH_INDEX);
    await this._pool.query(ADD_CREATED_BY);
    await this._pool.query(CREATE_CREATOR_INDEX);
    this._initialized = true;
  }

  async create(meta: ApiKeyMetadata): Promise<void> {
    await this.init();
    await this._pool.query(
      `INSERT INTO otk_api_keys (key_id, tenant_id, label, prefix, token_hash, role, created_at, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [meta.keyId, meta.tenantId, meta.label, meta.prefix, meta.tokenHash, meta.role, meta.createdAt, meta.expiresAt, meta.createdBy ?? null],
    );
  }

  async get(keyId: string): Promise<ApiKeyMetadata | null> {
    await this.init();
    const { rows } = await this._pool.query(`SELECT * FROM otk_api_keys WHERE key_id = $1`, [keyId]);
    if (rows.length === 0) return null;
    return this._toMeta(rows[0]);
  }

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

  async listByCreator(userId: string): Promise<ApiKeyMetadata[]> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT * FROM otk_api_keys WHERE created_by = $1 AND revoked_at IS NULL ORDER BY created_at DESC`,
      [userId],
    );
    return rows.map(r => this._toMeta(r));
  }

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

  /** H1R2 R-13: authoritative lookup by token hash (indexed: idx_api_keys_hash); revoked rows are returned too. */
  async getByHash(tokenHash: string): Promise<ApiKeyMetadata | null> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT * FROM otk_api_keys WHERE token_hash = $1 ORDER BY (revoked_at IS NULL) ASC, created_at DESC LIMIT 1`,
      [tokenHash],
    );
    return rows.length === 0 ? null : this._toMeta(rows[0]);
  }

  async updateLastUsed(keyId: string): Promise<void> {
    await this.init();
    await this._pool.query(
      `UPDATE otk_api_keys SET last_used_at = NOW() WHERE key_id = $1`,
      [keyId],
    );
  }

  async updateLastUsedByHash(tokenHash: string): Promise<void> {
    await this.init();
    await this._pool.query(
      `UPDATE otk_api_keys SET last_used_at = NOW() WHERE token_hash = $1`,
      [tokenHash],
    );
  }

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
