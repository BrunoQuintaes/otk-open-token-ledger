/**
 * RV-RUNS-05 (independent adversarial review of RUN-S, 2026-10-10; MEDIUM). The fail-closed rule of PF-NEW-03 applied
 * only to NODE_ENV exactly "production" or "staging": "Production", " production", "prod", "live", "qa" or any other
 * label reopened the auth-disabled OWNER mode, and authMiddleware treated only "production" as production. Now every
 * value except development / dev / test (case and spaces ignored) or an unset NODE_ENV is a deployed environment.
 * Unset stays permissive (Node convention; tests and local runs) and is documented as a limitation.
 *
 * Modules under test: `src/api/productionGuard.ts` (deployed-environment detection), `src/api/routes.ts`
 * and `src/auth/authMiddleware.ts`, plus the start-up check of `src/api/server.ts`.
 *
 * Strategy / partitions: `NODE_ENV` values that must count as deployed (case, spaces and other labels), values
 * that keep the development mode (development, dev, test), an unset value, and a server start with a
 * deployed label and no tenants.
 *
 * Needs: changes `NODE_ENV` and removes `OTK_ADMIN_KEY` during each test, restoring both afterwards. The
 * start-up case spawns `src/api/server.ts` with the `tsx` loader on port 0 (killed after at most 40 s).
 *
 * Run just this file: `npx tsx --test test/unit/production_env_normalization.test.ts`
 *
 * @module test/unit/production_env_normalization.test
 */
import { describe, it, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadTenantsFromString } from '../../src/api/tenantKeyRegistry.js';
import { handleRequest } from '../../src/api/routes.js';
import { authenticateRequest } from '../../src/auth/authMiddleware.js';
import { isProductionEnv } from '../../src/api/productionGuard.js';

function mockReq(method: string, url: string): IncomingMessage {
  const em = new EventEmitter(); let sent = false;
  em.on('newListener', (ev: string) => { if (ev === 'end' && !sent) { sent = true; setImmediate(() => em.emit('end')); } });
  return Object.assign(em, { method, url, headers: {}, destroy: () => {} }) as unknown as IncomingMessage;
}
async function status(url: string) {
  let code = 200;
  const res = { setHeader() {}, writeHead(c: number) { code = c; return res; }, end() {}, get statusCode() { return code; }, set statusCode(c: number) { code = c; } };
  await handleRequest(mockReq('GET', url), res as unknown as ServerResponse);
  return code;
}
let orig: string | undefined; let origAdmin: string | undefined;
beforeEach(() => { orig = process.env['NODE_ENV']; origAdmin = process.env['OTK_ADMIN_KEY']; delete process.env['OTK_ADMIN_KEY']; loadTenantsFromString(''); });
afterEach(() => {
  if (orig === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = orig;
  if (origAdmin === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origAdmin;
});
const DEPLOYED = ['production', 'Production', ' production ', 'PRODUCTION', 'prod', 'live', 'qa', 'staging', 'Staging', 'preprod'];
const PERMISSIVE = ['development', 'Development', 'dev', 'test', ' test '];

describe('RV-RUNS-05: deployed-environment detection is not an exact-string match', () => {
  for (const v of DEPLOYED) {
    it(`NODE_ENV=${JSON.stringify(v)} is deployed: GDPR export and billing are refused without auth`, async () => {
      process.env['NODE_ENV'] = v;
      assert.equal(isProductionEnv(), true);
      assert.equal(await status('/v1/admin/gdpr/export/tenant-x'), 503);
      assert.equal(await status('/v1/billing/cycles'), 503);
      assert.equal(authenticateRequest(mockReq('GET', '/x')).authenticated, false, 'no implicit OWNER');
    });
  }
  for (const v of PERMISSIVE) {
    it(`NODE_ENV=${JSON.stringify(v)} keeps the development A0 mode (characterized)`, () => {
      process.env['NODE_ENV'] = v;
      assert.equal(isProductionEnv(), false);
    });
  }
  it('an unset NODE_ENV keeps the development A0 mode (documented limitation)', () => {
    delete process.env['NODE_ENV'];
    assert.equal(isProductionEnv(), false);
  });
  it('the server refuses to start with NODE_ENV=prod and no tenants', async () => {
    const r = await new Promise<{ code: number | null; out: string }>((resolve) => {
      const c = spawn(process.execPath, ['--import', 'tsx', 'src/api/server.ts'], { env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', NODE_ENV: 'prod', API_PORT: '0', OTK_CSRF_SECRET: 'fixture-csrf-0123456789', OTK_ADMIN_KEY: 'fixture-admin-0123456789' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; const t = setTimeout(() => c.kill(), 40_000);
      c.stdout.on('data', (d) => { out += String(d); if (out.includes('api server listening')) c.kill(); });
      c.stderr.on('data', (d) => { out += String(d); });
      c.on('exit', (code) => { clearTimeout(t); resolve({ code, out }); });
    });
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.includes('api server listening'));
  });
});
