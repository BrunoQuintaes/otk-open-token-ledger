/**
 * ScimRouter — SCIM 2.0 endpoint handler (NEW-4.04)
 *
 * Handles:
 *   GET    /scim/v2/Users           — list users (filter support)
 *   POST   /scim/v2/Users           — provision user
 *   GET    /scim/v2/Users/:id       — get user by id
 *   PUT    /scim/v2/Users/:id       — update user
 *   DELETE /scim/v2/Users/:id       — deprovision (soft delete: set active=false)
 *   GET    /scim/v2/Groups          — list groups (orgs)
 *   POST   /scim/v2/Groups          — create group (org)
 *
 * Auth: Bearer token from OTK_SCIM_BEARER_TOKEN env var.
 *
 * Also accepts PATCH on a user (replace of `active` / `displayName` only). Called from `src/api/routes.ts` with the
 * path already stripped of the version prefix. Every request must present the configured SCIM token (see the line
 * above); without a configured token every SCIM request is refused (401). Deprovisioning (DELETE, or `active=false`)
 * marks the user in `src/auth/subjectStatus.ts`, revokes the API keys the user minted and records the event in the
 * governance trail. This file is read as text by `scripts/ops/extract_routes.mjs`; comments here describe routes in
 * words only.
 *
 * @module src/auth/scim/ScimRouter
 * @since Wave 4 (4D-PACK-4D02 / NEW-4.04)
 */

import crypto from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { IUserStore } from '../../users/IUserStore.js';
import {
  userToScim, scimToUser, orgToScimGroup,
  makeListResponse, makeScimError, parseScimFilter,
  type ScimUser, type ScimGroup,
} from './ScimUserAdapter.js';
import type { Organization } from '../../users/types.js';
import { getGovernanceTrail } from '../../security/GovernanceTrail.js';
import { markUserDeprovisioned, markUserActive, flushSubjectStatus } from '../subjectStatus.js';
import { revokeApiKeysCreatedBy, listUnattributedApiKeys } from '../../api/apiKeyManager.js';
import { getLogger } from '../../infra/logging/StructuredLogger.js';

const SCIM_CONTENT_TYPE = 'application/scim+json';

// Sends a SCIM JSON response with the SCIM content type.
function sendScim(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': SCIM_CONTENT_TYPE, 'Content-Length': Buffer.byteLength(json) });
  res.end(json);
}

/**
 * H1 R-09: SCIM PatchOp (RFC 7644 §3.5.2) reduced to the attributes this server manages: `active` and `displayName`.
 * Accepts {op:"replace", path:"active", value:false}, {op:"Replace", value:{active:"False"}} (Entra sends strings and
 * capitalised ops). Any other operation → null (400), never a silent success.
 *
 * @param body - Parsed PatchOp request body.
 * @returns The attributes to apply, or `null` when any operation is unsupported.
 */
function patchToScimUser(body: unknown): ScimUser | null {
  const ops = (body as { Operations?: unknown })?.Operations;
  if (!Array.isArray(ops) || ops.length === 0) return null;
  const out: Partial<ScimUser> = {};
  const bool = (v: unknown): boolean | undefined => v === true || v === 'true' || v === 'True' ? true : v === false || v === 'false' || v === 'False' ? false : undefined;
  for (const raw of ops) {
    const op = raw as { op?: unknown; path?: unknown; value?: unknown };
    if (String(op.op ?? '').toLowerCase() !== 'replace') return null;
    const path = typeof op.path === 'string' ? op.path : '';
    if (path === 'active') { const b = bool(op.value); if (b === undefined) return null; out.active = b; continue; }
    if (path === 'displayName' && typeof op.value === 'string') { out.displayName = op.value; continue; }
    if (path === '' && op.value && typeof op.value === 'object') {
      const v = op.value as Record<string, unknown>;
      for (const k of Object.keys(v)) {
        if (k === 'active') { const b = bool(v[k]); if (b === undefined) return null; out.active = b; }
        else if (k === 'displayName' && typeof v[k] === 'string') out.displayName = v[k] as string;
        else return null;
      }
      continue;
    }
    return null;
  }
  return out as ScimUser;
}

// Sends a SCIM error document (RFC 7644 error schema).
function sendScimError(res: ServerResponse, status: number, detail: string, scimType?: string): void {
  sendScim(res, status, makeScimError(status, detail, scimType));
}

// Reads the whole body as JSON (no size limit or timeout here); an empty body is {} and bad JSON rejects.
async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf-8');
        resolve(text ? JSON.parse(text) : {});
      } catch {
        reject(new Error('invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

// Compares the presented credential header with the configured SCIM token in constant time; no token configured = deny.
function checkScimAuth(req: IncomingMessage): boolean {
  const token = process.env['OTK_SCIM_BEARER_TOKEN'];
  if (!token) return false; // fail-closed: no token configured → deny all SCIM requests
  const authHeader = req.headers['authorization'] ?? '';
  // F-H1-08 (H1 lane B): constant-time comparison (it was `===`, whose running time depends on the common prefix).
  // Both sides are hashed first so that the comparison also hides the length of the configured token.
  const a = crypto.createHash('sha256').update(String(authHeader)).digest();
  const b = crypto.createHash('sha256').update(`Bearer ${token}`).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * H1 lane B (S05 residual): on deprovisioning, revoke the API keys the user minted (recorded author). Keys without an
 * author in the user's orgs (registry-token keys, keys minted before authorship was recorded) are NOT guessed: they are
 * logged for operator review. Returns false when the revocation (or the write of the status to the shared store) could
 * not be completed (the caller answers 503 so that
 * the identity provider retries; the deprovisioning itself is already recorded and enforced at authentication time).
 *
 * @param userId - Deprovisioned user id.
 * @param userStore - User store, used to list the user's organizations.
 * @returns `true` when the keys were revoked and the status reached the shared store.
 */
async function revokeKeysOfDeprovisionedUser(userId: string, userStore: IUserStore): Promise<boolean> {
  const log = getLogger();
  try {
    const revoked = await revokeApiKeysCreatedBy(userId);
    const orgs = (await userStore.getMemberships(userId)).map((m) => m.orgId);
    const unattributed: Array<{ orgId: string; keyIds: string[] }> = [];
    for (const orgId of orgs) {
      const keys = await listUnattributedApiKeys(orgId);
      if (keys.length) unattributed.push({ orgId, keyIds: keys.map((k) => k.keyId) });
    }
    log.info('scim deprovisioning: user api keys revoked', { userId, revokedKeyIds: revoked });
    if (unattributed.length) {
      log.warn('scim deprovisioning: org api keys without recorded author left active (review)', { userId, unattributed });
    }
    // H1 lane B (S04 residual): the deprovisioning must reach the status store shared by the replicas
    const flushed = await flushSubjectStatus({ kind: 'user', id: userId }); // H1 R-05: this user's write
    if (!flushed.ok) {
      log.error('scim deprovisioning: subject status not written to the shared store', { userId });
      return false;
    }
    return true;
  } catch (err) {
    log.error('scim deprovisioning: api key revocation failed', { userId, error: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Handle a SCIM 2.0 request. Returns true if the route was handled, false if not a SCIM route.
 *
 * @param req - Incoming request.
 * @param res - Response; written when the route is handled.
 * @param routePath - Request path without the version prefix.
 * @param method - HTTP method.
 * @param userStore - User store, or `null` when none is configured (lists are then empty and writes answer 503 or 404).
 * @returns `true` when the path is under the SCIM prefix (a response was sent), `false` otherwise.
 */
export async function handleScimRequest(
  req: IncomingMessage,
  res: ServerResponse,
  routePath: string,
  method: string,
  userStore: IUserStore | null,
): Promise<boolean> {
  if (!routePath.startsWith('/scim/v2/')) return false;

  if (!checkScimAuth(req)) {
    sendScimError(res, 401, 'Authentication required');
    return true;
  }

  // ── Users ──────────────────────────────────────────────

  if (routePath === '/scim/v2/Users') {
    if (method === 'GET') {
      if (!userStore) {
        sendScim(res, 200, makeListResponse<ScimUser>([]));
        return true;
      }
      const urlObj = new URL(req.url ?? '/', 'http://localhost');
      const filter = urlObj.searchParams.get('filter');
      const parsed = filter ? parseScimFilter(filter) : null;

      // List all users and apply filter
      // IUserStore doesn't have listUsers — iterate via membership lookup or use org users
      // For SCIM we keep a simple approach: list all org members across a known default org
      // If no filter: return empty list (no listAll on IUserStore)
      // If filter on userName (email): lookup by email
      if (parsed?.attr === 'userName') {
        const user = await userStore.getUserByEmail(parsed.value);
        const resources = user ? [userToScim(user)] : [];
        sendScim(res, 200, makeListResponse(resources));
      } else {
        // No broad list capability without a listUsers method — return empty for unsupported filters
        sendScim(res, 200, makeListResponse<ScimUser>([]));
      }
      return true;
    }

    if (method === 'POST') {
      if (!userStore) {
        sendScimError(res, 503, 'User store not available');
        return true;
      }
      let body: unknown;
      try { body = await readBody(req); } catch { return sendScimError(res, 400, 'Invalid JSON'), true; }
      const scimUser = body as ScimUser;
      if (!scimUser.userName) {
        sendScimError(res, 400, 'userName is required', 'invalidValue');
        return true;
      }
      const email = scimUser.emails?.[0]?.value ?? scimUser.userName;
      const existing = await userStore.getUserByEmail(email);
      if (existing) {
        sendScimError(res, 409, `User ${email} already exists`, 'uniqueness');
        return true;
      }
      const user = scimToUser(scimUser);
      await userStore.createUser(user);
      // OPS-03: record SCIM provision event in GovernanceTrail
      getGovernanceTrail().append({
        ts: new Date().toISOString(),
        tenantId: user.id,
        actor: 'scim',
        action: 'tenant_created',
        meta: { scimAction: 'SCIM_USER_CREATE', email },
      });
      sendScim(res, 201, userToScim(user));
      return true;
    }
  }

  // ── Users/:id ──────────────────────────────────────────

  const userIdMatch = routePath.match(/^\/scim\/v2\/Users\/(.+)$/);
  if (userIdMatch) {
    const userId = userIdMatch[1]!;

    if (method === 'GET') {
      if (!userStore) return sendScimError(res, 404, 'Not found'), true;
      const user = await userStore.getUser(userId);
      if (!user) return sendScimError(res, 404, 'User not found'), true;
      sendScim(res, 200, userToScim(user));
      return true;
    }

    if (method === 'PUT' || method === 'PATCH') {
      if (!userStore) return sendScimError(res, 404, 'Not found'), true;
      let body: unknown;
      try { body = await readBody(req); } catch { return sendScimError(res, 400, 'Invalid JSON'), true; }
      // H1 R-09 (adversarial review): IdPs such as Entra ID deprovision with PATCH (PatchOp replace active=false); it
      // answered 404 before and some IdPs count that as done while the user stayed active
      const scimUser = method === 'PATCH' ? patchToScimUser(body) : body as ScimUser;
      if (!scimUser) return sendScimError(res, 400, 'Unsupported PATCH operation (only replace of active/displayName)'), true;
      const existing = await userStore.getUser(userId);
      if (!existing) return sendScimError(res, 404, 'User not found'), true;
      // H1-S05 (SEC02-N04): active=false deprovisions (no login, JWTs refused); active=true re-provisions, but tokens
      // issued before the deprovisioning stay invalid (auth/subjectStatus)
      const nowIso = new Date().toISOString();
      const deprovisionedAt = scimUser.active === false ? (existing.deprovisionedAt ?? nowIso)
        : scimUser.active === true ? null : undefined;
      const updated = await userStore.updateUser(userId, {
        name: scimUser.displayName ?? scimUser.name?.formatted ?? existing.name,
        emailVerified: scimUser.active ?? existing.emailVerified,
        ...(deprovisionedAt !== undefined ? { deprovisionedAt } : {}),
      });
      if (!updated) return sendScimError(res, 404, 'User not found'), true;
      if (deprovisionedAt) {
        markUserDeprovisioned(userId, Date.parse(deprovisionedAt));
        if (!(await revokeKeysOfDeprovisionedUser(userId, userStore))) return sendScimError(res, 503, 'API key revocation failed; retry'), true;
      } else if (deprovisionedAt === null) markUserActive(userId);
      // OPS-03: record SCIM update event in GovernanceTrail
      getGovernanceTrail().append({
        ts: new Date().toISOString(),
        tenantId: userId,
        actor: 'scim',
        action: 'tenant_updated',
        meta: { scimAction: 'SCIM_USER_UPDATE', userId },
      });
      sendScim(res, 200, userToScim(updated));
      return true;
    }

    if (method === 'DELETE') {
      if (!userStore) return sendScimError(res, 404, 'Not found'), true;
      const user = await userStore.getUser(userId);
      if (!user) return sendScimError(res, 404, 'User not found'), true;
      // Soft delete: active=false in SCIM. H1-S05 (SEC02-N04): it used to only clear emailVerified, which /login ignored;
      // now the user is deprovisioned: /login issues no token and every JWT carrying its userId is refused.
      const deprovisionedAt = new Date().toISOString();
      await userStore.updateUser(userId, { emailVerified: false, deprovisionedAt });
      markUserDeprovisioned(userId, Date.parse(deprovisionedAt));
      if (!(await revokeKeysOfDeprovisionedUser(userId, userStore))) return sendScimError(res, 503, 'API key revocation failed; retry'), true;
      // OPS-03: record SCIM deprovision event in GovernanceTrail
      getGovernanceTrail().append({
        ts: new Date().toISOString(),
        tenantId: userId,
        actor: 'scim',
        action: 'tenant_deleted',
        meta: { scimAction: 'SCIM_USER_DELETE', userId },
      });
      res.writeHead(204);
      res.end();
      return true;
    }
  }

  // ── Groups ─────────────────────────────────────────────

  if (routePath === '/scim/v2/Groups') {
    if (method === 'GET') {
      if (!userStore) {
        sendScim(res, 200, makeListResponse<ScimGroup>([]));
        return true;
      }
      const orgs = await userStore.listOrgs();
      sendScim(res, 200, makeListResponse(orgs.map(o => orgToScimGroup(o))));
      return true;
    }

    if (method === 'POST') {
      if (!userStore) return sendScimError(res, 503, 'User store not available'), true;
      let body: unknown;
      try { body = await readBody(req); } catch { return sendScimError(res, 400, 'Invalid JSON'), true; }
      const scimGroup = body as ScimGroup;
      if (!scimGroup.displayName) {
        sendScimError(res, 400, 'displayName is required', 'invalidValue');
        return true;
      }
      const now = new Date().toISOString();
      const org: Organization = {
        id: crypto.randomUUID(),
        name: scimGroup.displayName,
        slug: scimGroup.displayName.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        plan: 'FREE',
        createdAt: now,
        updatedAt: now,
      };
      await userStore.createOrg(org);
      sendScim(res, 201, orgToScimGroup(org));
      return true;
    }
  }

  // Route exists under /scim/v2/ but method/subpath not handled
  sendScimError(res, 404, `SCIM resource not found: ${routePath}`);
  return true;
}
