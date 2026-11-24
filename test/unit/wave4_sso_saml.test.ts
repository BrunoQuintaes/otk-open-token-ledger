/**
 * W4-4D01 — SSO SAML tests (NEW-4.03)
 *
 * Covers:
 *   1.  ADR-0302-sso-library.md exists
 *   2.  src/auth/sso/SamlProvider.ts exists
 *   3.  routes.ts has /auth/saml/metadata route
 *   4.  routes.ts has /auth/saml/acs route
 *   5.  SamlProvider.getMetadata() returns XML string
 *   6.  Metadata XML contains SPSSODescriptor
 *   7.  Metadata XML contains entityID
 *   8.  SamlProvider config uses OTK_SAML_ENTITY_ID from env
 *   9.  validateAssertion() throws when NameID not found
 *  10.  validateAssertion() returns nameId from XML
 *  11.  SamlProvider constructor accepts custom config
 *  12.  Metadata XML contains AssertionConsumerService
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

import { SamlProvider } from '../../src/auth/sso/SamlProvider.js';

describe('W4-4D01 — File structure', () => {
  it('ADR-0302-sso-library.md exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'docs/architecture/adr/ADR-0302-sso-library.md')));
  });

  it('src/auth/sso/SamlProvider.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/auth/sso/SamlProvider.ts')));
  });

  it('routes.ts has /auth/saml/metadata route', () => {
    const c = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(c.includes('/auth/saml/metadata'));
  });

  it('routes.ts has /auth/saml/acs route', () => {
    const c = fs.readFileSync(path.join(ROOT, 'src/api/routes.ts'), 'utf-8');
    assert.ok(c.includes('/auth/saml/acs'));
  });
});

describe('W4-4D01 — SamlProvider', () => {
  let origEntityId: string | undefined;

  before(() => { origEntityId = process.env['OTK_SAML_ENTITY_ID']; });
  after(() => {
    if (origEntityId !== undefined) process.env['OTK_SAML_ENTITY_ID'] = origEntityId;
    else delete process.env['OTK_SAML_ENTITY_ID'];
  });

  it('getMetadata() returns XML string', () => {
    const sp = new SamlProvider({ entityId: 'https://test.otk.io/sp' });
    const xml = sp.getMetadata();
    assert.ok(typeof xml === 'string');
    assert.ok(xml.length > 50);
  });

  it('metadata XML contains SPSSODescriptor', () => {
    const sp = new SamlProvider({ entityId: 'https://test.otk.io/sp' });
    assert.ok(sp.getMetadata().includes('SPSSODescriptor'));
  });

  it('metadata XML contains entityID', () => {
    const sp = new SamlProvider({ entityId: 'https://my-entity.example.com' });
    assert.ok(sp.getMetadata().includes('my-entity.example.com'));
  });

  it('metadata XML contains AssertionConsumerService', () => {
    const sp = new SamlProvider({ entityId: 'https://test.otk.io/sp' });
    assert.ok(sp.getMetadata().includes('AssertionConsumerService'));
  });

  it('constructor uses OTK_SAML_ENTITY_ID from env', () => {
    process.env['OTK_SAML_ENTITY_ID'] = 'https://env-entity.otk.io/sp';
    const sp = new SamlProvider();
    assert.strictEqual(sp.config.entityId, 'https://env-entity.otk.io/sp');
  });

  it('validateAssertion() throws when NameID not found', async () => {
    const sp = new SamlProvider({ entityId: 'https://test.otk.io/sp' });
    await assert.rejects(
      () => sp.validateAssertion('<samlp:Response><Assertion/></samlp:Response>'),
      /NameID not found/,
    );
  });

  it('validateAssertion() returns nameId from XML', async () => {
    const sp = new SamlProvider({ entityId: 'https://test.otk.io/sp' });
    const xml = '<Response><NameID>user@example.com</NameID></Response>';
    const result = await sp.validateAssertion(xml);
    assert.strictEqual(result.nameId, 'user@example.com');
  });

  it('constructor accepts custom callbackUrl', () => {
    const sp = new SamlProvider({ callbackUrl: 'https://custom.example.com/acs' });
    assert.strictEqual(sp.config.callbackUrl, 'https://custom.example.com/acs');
  });
});
