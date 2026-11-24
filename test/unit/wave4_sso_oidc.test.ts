/**
 * W4-4D01 — SSO OIDC tests (NEW-4.03)
 *
 * Covers:
 *   1.  src/auth/sso/OidcProvider.ts exists
 *   2.  routes.ts has /auth/oidc/callback route
 *   3.  OidcProvider.isConfigured() returns false when env vars not set
 *   4.  OidcProvider.isConfigured() returns true when issuer + clientId set
 *   5.  OidcProvider.exchangeCode() throws when not configured
 *   6.  OidcProvider.exchangeCode() returns OidcTokenResult shape
 *   7.  OidcProvider.getAuthorizationUrl() throws when not configured
 *   8.  OidcProvider.getAuthorizationUrl() returns URL with response_type=code
 *   9.  OidcProvider constructor reads OTK_OIDC_ISSUER from env
 *  10.  OidcProvider result.sub is derived from code
 *
 * @since Wave 4 (4D-PACK-4D01 / NEW-4.03)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

import { OidcProvider } from '../../src/auth/sso/OidcProvider.js';

describe('W4-4D01 — File structure (OIDC)', () => {
  it('src/auth/sso/OidcProvider.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/auth/sso/OidcProvider.ts')));
  });

  it('routes.ts has /auth/oidc/callback route', () => {
    const c = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(c.includes('/auth/oidc/callback'));
  });
});

describe('W4-4D01 — OidcProvider', () => {
  let origIssuer: string | undefined, origClientId: string | undefined;

  before(() => {
    origIssuer = process.env['OTK_OIDC_ISSUER'];
    origClientId = process.env['OTK_OIDC_CLIENT_ID'];
    delete process.env['OTK_OIDC_ISSUER'];
    delete process.env['OTK_OIDC_CLIENT_ID'];
  });

  after(() => {
    if (origIssuer !== undefined) process.env['OTK_OIDC_ISSUER'] = origIssuer; else delete process.env['OTK_OIDC_ISSUER'];
    if (origClientId !== undefined) process.env['OTK_OIDC_CLIENT_ID'] = origClientId; else delete process.env['OTK_OIDC_CLIENT_ID'];
  });

  it('isConfigured() returns false when env vars not set', () => {
    const oidc = new OidcProvider();
    assert.strictEqual(oidc.isConfigured(), false);
  });

  it('isConfigured() returns true when issuer + clientId set', () => {
    const oidc = new OidcProvider({ issuer: 'https://accounts.google.com', clientId: 'client-123' });
    assert.strictEqual(oidc.isConfigured(), true);
  });

  it('exchangeCode() throws when not configured', async () => {
    const oidc = new OidcProvider();
    await assert.rejects(() => oidc.exchangeCode('some-code'), /not configured/);
  });

  it('exchangeCode() returns OidcTokenResult shape', async () => {
    const oidc = new OidcProvider({ issuer: 'https://accounts.google.com', clientId: 'client-abc', clientSecret: 'secret' });
    const result = await oidc.exchangeCode('test-code-123');
    assert.ok(typeof result.sub === 'string');
    assert.ok(typeof result.accessToken === 'string');
    assert.ok('claims' in result);
  });

  it('getAuthorizationUrl() throws when not configured', () => {
    const oidc = new OidcProvider();
    assert.throws(() => oidc.getAuthorizationUrl(), /not configured/);
  });

  it('getAuthorizationUrl() returns URL with response_type=code', () => {
    const oidc = new OidcProvider({ issuer: 'https://sso.example.com', clientId: 'my-client' });
    const authUrl = oidc.getAuthorizationUrl('test-state');
    assert.ok(authUrl.includes('response_type=code'));
    assert.ok(authUrl.includes('my-client'));
  });

  it('constructor reads OTK_OIDC_ISSUER from env', () => {
    process.env['OTK_OIDC_ISSUER'] = 'https://env-issuer.example.com';
    process.env['OTK_OIDC_CLIENT_ID'] = 'env-client';
    const oidc = new OidcProvider();
    assert.strictEqual(oidc.config.issuer, 'https://env-issuer.example.com');
    delete process.env['OTK_OIDC_ISSUER'];
    delete process.env['OTK_OIDC_CLIENT_ID'];
  });

  it('exchangeCode() result.sub derived from code', async () => {
    const oidc = new OidcProvider({ issuer: 'https://sso.test', clientId: 'c1', clientSecret: 'cs1' });
    const result = await oidc.exchangeCode('abcdef1234');
    assert.ok(result.sub.includes('abcdef12'));
  });
});
