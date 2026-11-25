/**
 * ScimUserAdapter — SCIM 2.0 ↔ IUserStore translation layer (NEW-4.04)
 *
 * Converts between SCIM 2.0 User format and internal User/Organization types.
 *
 * Pure functions with no I/O, used by `src/auth/scim/ScimRouter.ts`. A SCIM group maps to an organization; group
 * members are not tracked (always an empty list).
 *
 * @module src/auth/scim/ScimUserAdapter
 * @since Wave 4 (4D-PACK-4D02 / NEW-4.04)
 */

import type { User, Organization } from '../../users/types.js';

// ──────────────────────────────────────────────────────────
// SCIM 2.0 Types
// ──────────────────────────────────────────────────────────

/** SCIM user name components. */
export interface ScimName {
  formatted?: string;
  givenName?: string;
  familyName?: string;
}

/** One SCIM e-mail entry. */
export interface ScimEmail {
  value: string;
  primary?: boolean;
  type?: string;
}

/** SCIM resource metadata (timestamps are ISO-8601). */
export interface ScimMeta {
  resourceType: string;
  created?: string;
  lastModified?: string;
  location?: string;
}

/** SCIM 2.0 User resource (the subset this server reads and writes). */
export interface ScimUser {
  schemas: string[];
  id?: string;
  externalId?: string;
  /** Login name; this server uses the e-mail address. */
  userName: string;
  name?: ScimName;
  displayName?: string;
  emails?: ScimEmail[];
  /** `false` for deprovisioned or unverified users. */
  active?: boolean;
  meta?: ScimMeta;
}

/** SCIM 2.0 Group resource, mapped to an organization. */
export interface ScimGroup {
  schemas: string[];
  id?: string;
  displayName: string;
  members?: Array<{ value: string; display?: string }>;
  meta?: ScimMeta;
}

/** SCIM list response (no paging: every item in one page, `startIndex` 1). */
export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
  Resources: T[];
}

/** SCIM error document. */
export interface ScimError {
  schemas: string[];
  scimType?: string;
  detail: string;
  status: number;
}

// ──────────────────────────────────────────────────────────
// SCIM ↔ User conversions
// ──────────────────────────────────────────────────────────

/** SCIM schema URN of the User resource. */
export const SCIM_SCHEMAS_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
/** SCIM schema URN of the Group resource. */
export const SCIM_SCHEMAS_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
/** SCIM schema URN of list responses. */
export const SCIM_SCHEMAS_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
/** SCIM schema URN of error documents. */
export const SCIM_SCHEMAS_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';

/**
 * Converts an internal user to a SCIM User.
 *
 * @param user - Internal user.
 * @param baseUrl - Public base URL used for `meta.location`; empty omits the location.
 * @returns The SCIM resource; `active` is true only for a verified, not deprovisioned user.
 */
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

/**
 * Converts a SCIM User to an internal user (a new id and timestamps unless `existingUser` is given).
 *
 * @param scimUser - SCIM resource from the identity provider.
 * @param existingUser - Current user whose id, password hash and creation time are kept.
 * @returns The internal user; e-mail is the primary e-mail, else the first one, else `userName`.
 */
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

/**
 * Converts an organization to a SCIM Group (without members).
 *
 * @param org - Organization.
 * @param baseUrl - Public base URL used for `meta.location`; empty omits the location.
 * @returns The SCIM group.
 */
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

/**
 * Wraps items in a SCIM list response.
 *
 * @param items - Resources to return.
 * @returns The list response (all items, one page).
 */
export function makeListResponse<T>(items: T[]): ScimListResponse<T> {
  return {
    schemas: [SCIM_SCHEMAS_LIST],
    totalResults: items.length,
    startIndex: 1,
    itemsPerPage: items.length,
    Resources: items,
  };
}

/**
 * Builds a SCIM error document.
 *
 * @param status - HTTP status code.
 * @param detail - Human-readable detail.
 * @param scimType - Optional SCIM error type such as `uniqueness` or `invalidValue`.
 * @returns The error document.
 */
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
 *
 * @param filter - Value of the `filter` query parameter.
 * @returns Attribute and value of an `eq` filter, or `null` for anything else.
 */
export function parseScimFilter(filter: string): { attr: string; value: string } | null {
  const m = filter.match(/^\s*(\w+)\s+eq\s+"([^"]+)"\s*$/i);
  if (!m) return null;
  return { attr: m[1]!, value: m[2]! };
}
