/**
 * IUserStore — interface for user/org/membership CRUD (NEW-3.09)
 *
 * @module users/IUserStore
 * @since Wave 3C (PACK 3C-03)
 */

import type { Organization, User, Membership, Invite, InviteStatus } from './types.js';

export interface IUserStore {
  // Organizations
  createOrg(org: Organization): Promise<void>;
  getOrg(id: string): Promise<Organization | null>;
  getOrgBySlug(slug: string): Promise<Organization | null>;
  listOrgs(opts?: { limit?: number; offset?: number }): Promise<Organization[]>;

  // Users
  createUser(user: User): Promise<void>;
  getUser(id: string): Promise<User | null>;
  getUserByEmail(email: string): Promise<User | null>;
  updateUser(id: string, updates: Partial<Pick<User, 'name' | 'emailVerified' | 'passwordHash' | 'deprovisionedAt'>>): Promise<User | null>;

  // Memberships
  addMembership(membership: Membership): Promise<void>;
  getMemberships(userId: string): Promise<Membership[]>;
  getOrgMembers(orgId: string): Promise<Membership[]>;
  removeMembership(userId: string, orgId: string): Promise<boolean>;

  // Invites
  createInvite(invite: Invite): Promise<void>;
  getInvite(id: string): Promise<Invite | null>;
  listInvitesByOrg(orgId: string, status?: InviteStatus): Promise<Invite[]>;
  updateInviteStatus(id: string, status: InviteStatus): Promise<Invite | null>;

  // Maintenance
  clear(): Promise<void>;
}

let _store: IUserStore | null = null;
export function getUserStore(): IUserStore | null { return _store; }
export function setUserStore(store: IUserStore): void { _store = store; }
export function resetUserStoreForTest(): void { _store = null; }
