/**
 * PgTenantTokenStore — PostgreSQL-backed RegistryTokenSource (STOPGATE-01 P1.1, R-13b)
 *
 * Cross-replica state of the static registry tokens managed at runtime (POST/PUT/DELETE /admin/tenants and
 * /admin/tenants/reload). One row per token hash (SHA-256): the token itself is never stored. A revoked row stays revoked
 * unless the same token is registered again explicitly (put). Tokens of OTK_TENANTS that were never changed through the
 * API have no row and are decided by each replica's registry, as before.
 *
 * Installed by `src/infra/storeBootstrap.ts`; read by `src/auth/registryTokenAuthority.ts`. Every method first runs
 * `init()`. Query errors propagate.
 *
 * @module src/infra/pg/PgTenantTokenStore
 */

import { RegistryTokenConflictError, type RegistryTokenRow, type RegistryTokenSource } from '../../auth/registryTokenAuthority.js';

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
CREATE TABLE IF NOT EXISTS otk_tenant_tokens (
  token_hash TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  role TEXT NOT NULL,
  suspended BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;
const CREATE_INDEX = `CREATE INDEX IF NOT EXISTS otk_tenant_tokens_tenant_idx ON otk_tenant_tokens (tenant_id)`;

/** `RegistryTokenSource` in the PostgreSQL table `otk_tenant_tokens`. */
export class PgTenantTokenStore implements RegistryTokenSource {
  private _initialized = false;
  /**
   * Wraps a pool; nothing is queried until the first call.
   *
   * @param _pool - PostgreSQL pool.
   */
  constructor(private readonly _pool: PgPool) {}

  /**
   * Creates the table and index if missing (idempotent, once per instance).
   *
   * @throws {Error} When a DDL statement fails.
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    await this._pool.query(CREATE_TABLE);
    await this._pool.query(CREATE_INDEX);
    this._initialized = true;
  }

  /**
   * Reads the stored state of a token hash.
   *
   * @param tokenHash - SHA-256 of the token.
   * @returns Tenant, role, suspended and revoked flags, or null when there is no (valid) row.
   */
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

  /**
   * Registers or re-registers a token for its tenant (clears a previous revocation).
   *
   * @param tokenHash - SHA-256 of the token.
   * @param tenantId - Owning tenant.
   * @param role - Role of the token.
   * @param suspended - Whether the tenant is suspended.
   * @throws {@link RegistryTokenConflictError} When the hash already belongs to another tenant.
   */
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

  /**
   * Marks a token as revoked (keeps the first revocation time); creates the row when missing.
   *
   * @param tokenHash - SHA-256 of the token.
   * @param tenantId - Tenant recorded when the row is created (an existing row keeps its tenant).
   */
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

  /**
   * Sets the suspended flag on every non-revoked token of a tenant.
   *
   * @param tenantId - Tenant.
   * @param suspended - New flag.
   */
  async setTenantSuspended(tenantId: string, suspended: boolean): Promise<void> {
    await this.init();
    await this._pool.query(
      'UPDATE otk_tenant_tokens SET suspended = $2, updated_at = NOW() WHERE tenant_id = $1 AND revoked_at IS NULL',
      [tenantId, suspended],
    );
  }

  /**
   * Tells whether the tenant has at least one non-revoked token row.
   *
   * @param tenantId - Tenant.
   * @returns True when such a row exists.
   */
  async hasTenant(tenantId: string): Promise<boolean> {
    await this.init();
    const { rows } = await this._pool.query(
      'SELECT 1 FROM otk_tenant_tokens WHERE tenant_id = $1 AND revoked_at IS NULL LIMIT 1',
      [tenantId],
    );
    return rows.length > 0;
  }
}
