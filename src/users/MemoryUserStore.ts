/**
 * MemoryUserStore — in-memory IUserStore implementation (NEW-3.09)
 *
 * For development, testing, and when OTK_DB_URL is not configured.
 *
 * @module users/MemoryUserStore
 * @since Wave 3C (PACK 3C-03)
 */

import type { IUserStore } from './IUserStore.js';
import type { Organization, User, Membership, Invite, InviteStatus } from './types.js';

/**
 * In-memory {@link IUserStore}; records are stored by reference and lost on restart.
 */
export class MemoryUserStore implements IUserStore {
  private _orgs = new Map<string, Organization>();
  private _users = new Map<string, User>();
  private _memberships: Membership[] = [];
  private _invites = new Map<string, Invite>();

  // -- Organizations --

  /**
   * Stores an organization (replaces one with the same ID).
   *
   * @param org - Organization to store.
   */
  async createOrg(org: Organization): Promise<void> {
    this._orgs.set(org.id, org);
  }

  /**
   * Reads an organization by ID.
   *
   * @param id - Organization (tenant) ID.
   * @returns The organization, or `null`.
   */
  async getOrg(id: string): Promise<Organization | null> {
    return this._orgs.get(id) ?? null;
  }

  /**
   * Reads an organization by slug (exact match).
   *
   * @param slug - URL-safe identifier.
   * @returns The first matching organization, or `null`.
   */
  async getOrgBySlug(slug: string): Promise<Organization | null> {
    for (const org of this._orgs.values()) {
      if (org.slug === slug) return org;
    }
    return null;
  }

  /**
   * Lists organizations, newest first.
   *
   * @param opts - `offset` (default 0) and `limit` (default 100).
   * @returns One page of organizations.
   */
  async listOrgs(opts?: { limit?: number; offset?: number }): Promise<Organization[]> {
    const all = [...this._orgs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 100;
    return all.slice(offset, offset + limit);
  }

  // -- Users --

  /**
   * Stores a user (replaces one with the same ID).
   *
   * @param user - User to store.
   */
  async createUser(user: User): Promise<void> {
    this._users.set(user.id, user);
  }

  /**
   * Reads a user by ID.
   *
   * @param id - User ID.
   * @returns The user, or `null`.
   */
  async getUser(id: string): Promise<User | null> {
    return this._users.get(id) ?? null;
  }

  /**
   * Reads a user by e-mail (exact, case-sensitive match).
   *
   * @param email - E-mail address.
   * @returns The first matching user, or `null`.
   */
  async getUserByEmail(email: string): Promise<User | null> {
    for (const u of this._users.values()) {
      if (u.email === email) return u;
    }
    return null;
  }

  /**
   * Applies a partial update and refreshes `updatedAt`.
   *
   * @param id - User ID.
   * @param updates - Fields to change.
   * @returns The updated user (a new object), or `null` when the ID is unknown.
   */
  async updateUser(id: string, updates: Partial<Pick<User, 'name' | 'emailVerified' | 'passwordHash' | 'deprovisionedAt'>>): Promise<User | null> {
    const user = this._users.get(id);
    if (!user) return null;
    const updated = { ...user, ...updates, updatedAt: new Date().toISOString() };
    this._users.set(id, updated);
    return updated;
  }

  // -- Memberships --

  /**
   * Adds a membership (no duplicate check).
   *
   * @param m - Membership to add.
   */
  async addMembership(m: Membership): Promise<void> {
    this._memberships.push(m);
  }

  /**
   * Lists a user's memberships.
   *
   * @param userId - User ID.
   * @returns The memberships, in insertion order.
   */
  async getMemberships(userId: string): Promise<Membership[]> {
    return this._memberships.filter(m => m.userId === userId);
  }

  /**
   * Lists an organization's memberships.
   *
   * @param orgId - Organization ID.
   * @returns The memberships, in insertion order.
   */
  async getOrgMembers(orgId: string): Promise<Membership[]> {
    return this._memberships.filter(m => m.orgId === orgId);
  }

  /**
   * Removes the first membership of a user in an organization.
   *
   * @param userId - User ID.
   * @param orgId - Organization ID.
   * @returns `true` when a membership was removed.
   */
  async removeMembership(userId: string, orgId: string): Promise<boolean> {
    const idx = this._memberships.findIndex(m => m.userId === userId && m.orgId === orgId);
    if (idx === -1) return false;
    this._memberships.splice(idx, 1);
    return true;
  }

  // -- Invites --

  /**
   * Stores an invitation (replaces one with the same ID).
   *
   * @param invite - Invitation to store.
   */
  async createInvite(invite: Invite): Promise<void> {
    this._invites.set(invite.id, invite);
  }

  /**
   * Reads an invitation by ID.
   *
   * @param id - Invitation ID.
   * @returns The invitation, or `null`.
   */
  async getInvite(id: string): Promise<Invite | null> {
    return this._invites.get(id) ?? null;
  }

  /**
   * Lists an organization's invitations, optionally only those with one status.
   *
   * @param orgId - Organization ID.
   * @param status - Status filter; all statuses when absent.
   * @returns The matching invitations.
   */
  async listInvitesByOrg(orgId: string, status?: InviteStatus): Promise<Invite[]> {
    return [...this._invites.values()].filter(i =>
      i.orgId === orgId && (status ? i.status === status : true),
    );
  }

  /**
   * Changes an invitation's status; `accepted` also sets `acceptedAt` to now.
   *
   * @param id - Invitation ID.
   * @param status - New status (no transition rule is enforced).
   * @returns The updated invitation (a new object), or `null` when the ID is unknown.
   */
  async updateInviteStatus(id: string, status: InviteStatus): Promise<Invite | null> {
    const invite = this._invites.get(id);
    if (!invite) return null;
    const updated = {
      ...invite,
      status,
      acceptedAt: status === 'accepted' ? new Date().toISOString() : invite.acceptedAt,
    };
    this._invites.set(id, updated);
    return updated;
  }

  // -- Maintenance --

  /**
   * Deletes every record.
   */
  async clear(): Promise<void> {
    this._orgs.clear();
    this._users.clear();
    this._memberships.length = 0;
    this._invites.clear();
  }
}
