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

export class MemoryUserStore implements IUserStore {
  private _orgs = new Map<string, Organization>();
  private _users = new Map<string, User>();
  private _memberships: Membership[] = [];
  private _invites = new Map<string, Invite>();

  // -- Organizations --

  async createOrg(org: Organization): Promise<void> {
    this._orgs.set(org.id, org);
  }

  async getOrg(id: string): Promise<Organization | null> {
    return this._orgs.get(id) ?? null;
  }

  async getOrgBySlug(slug: string): Promise<Organization | null> {
    for (const org of this._orgs.values()) {
      if (org.slug === slug) return org;
    }
    return null;
  }

  async listOrgs(opts?: { limit?: number; offset?: number }): Promise<Organization[]> {
    const all = [...this._orgs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 100;
    return all.slice(offset, offset + limit);
  }

  // -- Users --

  async createUser(user: User): Promise<void> {
    this._users.set(user.id, user);
  }

  async getUser(id: string): Promise<User | null> {
    return this._users.get(id) ?? null;
  }

  async getUserByEmail(email: string): Promise<User | null> {
    for (const u of this._users.values()) {
      if (u.email === email) return u;
    }
    return null;
  }

  async updateUser(id: string, updates: Partial<Pick<User, 'name' | 'emailVerified' | 'passwordHash' | 'deprovisionedAt'>>): Promise<User | null> {
    const user = this._users.get(id);
    if (!user) return null;
    const updated = { ...user, ...updates, updatedAt: new Date().toISOString() };
    this._users.set(id, updated);
    return updated;
  }

  // -- Memberships --

  async addMembership(m: Membership): Promise<void> {
    this._memberships.push(m);
  }

  async getMemberships(userId: string): Promise<Membership[]> {
    return this._memberships.filter(m => m.userId === userId);
  }

  async getOrgMembers(orgId: string): Promise<Membership[]> {
    return this._memberships.filter(m => m.orgId === orgId);
  }

  async removeMembership(userId: string, orgId: string): Promise<boolean> {
    const idx = this._memberships.findIndex(m => m.userId === userId && m.orgId === orgId);
    if (idx === -1) return false;
    this._memberships.splice(idx, 1);
    return true;
  }

  // -- Invites --

  async createInvite(invite: Invite): Promise<void> {
    this._invites.set(invite.id, invite);
  }

  async getInvite(id: string): Promise<Invite | null> {
    return this._invites.get(id) ?? null;
  }

  async listInvitesByOrg(orgId: string, status?: InviteStatus): Promise<Invite[]> {
    return [...this._invites.values()].filter(i =>
      i.orgId === orgId && (status ? i.status === status : true),
    );
  }

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

  async clear(): Promise<void> {
    this._orgs.clear();
    this._users.clear();
    this._memberships.length = 0;
    this._invites.clear();
  }
}
