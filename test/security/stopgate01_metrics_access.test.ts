/**
 * STOPGATE-01 P1.2 (R2-D8 / H1R2 review LOW-4): /metrics, /metrics?format=json and /metrics/prover are restricted in
 * deployed environments (OTK_METRICS_TOKEN bearer or platform credential) and stay open locally. Real HTTP server over
 * the API router.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { handleRequest } from '../../src/api/routes.js';
import { registerToken, clearRegistry } from '../../src/api/tenantKeyRegistry.js';
import { resetSecretsForTest } from '../../src/infra/secretsBootstrap.js';

const STATIC = 'sg01-metrics-tenant-token-0123456789abcdef';
const METRICS = 'sg01-metrics-scraper-token-0123456789abcdef';
const ADMIN = 'sg01-metrics-admin-key-0123456789abcdef';

describe('STOPGATE-01 P1.2: metrics access', () => {
  let server: http.Server;
  let base = '';
  const saved = { env: process.env['NODE_ENV'], tok: process.env['OTK_METRICS_TOKEN'], adm: process.env['OTK_ADMIN_KEY'] };

  before(async () => {
    server = http.createServer((req, res) => { void handleRequest(req, res); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    for (const [k, v] of [['NODE_ENV', saved.env], ['OTK_METRICS_TOKEN', saved.tok], ['OTK_ADMIN_KEY', saved.adm]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    process.env['NODE_ENV'] = 'test';
    resetSecretsForTest(); clearRegistry();
  });
  beforeEach(() => {
    process.env['NODE_ENV'] = 'test'; // clearRegistry() is refused in deployed environments
    resetSecretsForTest(); clearRegistry();
    registerToken(STATIC, 'acme', 'OWNER'); // auth enabled
    process.env['OTK_ADMIN_KEY'] = ADMIN;
  });

  const get = async (p: string, h: Record<string, string> = {}) => {
    const r = await fetch(base + p, { headers: h });
    return { status: r.status, body: await r.text(), www: r.headers.get('www-authenticate') };
  };

  it('local/test environment: open as before', async () => {
    process.env['NODE_ENV'] = 'test'; delete process.env['OTK_METRICS_TOKEN'];
    assert.equal((await get('/metrics')).status, 200);
  });

  it('deployed with OTK_METRICS_TOKEN: only the scraper bearer or the platform credential', async () => {
    process.env['NODE_ENV'] = 'production'; process.env['OTK_METRICS_TOKEN'] = METRICS;
    for (const p of ['/metrics', '/metrics?format=json', '/metrics/prover', '/v1/metrics']) {
      const anon = await get(p);
      assert.equal(anon.status, 401, `${p} anonymous`);
      assert.match(anon.www ?? '', /Bearer/);
      assert.equal((await get(p, { authorization: 'Bearer wrong-token-value' })).status, 401, `${p} wrong bearer`);
      assert.equal((await get(p, { authorization: `Bearer ${STATIC}` })).status, 401, `${p} tenant credential is not a metrics credential`);
      assert.equal((await get(p, { 'x-admin-key': 'wrong' })).status, 401, `${p} wrong admin key`);
    }
    const ok = await get('/metrics', { authorization: `Bearer ${METRICS}` });
    assert.equal(ok.status, 200);
    assert.ok(ok.body.includes('# HELP') || ok.body.includes('# TYPE'), 'Prometheus text');
    for (const secret of [METRICS, STATIC, ADMIN, 'acme']) assert.ok(!ok.body.includes(secret), `metrics never contain ${secret}`);
    assert.equal((await get('/metrics', { 'x-admin-key': ADMIN })).status, 200, 'platform operator');
    assert.equal((await get('/metrics?format=json', { authorization: `Bearer ${METRICS}` })).status, 200);
  });

  it('deployed without OTK_METRICS_TOKEN: fail closed except for the platform credential', async () => {
    process.env['NODE_ENV'] = 'production'; delete process.env['OTK_METRICS_TOKEN'];
    assert.equal((await get('/metrics')).status, 401);
    assert.equal((await get('/metrics', { authorization: `Bearer ${METRICS}` })).status, 401);
    assert.equal((await get('/metrics', { 'x-admin-key': ADMIN })).status, 200);
  });

  it('the metrics token opens nothing else', async () => {
    process.env['NODE_ENV'] = 'production'; process.env['OTK_METRICS_TOKEN'] = METRICS;
    assert.equal((await get('/keys', { authorization: `Bearer ${METRICS}` })).status, 401);
    assert.equal((await get('/admin/tenants', { authorization: `Bearer ${METRICS}` })).status, 401);
  });
});
