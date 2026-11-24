/**
 * ScimUserAdapter — SCIM 2.0 ↔ IUserStore translation layer (NEW-4.04)
 *
 * Converts between SCIM 2.0 User format and internal User/Organization types.
 *
 * @module auth/scim/ScimUserAdapter
 * @since Wave 4 (4D-PACK-4D02 / NEW-4.04)
 */

import type { User, Organization } from '../../users/types.js';

// ──────────────────────────────────────────────────────────
// SCIM 2.0 Types
// ──────────────────────────────────────────────────────────

export interface ScimName {
  formatted?: string;
  givenName?: string;
  familyName?: string;
}

export interface ScimEmail {
  value: string;
  primary?: boolean;
  type?: string;
}

export interface ScimMeta {
  resourceType: string;
  created?: string;
  lastModified?: string;
  location?: string;
}

export interface ScimUser {
  schemas: string[];
  id?: string;
  externalId?: string;
  userName: string;
  name?: ScimName;
  displayName?: string;
  emails?: ScimEmail[];
  active?: boolean;
  meta?: ScimMeta;
}

export interface ScimGroup {
  schemas: string[];
  id?: string;
  displayName: string;
  members?: Array<{ value: string; display?: string }>;
  meta?: ScimMeta;
}

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

export interface ScimError {
  schemas: string[];
  scimType?: string;
  detail: string;
  status: number;
}

// ──────────────────────────────────────────────────────────
// SCIM ↔ User conversions
// ──────────────────────────────────────────────────────────

export const SCIM_SCHEMAS_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_SCHEMAS_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
export const SCIM_SCHEMAS_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_SCHEMAS_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

export function userToScim(user: User, baseUrl = ''): ScimUser {
  return {
    schemas: [SCIM_SCHEMAS_USER],
    id: user.id,
    userName: user.email,
    name: { formatted: user.name },
    displayName: user.name,
    emails: [{ value: user.email, primary: true, type: 'work' }],
    active: user.emailVerified && !user.deprovisionedAt, // H1-S05: a deprovisioned user is never active
    meta: {
      resourceType: 'User',
      created: user.createdAt,
      lastModified: user.updatedAt,
      ...(baseUrl ? { location: `${baseUrl}/scim/v2/Users/${user.id}` } : {}),
    },
  };
}

export function scimToUser(scimUser: ScimUser, existingUser?: User): User {
  const email = scimUser.emails?.find(e => e.primary)?.value
    ?? scimUser.emails?.[0]?.value
    ?? scimUser.userName;
  const now = new Date().toISOString();
  return {
    id: existingUser?.id ?? crypto.randomUUID(),
    email,
    emailVerified: scimUser.active ?? false,
    name: scimUser.displayName ?? scimUser.name?.formatted ?? scimUser.userName,
    passwordHash: existingUser?.passwordHash ?? null,
    createdAt: existingUser?.createdAt ?? now,
    updatedAt: now,
  };
}

export function orgToScimGroup(org: Organization, baseUrl = ''): ScimGroup {
  return {
    schemas: [SCIM_SCHEMAS_GROUP],
    id: org.id,
    displayName: org.name,
    members: [],
    meta: {
      resourceType: 'Group',
      created: org.createdAt,
      lastModified: org.updatedAt,
      ...(baseUrl ? { location: `${baseUrl}/scim/v2/Groups/${org.id}` } : {}),
    },
  };
}

export function makeListResponse<T>(items: T[]): ScimListResponse<T> {
  return {
    schemas: [SCIM_SCHEMAS_LIST],
    totalResults: items.length,
    startIndex: 1,
    itemsPerPage: items.length,
    Resources: items,
  };
}

export function makeScimError(status: number, detail: string, scimType?: string): ScimError {
  return {
    schemas: [SCIM_SCHEMAS_ERROR],
    detail,
    status,
    ...(scimType ? { scimType } : {}),
  };
}

/**
 * Parse SCIM filter expression. Supports only the basic eq operator.
 * e.g. `userName eq "user@example.com"` → { attr: 'userName', value: 'user@example.com' }
 */
export function parseScimFilter(filter: string): { attr: string; value: string } | null {
  const m = filter.match(/^\s*(\w+)\s+eq\s+"([^"]+)"\s*$/i);
  if (!m) return null;
  return { attr: m[1]!, value: m[2]! };
}
