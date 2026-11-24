/**
 * Wave 3E Pack 01 — Signup + Login + Email Verification Tests (P3.1)
 *
 * Tests password hashing, email verification tokens, signup/login endpoints.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

// ===========================================================================
// Password hashing
// ===========================================================================

import { hashPassword, verifyPassword } from '../../src/auth/password.js';

describe('W3E-01 — Password hashing (scrypt)', () => {
  it('hashPassword returns scrypt-prefixed hash', async () => {
    const hash = await hashPassword('MyPassword123');
    assert.ok(hash.startsWith('scrypt:'), 'hash must start with scrypt:');
    const parts = hash.split(':');
    assert.equal(parts.length, 3, 'hash must have 3 parts');
    assert.equal(parts[1].length, 32, 'salt must be 16 bytes = 32 hex chars');
    assert.equal(parts[2].length, 128, 'derived key must be 64 bytes = 128 hex chars');
  });

  it('verifyPassword returns true for correct password', async () => {
    const hash = await hashPassword('CorrectPassword');
    assert.ok(await verifyPassword('CorrectPassword', hash));
  });

  it('verifyPassword returns false for wrong password', async () => {
    const hash = await hashPassword('CorrectPassword');
    assert.equal(await verifyPassword('WrongPassword', hash), false);
  });

  it('verifyPassword returns false for invalid hash format', async () => {
    assert.equal(await verifyPassword('any', 'not-a-hash'), false);
    assert.equal(await verifyPassword('any', 'bcrypt:invalid:hash'), false);
  });

  it('different passwords produce different hashes', async () => {
    const h1 = await hashPassword('password1');
    const h2 = await hashPassword('password2');
    assert.notEqual(h1, h2);
  });

  it('same password produces different hashes (unique salt)', async () => {
    const h1 = await hashPassword('samePassword');
    const h2 = await hashPassword('samePassword');
    assert.notEqual(h1, h2, 'different salts should produce different hashes');
    // But both should verify
    assert.ok(await verifyPassword('samePassword', h1));
    assert.ok(await verifyPassword('samePassword', h2));
  });
});

// ===========================================================================
// Email verification tokens
// ===========================================================================

import { generateVerificationToken, validateVerificationToken } from '../../src/auth/emailVerification.js';

// Email verification requires OTK_JWT_SECRET
if (!process.env['OTK_JWT_SECRET']) process.env['OTK_JWT_SECRET'] = 'test-jwt-secret-for-verification';

describe('W3E-01 — Email verification tokens', () => {
  it('generates a token with 3 dot-separated parts', () => {
    const token = generateVerificationToken('user123');
    const parts = token.split('.');
    assert.equal(parts.length, 3);
    assert.equal(parts[0], 'user123');
  });

  it('validates a valid token and returns userId', () => {
    const token = generateVerificationToken('user456');
    const userId = validateVerificationToken(token);
    assert.equal(userId, 'user456');
  });

  it('rejects expired token', async () => {
    // Manually craft an expired token (expiry in the past)
    const { createHmac } = await import('node:crypto');
    const expiry = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago
    const payload = `user789.${expiry}`;
    const hmac = createHmac('sha256', process.env['OTK_JWT_SECRET'] ?? 'otk-default-verify-secret')
      .update(payload).digest('hex');
    const token = `${payload}.${hmac}`;
    const userId = validateVerificationToken(token);
    assert.equal(userId, null, 'expired token should return null');
  });

  it('rejects tampered token', () => {
    const token = generateVerificationToken('user111');
    const tampered = token.slice(0, -4) + 'xxxx';
    const userId = validateVerificationToken(tampered);
    assert.equal(userId, null, 'tampered token should return null');
  });

  it('rejects malformed token', () => {
    assert.equal(validateVerificationToken(''), null);
    assert.equal(validateVerificationToken('only.two'), null);
    assert.equal(validateVerificationToken('a.notanumber.c'), null);
  });
});

// ===========================================================================
// REST endpoints — signup, login, verify-email
// ===========================================================================

import { handleRequest } from '../../src/api/routes.js';
import { MemoryUserStore } from '../../src/users/MemoryUserStore.js';
import { setUserStore } from '../../src/users/IUserStore.js';

function mockReq(method: string, url: string, body?: string): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, {
    method,
    url,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
  process.nextTick(() => {
    if (body) em.emit('data', Buffer.from(body));
    em.emit('end');
  });
  return req;
}

type MockRes = ServerResponse & { body: string };

function mockRes(): MockRes {
  let body = '';
  return {
    statusCode: 200,
    setHeader: () => {},
    end: (data: string) => { body = data; },
    get body() { return body; },
  } as unknown as MockRes;
}

describe('W3E-01 — POST /signup endpoint', () => {
  beforeEach(() => {
    const store = new MemoryUserStore();
    setUserStore(store);
  });

  it('creates user + org and returns 201 with userId, orgId', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/signup', JSON.stringify({
      email: 'alice@example.com', password: 'SecurePass123', name: 'Alice', orgName: 'Acme Inc',
    })), res);
    assert.equal(res.statusCode, 201, `expected 201 but got ${res.statusCode}: ${res.body}`);
    const json = JSON.parse(res.body);
    assert.ok(json.ok);
    assert.ok(json.userId);
    assert.ok(json.orgId);
  });

  it('rejects duplicate email with 409', async () => {
    const body = JSON.stringify({ email: 'dup@example.com', password: 'SecurePass123', name: 'Bob', orgName: 'DupOrg' });
    const r1 = mockRes();
    await handleRequest(mockReq('POST', '/signup', body), r1);
    assert.equal(r1.statusCode, 201);

    const r2 = mockRes();
    await handleRequest(mockReq('POST', '/signup', body), r2);
    assert.equal(r2.statusCode, 409);
  });

  it('rejects missing email with 400', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/signup', JSON.stringify({
      password: 'x'.repeat(8), name: 'X', orgName: 'Y',
    })), res);
    assert.equal(res.statusCode, 400);
  });

  it('rejects short password with 400', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/signup', JSON.stringify({
      email: 'test@x.com', password: 'short', name: 'X', orgName: 'Y',
    })), res);
    assert.equal(res.statusCode, 400);
  });
});

describe('W3E-01 — POST /login endpoint', () => {
  beforeEach(async () => {
    const store = new MemoryUserStore();
    setUserStore(store);
    // Pre-create a user
    const r = mockRes();
    await handleRequest(mockReq('POST', '/signup', JSON.stringify({
      email: 'login@test.com', password: 'ValidPass123', name: 'Login User', orgName: 'LoginOrg',
    })), r);
  });

  it('returns 200 with token for valid credentials', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/login', JSON.stringify({
      email: 'login@test.com', password: 'ValidPass123',
    })), res);
    assert.equal(res.statusCode, 200);
    const json = JSON.parse(res.body);
    assert.ok(json.ok);
    assert.ok(json.userId);
    assert.ok(json.orgId);
  });

  it('returns 401 for wrong password', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/login', JSON.stringify({
      email: 'login@test.com', password: 'WrongPassword',
    })), res);
    assert.equal(res.statusCode, 401);
  });

  it('returns 401 for non-existent email', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/login', JSON.stringify({
      email: 'nobody@test.com', password: 'anything',
    })), res);
    assert.equal(res.statusCode, 401);
  });
});

describe('W3E-01 — POST /verify-email endpoint', () => {
  beforeEach(() => {
    const store = new MemoryUserStore();
    setUserStore(store);
  });

  it('verifies email with valid token', async () => {
    // Create user first
    const r1 = mockRes();
    await handleRequest(mockReq('POST', '/signup', JSON.stringify({
      email: 'verify@test.com', password: 'ValidPass123', name: 'Verify', orgName: 'VerifyOrg',
    })), r1);
    const userId = JSON.parse(r1.body).userId;

    // Generate token and verify
    const token = generateVerificationToken(userId);
    const r2 = mockRes();
    await handleRequest(mockReq('POST', '/verify-email', JSON.stringify({ token })), r2);
    assert.equal(r2.statusCode, 200);
    const json = JSON.parse(r2.body);
    assert.ok(json.emailVerified);
  });

  it('rejects invalid token with 401', async () => {
    const res = mockRes();
    await handleRequest(mockReq('POST', '/verify-email', JSON.stringify({ token: 'invalid.token.here' })), res);
    assert.equal(res.statusCode, 401);
  });
});

// ===========================================================================
// File structure
// ===========================================================================

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

describe('W3E-01 — File structure', () => {
  it('password.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src', 'auth', 'password.ts')));
  });
  it('emailVerification.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src', 'auth', 'emailVerification.ts')));
  });
});

// ===========================================================================
// Schema types compile
// ===========================================================================

import type { SignupInput, LoginInput, VerifyEmailInput } from '../../src/api/schemas.js';

describe('W3E-01 — Schema types compile', () => {
  it('SignupInput type has expected fields', () => {
    const s: SignupInput = { email: 'a@b.com', password: '12345678', name: 'A', orgName: 'O' };
    assert.ok(s.email);
  });
  it('LoginInput type has expected fields', () => {
    const l: LoginInput = { email: 'a@b.com', password: '12345678' };
    assert.ok(l.email);
  });
  it('VerifyEmailInput type has expected fields', () => {
    const v: VerifyEmailInput = { token: 'abc' };
    assert.ok(v.token);
  });
});
