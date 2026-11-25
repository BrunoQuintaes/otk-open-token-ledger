/**
 * RUN-S-T026 / T025 (RUN-S 2026-10-09, Gate S-05): HTTP surface of the API.
 * 1. The routes registered in the source (scripts/ops/extract_routes.mjs) equal the committed inventory
 *    (test/fixtures/security/route_surface_m1.json): a new or removed route fails until the inventory is reviewed.
 * 2. With auth enabled every route classified "authenticated" answers 401 without a credential and with a revoked key.
 * 3. Data of another tenant (seeded receipts, TAL debit, API key label) never appears in a public route nor in what a
 *    VIEWER of tenant A can read, for the three credential origins: static token, key created by /keys, JWT.
 * Static extraction is not a proof of authorization; the dynamic checks below are the evidence.
 *
 * Also checked: every public route in the inventory states its reason.
 *
 * Under test: `scripts/ops/extract_routes.mjs` (run once as a child `node` process with `--json`) against the
 * committed inventory, and the route handlers of `src/api/routes.ts` called in process with mock request and response
 * objects (each call bounded at 4 s). Tenant B is seeded with a dynamic key label, an indexed receipt, a dead letter and
 * a ledger debit.
 *
 * Needs: only the repository files; no network, no database. `OTK_ADMIN_KEY` and `OTK_JWT_SECRET` get fixture values
 * for the run and are restored afterwards.
 *
 * Run just this file: `npx tsx --test test/security/route_surface.test.ts`
 *
 * @module test/security/route_surface.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { registerToken, clearRegistry, clearHashRegistryForTest } from '../../src/api/tenantKeyRegistry.js';
import { createApiKey, revokeApiKey } from '../../src/api/apiKeyManager.js';
import { resetApiKeyMetadataStoreForTest } from '../../src/api/IApiKeyMetadataStore.js';
import { resetTokenStoreForTest } from '../../src/api/ITokenStore.js';
import { signToken } from '../../src/auth/jwt.js';
import { handleRequest } from '../../src/api/routes.js';
import { getIndexer } from '../../src/dashboard/indexer.js';
import { getAccountingLayer } from '../../src/security/talRuntime.js';
import { addDeadLetter } from '../../src/api/deadLetterStore.js';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
type Route = { key: string; server: string; methods: string[]; kind: string; path: string; file: string; access: string; sample?: string; publicReason?: string; streaming?: boolean };
const inventory = (JSON.parse(fs.readFileSync(path.join(ROOT, 'test', 'fixtures', 'security', 'route_surface_m1.json'), 'utf-8')) as { routes: Route[] }).routes;
const extracted = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'ops', 'extract_routes.mjs'), ROOT, '--json'], { encoding: 'utf-8' })) as Route[];

function sample(r: Route): string {
  if (r.sample) return r.sample;
  const concrete = (p: string, kind: string) => {
    if (kind === 'eq') return p;
    if (kind === 'prefix') return p.endsWith('/') ? `${p}probe-id` : `${p}/probe-id`;
    return p.replace(/^\//, '').replace(/\/[a-z]*$/, '').replace(/^\^/, '').replace(/\$$/, '').replace(/\(\?:[^)]*\)\??/g, '')
      .replace(/\[\^\/\]\+|\[\^\/\]\*|\(\[\^\/\]\+\)|\(\.\+\)|\.\+|\\w\+|\(\\w\+\)/g, 'probe').replace(/\\\//g, '/').replace(/[()]/g, '');
  };
  const c = concrete(r.path, r.kind);
  return r.path.startsWith('/v1/') && r.file === 'src/api/routes.ts' && r.path !== '/v1/' ? `/v1${c}` : c; // NF-15 double prefix
}
function mockReq(method: string, url: string, headers: Record<string, string>): IncomingMessage {
  const em = new EventEmitter(); let sent = false;
  em.on('newListener', (ev: string) => { if (ev === 'end' && !sent) { sent = true; setImmediate(() => { em.emit('data', Buffer.from('{}')); em.emit('end'); }); } });
  return Object.assign(em, { method, url, headers: { 'content-type': 'application/json', ...headers }, destroy: () => {}, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
}
async function call(method: string, url: string, headers: Record<string, string> = {}) {
  let code = 200; let body = '';
  const res = { headersSent: false, setHeader() {}, getHeader() { return undefined; }, writeHead(c: number) { code = c; return res; }, write(d: string) { body += d; return true; }, end(d?: string) { if (d) body += String(d); }, get statusCode() { return code; }, set statusCode(c: number) { code = c; } };
  await Promise.race([handleRequest(mockReq(method, url, headers), res as unknown as ServerResponse), new Promise((r) => setTimeout(r, 4000))]);
  return { status: code, body };
}
const methodsOf = (r: Route) => r.methods.map((m) => (m === 'ANY' ? 'GET' : m));

const RUN = Date.now().toString(36);
const A = `surf-a-${RUN}`; const B = `surf-b-${RUN}`;
const B_MARK = `surf-b-label-${RUN}`;
const VIEWER_A = `surf-viewer-a-${RUN}`; const OWNER_A = `surf-owner-a-${RUN}`;
const JWT_SECRET = `surf-jwt-${RUN}-0123456789abcdef`;
let origKey: string | undefined; let origJwt: string | undefined;
let dynKey = ''; let revokedKey = ''; let jwt = ''; let ownerJwt = '';

before(async () => {
  origKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = `surf-platform-${RUN}`;
  origJwt = process.env['OTK_JWT_SECRET']; process.env['OTK_JWT_SECRET'] = JWT_SECRET;
  clearRegistry(); clearHashRegistryForTest(); resetApiKeyMetadataStoreForTest(); resetTokenStoreForTest();
  registerToken(VIEWER_A, A, 'VIEWER'); registerToken(OWNER_A, A, 'OWNER');
  dynKey = (await createApiKey(A, 'a-viewer-key', 'VIEWER')).rawKey;
  const rk = await createApiKey(A, 'a-revoked', 'OWNER'); await revokeApiKey(rk.keyId); revokedKey = rk.rawKey;
  jwt = signToken({ sub: A, role: 'VIEWER' }, JWT_SECRET, 600);
  ownerJwt = signToken({ sub: A, role: 'OWNER' }, JWT_SECRET, 600);
  await createApiKey(B, B_MARK, 'OWNER');
  getIndexer().index({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 10, outputTokens: 2, costUnits: 5, latencyMs: 1, timestamp: Date.now(), requestId: `surf-rb-${RUN}`, tenantId: B });
  await addDeadLetter({ originalPayload: `payload-${B_MARK}`, error: 'e', reason: 'validation_error', source: 'surface', tenantId: B });
  getAccountingLayer().debit({ tenantId: B, epochId: `ep-${RUN}`, requestId: `surf-tal-b-${RUN}`, provider: 'openai', model: 'gpt-4o-mini', cu: 9n, ts: Date.now() });
});
after(() => {
  if (origKey === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origKey;
  if (origJwt === undefined) delete process.env['OTK_JWT_SECRET']; else process.env['OTK_JWT_SECRET'] = origJwt;
});

describe('S-05: route inventory', () => {
  it('the extracted routes equal the committed inventory (no unreviewed route)', () => {
    const inv = new Set(inventory.map((r) => r.key)); const ext = new Set(extracted.map((r) => r.key));
    const added = [...ext].filter((k) => !inv.has(k)); const removed = [...inv].filter((k) => !ext.has(k));
    assert.deepEqual({ added, removed }, { added: [], removed: [] }, 'update test/fixtures/security/route_surface_m1.json after reviewing the access of each route');
  });
  it('every public route has a reason', () => {
    for (const r of inventory.filter((x) => x.access === 'public')) assert.ok(r.publicReason && r.publicReason !== 'UNREVIEWED', r.key);
  });
});

describe('S-05: authenticated routes refuse missing and revoked credentials', () => {
  it('every authenticated API route answers 401 without a credential', async () => {
    const bad: string[] = [];
    for (const r of inventory.filter((x) => x.access === 'authenticated' && x.server === 'api')) {
      for (const m of methodsOf(r)) { const s = (await call(m, sample(r))).status; if (s !== 401) bad.push(`${m} ${sample(r)} -> ${s}`); }
    }
    assert.deepEqual(bad, []);
  });
  it('every authenticated API route answers 401 with a revoked key', async () => {
    const bad: string[] = [];
    for (const r of inventory.filter((x) => x.access === 'authenticated' && x.server === 'api')) {
      for (const m of methodsOf(r)) { const s = (await call(m, sample(r), { authorization: `Bearer ${revokedKey}` })).status; if (s !== 401) bad.push(`${m} ${sample(r)} -> ${s}`); }
    }
    assert.deepEqual(bad, []);
  });
});

describe('S-05: no data of another tenant through public routes or VIEWER reads', () => {
  it('public routes show no identifier of tenant B', async () => {
    const leaks: string[] = [];
    for (const r of inventory.filter((x) => x.access === 'public' && x.server === 'api')) {
      for (const m of methodsOf(r)) { const b = (await call(m, sample(r))).body; if (b.includes(B) || b.includes(B_MARK)) leaks.push(`${m} ${sample(r)}`); }
    }
    assert.deepEqual(leaks, []);
  });
  const creds = [['VIEWER, static token', () => VIEWER_A, ''], ['VIEWER, key created by /keys', () => dynKey, ''], ['VIEWER, JWT', () => jwt, ''],
    ['OWNER, static token', () => OWNER_A, ''], ['OWNER, JWT', () => ownerJwt, ''], ['OWNER, static token, ?tenantId=B in the query', () => OWNER_A, `tenantId=${B}`]] as const;
  for (const [origin, cred, query] of creds) {
    it(`a tenant role of A (${origin}) reads nothing of tenant B on any GET route`, async () => {
      const leaks: string[] = [];
      // streaming routes (SSE) keep the connection open once authorized; they are covered by the 401 checks above
      for (const r of inventory.filter((x) => x.server === 'api' && !x.streaming && x.methods.some((m) => m === 'GET' || m === 'ANY'))) {
        const u = query ? `${sample(r)}${sample(r).includes('?') ? '&' : '?'}${query}` : sample(r);
        const res = await call('GET', u, { authorization: `Bearer ${cred()}` });
        if (res.status < 300 && (res.body.includes(B) || res.body.includes(B_MARK))) leaks.push(`GET ${u} -> ${res.status}`);
      }
      assert.deepEqual(leaks, []);
    });
  }
});
