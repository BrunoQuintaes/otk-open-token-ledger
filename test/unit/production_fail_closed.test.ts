/**
 * PF-NEW-03 / NF-17 / NF-22 (POST-FREEZE review; decision D2 = fix, RUN-S prompt of the author 2026-10-08).
 * With OTK_TENANTS empty authentication is off (A0). Under NODE_ENV=production that left every route guarded only by
 * `if (isAuthEnabled())` open without a credential (GDPR export answered 200, EV-09), the legacy admin key check let
 * everything through when OTK_ADMIN_KEY was missing, and the legacy POST /proxy accepted events with the tenant taken
 * from the body. A production deployment must not disable authentication silently:
 *   1. the server refuses to start in production without OTK_TENANTS and OTK_ADMIN_KEY;
 *   2. if the API is reached anyway in production A0, every route except the liveness probes answers 503;
 *   3. the legacy POST /proxy answers 503 in production A0 (same rule as the MITM path);
 *   4. development and test keep their permissive A0 mode (characterized, not changed).
 *
 * Modules under test: `src/api/routes.ts`, `src/api/tenantKeyRegistry.ts`, the legacy gateway of
 * `src/proxy/ProxyGateway.ts` and the start-up checks of `src/api/server.ts`.
 *
 * Strategy / partitions: in-process routes in production and staging without authentication (closed),
 * liveness probe (still open) and development (open, characterized); the legacy gateway in production
 * without authentication; server start without tenants, without admin key, in staging, with a valid
 * configuration, with an in-memory plan store, with the public demo key and with a key shorter than 32
 * characters.
 *
 * Needs: changes `NODE_ENV` and `OTK_ADMIN_KEY` and restores them. Starts the gateway on a random port of
 * 127.0.0.1 and spawns `src/api/server.ts` with the `tsx` loader (each child killed after at most 40 s).
 *
 * Run just this file: `npx tsx --test test/unit/production_fail_closed.test.ts`
 *
 * @module test/unit/production_fail_closed.test
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import type { IncomingMessage, ServerResponse, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadTenantsFromString } from '../../src/api/tenantKeyRegistry.js';
import { handleRequest } from '../../src/api/routes.js';
import { startProxyGateway } from '../../src/proxy/ProxyGateway.js';

function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers }) as unknown as IncomingMessage;
  process.nextTick(() => { em.emit('end'); });
  return req;
}
type MockRes = ServerResponse & { body: string };
function mockRes(): MockRes {
  let body = '';
  return { statusCode: 200, setHeader: () => {}, writeHead(c: number) { (this as { statusCode: number }).statusCode = c; return this; }, end: (d: string) => { body = d; }, get body() { return body; } } as unknown as MockRes;
}
async function call(method: string, url: string, headers: Record<string, string> = {}) {
  const res = mockRes();
  await handleRequest(mockReq(method, url, headers), res);
  return { status: res.statusCode, body: res.body };
}
const SENSITIVE = ['/v1/admin/gdpr/export/tenant-x', '/v1/billing/cycles', '/admin/tal-summary', '/admin/dead-letters', '/v1/receipts', '/v1/balance', '/admin/finance', '/v1/flags/evaluate'];
let origEnv: string | undefined; let origAdmin: string | undefined;

beforeEach(() => {
  origEnv = process.env['NODE_ENV']; origAdmin = process.env['OTK_ADMIN_KEY'];
  delete process.env['OTK_ADMIN_KEY'];
  loadTenantsFromString('');
});
afterEach(() => {
  if (origEnv === undefined) delete process.env['NODE_ENV']; else process.env['NODE_ENV'] = origEnv;
  if (origAdmin === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origAdmin;
});

describe('PF-NEW-03: production with authentication disabled fails closed', () => {
  it('no sensitive route answers 2xx without a credential in production A0', async () => {
    process.env['NODE_ENV'] = 'production';
    for (const u of SENSITIVE) {
      const r = await call('GET', u);
      assert.ok(r.status >= 400, `${u} answered ${r.status}`);
    }
  });
  it('the legacy admin key check does not let requests through in production when OTK_ADMIN_KEY is missing', async () => {
    process.env['NODE_ENV'] = 'production';
    assert.notEqual((await call('GET', '/admin/tal-summary')).status, 200);
    assert.notEqual((await call('POST', '/admin/flush-batch')).status, 200);
  });
  it('the liveness probe still answers in production A0', async () => {
    process.env['NODE_ENV'] = 'production';
    assert.equal((await call('GET', '/health')).status, 200);
    assert.equal((await call('GET', '/healthz')).status, 200);
  });
  it('staging (public ingress in the Helm values) fails closed like production', async () => {
    process.env['NODE_ENV'] = 'staging';
    for (const u of SENSITIVE) assert.ok((await call('GET', u)).status >= 400, u);
    assert.equal((await call('GET', '/health')).status, 200);
  });
  it('development A0 is unchanged (permissive by design, characterized)', async () => {
    process.env['NODE_ENV'] = 'development';
    assert.equal((await call('GET', '/v1/billing/cycles')).status, 200);
  });
});

describe('NF-17: legacy POST /proxy in production A0', () => {
  let server: Server; let base = '';
  before(async () => {
    server = startProxyGateway({ port: 0 });
    await new Promise<void>((r) => (server.listening ? r() : server.once('listening', () => r())));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => { await new Promise<void>((r) => server.close(() => r())); });
  it('answers 503 and stores nothing when authentication is not configured in production', async () => {
    process.env['NODE_ENV'] = 'production';
    const event = { provider: 'openai', model: 'gpt-4o-mini', inputTokens: 10, outputTokens: 2, tenantId: 'victim', requestId: `nf17-${Date.now()}` };
    const r = await fetch(`${base}/proxy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event) });
    assert.equal(r.status, 503);
  });
});

describe('PF-NEW-03: the server refuses to start in production without authentication', () => {
  function runServer(env: Record<string, string>): Promise<{ code: number | null; out: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'src/api/server.ts'], {
        env: { PATH: process.env['PATH'] ?? '', SystemRoot: process.env['SystemRoot'] ?? '', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      const done = (code: number | null) => { clearTimeout(t); resolve({ code, out }); };
      child.stdout.on('data', (d) => { out += String(d); if (out.includes('api server listening')) { child.kill(); } });
      child.stderr.on('data', (d) => { out += String(d); });
      child.on('exit', (code) => done(code));
      const t = setTimeout(() => child.kill(), 40_000);
    });
  }
  it('exits non-zero and says why when OTK_TENANTS is empty', async () => {
    const r = await runServer({ NODE_ENV: 'production', API_PORT: '0', OTK_CSRF_SECRET: 'fixture-csrf-secret-0123456789', OTK_ADMIN_KEY: 'fixture-admin-key-0123456789abcdef' });
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.includes('api server listening'), 'server must not listen');
    assert.match(r.out, /OTK_TENANTS/);
  });
  it('exits non-zero when OTK_ADMIN_KEY is missing', async () => {
    const r = await runServer({ NODE_ENV: 'production', API_PORT: '0', OTK_CSRF_SECRET: 'fixture-csrf-secret-0123456789', OTK_TENANTS: 'acme/OWNER:fixture-token-0123456789' });
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.includes('api server listening'));
    assert.match(r.out, /OTK_ADMIN_KEY/);
  });
  it('exits non-zero in staging without OTK_TENANTS', async () => {
    const r = await runServer({ NODE_ENV: 'staging', API_PORT: '0', OTK_CSRF_SECRET: 'fixture-csrf-secret-0123456789', OTK_ADMIN_KEY: 'fixture-admin-key-0123456789abcdef' });
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.includes('api server listening'));
  });
  it('starts normally with a valid production configuration', async () => {
    // H1-S01 (FA-04): without PostgreSQL the plan store is in memory; a deployed start now needs the explicit opt-out
    // (the case without it is the next test). This process has no PostgreSQL to point at.
    const r = await runServer({ NODE_ENV: 'production', API_PORT: '0', OTK_CSRF_SECRET: 'fixture-csrf-secret-0123456789', OTK_ADMIN_KEY: 'fixture-admin-key-0123456789abcdef', OTK_TENANTS: 'acme/OWNER:fixture-token-0123456789', OTK_ALLOW_NON_DURABLE_STORES: '1' });
    assert.ok(r.out.includes('api server listening'), r.out.slice(-800));
    assert.match(r.out, /OTK_ALLOW_NON_DURABLE_STORES=1/, 'the opt-out is logged, never silent');
    assert.ok(!r.out.includes('fixture-token-0123456789') && !r.out.includes('fixture-admin-key-0123456789abcdef'), 'no secret in the logs');
  });
  it('H1-S01: exits non-zero in production when the plan store would be in memory (no OTK_DB_URL, no opt-out)', async () => {
    const r = await runServer({ NODE_ENV: 'production', API_PORT: '0', OTK_CSRF_SECRET: 'fixture-csrf-secret-0123456789', OTK_ADMIN_KEY: 'fixture-admin-key-0123456789abcdef', OTK_TENANTS: 'acme/OWNER:fixture-token-0123456789' });
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.includes('api server listening'));
    assert.match(r.out, /plan store is not PostgreSQL/);
  });
  // ADV-M24-18 / RV2-RUNS-05 (RUN-M1-24H): the platform credential must not be the public demo value nor short
  it('exits non-zero when OTK_ADMIN_KEY is the public demo value', async () => {
    const r = await runServer({ NODE_ENV: 'production', API_PORT: '0', OTK_CSRF_SECRET: 'fixture-csrf-secret-0123456789', OTK_ADMIN_KEY: 'demo-otk-2026', OTK_TENANTS: 'acme/OWNER:fixture-token-0123456789' });
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.includes('api server listening'));
    assert.match(r.out, /OTK_ADMIN_KEY/);
  });
  it('exits non-zero when OTK_ADMIN_KEY is shorter than 32 characters', async () => {
    const r = await runServer({ NODE_ENV: 'production', API_PORT: '0', OTK_CSRF_SECRET: 'fixture-csrf-secret-0123456789', OTK_ADMIN_KEY: 'short-admin-key-0123', OTK_TENANTS: 'acme/OWNER:fixture-token-0123456789' });
    assert.notEqual(r.code, 0);
    assert.ok(!r.out.includes('api server listening'));
  });
});
