/**
 * PgUserStore — PostgreSQL-backed IUserStore (Wave 3C)
 *
 * Tables: otk_organizations, otk_users, otk_memberships, otk_invites
 *
 * Installed by `src/infra/storeBootstrap.ts`. Every method first runs `init()` (creates the four tables, the
 * `deprovisioned_at` column and the indexes if missing). Stores only password hashes. Query errors propagate,
 * including unique violations (duplicate e-mail or slug) and foreign-key violations.
 *
 * @module src/infra/pg/PgUserStore
 * @since Wave 3C (PACK 3C-03)
 */

import type { IUserStore } from '../../users/IUserStore.js';
import type { Organization, User, Membership, Invite, InviteStatus } from '../../users/types.js';

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

const INIT_SQL = [
  `CREATE TABLE IF NOT EXISTS otk_organizations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    plan TEXT NOT NULL DEFAULT 'FREE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  `CREATE TABLE IF NOT EXISTS otk_users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    email_verified BOOLEAN NOT NULL DEFAULT FALSE,
    name TEXT NOT NULL,
    password_hash TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,
  // H1-S05 (SEC02-N04): deprovisioned state of a user (SCIM DELETE); additive, idempotent
  `ALTER TABLE otk_users ADD COLUMN IF NOT EXISTS deprovisioned_at TIMESTAMPTZ`,
  `CREATE TABLE IF NOT EXISTS otk_memberships (
    user_id TEXT NOT NULL REFERENCES otk_users(id),
    org_id TEXT NOT NULL REFERENCES otk_organizations(id),
    role TEXT NOT NULL DEFAULT 'MEMBER',
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (user_id, org_id)
  )`,
  `CREATE TABLE IF NOT EXISTS otk_invites (
    id TEXT PRIMARY KEY,
    org_id TEXT NOT NULL REFERENCES otk_organizations(id),
    email TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'MEMBER',
    invited_by TEXT NOT NULL REFERENCES otk_users(id),
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ
  )`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON otk_users (email)`,
  `CREATE INDEX IF NOT EXISTS idx_memberships_user ON otk_memberships (user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_memberships_org ON otk_memberships (org_id)`,
  `CREATE INDEX IF NOT EXISTS idx_invites_org ON otk_invites (org_id)`,
  `CREATE INDEX IF NOT EXISTS idx_orgs_slug ON otk_organizations (slug)`,
];

/** `IUserStore` over organizations, users, memberships and invites in PostgreSQL. */
export class PgUserStore implements IUserStore {
  private readonly _pool: PgPool;
  private _initialized = false;

  /**
   * Wraps a pool; nothing is queried until the first call.
   *
   * @param pool - PostgreSQL pool.
   */
  constructor(pool: PgPool) { this._pool = pool; }

  /**
   * Creates tables, columns and indexes if missing (idempotent, once per instance).
   *
   * @throws {Error} When a DDL statement fails.
   */
  async init(): Promise<void> {
    if (this._initialized) return;
    for (const sql of INIT_SQL) await this._pool.query(sql);
    this._initialized = true;
  }

  // -- Organizations --

  /**
   * Inserts an organization.
   *
   * @param org - Organization to create.
   */
  async createOrg(org: Organization): Promise<void> {
    await this.init();
    await this._pool.query(
      `INSERT INTO otk_organizations (id, name, slug, plan, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6)`,
      [org.id, org.name, org.slug, org.plan, org.createdAt, org.updatedAt],
    );
  }

  /**
   * Reads an organization by id.
   *
   * @param id - Organization id.
   * @returns The organization, or null.
   */
  async getOrg(id: string): Promise<Organization | null> {
    await this.init();
    const { rows } = await this._pool.query(`SELECT * FROM otk_organizations WHERE id = $1`, [id]);
    return rows.length ? this._toOrg(rows[0]) : null;
  }

  /**
   * Reads an organization by slug.
   *
   * @param slug - Unique slug.
   * @returns The organization, or null.
   */
  async getOrgBySlug(slug: string): Promise<Organization | null> {
    await this.init();
    const { rows } = await this._pool.query(`SELECT * FROM otk_organizations WHERE slug = $1`, [slug]);
    return rows.length ? this._toOrg(rows[0]) : null;
  }

  /**
   * Lists organizations, newest first.
   *
   * @param opts - `limit` (default 100) and `offset` (default 0).
   * @returns The page of organizations.
   */
  async listOrgs(opts?: { limit?: number; offset?: number }): Promise<Organization[]> {
    await this.init();
    const { rows } = await this._pool.query(
      `SELECT * FROM otk_organizations ORDER BY created_at DESC LIMIT $1 OFFSET $2`,
      [opts?.limit ?? 100, opts?.offset ?? 0],
    );
    return rows.map(r => this._toOrg(r));
  }

  // -- Users --

  /**
   * Inserts a user.
   *
   * @param user - User to create (password already hashed, or null).
   */
  async createUser(user: User): Promise<void> {
    await this.init();
    await this._pool.query(
      `INSERT INTO otk_users (id, email, email_verified, name, password_hash, created_at, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [user.id, user.email, user.emailVerified, user.name, user.passwordHash, user.createdAt, user.updatedAt],
    );
  }

  /**
   * Reads a user by id.
   *
   * @param id - User id.
   * @returns The user, or null.
   */
  async getUser(id: string): Promise<User | null> {
    await this.init();
    const { rows } = await this._pool.query(`SELECT * FROM otk_users WHERE id = $1`, [id]);
    return rows.length ? this._toUser(rows[0]) : null;
  }

  /**
   * Reads a user by e-mail (exact match, case-sensitive).
   *
   * @param email - E-mail address.
   * @returns The user, or null.
   */
  async getUserByEmail(email: string): Promise<User | null> {
    await this.init();
    const { rows } = await this._pool.query(`SELECT * FROM otk_users WHERE email = $1`, [email]);
    return rows.length ? this._toUser(rows[0]) : null;
  }

  /**
   * Updates the given fields of a user and sets `updated_at` to now.
   *
   * @param id - User id.
   * @param updates - Fields to change; undefined fields are left as they are.
   * @returns The updated user, or null when unknown.
   */
  async updateUser(id: string, updates: Partial<Pick<User, 'name' | 'emailVerified' | 'passwordHash' | 'deprovisionedAt'>>): Promise<User | null> {
    await this.init();
    const sets: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;
    if (updates.name !== undefined) { sets.push(`name = $${idx++}`); params.push(updates.name); }
    if (updates.emailVerified !== undefined) { sets.push(`email_verified = $${idx++}`); params.push(updates.emailVerified); }
    if (updates.passwordHash !== undefined) { sets.push(`password_hash = $${idx++}`); params.push(updates.passwordHash); }
    if (updates.deprovisionedAt !== undefined) { sets.push(`deprovisioned_at = $${idx++}`); params.push(updates.deprovisionedAt); }
    params.push(id);
    const { rows } = await this._pool.query(
      `UPDATE otk_users SET ${sets.join(', ')} WHERE id = $${idx} RETURNING *`, params,
    );
    return rows.length ? this._toUser(rows[0]) : null;
  }

  // -- Memberships --

  /**
   * Adds a user to an organization.
   *
   * @param m - Membership to create.
   */
  async addMembership(m: Membership): Promise<void> {
    await this.init();
    await this._pool.query(
      `INSERT INTO otk_memberships (user_id, org_id, role, joined_at) VALUES ($1,$2,$3,$4)`,
      [m.userId, m.orgId, m.role, m.joinedAt],
    );
  }

  /**
   * Lists a user's memberships.
   *
   * @param userId - User id.
   * @returns The memberships.
   */
  async getMemberships(userId: string): Promise<Membership[]> {
    await this.init();
    const { rows } = await this._pool.query(`SELECT * FROM otk_memberships WHERE user_id = $1`, [userId]);
    return rows.map(r => this._toMembership(r));
  }

  /**
   * Lists an organization's memberships.
   *
   * @param orgId - Organization id.
   * @returns The memberships.
   */
  async getOrgMembers(orgId: string): Promise<Membership[]> {
    await this.init();
    const { rows } = await this._pool.query(`SELECT * FROM otk_memberships WHERE org_id = $1`, [orgId]);
    return rows.map(r => this._toMembership(r));
  }

  /**
   * Removes a user from an organization.
   *
   * @param userId - User id.
   * @param orgId - Organization id.
   * @returns True when a membership was removed.
   */
  async removeMembership(userId: string, orgId: string): Promise<boolean> {
    await this.init();
    const { rows } = await this._pool.query(
      `DELETE FROM otk_memberships WHERE user_id = $1 AND org_id = $2 RETURNING *`, [userId, orgId],
    );
    return rows.length > 0;
  }

  // -- Invites --

  /**
   * Inserts an invite.
   *
   * @param invite - Invite to create.
   */
  async createInvite(invite: Invite): Promise<void> {
    await this.init();
    await this._pool.query(
      `INSERT INTO otk_invites (id, org_id, email, role, invited_by, status, created_at, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [invite.id, invite.orgId, invite.email, invite.role, invite.invitedBy, invite.status, invite.createdAt, invite.expiresAt],
    );
  }

  /**
   * Reads an invite by id.
   *
   * @param id - Invite id.
   * @returns The invite, or null.
   */
  async getInvite(id: string): Promise<Invite | null> {
    await this.init();
    const { rows } = await this._pool.query(`SELECT * FROM otk_invites WHERE id = $1`, [id]);
    return rows.length ? this._toInvite(rows[0]) : null;
  }

  /**
   * Lists an organization's invites, newest first.
   *
   * @param orgId - Organization id.
   * @param status - Only invites with this status, when given.
   * @returns The invites.
   */
  async listInvitesByOrg(orgId: string, status?: InviteStatus): Promise<Invite[]> {
    await this.init();
    const params: unknown[] = [orgId];
    let sql = `SELECT * FROM otk_invites WHERE org_id = $1`;
    if (status) { sql += ` AND status = $2`; params.push(status); }
    sql += ` ORDER BY created_at DESC`;
    const { rows } = await this._pool.query(sql, params);
    return rows.map(r => this._toInvite(r));
  }

  /**
   * Sets an invite's status (`accepted` also records `accepted_at`).
   *
   * @param id - Invite id.
   * @param status - New status.
   * @returns The updated invite, or null when unknown.
   */
  async updateInviteStatus(id: string, status: InviteStatus): Promise<Invite | null> {
    await this.init();
    const sql = status === 'accepted'
      ? `UPDATE otk_invites SET status = $1, accepted_at = NOW() WHERE id = $2 RETURNING *`
      : `UPDATE otk_invites SET status = $1 WHERE id = $2 RETURNING *`;
    const { rows } = await this._pool.query(sql, [status, id]);
    return rows.length ? this._toInvite(rows[0]) : null;
  }

  /** Deletes every row of the four tables (tests; destructive). */
  async clear(): Promise<void> {
    await this.init();
    await this._pool.query(`DELETE FROM otk_invites`);
    await this._pool.query(`DELETE FROM otk_memberships`);
    await this._pool.query(`DELETE FROM otk_users`);
    await this._pool.query(`DELETE FROM otk_organizations`);
  }

  // -- Mappers --

  // A missing timestamp becomes "now" rather than failing the read.
  private _ts(v: unknown): string {
    return v ? new Date(v as string).toISOString() : new Date().toISOString();
  }

  private _toOrg(r: Record<string, unknown>): Organization {
    return { id: r.id as string, name: r.name as string, slug: r.slug as string, plan: r.plan as string, createdAt: this._ts(r.created_at), updatedAt: this._ts(r.updated_at) };
  }

  private _toUser(r: Record<string, unknown>): User {
    return { id: r.id as string, email: r.email as string, emailVerified: r.email_verified as boolean, name: r.name as string, passwordHash: (r.password_hash as string) ?? null, deprovisionedAt: r.deprovisioned_at ? this._ts(r.deprovisioned_at) : null, createdAt: this._ts(r.created_at), updatedAt: this._ts(r.updated_at) };
  }

  private _toMembership(r: Record<string, unknown>): Membership {
    return { userId: r.user_id as string, orgId: r.org_id as string, role: r.role as Membership['role'], joinedAt: this._ts(r.joined_at) };
  }

  private _toInvite(r: Record<string, unknown>): Invite {
    return { id: r.id as string, orgId: r.org_id as string, email: r.email as string, role: r.role as Invite['role'], invitedBy: r.invited_by as string, status: r.status as Invite['status'], createdAt: this._ts(r.created_at), expiresAt: this._ts(r.expires_at), acceptedAt: r.accepted_at ? this._ts(r.accepted_at) : null };
  }
}
