/**
 * AUD-FC-06..11 (FINAL CLOSURE re-audit sweep, 2026-10-07): routes that take a tenant or a resource id from the path
 * act only inside the caller's tenant. Another tenant's vault, GDPR export/erasure, export job, webhook endpoint or
 * team is refused without effect (403 cross_tenant_forbidden for a tenant named in the path, 404 for a resource id);
 * feature flags are platform configuration (no tenant role). Bruno's rule: tenant roles administer only their own
 * tenant; no platform role exists in this version.
 *
 * Note: the vault and webhook routers match `routePath` against a `/v1/...` prefix after the `/v1` strip, so they are
 * reached at `/v1/v1/...` (pre-existing routing; recorded, not changed here).
 *
 * Module under test: `src/api/routes.ts` (tenant scoping of routes that take a tenant or resource id from the
 * path), with `src/security/ProviderKeyVault.ts`, `src/webhooks/WebhookRegistry.ts`, `src/users/teamStore.ts`
 * and `src/api/tenantKeyRegistry.ts` as fixtures.
 *
 * Strategy / partitions: for the vault, GDPR, export job, webhook endpoint and team routes, a caller of tenant
 * A acting on tenant B (refused, B unchanged) and, where relevant, on its own tenant (allowed); feature flags
 * refused to every tenant role.
 *
 * Needs: nothing external; requests and responses are in-memory mocks.
 *
 * Run just this file: `npx tsx --test test/unit/tenant_boundary_sweep.test.ts`
 *
 * @module test/unit/tenant_boundary_sweep.test
 */
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerToken, clearRegistry } from '../../src/api/tenantKeyRegistry.js';
import { handleRequest } from '../../src/api/routes.js';
import { getVault, resetVaultForTest } from '../../src/security/ProviderKeyVault.js';
import { getWebhookStore, createWebhookEndpoint } from '../../src/webhooks/WebhookRegistry.js';
import { getTeamStore } from '../../src/users/teamStore.js';

function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter();
  const req = Object.assign(em, { method, url, headers: { 'content-type': 'application/json', ...headers } }) as unknown as IncomingMessage;
  process.nextTick(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); });
  return req;
}
type MockRes = ServerResponse & { body: string };
function mockRes(): MockRes {
  let body = '';
  return { statusCode: 200, setHeader: () => {}, writeHead(c: number) { (this as { statusCode: number }).statusCode = c; return this; }, end: (d: string) => { body = d; }, get body() { return body; } } as unknown as MockRes;
}
async function call(method: string, url: string, token: string, body?: unknown) {
  const res = mockRes();
  await handleRequest(mockReq(method, url, body === undefined ? '' : JSON.stringify(body), { authorization: `Bearer ${token}` }), res);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(res.body) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: res.statusCode, json };
}
const RUN = Date.now().toString(36);
const A = `bnd-a-${RUN}`; const B = `bnd-b-${RUN}`;
const OWNER_A = `bnd-owner-a-${RUN}`; const ADMIN_A = `bnd-admin-a-${RUN}`; const OWNER_B = `bnd-owner-b-${RUN}`;

beforeEach(() => {
  clearRegistry();
  registerToken(OWNER_A, A, 'OWNER'); registerToken(ADMIN_A, A, 'ADMIN'); registerToken(OWNER_B, B, 'OWNER');
});

describe('AUD-FC-06: provider-key vault of another tenant', () => {
  it('ADMIN of A cannot store, list or delete keys in the vault of B; B keeps its key', async () => {
    resetVaultForTest();
    getVault().storeKey(B, 'openai', `sk-test-only-b-${RUN}`);
    const base = `/v1/v1/tenants/${encodeURIComponent(B)}/provider-keys`;
    const w = await call('POST', base, ADMIN_A, { provider: 'openai', key: `sk-test-only-attacker-${RUN}` });
    assert.equal(w.status, 403); assert.equal(w.json['error'], 'cross_tenant_forbidden');
    assert.equal((await call('GET', base, ADMIN_A)).status, 403);
    assert.equal((await call('DELETE', `${base}/openai`, ADMIN_A)).status, 403);
    const keys = getVault().listKeys(B);
    assert.equal(keys.length, 1, 'B key still there');
    assert.equal(getVault().getKey(B, 'openai'), `sk-test-only-b-${RUN}`, 'B key not overwritten');
  });
  it('ADMIN of A still manages its own vault', async () => {
    resetVaultForTest();
    const base = `/v1/v1/tenants/${encodeURIComponent(A)}/provider-keys`;
    assert.equal((await call('POST', base, ADMIN_A, { provider: 'openai', key: `sk-test-only-a-${RUN}` })).status, 201);
    assert.equal((await call('GET', base, ADMIN_A)).status, 200);
  });
});

describe('AUD-FC-07: GDPR export and erasure of another tenant', () => {
  it('OWNER of A cannot export or erase tenant B', async () => {
    const ex = await call('GET', `/admin/gdpr/export/${encodeURIComponent(B)}`, OWNER_A);
    assert.equal(ex.status, 403); assert.equal(ex.json['error'], 'cross_tenant_forbidden');
    const er = await call('DELETE', `/admin/gdpr/erase/${encodeURIComponent(B)}`, OWNER_A);
    assert.equal(er.status, 403); assert.equal(er.json['error'], 'cross_tenant_forbidden');
  });
});

describe('AUD-FC-08: feature flags are platform configuration', () => {
  it('OWNER and ADMIN of a tenant cannot list, create, delete flags or set an override (any tenant)', async () => {
    for (const tok of [OWNER_A, ADMIN_A]) {
      for (const [m, u, b] of [
        ['GET', '/admin/flags', undefined],
        ['POST', '/admin/flags', { key: `flag-${RUN}`, enabled: true }],
        ['DELETE', `/admin/flags/flag-${RUN}`, undefined],
        ['PUT', `/admin/flags/flag-${RUN}/override/${encodeURIComponent(B)}`, { enabled: true }],
        ['PUT', `/admin/flags/flag-${RUN}/override/${encodeURIComponent(A)}`, { enabled: true }],
      ] as const) {
        const r = await call(m, u, tok, b);
        assert.equal(r.status, 403, `${tok} ${m} ${u}`);
        assert.equal(r.json['error'], 'platform_operation_forbidden');
      }
    }
  });
});

describe('AUD-FC-09: export job of another tenant', () => {
  it('a job created by B is "not found" for A and readable by B', async () => {
    const created = await call('POST', '/v1/data/export', OWNER_B);
    assert.equal(created.status, 202);
    const jobId = String(created.json['jobId']);
    const foreign = await call('GET', `/v1/data/export/status/${jobId}`, OWNER_A);
    assert.equal(foreign.status, 404);
    assert.equal(foreign.json['data'], undefined);
    assert.equal((await call('GET', `/v1/data/export/status/${jobId}`, OWNER_B)).status, 200);
  });
});

describe('AUD-FC-10: webhook endpoint of another tenant', () => {
  it('A cannot delete, list deliveries of or replay on an endpoint of B; the endpoint survives', async () => {
    const ep = createWebhookEndpoint(B, 'https://example.invalid/hook', ['*']);
    await getWebhookStore().createEndpoint(ep);
    const id = encodeURIComponent(ep.id);
    assert.equal((await call('DELETE', `/v1/v1/webhooks/${id}`, OWNER_A)).status, 404);
    assert.equal((await call('GET', `/v1/v1/webhooks/${id}/deliveries`, OWNER_A)).status, 404);
    assert.equal((await call('POST', `/v1/v1/webhooks/${id}/deliveries/x/replay`, OWNER_A)).status, 404);
    assert.ok(await getWebhookStore().getEndpoint(ep.id), 'endpoint of B still exists');
    assert.equal((await call('GET', `/v1/v1/webhooks/${id}/deliveries`, OWNER_B)).status, 200);
  });
});

describe('AUD-FC-11: team of another tenant', () => {
  it('A cannot add, remove or list members of a team owned by B', async () => {
    const teamId = `team-b-${RUN}`;
    await getTeamStore().createTeam({ id: teamId, name: 'b team', ownerId: B, createdAt: new Date().toISOString() });
    assert.equal((await call('POST', `/v1/teams/${teamId}/members`, OWNER_A, { tenantId: A })).status, 404);
    assert.equal((await call('DELETE', `/v1/teams/${teamId}/members/${encodeURIComponent(B)}`, OWNER_A)).status, 404);
    assert.equal((await call('GET', `/v1/teams/${teamId}/members`, OWNER_A)).status, 404);
    const own = await call('GET', `/v1/teams/${teamId}/members`, OWNER_B);
    assert.equal(own.status, 200);
    assert.ok(!(own.json['members'] as Array<{ tenantId: string }>).some((m) => m.tenantId === A), 'A was not added');
  });
});
