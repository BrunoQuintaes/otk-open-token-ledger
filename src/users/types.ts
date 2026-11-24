/**
 * User model types — organizations, users, memberships, invites (NEW-3.09)
 *
 * Data foundation for self-service registration (Wave 3E).
 * Organizations map 1:1 to existing tenantId concept.
 *
 * @module users/types
 * @since Wave 3C (PACK 3C-03)
 */

export interface Organization {
  id: string;               // matches tenantId
  name: string;
  slug: string;             // URL-safe org identifier
  plan: string;             // FREE | STARTER | PRO | ENTERPRISE
  createdAt: string;
  updatedAt: string;
}

export interface User {
  id: string;
  email: string;
  emailVerified: boolean;
  name: string;
  passwordHash: string | null;  // nullable for SSO-only users (Wave 4)
  /** H1-S05 (SEC02-N04): ISO instant of SCIM deprovisioning; set = no login, no JWT accepted. null/absent = active. */
  deprovisionedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type MembershipRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

export interface Membership {
  userId: string;
  orgId: string;
  role: MembershipRole;
  joinedAt: string;
}

export type InviteStatus = 'pending' | 'accepted' | 'expired' | 'cancelled';

export interface Invite {
  id: string;
  orgId: string;
  email: string;
  role: MembershipRole;
  invitedBy: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
}
