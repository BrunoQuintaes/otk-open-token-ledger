/**
 * H1-S08 (OTK-H1-MEGA-S01-S24-20261013, lane D): gaps of the API surface matrix (docs/_ops/H1/LANED_20261013/S08_ROUTE_MATRIX.md).
 *
 * 1. Inventory blind spot (S08-F01): scripts/ops/extract_routes.mjs does not see handlers whose condition is a regex with
 *    `[^/]` inside it, an `endsWith`, a `flagsPath` test or a pre-computed `*Match` variable. Those 16 handlers are not in
 *    test/fixtures/security/route_surface_m1.json, so route_surface.test.ts neither fails when one is added nor probes
 *    them without a credential. This file keeps a supplementary inventory (a new handler of that form fails here) and
 *    probes each one: no credential → 401, revoked key → 401, tenant B → refused with no effect, and a POSITIVE CONTROL
 *    (the owner of the resource, or the platform credential, is not refused) so a refusal is not an artefact of the probe.
 * 2. POST .../rotate alias (S08-F02): the rotate handler matches ANY path ending in /rotate and takes the key id from
 *    character 6 on. A foreign key through the alias is refused (asserted); the alias itself is OPEN (todo).
 * 3. Receipt without tenant (S08-F03, INFO): the read handler checks the tenant only when receipt.tenantId is set; the
 *    store stamps 'default' on a receipt written without a tenant, so tenant A is refused (asserted).
 * 4. Invalid JSON on unauthenticated routes (S08-F04): /signup, /login and /verify-email answer 500 and add a dead-letter
 *    entry per request (todo; files owned by another lane, patch proposed in the matrix document).
 * In-memory stores only: no network, no database, no Redis.
 *
 * Also covered: a VIEWER of tenant A is refused on the writes of its own tenant (role check, not only tenant binding),
 * and a path outside the keys prefix that ends in the rotate suffix is not treated as a key rotation.
 *
 * Under test: the route handlers of `src/api/routes.ts` (called in process, and also read as text to find the
 * handler conditions), the route extractor `scripts/ops/extract_routes.mjs` (run as a child `node` process), and the
 * stores the probed routes use (API keys, tokens, webhooks, teams, dead letters, provider key vault, feature flags,
 * receipts).
 *
 * Needs: nothing external. Before importing it empties `OTK_RECEIPT_LOG`, `OTK_DB_URL` and `OTK_TENANT_LOG`, sets
 * `PROVER_URL=disabled` and removes `OTK_REDIS_URL` and `OTK_TENANTS`; `OTK_ADMIN_KEY` gets a fixture value and is
 * restored after the run.
 *
 * Run just this file: `npx tsx --test test/security/h1_s08_route_matrix_gaps.test.ts`
 *
 * @module test/security/h1_s08_route_matrix_gaps.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const ROOT = path.resolve(import.meta.dirname, '..', '..');

let routes: any; let registry: any; let apiKeys: any; let metaStore: any; let tokenStore: any; let whMod: any;
let teamStore: any; let dlStore: any; let vault: any; let flags: any; let receiptStore: any;

function mockReq(method: string, url: string, body = '', headers: Record<string, string> = {}): IncomingMessage {
  const em = new EventEmitter(); let sent = false;
  em.on('newListener', (ev: string) => { if (ev === 'end' && !sent) { sent = true; setImmediate(() => { if (body) em.emit('data', Buffer.from(body)); em.emit('end'); }); } });
  return Object.assign(em, { method, url, headers: { 'content-type': 'application/json', ...headers }, socket: { remoteAddress: '127.0.0.1' }, destroy: () => {} }) as unknown as IncomingMessage;
}
class MockRes extends EventEmitter {
  statusCode = 200; body = ''; headersSent = false; hdrs: Record<string, unknown> = {};
  setHeader(k: string, v: unknown) { this.hdrs[k.toLowerCase()] = v; }
  getHeader(k: string) { return this.hdrs[k.toLowerCase()]; }
  removeHeader() { /* noop */ }
  writeHead(c: number, h?: unknown) { this.statusCode = c; if (h && typeof h === 'object') Object.assign(this.hdrs, h); this.headersSent = true; return this; }
  write(d: unknown) { this.body += String(d); return true; }
  end(d?: unknown) { if (d !== undefined && d !== null) this.body += String(d); this.headersSent = true; this.emit('finish'); return this; }
}
async function call(method: string, url: string, headers: Record<string, string> = {}, body = ''): Promise<{ status: number; body: string; json: Json }> {
  const res = new MockRes();
  await Promise.race([
    routes.handleRequest(mockReq(method, url, body, headers), res as unknown as ServerResponse),
    new Promise((r) => { setTimeout(r, 4000).unref(); }),
  ]);
  let json: Json; try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.statusCode, body: res.body, json };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

const RUN = Date.now().toString(36);
const A = `s08a-${RUN}`; const B = `s08b-${RUN}`;
const OWNER_A = `s08-owner-a-${RUN}-0123456789`; const VIEWER_A = `s08-viewer-a-${RUN}-0123456789`;
const OWNER_B = `s08-owner-b-${RUN}-0123456789`;
const PLATFORM = `s08-platform-${RUN}-0123456789abcdef`;
const platform = { 'x-admin-key': PLATFORM };
const FLAG = `s08-flag-${RUN}`;
const seed: Record<string, string> = {};
let revokedKey = '';
let origAdmin: string | undefined;

before(async () => {
  origAdmin = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  apiKeys = await import('../../src/api/apiKeyManager.js');
  metaStore = await import('../../src/api/IApiKeyMetadataStore.js');
  tokenStore = await import('../../src/api/ITokenStore.js');
  whMod = await import('../../src/webhooks/WebhookRegistry.js');
  teamStore = await import('../../src/users/teamStore.js');
  dlStore = await import('../../src/api/deadLetterStore.js');
  vault = await import('../../src/security/ProviderKeyVault.js');
  flags = await import('../../src/features/FeatureFlagService.js');
  receiptStore = await import('../../src/api/receiptStore.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest();
  metaStore.resetApiKeyMetadataStoreForTest(); tokenStore.resetTokenStoreForTest();
  registry.registerToken(OWNER_A, A, 'OWNER'); registry.registerToken(VIEWER_A, A, 'VIEWER'); registry.registerToken(OWNER_B, B, 'OWNER');
  const rk = await apiKeys.createApiKey(A, 's08-revoked', 'OWNER'); await apiKeys.revokeApiKey(rk.keyId); revokedKey = rk.rawKey;
  seed['KA'] = (await apiKeys.createApiKey(A, 's08-key-a', 'MEMBER')).keyId;
  seed['KA2'] = (await apiKeys.createApiKey(A, 's08-key-a2', 'MEMBER')).keyId;
  const ws = whMod.getWebhookStore();
  const ep = whMod.createWebhookEndpoint(A, 'https://hooks.example.invalid/a', ['*']); await ws.createEndpoint(ep); seed['EA'] = ep.id;
  seed['WDLA'] = `s08-wdl-${RUN}`;
  await ws.addDeadLetter({ id: seed['WDLA'], endpointId: ep.id, eventKind: 'receipt.created', payload: '{}', attempts: 3, lastError: 'x', createdAt: new Date().toISOString() });
  seed['TA'] = `s08-team-a-${RUN}`;
  await teamStore.getTeamStore().createTeam({ id: seed['TA'], name: 'team a', ownerId: A, createdAt: new Date().toISOString() });
  await teamStore.getTeamStore().addMember({ teamId: seed['TA'], tenantId: A, role: 'admin', joinedAt: new Date().toISOString() });
  seed['DLA'] = (await dlStore.addDeadLetter({ originalPayload: 'p', error: 'e', reason: 'validation_error', source: 's08', tenantId: A })).id;
  vault.getVault().storeKey(A, 'openai', `sk-s08-a-${RUN}-Aq1w`);
  flags.getFeatureFlagService().upsert(FLAG, false, 's08');
});
after(() => {
  if (origAdmin === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origAdmin;
});

// ── 1. supplementary inventory ──
/** Handler conditions in src/api/routes.ts that extract_routes.mjs does not report (S08-F01). */
const SUPPLEMENTARY = [
  "DELETE epDeleteMatch",
  "GET dlMatch",
  "POST replayMatch",
  "POST routePath.match(/^\\/v1\\/tenants\\/[^/]+\\/provider-keys$/)",
  "GET routePath.match(/^\\/v1\\/tenants\\/[^/]+\\/provider-keys$/)",
  "DELETE routePath.match(/^\\/v1\\/tenants\\/[^/]+\\/provider-keys\\/[^/]+$/)",
  "GET flagsPath.startsWith('/admin/flags/') && !overrideMatch",
  "PUT overrideMatch",
  "DELETE overrideMatch",
  "DELETE flagsPath.startsWith('/admin/flags/') && !overrideMatch",
  "POST routePath.match(/^\\/admin\\/dead-letters\\/[^/]+\\/retry$/)",
  "POST routePath.match(/^\\/admin\\/dead-letters\\/[^/]+\\/discard$/)",
  "POST routePath.match(/^\\/keys\\/[^/]+\\/rotate$/)", // S08-F02 fixed in H1 (was endsWith('/rotate'))
  "POST routePath.match(/^\\/teams\\/[^/]+\\/members$/)",
  "DELETE routePath.match(/^\\/teams\\/[^/]+\\/members\\/[^/]+$/)",
  "GET routePath.match(/^\\/teams\\/[^/]+\\/members$/)",
];
function scanSupplementary(): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'api', 'routes.ts'), 'utf-8').split(/\r?\n/);
  const out: string[] = [];
  for (const l of src) {
    const m = l.match(/^\s*if \(method === '([A-Z]+)' && (.*)\) \{\s*$/);
    if (!m) continue;
    const cond = m[2]!;
    // conditions the extractor resolves (eq / startsWith on routePath with a literal) are in the main inventory
    if (/^routePath\.startsWith\('[^']*'\)( && !routePath\.endsWith\('[^']*'\))*$/.test(cond)) continue;
    if (/routePath\.match\(|routePath\.endsWith\(|flagsPath\.|^\w+Match$/.test(cond)) out.push(`${m[1]} ${cond}`);
  }
  return out;
}

describe('H1-S08 supplementary route inventory (handlers invisible to extract_routes.mjs)', () => {
  it('the handlers of this form in routes.ts equal the committed supplementary list (a new one fails here)', () => {
    assert.deepEqual(scanSupplementary().sort(), [...SUPPLEMENTARY].sort());
  });
  // H1R2 C1: S08-F01 fixed in the extractor; every supplementary handler is now in the main inventory
  // (route_surface_m1.json) as well, so route_surface.test.ts probes it too (see h1r2_c1_route_extractor.test.ts)
  it('S08-F01: the main extractor reports a route at the line of every supplementary handler', () => {
    const extracted = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ops', 'extract_routes.mjs'), ROOT, '--json'], { encoding: 'utf-8' })) as Array<{ path: string; file: string; line: number; methods: string[] }>;
    const src = fs.readFileSync(path.join(ROOT, 'src', 'api', 'routes.ts'), 'utf-8').split(/\r?\n/);
    const missing: string[] = [];
    for (const cond of SUPPLEMENTARY) {
      const [method, ...rest] = cond.split(' ');
      const idx = src.findIndex((l) => l.trim() === `if (method === '${method}' && ${rest.join(' ')}) {`);
      const hit = extracted.some((r) => r.file === 'src/api/routes.ts' && r.line === idx + 1 && r.methods.includes(method!));
      if (idx < 0 || !hit) missing.push(cond);
    }
    assert.deepEqual(missing, []);
  });
});

type Probe = { name: string; method: string; url: () => string; body?: string; owner: () => Record<string, string>; okStatus: number[] };
const PROBES: Probe[] = [
  { name: 'GET webhook deliveries', method: 'GET', url: () => `/v1/v1/webhooks/${seed['EA']}/deliveries`, owner: () => bearer(OWNER_A), okStatus: [200] },
  { name: 'POST webhook replay', method: 'POST', url: () => `/v1/v1/webhooks/${seed['EA']}/deliveries/${seed['WDLA']}/replay`, owner: () => bearer(OWNER_A), okStatus: [200] },
  { name: 'GET provider keys', method: 'GET', url: () => `/v1/v1/tenants/${A}/provider-keys`, owner: () => bearer(OWNER_A), okStatus: [200] },
  { name: 'POST provider key', method: 'POST', url: () => `/v1/v1/tenants/${A}/provider-keys`, body: JSON.stringify({ provider: 'anthropic', key: `sk-ant-s08-${RUN}` }), owner: () => bearer(OWNER_A), okStatus: [201] },
  { name: 'GET flag by key', method: 'GET', url: () => `/admin/flags/${FLAG}`, owner: () => platform, okStatus: [200] },
  { name: 'PUT flag override', method: 'PUT', url: () => `/admin/flags/${FLAG}/override/${A}`, body: JSON.stringify({ enabled: true }), owner: () => platform, okStatus: [200] },
  { name: 'DELETE flag override', method: 'DELETE', url: () => `/admin/flags/${FLAG}/override/${A}`, owner: () => platform, okStatus: [200] },
  { name: 'GET team members', method: 'GET', url: () => `/teams/${seed['TA']}/members`, owner: () => bearer(OWNER_A), okStatus: [200] },
  { name: 'POST team member', method: 'POST', url: () => `/teams/${seed['TA']}/members`, body: JSON.stringify({ tenantId: `${A}-peer` }), owner: () => bearer(OWNER_A), okStatus: [201] },
  { name: 'DELETE team member', method: 'DELETE', url: () => `/teams/${seed['TA']}/members/${A}-peer`, owner: () => bearer(OWNER_A), okStatus: [200] },
  { name: 'POST dead-letter retry', method: 'POST', url: () => `/admin/dead-letters/${seed['DLA']}/retry`, owner: () => bearer(OWNER_A), okStatus: [200] },
  { name: 'POST dead-letter discard', method: 'POST', url: () => `/admin/dead-letters/${seed['DLA']}/discard`, owner: () => bearer(OWNER_A), okStatus: [200] },
  { name: 'POST key rotate', method: 'POST', url: () => `/keys/${seed['KA']}/rotate`, owner: () => bearer(OWNER_A), okStatus: [200] },
  { name: 'DELETE provider key', method: 'DELETE', url: () => `/v1/v1/tenants/${A}/provider-keys/anthropic`, owner: () => bearer(OWNER_A), okStatus: [200] },
  { name: 'DELETE webhook endpoint', method: 'DELETE', url: () => `/v1/v1/webhooks/${seed['EA']}`, owner: () => bearer(OWNER_A), okStatus: [200] },
  { name: 'DELETE flag', method: 'DELETE', url: () => `/admin/flags/${FLAG}`, owner: () => platform, okStatus: [200] },
];

describe('H1-S08 supplementary routes: negative probes paired with a positive control', () => {
  it('every supplementary handler has exactly one probe (16)', () => {
    assert.equal(PROBES.length, SUPPLEMENTARY.length);
  });
  it('no credential → 401 and a revoked API key → 401 on every supplementary route (nothing changes)', async () => {
    for (const p of PROBES) {
      const none = await call(p.method, p.url(), {}, p.body ?? '');
      assert.equal(none.status, 401, `${p.name} without credential: ${none.status} ${none.body}`);
      const rev = await call(p.method, p.url(), bearer(revokedKey), p.body ?? '');
      assert.equal(rev.status, 401, `${p.name} with revoked key: ${rev.status} ${rev.body}`);
    }
    // state unchanged by the refused calls
    assert.ok(await whMod.getWebhookStore().getEndpoint(seed['EA']));
    assert.equal((await dlStore.getDeadLetter(seed['DLA'])).status, 'pending');
    assert.equal((await apiKeys.getApiKey(seed['KA'])).revokedAt, null);
    assert.equal(flags.getFeatureFlagService().get(FLAG)?.enabled, false);
  });
  it('OWNER of tenant B (valid credential, other tenant) → 403/404 on every supplementary route of A, nothing changes', async () => {
    for (const p of PROBES) {
      const r = await call(p.method, p.url(), bearer(OWNER_B), p.body ?? '');
      assert.ok([403, 404].includes(r.status), `${p.name} as OWNER of B: ${r.status} ${r.body}`);
      assert.ok(!r.body.includes('Aq1w') && !r.body.includes('hooks.example.invalid'), `${p.name}: no A data in the refusal`);
    }
    assert.ok(await whMod.getWebhookStore().getEndpoint(seed['EA']));
    assert.equal((await dlStore.getDeadLetter(seed['DLA'])).status, 'pending');
    assert.equal((await apiKeys.getApiKey(seed['KA'])).revokedAt, null);
    assert.equal(vault.getVault().listKeys(A).length, 1);
    assert.deepEqual((await teamStore.getTeamStore().listMembers(seed['TA'])).map((m: Json) => m.tenantId), [A]);
  });
  it('VIEWER of A → 403/404 on the writes of its own tenant (RBAC, not only tenant binding)', async () => {
    const writes = PROBES.filter((p) => p.method !== 'GET' && !p.name.startsWith('POST webhook') && !p.name.startsWith('DELETE webhook'));
    for (const p of writes) {
      const r = await call(p.method, p.url(), bearer(VIEWER_A), p.body ?? '');
      assert.ok([403, 404].includes(r.status), `${p.name} as VIEWER of A: ${r.status} ${r.body}`);
    }
    assert.equal((await dlStore.getDeadLetter(seed['DLA'])).status, 'pending');
  });
  it('POSITIVE CONTROL: the owner of each resource (or the platform credential for flags) is served', async () => {
    for (const p of PROBES) {
      const r = await call(p.method, p.url(), p.owner(), p.body ?? '');
      assert.ok(p.okStatus.includes(r.status), `${p.name} as owner: ${r.status} ${r.body}`);
    }
    assert.equal(await whMod.getWebhookStore().getEndpoint(seed['EA']), null, 'the endpoint was deleted by its owner');
    assert.equal(flags.getFeatureFlagService().get(FLAG), undefined);
  });
});

// ── 2. rotate alias ──
describe('H1-S08 POST */rotate alias (S08-F02)', () => {
  it('a key of A rotated by OWNER of B through the alias path → 404, the key of A stays valid', async () => {
    const id = seed['KA2']!;
    const alias = `/zzzzz${id}/rotate`; // '/zzzzz'.length === '/keys/'.length
    const r = await call('POST', alias, bearer(OWNER_B));
    assert.equal(r.status, 404, `${r.status} ${r.body}`);
    assert.equal((await apiKeys.getApiKey(id)).revokedAt, null);
    // positive control: the canonical path is served for the owner
    const ok = await call('GET', `/keys/${id}`, bearer(OWNER_A));
    assert.equal(ok.status, 200);
  });
  // S08-F02: fixed in routes.ts (exact /keys/:id/rotate match); todo removed
  it('a path outside /keys/ ending in /rotate is not a key rotation', async () => {
    const k = await apiKeys.createApiKey(A, 's08-alias', 'MEMBER');
    const r = await call('POST', `/v1/zzzzz${k.keyId}/rotate`, bearer(OWNER_A));
    assert.equal(r.status, 404, `alias rotated the key: ${r.status} ${r.body}`);
  });
});

// ── 3. receipt without tenant ──
describe('H1-S08 receipt stored without a tenant (S08-F03)', () => {
  it('a tenant of another tenant cannot read a receipt of B (control, asserted)', async () => {
    const rid = `s08-rb-${RUN}`;
    await receiptStore.storeReceiptDurable({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1, outputTokens: 1, costUnits: 2, latencyMs: 1, timestamp: Math.floor(Date.now() / 1000), requestId: rid, userId: 0n, nonce: 0n, tenantId: B }, B);
    const r = await call('GET', `/receipts/${rid}`, bearer(VIEWER_A));
    assert.equal(r.status, 403, `${r.status} ${r.body}`);
    assert.equal((await call('GET', `/receipts/${rid}`, bearer(OWNER_B))).status, 200, 'positive control: B reads its own receipt');
  });
  it('a receipt written without a tenant is stamped "default" by the store and is not readable by tenant A', async () => {
    // S08-F03 (INFO, defence in depth): the read handler applies the tenant boundary only when receipt.tenantId is set;
    // the in-memory store never leaves it unset (tenantId ?? input.tenantId ?? 'default'), so the branch is not reachable here
    const rid = `s08-r0-${RUN}`;
    await receiptStore.storeReceiptDurable({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 1, outputTokens: 1, costUnits: 2, latencyMs: 1, timestamp: Math.floor(Date.now() / 1000), requestId: rid, userId: 0n, nonce: 0n }, undefined);
    assert.equal((await receiptStore.getReceiptDurable(rid))?.tenantId, 'default');
    const r = await call('GET', `/receipts/${rid}`, bearer(VIEWER_A));
    assert.equal(r.status, 403, `receipt of "default" served to a tenant: ${r.status} ${r.body}`);
  });
});

// ── 4. invalid JSON on unauthenticated routes ──
describe('H1-S08 invalid JSON on unauthenticated routes (S08-F04)', () => {
  it('POST /ping with invalid JSON is an echo (control: the body is not parsed, 200)', async () => {
    const r = await call('POST', '/ping', {}, '{not json');
    assert.equal(r.status, 200);
  });
  for (const route of ['/signup', '/login', '/verify-email']) {
    // S08-F04: fixed in routes.ts (JSON.parse guarded → 400 OTK-4002); todo removed
    it(`${route} with invalid JSON → 400 OTK-4002 and no dead-letter entry`, async () => {
      const before = await dlStore.deadLetterCount();
      const r = await call('POST', route, {}, '{not json');
      const after = await dlStore.deadLetterCount();
      assert.deepEqual({ status: r.status, code: r.json?.code, deadLetters: after - before }, { status: 400, code: 'OTK-4002', deadLetters: 0 });
    });
  }
});
