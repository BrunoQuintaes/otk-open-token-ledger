/**
 * PgTenantTokenStore — PostgreSQL-backed RegistryTokenSource (STOPGATE-01 P1.1, R-13b)
 *
 * Cross-replica state of the static registry tokens managed at runtime (POST/PUT/DELETE /admin/tenants and
 * /admin/tenants/reload). One row per token hash (SHA-256): the token itself is never stored. A revoked row stays revoked
 * unless the same token is registered again explicitly (put). Tokens of OTK_TENANTS that were never changed through the
 * API have no row and are decided by each replica's registry, as before.
 *
 * @module infra/pg/PgTenantTokenStore
 */

import { RegistryTokenConflictError, type RegistryTokenRow, type RegistryTokenSource } from '../../auth/registryTokenAuthority.js';

export interface PgPool {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

const CREATE_TABLE = `
CREATE TABLE IF NOT EXISTS otk_tenant_tokens (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL,
  suspended BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS otk_tenant_tokens_tenant_idx ON otk_tenant_tokens (tenant_id)`;

export class PgTenantTokenStore implements RegistryTokenSource {
  private _initialized = false;
  constructor(private readonly _pool: PgPool) {}

  async init(): Promise<void> {
    if (this._initialized) return;
    await this._pool.query(CREATE_TABLE);
    await this._pool.query(CREATE_INDEX);
    this._initialized = true;
  }

  async getByHash(tokenHash: string): Promise<RegistryTokenRow | null> {
    await this.init();
    const { rows } = await this._pool.query(
      'SELECT tenant_id, role, suspended, revoked_at FROM otk_tenant_tokens WHERE token_hash = $1',
      [tokenHash],
    );
    const r = rows[0];
    if (!r || typeof r.tenant_id !== 'string' || typeof r.role !== 'string') return null;
    return { tenantId: r.tenant_id, role: r.role, suspended: r.suspended === true, revoked: r.revoked_at != null };
  }

  async put(tokenHash: string, tenantId: string, role: string, suspended: boolean): Promise<void> {
    await this.init();
    const { rows } = await this._pool.query(
      `INSERT INTO otk_tenant_tokens (token_hash, tenant_id, role, suspended, revoked_at, updated_at)
       VALUES ($1, $2, $3, $4, NULL, NOW())
       ON CONFLICT (token_hash) DO UPDATE SET
         role = EXCLUDED.role, suspended = EXCLUDED.suspended, revoked_at = NULL, updated_at = NOW()
       WHERE otk_tenant_tokens.tenant_id = EXCLUDED.tenant_id
       RETURNING token_hash`,
      [tokenHash, tenantId, role, suspended],
    );
    // STOPGATE-01 cycle 2 (review MED-3): a row of ANOTHER tenant is never taken over (cross-replica H1-S06)
    if (rows.length === 0) throw new RegistryTokenConflictError();
  }

  async revoke(tokenHash: string, tenantId: string): Promise<void> {
    await this.init();
    // a token of OTK_TENANTS removed by a reload has no row yet: the revocation creates it (role unknown → '')
    await this._pool.query(
      `INSERT INTO otk_tenant_tokens (token_hash, tenant_id, role, suspended, revoked_at, updated_at)
       VALUES ($1, $2, '', FALSE, NOW(), NOW())
       ON CONFLICT (token_hash) DO UPDATE SET revoked_at = COALESCE(otk_tenant_tokens.revoked_at, NOW()), updated_at = NOW()`,
      [tokenHash, tenantId],
    );
  }

  async setTenantSuspended(tenantId: string, suspended: boolean): Promise<void> {
    await this.init();
    await this._pool.query(
      'UPDATE otk_tenant_tokens SET suspended = $2, updated_at = NOW() WHERE tenant_id = $1 AND revoked_at IS NULL',
      [tenantId, suspended],
    );
  }

  async hasTenant(tenantId: string): Promise<boolean> {
    await this.init();
    const { rows } = await this._pool.query(
      'SELECT 1 FROM otk_tenant_tokens WHERE tenant_id = $1 AND revoked_at IS NULL LIMIT 1',
      [tenantId],
    );
    return rows.length > 0;
  }
}
