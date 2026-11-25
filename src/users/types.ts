/**
 * User model types — organizations, users, memberships, invites (NEW-3.09)
 *
 * Data foundation for self-service registration (Wave 3E).
 * Organizations map 1:1 to existing tenantId concept.
 *
 * @module users/types
 * @since Wave 3C (PACK 3C-03)
 */

/**
 * An organization (customer account); its `id` is the tenant ID.
 */
export interface Organization {
  id: string;               // matches tenantId
  name: string;
  slug: string;             // URL-safe org identifier
  plan: string;             // FREE | STARTER | PRO | ENTERPRISE
  /** ISO-8601 creation time. */
  createdAt: string;
  updatedAt: string;
}

/**
 * A user account. Personal data: `email` and `name`; `passwordHash` is a hash, never the password.
 */
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

/**
 * Role of a user inside an organization.
 */
export type MembershipRole = 'OWNER' | 'ADMIN' | 'MEMBER' | 'VIEWER';

/**
 * Link between a user and an organization, with the user's role there.
 */
export interface Membership {
  userId: string;
  orgId: string;
  role: MembershipRole;
  joinedAt: string;
}

/**
 * Lifecycle state of an invitation.
 */
export type InviteStatus = 'pending' | 'accepted' | 'expired' | 'cancelled';

/**
 * Invitation of an e-mail address to join an organization with a role.
 */
export interface Invite {
  id: string;
  orgId: string;
  email: string;
  role: MembershipRole;
  /** User ID of the member who sent the invitation. */
  invitedBy: string;
  status: InviteStatus;
  createdAt: string;
  expiresAt: string;
  /** ISO-8601 time of acceptance; null while not accepted. */
  acceptedAt: string | null;
}
