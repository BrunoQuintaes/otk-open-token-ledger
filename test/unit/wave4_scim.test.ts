/**
 * W4-4D02 — SCIM 2.0 provisioning tests (NEW-4.04)
 *
 * Covers:
 *   1.  src/auth/scim/ScimRouter.ts exists
 *   2.  src/auth/scim/ScimUserAdapter.ts exists
 *   3.  routes.ts has /scim/v2 path
 *   4.  handleScimRequest returns false for non-SCIM paths
 *   5.  GET /scim/v2/Users returns ListResponse with correct schema
 *   6.  POST /scim/v2/Users creates user, returns 201
 *   7.  POST /scim/v2/Users returns 409 on duplicate userName
 *   8.  GET /scim/v2/Users/:id returns 404 for unknown user
 *   9.  GET /scim/v2/Users/?filter=userName eq "..." returns matching user
 *  10.  PUT /scim/v2/Users/:id updates user
 *  11.  DELETE /scim/v2/Users/:id returns 204
 *  12.  GET /scim/v2/Groups returns groups ListResponse
 *  13.  POST /scim/v2/Groups creates group, returns 201
 *
 * @since Wave 4 (4D-PACK-4D02 / NEW-4.04)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

import { handleScimRequest } from '../../src/auth/scim/ScimRouter.js';
import { userToScim, scimToUser, makeListResponse, parseScimFilter, SCIM_SCHEMAS_LIST, SCIM_SCHEMAS_USER } from '../../src/auth/scim/ScimUserAdapter.js';
import type { IUserStore } from '../../src/users/IUserStore.js';
import type { User, Organization } from '../../src/users/types.js';

// ──────────────────────────────────────────────────────────
// In-memory user store for testing
// ──────────────────────────────────────────────────────────

function makeTestStore(): IUserStore {
  const users = new Map<string, User>();
  const orgs = new Map<string, Organization>();
  return {
    async createUser(u) { users.set(u.id, u); },
    async getUser(id) { return users.get(id) ?? null; },
    async getUserByEmail(email) { return [...users.values()].find(u => u.email === email) ?? null; },
    async updateUser(id, updates) {
      const u = users.get(id);
      if (!u) return null;
      const updated = { ...u, ...updates, updatedAt: new Date().toISOString() };
      users.set(id, updated);
      return updated;
    },
    async createOrg(o) { orgs.set(o.id, o); },
    async getOrg(id) { return orgs.get(id) ?? null; },
    async getOrgBySlug(slug) { return [...orgs.values()].find(o => o.slug === slug) ?? null; },
    async listOrgs() { return [...orgs.values()]; },
    async addMembership(_m) {},
    async getMemberships(_userId) { return []; },
    async getOrgMembers(_orgId) { return []; },
    async removeMembership(_userId, _orgId) { return false; },
    async createInvite(_i) {},
    async getInvite(_id) { return null; },
    async listInvitesByOrg(_orgId, _status?) { return []; },
    async updateInviteStatus(_id, _status) { return null; },
    async clear() { users.clear(); orgs.clear(); },
  };
}

// ──────────────────────────────────────────────────────────
// Minimal mock req/res for handleScimRequest
// ──────────────────────────────────────────────────────────

// AUD-W4-005 fix: ScimRouter is now fail-closed. Tests must supply a bearer token.
const TEST_SCIM_TOKEN = 'test-scim-token-for-unit-tests';
process.env['OTK_SCIM_BEARER_TOKEN'] = TEST_SCIM_TOKEN;

function makeMockReq(method: string, url: string, body?: unknown): http.IncomingMessage {
  const req = new http.IncomingMessage(null as any);
  req.method = method;
  req.url = url;
  req.headers = { authorization: `Bearer ${TEST_SCIM_TOKEN}` };
  // Pre-buffer body
  if (body !== undefined) {
    const buf = Buffer.from(JSON.stringify(body));
    (req as any).push(buf);
    (req as any).push(null);
  } else {
    (req as any).push(null);
  }
  return req;
}

function makeMockRes(): http.ServerResponse & { body: string; statusCode: number } {
  const res = Object.assign(new http.ServerResponse(new http.IncomingMessage(null as any)), {
    body: '',
    _statusCode: 200,
  });
  res.writeHead = (status: number, _headers?: any) => {
    res.statusCode = status;
    return res;
  };
  res.end = (data?: any) => {
    if (typeof data === 'string') res.body = data;
    else if (Buffer.isBuffer(data)) res.body = data.toString();
    return res;
  };
  return res as any;
}

// ──────────────────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────────────────

describe('W4-4D02 — File structure (SCIM)', () => {
  it('src/auth/scim/ScimRouter.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/auth/scim/ScimRouter.ts')));
  });

  it('src/auth/scim/ScimUserAdapter.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/auth/scim/ScimUserAdapter.ts')));
  });

  it('routes.ts has /scim/v2 path', () => {
    const c = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(c.includes('/scim/v2'));
  });
});

describe('W4-4D02 — ScimUserAdapter', () => {
  it('userToScim maps user fields correctly', () => {
    const user: User = {
      id: 'u1', email: 'test@example.com', emailVerified: true,
      name: 'Test User', passwordHash: null,
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    };
    const scim = userToScim(user);
    assert.strictEqual(scim.id, 'u1');
    assert.strictEqual(scim.userName, 'test@example.com');
    assert.strictEqual(scim.active, true);
    assert.ok(scim.schemas.includes(SCIM_SCHEMAS_USER));
  });

  it('scimToUser maps SCIM fields to User', () => {
    const scim = { schemas: [SCIM_SCHEMAS_USER], userName: 'a@b.com', displayName: 'A B', active: true, emails: [{ value: 'a@b.com', primary: true }] };
    const user = scimToUser(scim);
    assert.strictEqual(user.email, 'a@b.com');
    assert.strictEqual(user.name, 'A B');
    assert.strictEqual(user.emailVerified, true);
  });

  it('makeListResponse produces correct schema', () => {
    const list = makeListResponse([{ id: '1' }]);
    assert.ok(list.schemas.includes(SCIM_SCHEMAS_LIST));
    assert.strictEqual(list.totalResults, 1);
  });

  it('parseScimFilter parses userName eq filter', () => {
    const result = parseScimFilter('userName eq "user@example.com"');
    assert.deepStrictEqual(result, { attr: 'userName', value: 'user@example.com' });
  });
});

describe('W4-4D02 — ScimRouter', () => {
  it('handleScimRequest returns false for non-SCIM paths', async () => {
    const req = makeMockReq('GET', '/v1/health');
    const res = makeMockRes();
    const handled = await handleScimRequest(req, res, '/v1/health', 'GET', null);
    assert.strictEqual(handled, false);
  });

  it('GET /scim/v2/Users returns ListResponse', async () => {
    const store = makeTestStore();
    const req = makeMockReq('GET', '/scim/v2/Users');
    const res = makeMockRes();
    await handleScimRequest(req, res, '/scim/v2/Users', 'GET', store);
    const body = JSON.parse(res.body);
    assert.ok(body.schemas.includes(SCIM_SCHEMAS_LIST));
    assert.ok('totalResults' in body);
  });

  it('POST /scim/v2/Users creates user and returns 201', async () => {
    const store = makeTestStore();
    const scimUser = { schemas: [SCIM_SCHEMAS_USER], userName: 'new@test.com', displayName: 'New User', active: true, emails: [{ value: 'new@test.com', primary: true }] };
    const req = makeMockReq('POST', '/scim/v2/Users', scimUser);
    const res = makeMockRes();
    await handleScimRequest(req, res, '/scim/v2/Users', 'POST', store);
    assert.strictEqual(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.userName, 'new@test.com');
  });

  it('POST /scim/v2/Users returns 409 on duplicate', async () => {
    const store = makeTestStore();
    const user: User = { id: 'u2', email: 'dup@test.com', emailVerified: false, name: 'Dup', passwordHash: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    await store.createUser(user);
    const scimUser = { schemas: [SCIM_SCHEMAS_USER], userName: 'dup@test.com', emails: [{ value: 'dup@test.com', primary: true }] };
    const req = makeMockReq('POST', '/scim/v2/Users', scimUser);
    const res = makeMockRes();
    await handleScimRequest(req, res, '/scim/v2/Users', 'POST', store);
    assert.strictEqual(res.statusCode, 409);
  });

  it('GET /scim/v2/Users/:id returns 404 for unknown', async () => {
    const store = makeTestStore();
    const req = makeMockReq('GET', '/scim/v2/Users/nonexistent');
    const res = makeMockRes();
    await handleScimRequest(req, res, '/scim/v2/Users/nonexistent', 'GET', store);
    assert.strictEqual(res.statusCode, 404);
  });

  it('GET /scim/v2/Users?filter=userName eq finds user', async () => {
    const store = makeTestStore();
    const user: User = { id: 'u3', email: 'find@test.com', emailVerified: true, name: 'Find Me', passwordHash: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    await store.createUser(user);
    const req = makeMockReq('GET', '/scim/v2/Users?filter=userName+eq+%22find%40test.com%22');
    req.url = '/scim/v2/Users?filter=userName+eq+%22find%40test.com%22';
    const res = makeMockRes();
    await handleScimRequest(req, res, '/scim/v2/Users', 'GET', store);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.totalResults, 1);
    assert.strictEqual(body.Resources[0].userName, 'find@test.com');
  });

  it('PUT /scim/v2/Users/:id updates name', async () => {
    const store = makeTestStore();
    const user: User = { id: 'u4', email: 'upd@test.com', emailVerified: true, name: 'Old Name', passwordHash: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    await store.createUser(user);
    const updatePayload = { schemas: [SCIM_SCHEMAS_USER], userName: 'upd@test.com', displayName: 'New Name', active: true };
    const req = makeMockReq('PUT', '/scim/v2/Users/u4', updatePayload);
    const res = makeMockRes();
    await handleScimRequest(req, res, '/scim/v2/Users/u4', 'PUT', store);
    assert.strictEqual(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.displayName, 'New Name');
  });

  it('DELETE /scim/v2/Users/:id returns 204', async () => {
    const store = makeTestStore();
    const user: User = { id: 'u5', email: 'del@test.com', emailVerified: true, name: 'Del', passwordHash: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    await store.createUser(user);
    const req = makeMockReq('DELETE', '/scim/v2/Users/u5');
    const res = makeMockRes();
    await handleScimRequest(req, res, '/scim/v2/Users/u5', 'DELETE', store);
    assert.strictEqual(res.statusCode, 204);
  });

  it('GET /scim/v2/Groups returns groups ListResponse', async () => {
    const store = makeTestStore();
    const org: Organization = { id: 'o1', name: 'OTK Corp', slug: 'otk-corp', plan: 'PRO', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' };
    await store.createOrg(org);
    const req = makeMockReq('GET', '/scim/v2/Groups');
    const res = makeMockRes();
    await handleScimRequest(req, res, '/scim/v2/Groups', 'GET', store);
    const body = JSON.parse(res.body);
    assert.ok(body.schemas.includes(SCIM_SCHEMAS_LIST));
    assert.strictEqual(body.totalResults, 1);
    assert.strictEqual(body.Resources[0].displayName, 'OTK Corp');
  });

  it('POST /scim/v2/Groups creates group and returns 201', async () => {
    const store = makeTestStore();
    const scimGroup = { schemas: ['urn:ietf:params:scim:schemas:core:2.0:Group'], displayName: 'New Team' };
    const req = makeMockReq('POST', '/scim/v2/Groups', scimGroup);
    const res = makeMockRes();
    await handleScimRequest(req, res, '/scim/v2/Groups', 'POST', store);
    assert.strictEqual(res.statusCode, 201);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.displayName, 'New Team');
  });
});
