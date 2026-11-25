/**
 * PF-NEW-01 (POST-FREEZE review; decision D2 = fix, RUN-S prompt of the author 2026-10-08). The SAML ACS endpoint
 * validated nothing (no signature, certificate, issuer, audience, destination, validity window or replay check) and
 * signed a JWT whose tenant was the NameID chosen by the sender. Outside production (staging has a public ingress in
 * the Helm values) anyone could obtain a MEMBER token of any tenant. Until real validation exists the endpoint refuses
 * every assertion and never issues a token, in every environment.
 *
 * Module under test: `src/api/routes.ts` (the SAML assertion consumer, the OIDC callback and the SP metadata),
 * with `src/api/tenantKeyRegistry.ts`.
 *
 * Strategy / partitions: a forged unsigned assertion in development, test, staging and production; the
 * explicit not-implemented refusal; the OIDC callback with a configured issuer in three environments; the SP
 * metadata still served.
 *
 * Needs: nothing external (the configured issuer is a non-resolvable `.invalid` host). Changes `NODE_ENV`,
 * `OTK_JWT_SECRET`, `OTK_OIDC_ISSUER` and `OTK_OIDC_CLIENT_ID` and restores them.
 *
 * Run just this file: `npx tsx --test test/unit/sso_fail_closed.test.ts`
 *
 * @module test/unit/sso_fail_closed.test
 */
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleRequest } from '../../src/api/routes.js';
import { registerToken, clearRegistry } from '../../src/api/tenantKeyRegistry.js';

function mockReq(method: string, url: string, body: string, headers: Record<string, string> = {}): IncomingMessage {
  // the body is emitted only once the handler listens for it (routes await dynamic imports before reading)
  const em = new EventEmitter();
  let sent = false;
  em.on('newListener', (ev: string) => {
    if (ev === 'end' && !sent) { sent = true; setImmediate(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); }); }
  });
  const req = Object.assign(em, { method, url, destroy: () => {}, headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers } }) as unknown as IncomingMessage;
  return req;
}
type MockRes = ServerResponse & { body: string };
function mockRes(): MockRes {
  let body = '';
  return { statusCode: 200, setHeader: () => {}, writeHead(c: number) { (this as { statusCode: number }).statusCode = c; return this; }, end: (d: string) => { body = d; }, get body() { return body; } } as unknown as MockRes;
}
const RUN = Date.now().toString(36);
const VICTIM = `victim-tenant-${RUN}`;
const forged = Buffer.from(`<samlp:Response><saml:Assertion><saml:NameID>${VICTIM}</saml:NameID></saml:Assertion></samlp:Response>`).toString('base64');
async function acs(env: string) {
  process.env['NODE_ENV'] = env;
  const res = mockRes();
  await handleRequest(mockReq('POST', '/v1/auth/saml/acs', `SAMLResponse=${encodeURIComponent(forged)}`), res);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(res.body) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.statusCode, json, body: res.body };
}
let origEnv: string | undefined; let origJwt: string | undefined;
before(() => {
  origJwt = process.env['OTK_JWT_SECRET']; process.env['OTK_JWT_SECRET'] = `saml-jwt-${RUN}-0123456789abcdef`;
  clearRegistry(); registerToken(`saml-owner-${RUN}`, `saml-ten-${RUN}`, 'OWNER');
});
after(() => { if (origJwt === undefined) delete process.env['OTK_JWT_SECRET']; else process.env['OTK_JWT_SECRET'] = origJwt; });
afterEach(() => { if (origEnv === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = origEnv; });

describe('PF-NEW-01: SAML ACS refuses unvalidated assertions', () => {
  for (const env of ['development', 'test', 'staging', 'production']) {
    it(`${env}: a forged unsigned assertion gets no token`, async () => {
      origEnv = process.env['NODE_ENV'];
      const r = await acs(env);
      assert.ok(r.status >= 400, `status ${r.status}`);
      assert.equal(r.json['token'], undefined);
      assert.ok(!r.body.includes('eyJ'), 'no JWT in the body');
    });
  }
  it('the refusal is explicit (not implemented), not a generic auth error', async () => {
    origEnv = process.env['NODE_ENV'];
    const r = await acs('development');
    assert.equal(r.status, 501);
    assert.equal(r.json['error'], 'saml_not_supported');
  });
  it('RUN-S-N02: OIDC callback with a configured issuer gets no token from the stub exchange', async () => {
    origEnv = process.env['NODE_ENV'];
    const prevIss = process.env['OTK_OIDC_ISSUER']; const prevId = process.env['OTK_OIDC_CLIENT_ID'];
    process.env['OTK_OIDC_ISSUER'] = 'https://idp.example.invalid'; process.env['OTK_OIDC_CLIENT_ID'] = `client-${RUN}`;
    try {
      for (const env of ['development', 'staging', 'production']) {
        process.env['NODE_ENV'] = env;
        const res = mockRes();
        await handleRequest(mockReq('GET', `/v1/auth/oidc/callback?code=${VICTIM}`, ''), res);
        assert.ok(res.statusCode >= 400, `${env}: status ${res.statusCode}`);
        assert.ok(!res.body.includes('eyJ'), `${env}: no JWT in the body`);
      }
    } finally {
      if (prevIss === undefined) delete process.env['OTK_OIDC_ISSUER']; else process.env['OTK_OIDC_ISSUER'] = prevIss;
      if (prevId === undefined) delete process.env['OTK_OIDC_CLIENT_ID']; else process.env['OTK_OIDC_CLIENT_ID'] = prevId;
    }
  });
  it('SP metadata stays available', async () => {
    const res = mockRes();
    await handleRequest(mockReq('GET', '/v1/auth/saml/metadata', ''), res);
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /SPSSODescriptor/);
  });
});
