/**
 * Wave 3C Pack 03 — User Registration Model Tests (NEW-3.09)
 *
 * Tests MemoryUserStore CRUD for organizations, users, memberships, invites.
 * No PG required — all tests use in-memory implementation.
 *
 * Module under test: `src/users/MemoryUserStore.ts` (types from `src/users/types.ts`).
 *
 * Strategy / partitions: organizations (create, by slug found and missing, list with limit and offset); users
 * (create, by e-mail found and missing, partial update, unknown user); memberships (add, list, remove present
 * and missing); invites (create, list per organization, status change, unknown invite); clear; the presence of
 * the source files; the role and status types compile.
 *
 * Needs: nothing external (a new in-memory store per test).
 *
 * Run just this file: `npx tsx --test test/unit/wave3c_pack03_user_model.test.ts`
 *
 * @module test/unit/wave3c_pack03_user_model.test
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryUserStore } from '../../src/users/MemoryUserStore.js';
import type { Organization, User, Membership, Invite } from '../../src/users/types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const now = () => new Date().toISOString();

function makeOrg(id: string, slug: string): Organization {
  return { id, name: `Org ${id}`, slug, plan: 'FREE', createdAt: now(), updatedAt: now() };
}

function makeUser(id: string, email: string): User {
  return { id, email, emailVerified: false, name: `User ${id}`, passwordHash: null, createdAt: now(), updatedAt: now() };
}

// ===========================================================================
// Organization CRUD
// ===========================================================================

describe('W3C-03 — Organization CRUD', () => {
  let store: MemoryUserStore;
  beforeEach(() => { store = new MemoryUserStore(); });

  it('createOrg + getOrg returns org', async () => {
    await store.createOrg(makeOrg('o1', 'acme'));
    const org = await store.getOrg('o1');
    assert.ok(org);
    assert.equal(org.slug, 'acme');
    assert.equal(org.plan, 'FREE');
  });

  it('getOrgBySlug finds org', async () => {
    await store.createOrg(makeOrg('o1', 'acme'));
    const org = await store.getOrgBySlug('acme');
    assert.ok(org);
    assert.equal(org.id, 'o1');
  });

  it('getOrgBySlug returns null for unknown slug', async () => {
    assert.equal(await store.getOrgBySlug('nope'), null);
  });

  it('listOrgs returns all orgs', async () => {
    await store.createOrg(makeOrg('o1', 'a'));
    await store.createOrg(makeOrg('o2', 'b'));
    const list = await store.listOrgs();
    assert.equal(list.length, 2);
  });

  it('listOrgs respects limit and offset', async () => {
    for (let i = 0; i < 5; i++) await store.createOrg(makeOrg(`o${i}`, `s${i}`));
    const page = await store.listOrgs({ limit: 2, offset: 1 });
    assert.equal(page.length, 2);
  });
});

// ===========================================================================
// User CRUD
// ===========================================================================

describe('W3C-03 — User CRUD', () => {
  let store: MemoryUserStore;
  beforeEach(() => { store = new MemoryUserStore(); });

  it('createUser + getUser returns user', async () => {
    await store.createUser(makeUser('u1', 'alice@example.com'));
    const user = await store.getUser('u1');
    assert.ok(user);
    assert.equal(user.email, 'alice@example.com');
    assert.equal(user.emailVerified, false);
  });

  it('getUserByEmail finds user', async () => {
    await store.createUser(makeUser('u1', 'alice@example.com'));
    const user = await store.getUserByEmail('alice@example.com');
    assert.ok(user);
    assert.equal(user.id, 'u1');
  });

  it('getUserByEmail returns null for unknown email', async () => {
    assert.equal(await store.getUserByEmail('nope@x.com'), null);
  });

  it('updateUser updates specific fields', async () => {
    await store.createUser(makeUser('u1', 'alice@example.com'));
    const updated = await store.updateUser('u1', { name: 'Alice W', emailVerified: true });
    assert.ok(updated);
    assert.equal(updated.name, 'Alice W');
    assert.equal(updated.emailVerified, true);
  });

  it('updateUser returns null for unknown user', async () => {
    assert.equal(await store.updateUser('nope', { name: 'X' }), null);
  });
});

// ===========================================================================
// Membership CRUD
// ===========================================================================

describe('W3C-03 — Membership CRUD', () => {
  let store: MemoryUserStore;
  beforeEach(() => { store = new MemoryUserStore(); });

  it('addMembership + getMemberships returns memberships', async () => {
    const m: Membership = { userId: 'u1', orgId: 'o1', role: 'MEMBER', joinedAt: now() };
    await store.addMembership(m);
    const list = await store.getMemberships('u1');
    assert.equal(list.length, 1);
    assert.equal(list[0].orgId, 'o1');
  });

  it('getOrgMembers returns members of org', async () => {
    await store.addMembership({ userId: 'u1', orgId: 'o1', role: 'OWNER', joinedAt: now() });
    await store.addMembership({ userId: 'u2', orgId: 'o1', role: 'MEMBER', joinedAt: now() });
    await store.addMembership({ userId: 'u3', orgId: 'o2', role: 'MEMBER', joinedAt: now() });
    const members = await store.getOrgMembers('o1');
    assert.equal(members.length, 2);
  });

  it('removeMembership removes and returns true', async () => {
    await store.addMembership({ userId: 'u1', orgId: 'o1', role: 'MEMBER', joinedAt: now() });
    assert.ok(await store.removeMembership('u1', 'o1'));
    assert.equal((await store.getMemberships('u1')).length, 0);
  });

  it('removeMembership returns false for non-existent', async () => {
    assert.equal(await store.removeMembership('nope', 'nope'), false);
  });
});

// ===========================================================================
// Invite CRUD
// ===========================================================================

describe('W3C-03 — Invite CRUD', () => {
  let store: MemoryUserStore;
  beforeEach(() => { store = new MemoryUserStore(); });

  it('createInvite + getInvite returns invite', async () => {
    const invite: Invite = {
      id: 'inv1', orgId: 'o1', email: 'bob@x.com', role: 'MEMBER',
      invitedBy: 'u1', status: 'pending', createdAt: now(),
      expiresAt: new Date(Date.now() + 86400000).toISOString(), acceptedAt: null,
    };
    await store.createInvite(invite);
    const found = await store.getInvite('inv1');
    assert.ok(found);
    assert.equal(found.email, 'bob@x.com');
    assert.equal(found.status, 'pending');
  });

  it('listInvitesByOrg returns invites for org', async () => {
    await store.createInvite({
      id: 'i1', orgId: 'o1', email: 'a@b.com', role: 'MEMBER',
      invitedBy: 'u1', status: 'pending', createdAt: now(),
      expiresAt: now(), acceptedAt: null,
    });
    await store.createInvite({
      id: 'i2', orgId: 'o1', email: 'c@d.com', role: 'ADMIN',
      invitedBy: 'u1', status: 'accepted', createdAt: now(),
      expiresAt: now(), acceptedAt: now(),
    });

    const all = await store.listInvitesByOrg('o1');
    assert.equal(all.length, 2);

    const pending = await store.listInvitesByOrg('o1', 'pending');
    assert.equal(pending.length, 1);
    assert.equal(pending[0].email, 'a@b.com');
  });

  it('updateInviteStatus changes status', async () => {
    await store.createInvite({
      id: 'i3', orgId: 'o1', email: 'x@y.com', role: 'MEMBER',
      invitedBy: 'u1', status: 'pending', createdAt: now(),
      expiresAt: now(), acceptedAt: null,
    });
    const updated = await store.updateInviteStatus('i3', 'accepted');
    assert.ok(updated);
    assert.equal(updated.status, 'accepted');
    assert.ok(updated.acceptedAt, 'acceptedAt should be set');
  });

  it('updateInviteStatus returns null for unknown invite', async () => {
    assert.equal(await store.updateInviteStatus('nope', 'cancelled'), null);
  });
});

// ===========================================================================
// clear()
// ===========================================================================

describe('W3C-03 — Store clear', () => {
  it('clear removes all data', async () => {
    const store = new MemoryUserStore();
    await store.createOrg(makeOrg('o1', 'a'));
    await store.createUser(makeUser('u1', 'a@b.com'));
    await store.addMembership({ userId: 'u1', orgId: 'o1', role: 'OWNER', joinedAt: now() });
    await store.clear();
    assert.equal(await store.getOrg('o1'), null);
    assert.equal(await store.getUser('u1'), null);
    assert.equal((await store.getMemberships('u1')).length, 0);
  });
});

// ===========================================================================
// File structure
// ===========================================================================

describe('W3C-03 — File structure', () => {
  const expected = [
    'src/users/types.ts',
    'src/users/IUserStore.ts',
    'src/users/MemoryUserStore.ts',
    'src/infra/pg/PgUserStore.ts',
    'scripts/migrations/003_create_user_model.sql',
  ];

  for (const f of expected) {
    it(`${f} exists`, () => {
      assert.ok(fs.existsSync(path.join(ROOT, f)), `${f} not found`);
    });
  }
});

// ===========================================================================
// Type correctness
// ===========================================================================

describe('W3C-03 — Type correctness', () => {
  it('MembershipRole values compile', () => {
    const roles: import('../../src/users/types.js').MembershipRole[] = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'];
    assert.equal(roles.length, 4);
  });

  it('InviteStatus values compile', () => {
    const statuses: import('../../src/users/types.js').InviteStatus[] = ['pending', 'accepted', 'expired', 'cancelled'];
    assert.equal(statuses.length, 4);
  });
});
