/**
 * M24-SEC-03 (MEDIUM, RUN-M1-24H-20261010; RUN-S had it as LOW in RV2-RUNS-08): GET /app/api/providers/health returned,
 * to any tenant credential (VIEWER and the OWNER of a fresh /signup included), per-provider request counts and CU totals
 * summed over EVERY tenant. CU is customer consumption: a caller subtracts its own share and reads the others'.
 * Now a tenant caller gets the health of its own receipts only; the platform keeps the global view.
 * Also M24-SEC-11 (latent): a verified credential without a tenant must not fall into "all tenants" on this branch.
 * Sentinel values: tenant B uses provider 'sentinel-prov' with 7919 CU; tenant A uses 'openai' with 13 CU.
 *
 * Modules under test: the provider health route of `src/api/routes.ts` (called in process with mock request and
 * response objects), reading the dashboard indexer `src/dashboard/indexer.ts`; credentials come from
 * `src/api/tenantKeyRegistry.ts` and `src/auth/jwt.ts`.
 *
 * Needs: nothing external. `OTK_ADMIN_KEY` and `OTK_JWT_SECRET` get fixture values for the run and are restored
 * afterwards; the indexer and the token registry are reset before each case.
 *
 * Run just this file: `npx tsx --test test/security/provider_health_tenant.test.ts`
 *
 * @module test/security/provider_health_tenant.test
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerToken, clearRegistry, clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';
import { getIndexer } from '../../src/dashboard/indexer.js';
import { signToken } from '../../src/auth/jwt.js';
import { handleRequest } from '../../src/api/routes.js';

function mockReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter(); let sent = false;
  em.on('newListener', (ev: string) => { if (ev === 'end' && !sent) { sent = true; setImmediate(() => em.emit('end')); } });
  return Object.assign(em, { method, url, headers: { 'content-type': 'application/json', ...headers }, destroy: () => {} }) as unknown as IncomingMessage;
}
async function call(url: string, headers: Record<string, string> = {}) {
  let code = 200; let out = '';
  const res = { setHeader() {}, writeHead(c: number) { code = c; return res; }, end(d?: string) { if (d) out += String(d); }, get statusCode() { return code; }, set statusCode(c: number) { code = c; } };
  await handleRequest(mockReq('GET', url, headers), res as unknown as ServerResponse);
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(out) as Record<string, unknown>; } catch { /* non-JSON */ }
  return { status: code, json, body: out };
}
const RUN = Date.now().toString(36);
const A = `ph-a-${RUN}`; const B = `ph-b-${RUN}`;
const VIEWER_A = `ph-viewer-a-${RUN}`;
const PLATFORM = `ph-platform-${RUN}-0123456789abcdef`;
const JWT_SECRET = `ph-jwt-${RUN}-0123456789abcdef`;
let origKey: string | undefined; let origJwt: string | undefined;
before(() => {
  origKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  origJwt = process.env['OTK_JWT_SECRET']; process.env['OTK_JWT_SECRET'] = JWT_SECRET;
});
after(() => {
  if (origKey === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origKey;
  if (origJwt === undefined) delete process.env['OTK_JWT_SECRET']; else process.env['OTK_JWT_SECRET'] = origJwt;
});
beforeEach(() => {
  clearRegistry(); clearHashRegistryForTest();
  registerToken(VIEWER_A, A, 'VIEWER');
  const ix = getIndexer(); ix.reset();
  ix.index({ requestId: `b-${RUN}`, provider: 'sentinel-prov', model: 'm', inputTokens: 1, outputTokens: 1, costUnits: 7919, latencyMs: 5, timestamp: Date.now(), tenantId: B });
  ix.index({ requestId: `a-${RUN}`, provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1, outputTokens: 1, costUnits: 13, latencyMs: 5, timestamp: Date.now(), tenantId: A });
});

describe('M24-SEC-03: /app/api/providers/health is scoped to the caller tenant', () => {
  it('a VIEWER of A sees only A: no sentinel provider, total CU exactly 13, no 7919 anywhere', async () => {
    const r = await call('/app/api/providers/health', { authorization: `Bearer ${VIEWER_A}` });
    assert.equal(r.status, 200, r.body);
    const providers = r.json['providers'] as Array<{ provider: string; totalCU: number; requests: number }>;
    assert.ok(!providers.some((p) => p.provider === 'sentinel-prov'), 'tenant B provider leaked');
    assert.equal(providers.reduce((s, p) => s + p.totalCU, 0), 13);
    assert.equal(providers.reduce((s, p) => s + p.requests, 0), 1);
    assert.ok(!r.body.includes('7919'), 'tenant B CU leaked');
  });
  it('the platform credential keeps the global view (both providers)', async () => {
    const r = await call('/app/api/providers/health', { 'x-admin-key': PLATFORM });
    assert.equal(r.status, 200, r.body);
    const providers = r.json['providers'] as Array<{ provider: string; totalCU: number }>;
    assert.equal(providers.reduce((s, p) => s + p.totalCU, 0), 7919 + 13);
  });
  it('M24-SEC-11: a signed JWT without a tenant (sub) gets 401 on the tenant branch, never the aggregate of all tenants', async () => {
    const noTenant = signToken({ role: 'VIEWER' } as unknown as { sub: string; role: string }, JWT_SECRET, 600);
    for (const u of ['/app/api/providers/health', '/app/api/usage']) {
      const r = await call(u, { authorization: `Bearer ${noTenant}` });
      assert.ok(!r.body.includes('7919'), `${u} leaked tenant B`);
      assert.equal(r.status, 401, `${u} answered ${r.status}`);
    }
  });
});
