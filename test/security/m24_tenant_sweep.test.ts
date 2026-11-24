/**
 * M24 dynamic tenant-isolation sweep (RUN-M1-24H-20261010). Adversarial: tries to FALSIFY tenant isolation with VALID
 * credentials of tenant A (roles VIEWER, MEMBER, OPERATOR, ADMIN, OWNER; origins static token, key created by /keys,
 * JWT) plus the OWNER of a fresh /signup, against tenants B and C seeded with sentinel data through the API where
 * possible (receipts, dead-letters, keys, teams, provider keys, exports, tenant records, flag overrides) and through
 * the in-memory stores otherwise (indexer entries with teamId, TAL debits, webhook endpoints/deliveries).
 * Sentinels: identifiers `sentinel-b-7919-<run>` / `sentinel-c-104729-<run>`; CU values 7919 (B) and 104729 (C), A = 13.
 * A response leaks when it contains a B/C identifier or ANY number equal to a sum of CU values that includes a B/C value.
 * Each defect found carries a `M24-DYN-NN FINDING` comment. DYN-01/02/03/04/05/06/07 were fixed in the same run (the
 * assertions now pass); DYN-08/09/10 stay OPEN and are marked `todo` (they run and report, without failing the suite).
 * In-memory stores only: no network, no database, no Redis (PROVER_URL disabled, OTK_DB_URL and logs empty).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];
delete process.env['OTK_SCIM_BEARER_TOKEN'];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
type Role = 'VIEWER' | 'MEMBER' | 'OPERATOR' | 'ADMIN' | 'OWNER';
const ROLES: Role[] = ['VIEWER', 'MEMBER', 'OPERATOR', 'ADMIN', 'OWNER'];

// ── module handles (dynamic import after the env above) ──
let routes: any; let registry: any; let jwt: any; let rbac: any; let indexerMod: any; let dlStore: any; let talRt: any;
let plans: any; let vaultMod: any; let flagsMod: any; let tenantCrud: any; let idem: any; let whMod: any; let teamMod: any;
let teamModel: any; let cycles: any; let sse: any; let streamMgr: any; let metaStore: any; let tokenStore: any; let analytics: any;
let apiKeyMgr: any;

// ── harness: mock IncomingMessage + ServerResponse, call(method, url, headers, body) ──
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
  flushHeaders() { /* noop */ }
  write(d: unknown) { this.body += String(d); return true; }
  end(d?: unknown) { if (d !== undefined && d !== null) this.body += String(d); this.headersSent = true; this.emit('finish'); return this; }
}
type Resp = { status: number; body: string; json: Json; res: MockRes };
async function call(method: string, url: string, headers: Record<string, string> = {}, body = ''): Promise<Resp> {
  const res = new MockRes();
  await Promise.race([
    routes.handleRequest(mockReq(method, url, body, headers), res as unknown as ServerResponse),
    new Promise((r) => { setTimeout(r, 4000).unref(); }),
  ]);
  let json: Json; try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.statusCode, body: res.body, json, res };
}
const j = (o: unknown) => JSON.stringify(o);
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });

// ── tenants, sentinels, credentials ──
const RUN = Date.now().toString(36);
const A = `m24a-${RUN}`; const B = `m24b-${RUN}`; const C = `m24c-${RUN}`;
const B_MARK = `sentinel-b-7919-${RUN}`; const C_MARK = `sentinel-c-104729-${RUN}`;
const B_CU = 7919; const C_CU = 104729; const A_CU = 13;
const EP = `ep-${RUN}`;
const PLATFORM = `m24-platform-${RUN}-0123456789abcdef`;
const JWT_SECRET = `m24-jwt-${RUN}-0123456789abcdef`;
const OTHER_SECRET = `m24-other-${RUN}-0123456789abcdef`;
const platform = { 'x-admin-key': PLATFORM };
const STATIC: Record<Role, string> = Object.fromEntries(ROLES.map((r) => [r, `m24-a-${r.toLowerCase()}-${RUN}`])) as Record<Role, string>;
const B_OWNER = `m24-b-owner-${RUN}`; const B_ADMIN = `m24-b-admin-${RUN}`; const C_OWNER = `m24-c-owner-${RUN}`;
const B_CRUD_TOK = `tok-${B_MARK}`; const C_CRUD_TOK = `tok-${C_MARK}`; const A_CRUD_TOK = `tok-a-crud-platform-${RUN}`; /* >= 24 chars (H1-S06 minimum) */
const A_PK = `sk-a-${RUN}-Aq1w`; const B_PK = `sk-${B_MARK}-Bq7x`;
const FLAG = `m24-flag-${RUN}`;

type Cred = { label: string; role: Role; origin: 'static' | 'dynamic' | 'jwt' | 'signup'; token: () => string };
const dyn: Partial<Record<Role, string>> = {};
let S_JWT = ''; let S_ORG = '';
const aCreds: Cred[] = [];
for (const r of ROLES) {
  aCreds.push({ label: `A ${r} static`, role: r, origin: 'static', token: () => STATIC[r] });
  aCreds.push({ label: `A ${r} /keys`, role: r, origin: 'dynamic', token: () => dyn[r]! });
  aCreds.push({ label: `A ${r} JWT`, role: r, origin: 'jwt', token: () => jwt.signToken({ sub: A, role: r }, JWT_SECRET, 600) });
}
const signupCred: Cred = { label: 'signup OWNER (other org)', role: 'OWNER', origin: 'signup', token: () => S_JWT };
const attackers = (): Cred[] => [
  aCreds.find((c) => c.label === 'A OWNER static')!, aCreds.find((c) => c.label === 'A OWNER /keys')!,
  aCreds.find((c) => c.label === 'A OWNER JWT')!, aCreds.find((c) => c.label === 'A ADMIN static')!,
  aCreds.find((c) => c.label === 'A OPERATOR static')!, aCreds.find((c) => c.label === 'A MEMBER JWT')!, signupCred,
];

// ── seeded ids ──
const seed: Record<string, string> = {};
const A_R1 = `m24a-r1-${RUN}`; const B_R1 = `${B_MARK}-r1`; const C_R1 = `${C_MARK}-r1`;

// ── leak detector ──
// foreign CU values that exist anywhere (posted receipts, indexer entries, TAL, idempotency tests, injected team receipt)
const FOREIGN_VALUES = [B_CU, B_CU, B_CU, B_CU, B_CU, B_CU, C_CU, C_CU];
const OWN_VALUES = [A_CU, A_CU, A_CU, A_CU, A_CU];
const FORBIDDEN = (() => {
  // every sum of a sub-multiset that contains at least one foreign value
  let states = new Set<string>(['0|0']);
  for (const [v, f] of [...FOREIGN_VALUES.map((v) => [v, 1]), ...OWN_VALUES.map((v) => [v, 0])] as Array<[number, number]>) {
    const next = new Set(states);
    for (const s of states) { const [sum, has] = s.split('|').map(Number); next.add(`${sum + v}|${has || f}`); }
    states = next;
  }
  const out = new Set<number>();
  for (const s of states) { const [sum, has] = s.split('|').map(Number); if (has) out.add(sum); }
  return out;
})();
function numbersIn(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v);
  else if (typeof v === 'string' && /^-?\d+$/.test(v)) out.push(Number(v));
  else if (Array.isArray(v)) for (const x of v) numbersIn(x, out);
  else if (v && typeof v === 'object') for (const x of Object.values(v)) numbersIn(x, out);
  return out;
}
function foreignStrings(): string[] {
  return [B, C, B_MARK, C_MARK, B_OWNER, B_ADMIN, C_OWNER, 'Bq7x', seed['KB'], seed['KC'], seed['EB'], seed['TB'], seed['JB'],
    seed['DLB'], seed['DLC'], seed['WDLB'], seed['WDB']].filter((s): s is string => typeof s === 'string' && s.length > 0);
}
function leaksOf(r: { body: string; json: Json }): string[] {
  const found = foreignStrings().filter((s) => r.body.includes(s)).map((s) => `id:${s}`);
  const nums = r.json !== undefined ? numbersIn(r.json) : [...r.body.matchAll(/(?<![\d.])\d+(?![\d.])/g)].map((m) => Number(m[0]));
  for (const n of nums) if (FORBIDDEN.has(n)) found.push(`num:${n}`);
  return found;
}

function receiptBody(requestId: string, tokens: number, extra: Record<string, unknown> = {}) {
  return j({ requestId, provider: 'openai', model: 'gpt-4o', inputTokens: tokens, outputTokens: 0, ...extra });
}

let origKey: string | undefined; let origJwt: string | undefined;
before(async () => {
  origKey = process.env['OTK_ADMIN_KEY']; process.env['OTK_ADMIN_KEY'] = PLATFORM;
  origJwt = process.env['OTK_JWT_SECRET']; process.env['OTK_JWT_SECRET'] = JWT_SECRET;
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  jwt = await import('../../src/auth/jwt.js');
  rbac = await import('../../src/security/rbac.js');
  indexerMod = await import('../../src/dashboard/indexer.js');
  dlStore = await import('../../src/api/deadLetterStore.js');
  talRt = await import('../../src/security/talRuntime.js');
  plans = await import('../../src/billing/PlanRegistry.js');
  vaultMod = await import('../../src/security/ProviderKeyVault.js');
  flagsMod = await import('../../src/features/FeatureFlagService.js');
  tenantCrud = await import('../../src/api/tenantCrud.js');
  idem = await import('../../src/api/idempotency.js');
  whMod = await import('../../src/webhooks/WebhookRegistry.js');
  teamMod = await import('../../src/users/teamStore.js');
  teamModel = await import('../../src/users/TeamModel.js');
  cycles = await import('../../src/billing/BillingCycleWorker.js');
  sse = await import('../../src/streaming/SseRouter.js');
  streamMgr = await import('../../src/streaming/StreamManager.js');
  metaStore = await import('../../src/api/IApiKeyMetadataStore.js');
  tokenStore = await import('../../src/api/ITokenStore.js');
  analytics = await import('../../src/dashboard/analytics.js');
  apiKeyMgr = await import('../../src/api/apiKeyManager.js');
  const { MemoryUserStore } = await import('../../src/users/MemoryUserStore.js');
  const { setUserStore } = await import('../../src/users/IUserStore.js');

  // clean in-memory state
  registry.clearRegistry(); registry.clearHashRegistryForTest(); metaStore.resetApiKeyMetadataStoreForTest(); tokenStore.resetTokenStoreForTest();
  indexerMod.resetIndexerForTest(); await dlStore.clearDeadLettersForTest(); talRt.resetAccountingLayerForTest(); plans.clearAssignmentsForTest();
  vaultMod.resetVaultForTest(); flagsMod.resetFeatureFlagServiceForTest(); tenantCrud.clearTenantsForTest(); idem.resetIdempotencyStoreForTest();
  whMod.setWebhookStore(new whMod.MemoryWebhookStore()); teamMod.setTeamStore(new teamModel.MemoryTeamStore()); jwt.clearBlacklistForTest();
  setUserStore(new MemoryUserStore());

  // static credentials
  for (const r of ROLES) registry.registerToken(STATIC[r], A, r);
  registry.registerToken(B_OWNER, B, 'OWNER'); registry.registerToken(B_ADMIN, B, 'ADMIN'); registry.registerToken(C_OWNER, C, 'OWNER');
  assert.ok(registry.isAuthEnabled());

  // plans (internal: POST /admin/plans/assign has no platform path; tenant self-assignment is M24-SEC-02, not used here)
  await plans.assignPlan(A, 'FREE'); await plans.assignPlan(B, 'STARTER'); await plans.assignPlan(C, 'PRO');

  // tenant registry records (platform credential)
  for (const [t, tok, role] of [[A, A_CRUD_TOK, 'VIEWER'], [B, B_CRUD_TOK, 'OWNER'], [C, C_CRUD_TOK, 'OWNER']] as const) {
    const r = await call('POST', '/admin/tenants', platform, j({ tenantId: t, token: tok, role }));
    assert.equal(r.status, 201, `seed tenant record ${t}: ${r.body}`);
  }

  // dynamic keys: A (one per role), B and C (sentinel labels)
  for (const r of ROLES) {
    const k = await call('POST', '/keys', bearer(STATIC.OWNER), j({ label: `a-${r.toLowerCase()}`, role: r }));
    assert.equal(k.status, 201, k.body); dyn[r] = k.json.key.rawKey;
  }
  const kb = await call('POST', '/keys', bearer(B_OWNER), j({ label: B_MARK, role: 'OWNER' }));
  assert.equal(kb.status, 201, kb.body); seed['KB'] = kb.json.key.keyId; seed['KB_RAW'] = kb.json.key.rawKey;
  const kc = await call('POST', '/keys', bearer(C_OWNER), j({ label: C_MARK, role: 'MEMBER' }));
  assert.equal(kc.status, 201, kc.body); seed['KC'] = kc.json.key.keyId;

  // receipts through the API (CU computed by the server: gpt-4o weights 1.0 x 1.0, so CU = tokens)
  for (const [tok, rid, cu] of [[STATIC.MEMBER, A_R1, A_CU], [B_OWNER, B_R1, B_CU], [C_OWNER, C_R1, C_CU]] as const) {
    const r = await call('POST', '/receipts', bearer(tok), receiptBody(rid, cu));
    assert.equal(r.status, 201, `seed receipt ${rid}: ${r.body}`); assert.equal(r.json.costUnits, cu);
  }
  // invalid receipts → dead-letters of each tenant through the API
  for (const [tok, mark] of [[STATIC.MEMBER, `m24a-bad-${RUN}`], [B_OWNER, `${B_MARK}-bad`], [C_OWNER, `${C_MARK}-bad`]] as const) {
    const r = await call('POST', '/receipts', bearer(tok), j({ requestId: mark, costUnits: 7919 }));
    assert.equal(r.status, 400, r.body);
  }
  seed['DLB'] = (await dlStore.addDeadLetter({ originalPayload: `${B_MARK} processing`, error: 'e', reason: 'processing_error', source: 'm24', tenantId: B })).id;
  seed['DLC'] = (await dlStore.addDeadLetter({ originalPayload: `${C_MARK} processing`, error: 'e', reason: 'processing_error', source: 'm24', tenantId: C })).id;
  seed['DLA'] = (await dlStore.listDeadLetters({ tenantId: A }))[0].id;

  // TAL debits in a known epoch
  const tal = talRt.getAccountingLayer(); const now = Date.now();
  tal.debit({ tenantId: A, epochId: EP, requestId: `m24a-tal-${RUN}`, provider: 'openai', model: 'gpt-4o', cu: BigInt(A_CU), ts: now });
  tal.debit({ tenantId: B, epochId: EP, requestId: `${B_MARK}-tal`, provider: 'openai', model: 'gpt-4o', cu: BigInt(B_CU), ts: now });
  tal.debit({ tenantId: C, epochId: EP, requestId: `${C_MARK}-tal`, provider: 'openai', model: 'gpt-4o', cu: BigInt(C_CU), ts: now });

  // teams through the API
  const ta = await call('POST', '/teams', bearer(STATIC.MEMBER), j({ name: 'a-team' })); assert.equal(ta.status, 201, ta.body); seed['TA'] = ta.json.team.id;
  const tb = await call('POST', '/teams', bearer(B_OWNER), j({ name: B_MARK })); assert.equal(tb.status, 201, tb.body); seed['TB'] = tb.json.team.id;
  assert.equal((await call('POST', `/teams/${seed['TA']}/members`, bearer(STATIC.MEMBER), j({ tenantId: A }))).status, 201);
  assert.equal((await call('POST', `/teams/${seed['TB']}/members`, bearer(B_OWNER), j({ tenantId: C, role: 'admin' }))).status, 201);

  // indexer entries with team attribution (what the legacy proxy writes from x-otk-team-id), ms timestamps
  const ix = indexerMod.getIndexer();
  ix.index({ requestId: `m24a-team-r-${RUN}`, provider: 'openai', model: 'gpt-4o', inputTokens: A_CU, outputTokens: 0, costUnits: A_CU, latencyMs: 3, timestamp: Date.now(), tenantId: A, teamId: seed['TA'] });
  ix.index({ requestId: `${B_MARK}-team-r`, provider: 'openai', model: 'gpt-4o', inputTokens: B_CU, outputTokens: 0, costUnits: B_CU, latencyMs: 7919, timestamp: Date.now(), tenantId: B, teamId: seed['TB'] });

  // webhooks (POST /webhooks is dead code, M24-SEC-10): endpoints, deliveries and dead letters in the store
  const ws = whMod.getWebhookStore(); const iso = new Date().toISOString();
  const ea = whMod.createWebhookEndpoint(A, 'https://a.example.test/hook', ['*']); await ws.createEndpoint(ea); seed['EA'] = ea.id;
  const ea2 = whMod.createWebhookEndpoint(A, 'https://a.example.test/hook2', ['*']); await ws.createEndpoint(ea2); seed['EA2'] = ea2.id;
  const eb = whMod.createWebhookEndpoint(B, `https://b.example.test/${B_MARK}`, ['*'], `secret-${B_MARK}`); await ws.createEndpoint(eb); seed['EB'] = eb.id;
  await ws.logDelivery({ id: `wd-a-${RUN}`, endpointId: ea.id, eventKind: 'receipt_submitted', payload: j({ cu: A_CU }), attempt: 1, status: 'failed', createdAt: iso });
  seed['WDB'] = `wd-${B_MARK}`;
  await ws.logDelivery({ id: seed['WDB'], endpointId: eb.id, eventKind: 'receipt_submitted', payload: j({ mark: B_MARK, cu: B_CU }), attempt: 1, status: 'failed', createdAt: iso });
  seed['WDLA'] = `wdl-a-${RUN}`; seed['WDLB'] = `wdl-${B_MARK}`;
  await ws.addDeadLetter({ id: seed['WDLA'], endpointId: ea.id, eventKind: 'receipt_submitted', payload: '{}', attempts: 3, lastError: 'e', createdAt: iso });
  await ws.addDeadLetter({ id: seed['WDLB'], endpointId: eb.id, eventKind: 'receipt_submitted', payload: j({ mark: B_MARK }), attempts: 3, lastError: 'e', createdAt: iso });

  // provider keys through the API
  assert.equal((await call('POST', `/v1/v1/tenants/${A}/provider-keys`, bearer(STATIC.ADMIN), j({ provider: 'openai', key: A_PK }))).status, 201);
  assert.equal((await call('POST', `/v1/v1/tenants/${B}/provider-keys`, bearer(B_ADMIN), j({ provider: 'openai', key: B_PK }))).status, 201);

  // export jobs through the API
  const ja = await call('POST', '/data/export', bearer(STATIC.OWNER)); assert.equal(ja.status, 202, ja.body); seed['JA'] = ja.json.jobId;
  const jb = await call('POST', '/data/export', bearer(B_OWNER)); assert.equal(jb.status, 202, jb.body); seed['JB'] = jb.json.jobId;

  // flags: global off, override on for B (platform)
  assert.equal((await call('POST', '/admin/flags', platform, j({ key: FLAG, enabled: false }))).status, 200);
  assert.equal((await call('PUT', `/admin/flags/${FLAG}/override/${B}`, platform, j({ enabled: true }))).status, 200);

  // anonymous attacker: /signup gives OWNER of a new org
  const su = await call('POST', '/signup', {}, j({ email: `m24-${RUN}@example.test`, password: 'correct horse battery staple 7919', name: 'atk', orgName: 'atk org' }));
  assert.equal(su.status, 201, su.body); S_JWT = String(su.json.token); S_ORG = String(su.json.orgId);

  // billing cycles are built lazily from the indexer
  cycles.resetCycles();
  await new Promise((r) => setTimeout(r, 30)); // export jobs reach "done"
});
after(() => {
  if (origKey === undefined) delete process.env['OTK_ADMIN_KEY']; else process.env['OTK_ADMIN_KEY'] = origKey;
  if (origJwt === undefined) delete process.env['OTK_JWT_SECRET']; else process.env['OTK_JWT_SECRET'] = origJwt;
});

// ── read routes for tenant credentials ──
type Perm = string;
type ReadSpec = { url: () => string; perm: Perm | 'any'; exact?: (json: Json, body: string) => void };
const sum = (xs: Array<Record<string, unknown>>, k: string) => xs.reduce((s, x) => s + Number(x[k] ?? 0), 0);
const READS: ReadSpec[] = [
  { url: () => `/receipts/${A_R1}`, perm: 'receipts:read', exact: (x) => { assert.equal(x.receipt.tenantId, A); assert.equal(x.receipt.costUnits, A_CU); } },
  { url: () => `/accounting/balance?epochId=${EP}`, perm: 'accounting:read', exact: (x) => { assert.equal(x.tenantId, A); assert.equal(x.totalCU, String(A_CU)); assert.equal(x.entryCount, 1); } },
  { url: () => '/accounting/balance', perm: 'accounting:read', exact: (x) => assert.equal(x.tenantId, A) },
  { url: () => `/admin/tal-summary?tenantId=${A}&epochId=${EP}`, perm: 'admin:tal-summary', exact: (x) => { assert.equal(x.balance.totalCU, String(A_CU)); assert.equal(x.totalEntries, undefined); } },
  { url: () => '/admin/tal-summary', perm: 'admin:tal-summary', exact: (x) => assert.equal(x.totalEntries, undefined) },
  { url: () => `/invoices?epochId=${EP}`, perm: 'accounting:read', exact: (x) => { assert.equal(x.invoice.tenantId, A); assert.equal(x.invoice.totalCU, String(A_CU)); assert.equal(x.invoice.totalRequests, 1); } },
  { url: () => '/invoices', perm: 'accounting:read', exact: (x) => assert.equal(x.invoice.tenantId, A) },
  { url: () => '/analytics/cu-trend?days=90', perm: 'any', exact: (x) => {
    const oracle = analytics.getCuTrendData(A, 90);
    assert.equal(sum(x, 'totalCU'), sum(oracle, 'totalCU')); assert.equal(sum(x, 'receiptCount'), sum(oracle, 'receiptCount'));
  } },
  { url: () => '/events/latest?n=100', perm: 'receipts:read', exact: (x) => { for (const e of x.events) assert.equal(e.payload?.tenantId, A); } },
  { url: () => `/flags/evaluate?key=${FLAG}`, perm: 'receipts:read', exact: (x) => { assert.equal(x.enabled, false); assert.equal(x.source, 'global'); } },
  { url: () => '/admin/plans/assignments', perm: 'admin:tenants', exact: (x) => assert.deepEqual(x.assignments, [{ tenantId: A, tier: 'FREE' }]) },
  { url: () => '/admin/dead-letters?limit=100000', perm: 'admin:dead-letters', exact: (x) => {
    assert.equal(x.total, 1); assert.equal(x.pending, 1); assert.equal(x.entries.length, 1); for (const e of x.entries) assert.equal(e.tenantId, A);
  } },
  { url: () => '/admin/dead-letters?status=pending&reason=validation_error&limit=500', perm: 'admin:dead-letters', exact: (x) => { for (const e of x.entries) assert.equal(e.tenantId, A); } },
  { url: () => '/billing/cycles', perm: 'admin:billing', exact: (x) => {
    assert.equal(x.cycles.length, 1); assert.equal(x.cycles[0].tenantId, A); assert.equal(x.cycles[0].totalCU, String(2 * A_CU));
  } },
  { url: () => '/admin/tenants', perm: 'admin:tenants', exact: (x) => { assert.equal(x.count, 1); assert.equal(x.tenants[0].tenantId, A); assert.equal(x.audit, undefined); } },
  { url: () => `/admin/tenants/${A}`, perm: 'admin:tenants', exact: (x) => assert.equal(x.tenant.tenantId, A) },
  { url: () => '/keys', perm: 'admin:keys', exact: (x) => { assert.ok(x.keys.length >= 5); for (const k of x.keys) assert.equal(k.tenantId, A); } },
  { url: () => '/teams', perm: 'receipts:read', exact: (x) => assert.deepEqual(x.teams.map((t: Json) => t.id), [seed['TA']]) },
  { url: () => `/teams/${seed['TA']}/members`, perm: 'receipts:read', exact: (x) => assert.deepEqual(x.members.map((m: Json) => m.tenantId), [A]) },
  { url: () => '/v1/v1/reports/teams', perm: 'receipts:read', exact: (x) => { assert.deepEqual(x.teams.map((t: Json) => t.teamId), [seed['TA']]); assert.equal(x.teams[0].totalCU, A_CU); } },
  { url: () => '/app/api/usage', perm: 'any', exact: (x) => { assert.equal(sum(x.usage, 'totalCU'), 2 * A_CU); assert.equal(sum(x.usage, 'requests'), 2); } },
  { url: () => '/app/api/receipts', perm: 'any', exact: (x) => assert.deepEqual(x.receipts.map((r: Json) => r.requestId).sort(), [A_R1, `m24a-team-r-${RUN}`].sort()) },
  { url: () => '/app/api/providers/health', perm: 'any', exact: (x) => { assert.equal(sum(x.providers, 'totalCU'), 2 * A_CU); assert.equal(sum(x.providers, 'requests'), 2); } },
  { url: () => '/app', perm: 'any' },
  // H1R2 C2 (S23-F03): the job exports the real receipts of A (before: stub { records: [], count: 0 })
  { url: () => `/data/export/status/${seed['JA']}`, perm: 'any', exact: (x) => {
    assert.equal(x.tenantId, A); assert.deepEqual(x.data.records.map((r: Json) => r.requestId), [A_R1]); assert.equal(x.data.count, 1);
    for (const r of x.data.records) assert.equal(r.tenantId, A);
  } },
  { url: () => `/admin/gdpr/export/${A}`, perm: 'admin:gdpr' },
  { url: () => `/v1/v1/tenants/${A}/provider-keys`, perm: 'admin:tenants', exact: (x) => {
    assert.equal(x.keys.length, 1); assert.equal(x.keys[0].provider, 'openai'); assert.ok(String(x.keys[0].maskedKey).endsWith('Aq1w'));
  } },
  { url: () => `/v1/v1/webhooks/${seed['EA']}/deliveries`, perm: 'any', exact: (x) => { assert.equal(x.deliveries.length, 1); assert.equal(x.deliveries[0].endpointId, seed['EA']); } },
  // /v1 prefix variants (the prefix is cut once)
  { url: () => '/v1/app/api/usage', perm: 'any', exact: (x) => assert.equal(sum(x.usage, 'totalCU'), 2 * A_CU) },
  { url: () => '/v1/keys', perm: 'admin:keys', exact: (x) => { for (const k of x.keys) assert.equal(k.tenantId, A); } },
  { url: () => '/v1/admin/dead-letters', perm: 'admin:dead-letters', exact: (x) => assert.equal(x.total, 1) },
  { url: () => '/v1/teams', perm: 'receipts:read', exact: (x) => assert.deepEqual(x.teams.map((t: Json) => t.id), [seed['TA']]) },
  { url: () => `/v1/invoices?epochId=${EP}`, perm: 'accounting:read', exact: (x) => assert.equal(x.invoice.totalCU, String(A_CU)) },
];
const PLATFORM_ONLY = ['/app/api/overview', '/app/api/tenants', '/app/api/admin/summary', '/app/api/dead-letters', '/app/webhooks', '/admin/finance',
  '/admin/chain-head', '/admin/health/full', '/admin/prover/status', '/admin/flags', `/admin/flags/${FLAG}`, '/v1/v1/reconciliation/reports',
  '/v1/v1/admin/prices', '/v1/v1/admin/ga-readiness'];
const allowed = (role: Role, perm: Perm | 'any') => perm === 'any' || rbac.hasPermission(role, perm);

describe('M24-DYN reads: tenant A (5 roles x 3 origins) and a /signup OWNER read nothing of B or C', () => {
  it('seed sanity: B and C data exist and the platform sees the sentinels (the detector is armed)', async () => {
    const p = await call('GET', '/app/api/tenants', platform);
    assert.equal(p.status, 200);
    assert.ok(leaksOf(p).length > 0, 'platform view must contain B/C sentinels, otherwise the detector proves nothing');
    const b = await call('GET', `/receipts/${B_R1}`, bearer(B_OWNER));
    assert.equal(b.status, 200); assert.equal(b.json.receipt.costUnits, B_CU);
  });
  for (const cred of aCreds) {
    it(`${cred.label}: every tenant GET route answers own data only (exact totals) or is refused`, async () => {
      const problems: string[] = [];
      for (const spec of READS) {
        const u = spec.url(); const r = await call('GET', u, bearer(cred.token()));
        const lk = leaksOf(r); if (lk.length) problems.push(`LEAK GET ${u} -> ${r.status} ${lk.join(',')}`);
        if (allowed(cred.role, spec.perm)) {
          if (r.status !== 200) { problems.push(`GET ${u} -> ${r.status} (expected 200) ${r.body.slice(0, 160)}`); continue; }
          try { spec.exact?.(r.json, r.body); } catch (e) { problems.push(`EXACT GET ${u}: ${(e as Error).message.split('\n')[0]}`); }
        } else if (r.status !== 403) problems.push(`GET ${u} -> ${r.status} (expected 403 for ${cred.role})`);
      }
      assert.deepEqual(problems, []);
    });
  }
  for (const cred of [...aCreds.filter((c) => c.origin !== 'dynamic' || c.role === 'OWNER'), signupCred]) {
    it(`${cred.label}: platform-wide routes answer 403 with no sentinel`, async () => {
      const problems: string[] = [];
      for (const u of PLATFORM_ONLY) {
        const r = await call('GET', u, bearer(cred.token()));
        if (r.status !== 403) problems.push(`GET ${u} -> ${r.status}`);
        const lk = leaksOf(r); if (lk.length) problems.push(`LEAK GET ${u} ${lk.join(',')}`);
      }
      assert.deepEqual(problems, []);
    });
  }
  it('signup OWNER (anonymous attacker): no B/C identifier or CU sum on any tenant GET route', async () => {
    const problems: string[] = [];
    for (const spec of READS) {
      const u = spec.url().split(A).join(S_ORG); const r = await call('GET', u, bearer(S_JWT));
      const lk = leaksOf(r); if (lk.length) problems.push(`LEAK GET ${u} -> ${r.status} ${lk.join(',')}`);
    }
    assert.deepEqual(problems, []);
  });
  it('SSE /stream: A receives its own events only (B event and ?tenantId=B do not reach A)', async () => {
    const r = await call('GET', `/stream?tenantId=${B}`, bearer(STATIC.VIEWER));
    assert.equal(r.status, 200);
    const mgr = streamMgr.getStreamManager();
    assert.equal(mgr.getConnectionsForTenant(B).length, 0, 'A connection registered under B');
    assert.equal(mgr.getConnectionsForTenant(A).length, 1);
    sse.publishSseEvent(B, 'receipt_submitted', { mark: B_MARK, costUnits: B_CU });
    sse.publishSseEvent(A, 'receipt_submitted', { mark: `own-${RUN}` });
    assert.ok(r.res.body.includes(`own-${RUN}`), 'positive control: own event delivered');
    assert.deepEqual(leaksOf({ body: r.res.body, json: undefined }), []);
    r.res.emit('close');
    assert.equal(mgr.getConnectionsForTenant(A).length, 0);
  });
  it('public routes (no credential) show no B/C identifier nor CU sum', async () => {
    const problems: string[] = [];
    for (const u of ['/metrics?format=json', '/metrics', '/system/status', '/status', '/readyz', '/healthz', '/health', '/version', '/plans', '/pricing', '/demo', '/changelog/json', '/ratelimit/status', '/metrics/prover']) {
      const r = await call('GET', u);
      const lk = leaksOf(r); if (lk.length) problems.push(`LEAK GET ${u} -> ${r.status} ${lk.join(',')}`);
    }
    assert.deepEqual(problems, []);
  });
  it('SCIM routes refuse every tenant credential (SCIM token only, unset → fail closed)', async () => {
    for (const cred of [...attackers()]) {
      for (const [m, u, b] of [['GET', '/scim/v2/Users', ''], ['GET', '/scim/v2/Groups', ''], ['POST', '/scim/v2/Users', j({ userName: `x-${RUN}@example.test` })]] as const) {
        const r = await call(m, u, bearer(cred.token()), b);
        assert.equal(r.status, 401, `${cred.label} ${m} ${u} -> ${r.status}`);
      }
    }
  });
});

// ── cross-tenant writes: A targets B's resources; B's resource must be unchanged ──
const refused = (s: number) => s === 401 || s === 403 || s === 404;
describe('M24-DYN writes: tenant A (and a /signup OWNER) cannot change resources of B', () => {
  it('API keys of B: read/revoke/rotate by id → refused; B key still works and is not revoked', async () => {
    const bad: string[] = [];
    for (const cred of attackers()) {
      for (const [m, u] of [['GET', `/keys/${seed['KB']}`], ['DELETE', `/keys/${seed['KB']}`], ['POST', `/keys/${seed['KB']}/rotate`],
        ['POST', `/v1/keys/${seed['KB']}/rotate`], ['DELETE', `/v1/keys/${encodeURIComponent(seed['KB'])}`], ['POST', `/keys/${seed['KB']}/x/rotate`]] as const) {
        const r = await call(m, u, bearer(cred.token()));
        if (!refused(r.status)) bad.push(`${cred.label} ${m} ${u} -> ${r.status}`);
        const lk = leaksOf(r); if (lk.length) bad.push(`LEAK ${cred.label} ${m} ${u} ${lk.join(',')}`);
      }
    }
    assert.deepEqual(bad, []);
    const own = await call('GET', `/keys/${seed['KB']}`, bearer(seed['KB_RAW']));
    assert.equal(own.status, 200, 'B key still authenticates'); assert.equal(own.json.key.revokedAt, null);
  });
  it('POST /keys with body tenantId=B creates a key of A, never of B', async () => {
    const r = await call('POST', '/keys', bearer(STATIC.OWNER), j({ label: `inj-${RUN}`, role: 'OWNER', tenantId: B }));
    assert.equal(r.status, 201); assert.equal(r.json.key.tenantId, A);
    assert.equal(registry.resolveByHash(apiKeyMgr.hashKey(r.json.key.rawKey))?.tenantId, A);
    const bKeys = await call('GET', '/keys', bearer(B_OWNER));
    assert.ok(!bKeys.body.includes(`inj-${RUN}`));
  });
  it('webhooks of B: delete, deliveries, replay by id → refused; endpoint and dead letter unchanged', async () => {
    const bad: string[] = [];
    for (const cred of attackers()) {
      for (const [m, u] of [['DELETE', `/v1/v1/webhooks/${seed['EB']}`], ['GET', `/v1/v1/webhooks/${seed['EB']}/deliveries`],
        ['POST', `/v1/v1/webhooks/${seed['EB']}/deliveries/${seed['WDLB']}/replay`],
        ['DELETE', `/v1/webhooks/${seed['EB']}`], ['DELETE', `/v1/v1/webhooks/${encodeURIComponent(seed['EB'])}`]] as const) {
        const r = await call(m, u, bearer(cred.token()));
        if (!refused(r.status)) bad.push(`${cred.label} ${m} ${u} -> ${r.status}`);
        const lk = leaksOf(r); if (lk.length) bad.push(`LEAK ${cred.label} ${m} ${u} ${lk.join(',')}`);
      }
    }
    assert.deepEqual(bad, []);
    const ws = whMod.getWebhookStore();
    assert.ok(await ws.getEndpoint(seed['EB']), 'B endpoint still exists');
    assert.equal((await ws.listDeadLetters(seed['EB'])).find((d: Json) => d.id === seed['WDLB'])?.replayedAt, undefined);
  });
  it('replay of a B webhook dead letter through an endpoint OF A: no side effect, no leak, answered 404', async () => {
    const statuses: number[] = []; const lk: string[] = [];
    for (const cred of attackers().filter((c) => c.origin !== 'signup')) {
      const r = await call('POST', `/v1/v1/webhooks/${seed['EA']}/deliveries/${seed['WDLB']}/replay`, bearer(cred.token()));
      statuses.push(r.status); lk.push(...leaksOf(r));
    }
    const ws = whMod.getWebhookStore();
    assert.equal((await ws.listDeadLetters(seed['EB'])).find((d: Json) => d.id === seed['WDLB'])?.replayedAt, undefined, 'B dead letter replayed');
    assert.deepEqual(lk, []);
    // M24-DYN-03 FINDING (INFO, robustness, not a leak): the "dead letter not found" branch calls sendError('OTK-4044'),
    // a code absent from ERROR_REGISTRY (src/api/errors.ts), so the answer is 500 OTK-5000 instead of 404 (any missing id).
    assert.deepEqual([...new Set(statuses)], [404], `statuses ${statuses.join(',')}`);
  });
  it('teams of B: add/remove/list members → refused; B team membership unchanged; POST /teams ignores body ownerId', async () => {
    const bad: string[] = [];
    for (const cred of attackers()) {
      for (const [m, u, b] of [['POST', `/teams/${seed['TB']}/members`, j({ tenantId: A, role: 'admin' })], ['DELETE', `/teams/${seed['TB']}/members/${C}`, ''],
        ['GET', `/teams/${seed['TB']}/members`, '']] as const) {
        const r = await call(m, u, bearer(cred.token()), b);
        if (!refused(r.status)) bad.push(`${cred.label} ${m} ${u} -> ${r.status}`);
        const lk = leaksOf(r); if (lk.length) bad.push(`LEAK ${cred.label} ${m} ${u} ${lk.join(',')}`);
      }
    }
    assert.deepEqual(bad, []);
    const members = await teamMod.getTeamStore().listMembers(seed['TB']);
    assert.deepEqual(members.map((x: Json) => [x.tenantId, x.role]), [[C, 'admin']]);
    const t = await call('POST', '/teams', bearer(STATIC.MEMBER), j({ name: `inj-${RUN}`, ownerId: B, tenantId: B }));
    assert.equal(t.status, 201); assert.equal(t.json.team.ownerId, A);
  });
  it('dead-letters of B: read/retry/discard by id → refused; status stays pending', async () => {
    const bad: string[] = [];
    for (const cred of attackers()) {
      for (const [m, u] of [['GET', `/admin/dead-letters/${seed['DLB']}`], ['POST', `/admin/dead-letters/${seed['DLB']}/retry`],
        ['POST', `/admin/dead-letters/${seed['DLB']}/discard`], ['POST', `/admin/dead-letters/${encodeURIComponent(seed['DLB'])}/retry`]] as const) {
        const r = await call(m, u, bearer(cred.token()));
        if (!refused(r.status)) bad.push(`${cred.label} ${m} ${u} -> ${r.status}`);
        const lk = leaksOf(r); if (lk.length) bad.push(`LEAK ${cred.label} ${m} ${u} ${lk.join(',')}`);
      }
    }
    assert.deepEqual(bad, []);
    assert.equal((await dlStore.getDeadLetter(seed['DLB'])).status, 'pending');
    const p = await call('GET', `/admin/dead-letters/${seed['DLB']}`, platform);
    assert.equal(p.status, 200); assert.equal(p.json.entry.status, 'pending');
  });
  it('tenant registry of B: get/put/delete/create → refused; B token keeps tenant and role', async () => {
    const bad: string[] = [];
    for (const cred of attackers()) {
      for (const [m, u, b] of [['GET', `/admin/tenants/${B}`, ''], ['PUT', `/admin/tenants/${B}`, j({ role: 'VIEWER' })], ['PUT', `/admin/tenants/${B}`, j({ token: `hijack-${RUN}` })],
        ['DELETE', `/admin/tenants/${B}`, ''], ['POST', '/admin/tenants', j({ tenantId: B, token: `hijack2-${RUN}`, role: 'OWNER' })]] as const) {
        const r = await call(m, u, bearer(cred.token()), b);
        if (!refused(r.status)) bad.push(`${cred.label} ${m} ${u} -> ${r.status}`);
        const lk = leaksOf(r); if (lk.length) bad.push(`LEAK ${cred.label} ${m} ${u} ${lk.join(',')}`);
      }
    }
    assert.deepEqual(bad, []);
    assert.deepEqual(registry.resolveTokenContext(B_CRUD_TOK), { tenantId: B, role: 'OWNER' });
    assert.equal(registry.resolveTokenContext(`hijack-${RUN}`), null); assert.equal(registry.resolveTokenContext(`hijack2-${RUN}`), null);
  });
  it('plan of B, provider keys of B, GDPR of B, flag override of B, reproject of B / all, TAL of B → refused, nothing changes', async () => {
    const bad: string[] = [];
    for (const cred of attackers()) {
      for (const [m, u, b] of [
        ['POST', '/admin/plans/assign', j({ tenantId: B, tier: 'FREE' })],
        ['POST', `/v1/v1/tenants/${B}/provider-keys`, j({ provider: 'openai', key: `sk-hijack-${RUN}` })],
        ['GET', `/v1/v1/tenants/${B}/provider-keys`, ''], ['DELETE', `/v1/v1/tenants/${B}/provider-keys/openai`, ''],
        ['POST', `/v1/v1/tenants/${A}%2F..%2F${B}/provider-keys`, j({ provider: 'openai', key: `sk-hijack-${RUN}` })],
        ['DELETE', `/admin/gdpr/erase/${B}`, ''], ['GET', `/admin/gdpr/export/${B}`, ''], ['GET', `/admin/gdpr/export/${A}%2F..%2F${B}`, ''],
        ['PUT', `/admin/flags/${FLAG}/override/${B}`, j({ enabled: false })], ['DELETE', `/admin/flags/${FLAG}/override/${B}`, ''], ['POST', '/admin/flags', j({ key: FLAG, enabled: true })],
        ['POST', '/admin/redis/reproject', j({ tenantId: B })], ['POST', '/admin/redis/reproject', ''],
        ['GET', `/admin/tal-summary?tenantId=${B}&epochId=${EP}`, ''], ['GET', `/accounting/balance?tenantId=${B}&epochId=${EP}`, ''],
        ['GET', `/invoices?tenantId=${B}&epochId=${EP}`, ''], ['GET', `/data/export/status/${seed['JB']}`, ''], ['GET', `/analytics/cu-trend?tenantId=${B}`, ''],
        ['GET', `/app/api/usage?tenantId=${B}`, ''], ['GET', `/flags/evaluate?key=${FLAG}&tenantId=${B}`, ''], ['GET', `/admin/dead-letters?tenantId=${B}`, ''],
      ] as const) {
        const r = await call(m, u, bearer(cred.token()), b);
        if (!refused(r.status)) bad.push(`${cred.label} ${m} ${u} -> ${r.status}`);
        const lk = leaksOf(r); if (lk.length) bad.push(`LEAK ${cred.label} ${m} ${u} ${lk.join(',')}`);
      }
    }
    assert.deepEqual(bad, []);
    assert.equal(plans.getTenantPlan(B), 'STARTER');
    assert.equal(vaultMod.getVault().getKey(B, 'openai'), B_PK);
    const fl = flagsMod.getFeatureFlagService();
    assert.equal(fl.evaluate(FLAG, B).enabled, true); assert.equal(fl.evaluate(FLAG).enabled, false);
  });
  it('receipt of B: A re-posting the same requestId does not change it; A reading it gets no data', async () => {
    for (const cred of attackers().filter((c) => rbac.hasPermission(c.role, 'receipts:write'))) {
      const w = await call('POST', '/receipts', bearer(cred.token()), receiptBody(B_R1, A_CU));
      assert.deepEqual(leaksOf({ body: w.body.split(B_R1).join(''), json: undefined }), [], `${cred.label} POST /receipts reusing B requestId -> ${w.status} ${w.body}`); // the echoed id was sent by A
      const rd = await call('GET', `/receipts/${encodeURIComponent(B_R1)}`, bearer(cred.token()));
      assert.notEqual(rd.status, 200); assert.deepEqual(leaksOf(rd), []);
    }
    const back = await call('GET', `/receipts/${B_R1}`, bearer(B_OWNER));
    assert.equal(back.json.receipt.tenantId, B); assert.equal(back.json.receipt.costUnits, B_CU);
  });
  it('POST /receipts and /data/export ignore tenantId in body and query (stamped with the caller tenant)', async () => {
    const rid = `m24a-inj-r-${RUN}`;
    const r = await call('POST', '/receipts', bearer(STATIC.MEMBER), receiptBody(rid, A_CU, { tenantId: B }));
    assert.equal(r.status, 201, r.body);
    assert.equal((await call('GET', `/receipts/${rid}`, bearer(B_OWNER))).status, 403);
    assert.equal((await call('GET', `/receipts/${rid}`, bearer(STATIC.VIEWER))).json.receipt.tenantId, A);
    const e = await call('POST', `/data/export?tenantId=${B}`, bearer(STATIC.OWNER), j({ tenantId: B }));
    assert.equal(e.status, 202); assert.equal(e.json.tenantId, A);
  });
});

// ── shared namespaces: Idempotency-Key and requestId ──
describe('M24-DYN shared namespaces (Idempotency-Key, requestId) are per tenant', () => {
  it('A cannot pre-occupy an Idempotency-Key and make B lose its receipt', async () => {
    const K = `idem-${RUN}-k1`;
    const a = await call('POST', '/receipts', { ...bearer(STATIC.MEMBER), 'idempotency-key': K }, receiptBody(`m24a-idem-r-${RUN}`, A_CU));
    assert.equal(a.status, 201, a.body);
    const bRid = `${B_MARK}-idem-r`;
    const b = await call('POST', '/receipts', { ...bearer(B_OWNER), 'idempotency-key': K }, receiptBody(bRid, B_CU));
    const back = await call('GET', `/receipts/${bRid}`, bearer(B_OWNER));
    // M24-DYN-01 FINDING: the idempotency store is keyed by the raw header only (src/api/idempotency.ts, routes.ts POST
    // /receipts); a key first used by tenant A makes tenant B's different request a 409 conflict and B's receipt is never stored.
    assert.equal(b.status, 201, `B got ${b.status} ${b.body}`);
    assert.equal(back.status, 200, 'B receipt must be stored');
  });
  it('A replaying B Idempotency-Key and body gets the same answer as without the key, never B cached response', async () => {
    const K = `idem-${RUN}-k2`; const body = receiptBody(`${B_MARK}-idem-r2`, B_CU);
    const b = await call('POST', '/receipts', { ...bearer(B_OWNER), 'idempotency-key': K }, body);
    assert.equal(b.status, 201, b.body);
    const control = await call('POST', '/receipts', bearer(STATIC.MEMBER), body);
    const a = await call('POST', '/receipts', { ...bearer(STATIC.MEMBER), 'idempotency-key': K }, body);
    // M24-DYN-02 FINDING: same root cause as M24-DYN-01; A receives B's cached 201 (ok, duplicate:false) for a requestId
    // that belongs to B, instead of the answer it gets without the key: cross-tenant replay of a cached response.
    assert.equal(a.status, control.status, `with key ${a.status} ${a.body} / without key ${control.status}`);
  });
  it('A cannot pre-occupy a requestId so that B receipt is silently dropped (requestId namespace)', async () => {
    const rid = `m24-shared-future-r-${RUN}`; // no sentinel: A owns this id after squatting it
    const a = await call('POST', '/receipts', bearer(STATIC.MEMBER), receiptBody(rid, A_CU));
    assert.equal(a.status, 201, a.body);
    const b = await call('POST', '/receipts', bearer(B_OWNER), receiptBody(rid, B_CU));
    const back = await call('GET', `/receipts/${rid}`, bearer(B_OWNER));
    // M24-DYN-04 FINDING: storeReceipt/storeReceiptDurable test `_receipts.has(requestId)` BEFORE any tenant comparison and the
    // tenant_mismatch branch compares the caller with the tenant stamped on the NEW receipt (always equal), so in memory/JSONL
    // mode (and for ids cached in memory in PG mode) B gets 200 {ok:true, duplicate:true}, its receipt is never stored, and
    // the stored one stays A's. The 409 request_id_in_use_by_another_tenant described statically (M24-SEC-09) is not reached.
    const silentlyDropped = b.status < 300 && back.json?.receipt?.tenantId !== B;
    assert.equal(silentlyDropped, false, `B got ${b.status} ${b.body}; B reading it back -> ${back.status}`);
  });
});

// ── composite key without delimiter escaping in the provider-key vault ──
describe('M24-DYN provider-key vault: tenant ids with ":" and the composite key', () => {
  const V = () => `${A}:eu`; const V_TOK = `m24-victim-token-${RUN}`; /* >= 24 chars (H1-S06) so the 400 below comes from the tenant id guard */ const V_PK = `sk-victim-${RUN}-Vq9z`;
  it('guard: the platform cannot create a tenant id containing ":" or "/" (so "<A>:eu" is not reachable through the API)', async () => {
    for (const tid of [V(), `${A}/eu`]) {
      const t = await call('POST', '/admin/tenants', platform, j({ tenantId: tid, token: `${V_TOK}-${tid.length}`, role: 'ADMIN' }));
      assert.equal(t.status, 400, t.body);
    }
  });
  // M24-DYN-10 FIXED (H1 lane B / S11): the vault keys entries by an unambiguous encoding of (tenant, provider) and lists
  // by the stored tenant id, so the case below runs as a regular test (it was `todo`).
  it('latent: if a tenant "<A>:eu" existed, tenant A could not list, overwrite or delete its provider key', async () => {
    registry.registerToken(V_TOK, V(), 'ADMIN'); // precondition outside the API (see guard above): simulates such a tenant
    const store = async () => {
      const r = await call('POST', `/v1/v1/tenants/${encodeURIComponent(V())}/provider-keys`, bearer(V_TOK), j({ provider: 'openai', key: V_PK }));
      assert.equal(r.status, 201, r.body);
    };
    await store();
    const list = await call('GET', `/v1/v1/tenants/${A}/provider-keys`, bearer(STATIC.ADMIN));
    const listed = list.body.includes('Vq9z');
    await call('POST', `/v1/v1/tenants/${A}/provider-keys`, bearer(STATIC.ADMIN), j({ provider: 'eu:openai', key: `sk-attacker-${RUN}-Xq0x` }));
    const overwritten = vaultMod.getVault().getKey(V(), 'openai') !== V_PK;
    await store();
    await call('DELETE', `/v1/v1/tenants/${A}/provider-keys/${encodeURIComponent('eu:openai')}`, bearer(STATIC.ADMIN));
    const deleted = vaultMod.getVault().getKey(V(), 'openai') === null;
    registry.revokeToken(V_TOK); vaultMod.getVault().deleteKey(V(), 'openai');
    // M24-DYN-10 FINDING (INFO, latent): ProviderKeyVault keys entries as `${tenantId}:${provider}` without escaping and lists
    // with startsWith(`${tenantId}:`); tenant A reaches the vault of tenant "<A>:eu" (list masked key, overwrite, delete).
    // Not reachable through the API today: tenantCrud refuses ":" and "/", OTK_TENANTS splits at ":", /signup ids are org_<uuid>.
    assert.deepEqual({ listed, overwritten, deleted }, { listed: false, overwritten: false, deleted: false });
  });
});

// ── credential edge cases ──
describe('M24-DYN credential edge cases: refused, no side effect', () => {
  const probes = (): Array<[string, string, string]> => [
    ['GET', '/keys', ''], ['GET', '/app/api/receipts', ''], ['POST', '/receipts', receiptBody(`m24-edge-${RUN}-${Math.random().toString(36).slice(2)}`, 1)],
    ['GET', '/admin/dead-letters', ''], ['POST', '/teams', j({ name: `edge-${RUN}` })], ['GET', '/teams', ''], ['POST', '/data/export', ''],
    ['DELETE', `/v1/v1/webhooks/${seed['EA']}`, ''], ['GET', '/analytics/cu-trend', ''], ['GET', '/events/latest', ''], ['GET', '/invoices', ''],
    ['GET', `/data/export/status/${seed['JA']}`, ''], ['GET', '/stream', ''],
  ];
  const teamCount = async () => (await teamMod.getTeamStore().listTeams(A)).length;
  async function expectRefusedEverywhere(token: string, label: string, okCodes: number[] = [401]) {
    const before = await teamCount();
    const bad: string[] = [];
    for (const [m, u, b] of probes()) {
      const r = await call(m, u, bearer(token), b);
      const accept = m === 'POST' && u === '/receipts' ? [...okCodes, 429] : okCodes;
      if (!accept.includes(r.status)) bad.push(`${label} ${m} ${u} -> ${r.status} ${r.body.slice(0, 120)}`);
      if (leaksOf(r).length) bad.push(`LEAK ${label} ${m} ${u}`);
      if (u === '/stream') r.res.emit('close');
    }
    assert.ok(await whMod.getWebhookStore().getEndpoint(seed['EA']), `${label}: webhook EA deleted`);
    assert.equal(await teamCount(), before, `${label}: a team was created`);
    assert.deepEqual(bad, []);
  }
  it('revoked static token → 401', async () => {
    const t = `m24-revoked-${RUN}`; registry.registerToken(t, A, 'OWNER'); registry.revokeToken(t);
    await expectRefusedEverywhere(t, 'revoked static');
  });
  it('revoked /keys key and the old key after rotation → 401', async () => {
    const k1 = await call('POST', '/keys', bearer(STATIC.OWNER), j({ label: `rev-${RUN}`, role: 'OWNER' }));
    assert.equal((await call('DELETE', `/keys/${k1.json.key.keyId}`, bearer(STATIC.OWNER))).status, 200);
    await expectRefusedEverywhere(k1.json.key.rawKey, 'revoked /keys');
    const k2 = await call('POST', '/keys', bearer(STATIC.OWNER), j({ label: `rot-${RUN}`, role: 'OWNER' }));
    assert.equal((await call('POST', `/keys/${k2.json.key.keyId}/rotate`, bearer(STATIC.OWNER))).status, 200);
    await expectRefusedEverywhere(k2.json.key.rawKey, 'rotated-out /keys');
  });
  it('expired JWT, JWT signed with another secret, tampered JWT (sub swapped to B), alg=none → 401', async () => {
    await expectRefusedEverywhere(jwt.signToken({ sub: A, role: 'OWNER' }, JWT_SECRET, -120), 'expired JWT');
    await expectRefusedEverywhere(jwt.signToken({ sub: A, role: 'OWNER' }, OTHER_SECRET, 600), 'other-secret JWT');
    const good = jwt.signToken({ sub: A, role: 'OWNER' }, JWT_SECRET, 600).split('.');
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const payload = JSON.parse(Buffer.from(good[1], 'base64url').toString());
    await expectRefusedEverywhere(`${good[0]}.${b64({ ...payload, sub: B })}.${good[2]}`, 'tampered JWT');
    await expectRefusedEverywhere(`${b64({ alg: 'none', typ: 'JWT' })}.${b64({ ...payload, sub: B })}.`, 'alg=none JWT');
  });
  // ADV-M24-15 (15cb8ea): a JWT whose role is outside the five tenant roles no longer authenticates, so the refusal moved
  // from RBAC (403) to authentication (401)
  it('JWT with a role outside RBAC (SUPERADMIN, lowercase owner): not authenticated (401), no B data anywhere', async () => {
    for (const role of ['SUPERADMIN', 'owner', 'PLATFORM']) {
      const t = jwt.signToken({ sub: A, role }, JWT_SECRET, 600);
      const bad: string[] = [];
      for (const spec of READS) {
        const r = await call('GET', spec.url(), bearer(t));
        if (leaksOf(r).length) bad.push(`LEAK ${role} ${spec.url()}`);
        if (spec.perm !== 'any' && r.status !== 401) bad.push(`${role} GET ${spec.url()} -> ${r.status}`);
      }
      for (const [m, u, b] of [['POST', '/receipts', receiptBody(`m24-role-${role}-${RUN}`, 1)], ['POST', '/teams', j({ name: 'x' })], ['POST', '/keys', j({ label: 'x' })],
        ['POST', `/admin/dead-letters/${seed['DLA']}/retry`, ''], ['DELETE', `/keys/${seed['KB']}`, '']] as const) {
        const r = await call(m, u, bearer(t), b);
        if (r.status !== 401) bad.push(`${role} ${m} ${u} -> ${r.status}`);
      }
      assert.deepEqual(bad, []);
    }
  });
  it('refresh token used as access token → 401 on every probe', async () => {
    // M24-DYN-06 FINDING (latent, M24-SEC-11 / PF-NEW-10 class): verifyToken accepts a refresh token as access token with
    // tenant and role undefined; POST /data/export only checks authentication and creates a job for tenant 'default'.
    await expectRefusedEverywhere(jwt.signRefreshToken(A, JWT_SECRET), 'refresh token', [401, 403, 404]);
  });
  it('signed JWT without sub (role OWNER) reads nothing of B and cannot write an untenanted receipt', async () => {
    const t = jwt.signToken({ role: 'OWNER' }, JWT_SECRET, 600);
    const bad: string[] = [];
    for (const spec of READS) {
      const r = await call('GET', spec.url(), bearer(t));
      const lk = leaksOf(r); if (lk.length) bad.push(`LEAK GET ${spec.url()} -> ${r.status} ${lk.join(',')}`);
    }
    const rid = `m24-nosub-r-${RUN}`;
    const w = await call('POST', '/receipts', bearer(t), receiptBody(rid, 1));
    if (w.status < 300) bad.push(`POST /receipts -> ${w.status} (receipt stored with no caller tenant, falls back to "default")`);
    const rd = await call('GET', `/receipts/${rid}`, bearer(B_OWNER));
    if (rd.status === 200) bad.push(`B reads the receipt written by the tenant-less JWT (tenantId=${rd.json.receipt.tenantId})`);
    // M24-DYN-07 FINDING (latent, needs a JWT signed with OTK_JWT_SECRET but without sub, M24-SEC-11 class): callerTenantScope
    // turns an undefined tenant into "no filter", so /admin/plans/assignments and /admin/tenants list every tenant, and
    // POST /receipts is accepted and the receipt is stored under the fallback tenant "default" (storeReceipt), not under a real tenant.
    assert.deepEqual(bad, []);
  });
  it('platform header with a wrong or demo value plus A token: still a tenant (403 on platform routes)', async () => {
    for (const k of ['demo-otk-2026', `${PLATFORM}x`, '', PLATFORM.slice(0, -1)]) {
      for (const u of ['/app/api/overview', '/app/api/tenants', '/admin/finance']) {
        const r = await call('GET', u, { ...bearer(STATIC.OWNER), 'x-admin-key': k });
        assert.equal(r.status, 403, `x-admin-key='${k.slice(0, 6)}...' ${u} -> ${r.status}`);
        assert.deepEqual(leaksOf(r), []);
      }
    }
  });
  it('malformed Authorization (two bearers, other schemes, x-api-key with B token) never resolves to B', async () => {
    const variants: Array<Record<string, string>> = [
      { authorization: `Bearer ${STATIC.OWNER}, Bearer ${B_OWNER}` }, { authorization: `Token ${B_OWNER}` }, { authorization: `bearer ${B_OWNER}` },
      { authorization: `Basic ${Buffer.from(`${B}:${B_OWNER}`).toString('base64')}` }, { 'x-api-key': B_OWNER },
    ];
    for (const h of variants) {
      const r = await call('GET', '/app/api/receipts', h);
      assert.equal(r.status, 401, `${Object.keys(h)[0]} -> ${r.status}`);
      assert.deepEqual(leaksOf(r), []);
    }
    const mixed = await call('GET', '/app/api/receipts', { ...bearer(STATIC.VIEWER), 'x-api-key': B_OWNER, 'x-tenant-id': B });
    assert.equal(mixed.status, 200); assert.deepEqual(leaksOf(mixed), []);
  });
});

// ── reduced role (VIEWER) on write routes of its own tenant ──
describe('M24-DYN VIEWER of A on write routes: 403 and no side effect', () => {
  for (const origin of ['static', 'dynamic', 'jwt'] as const) {
    it(`VIEWER (${origin}): RBAC-protected writes → 403`, async () => {
      const cred = aCreds.find((c) => c.role === 'VIEWER' && c.origin === origin)!;
      const t = cred.token(); const bad: string[] = [];
      const before = (await teamMod.getTeamStore().listMembers(seed['TA'])).length;
      for (const [m, u, b] of [
        ['POST', '/receipts', receiptBody(`m24-viewer-${origin}-${RUN}`, 1)], ['POST', '/teams', j({ name: 'v' })],
        ['POST', `/teams/${seed['TA']}/members`, j({ tenantId: `x-${RUN}` })], ['DELETE', `/teams/${seed['TA']}/members/${A}`, ''],
        ['POST', '/keys', j({ label: 'v', role: 'OWNER' })], ['DELETE', '/keys/x', ''], ['POST', `/keys/x/rotate`, ''],
        ['POST', `/admin/dead-letters/${seed['DLA']}/retry`, ''], ['POST', `/admin/dead-letters/${seed['DLA']}/discard`, ''],
        ['POST', '/admin/redis/reproject', j({ tenantId: A })], ['POST', `/v1/v1/tenants/${A}/provider-keys`, j({ provider: 'x', key: 'y' })],
        ['DELETE', `/v1/v1/tenants/${A}/provider-keys/openai`, ''], ['DELETE', `/admin/gdpr/erase/${A}`, ''],
        ['POST', '/admin/plans/assign', j({ tenantId: A, tier: 'PRO' })], ['POST', '/billing/checkout', j({ tier: 'PRO', successUrl: 'https://x.test', cancelUrl: 'https://x.test' })],
      ] as const) {
        const r = await call(m, u, bearer(t), b);
        if (r.status !== 403) bad.push(`${m} ${u} -> ${r.status}`);
      }
      assert.deepEqual(bad, []);
      assert.equal((await teamMod.getTeamStore().listMembers(seed['TA'])).length, before);
      assert.equal((await dlStore.getDeadLetter(seed['DLA'])).status, 'pending');
      assert.equal(vaultMod.getVault().getKey(A, 'openai'), A_PK);
      assert.equal(plans.getTenantPlan(A), 'FREE');
    });
  }
  it('VIEWER cannot create an export job (PF-NEW-11)',
    { todo: 'M24-DYN-08 OPEN (LOW, intra-tenant, PF-NEW-11): minimum role for /data/export is a product decision' }, async () => {
    const r = await call('POST', '/data/export', bearer(STATIC.VIEWER));
    // M24-DYN-08 FINDING (dynamic reproduction of PF-NEW-11, known, intra-tenant): /data/export checks authentication only.
    assert.equal(r.status, 403, `${r.status} ${r.body}`);
  });
  it('VIEWER cannot delete a webhook endpoint nor replay a webhook dead letter of its tenant (NF-16)',
    { todo: 'M24-DYN-09 OPEN (LOW, intra-tenant, NF-16): minimum role for webhook by-id routes is a product decision' }, async () => {
    const d = await call('DELETE', `/v1/v1/webhooks/${seed['EA2']}`, bearer(STATIC.VIEWER));
    const rp = await call('POST', `/v1/v1/webhooks/${seed['EA']}/deliveries/${seed['WDLA']}/replay`, bearer(STATIC.VIEWER));
    const ws = whMod.getWebhookStore();
    const stillThere = !!(await ws.getEndpoint(seed['EA2']));
    const replayed = (await ws.listDeadLetters(seed['EA'])).find((x: Json) => x.id === seed['WDLA'])?.replayedAt;
    // M24-DYN-09 FINDING (dynamic reproduction of NF-16, known, intra-tenant): webhook by-id routes have no permission check.
    assert.deepEqual({ d: d.status, rp: rp.status, stillThere, replayed }, { d: 403, rp: 403, stillThere: true, replayed: undefined });
  });
});

// ── query/path tricks ──
describe('M24-DYN query and path tricks', () => {
  const T = () => [STATIC.OWNER, STATIC.MEMBER, dyn.OWNER!, jwt.signToken({ sub: A, role: 'OWNER' }, JWT_SECRET, 600)];
  const GETS = ['/analytics/cu-trend', '/app/api/usage', '/app/api/receipts', '/app/api/providers/health', '/invoices', '/accounting/balance', '/admin/dead-letters',
    '/admin/tal-summary', `/flags/evaluate?key=${FLAG}`, '/events/latest', '/keys', '/teams', '/billing/cycles', '/admin/tenants', '/admin/plans/assignments', '/v1/v1/reports/teams'];
  const QS = [`tenantId=${B}`, `tenantId=${A}&tenantId=${B}`, `tenantId=${B}&tenantId=${A}`, 'tenantId=', 'tenantId=%20', 'tenantId=*', 'tenantId=default',
    `tenantId=${B}&epochId=${EP}`, `tenantId=${A}&epochId=${EP}`, 'limit=100000', 'limit=-1&offset=-5', 'limit=abc', 'n=100000', 'days=100000', 'days=-1', 'days=abc', 'status=pending&reason=validation_error',
    `TenantId=${B}`, `tenantid=${B}`, `tenant=${B}`, `tenantId[]=${B}`];
  it('tenantId/limit/offset/duplicate query params on every tenant GET route: no B/C data', async () => {
    const bad: string[] = [];
    for (const t of T()) for (const g of GETS) for (const q of QS) {
      const u = `${g}${g.includes('?') ? '&' : '?'}${q}`;
      const r = await call('GET', u, bearer(t));
      const lk = leaksOf(r); if (lk.length) bad.push(`LEAK GET ${u} -> ${r.status} ${lk.join(',')}`);
      if (r.status >= 500) bad.push(`5xx GET ${u} -> ${r.status} ${r.body.slice(0, 120)}`);
    }
    assert.deepEqual(bad, []);
  });
  it('headers x-tenant-id / x-otk-tenant / x-otk-team-id = B change nothing', async () => {
    const bad: string[] = [];
    for (const g of GETS) {
      const r = await call('GET', g, { ...bearer(STATIC.OWNER), 'x-tenant-id': B, 'x-otk-tenant': B, 'x-otk-team-id': seed['TB'], 'x-otk-tenant-id': B });
      const lk = leaksOf(r); if (lk.length) bad.push(`LEAK GET ${g} ${lk.join(',')}`);
    }
    assert.deepEqual(bad, []);
  });
  it('encoded and dot-segment paths do not reach B resources or platform aggregates', async () => {
    const bad: string[] = [];
    const paths = [
      `/admin/tenants/${A}%2F..%2F${B}`, `/admin/tenants/${encodeURIComponent(`${A}/../${B}`)}`, `/admin/tenants/${A}/../${B}`, `/admin/tenants/%2E%2E%2F${B}`,
      `/admin/gdpr/export/${A}%2F..%2F${B}`, `/admin/gdpr/export/${A}/../${B}`, `/v1/v1/tenants/${A}%2F..%2F${B}/provider-keys`,
      `/keys/${seed['KB']}%2F`, `/keys/%20${seed['KB']}`, `/keys/${seed['KB'].toUpperCase()}`, `/receipts/${encodeURIComponent(B_R1)}`, `/receipts/${A_R1}%2F..%2F${B_R1}`,
      `/admin/dead-letters/${seed['DLB']}%2F`, `/data/export/status/${seed['JB']}%2F`, `/data/export/status/${seed['JB'].toUpperCase()}`,
      `/teams/${seed['TB']}%2F/members`, `/teams/${seed['TA']}/../${seed['TB']}/members`, `/v1/v1/webhooks/${seed['EB']}%2Fdeliveries`,
      '/app/api/receipts/../tenants', '/app/api/x/..%2Ftenants', '//app/api/tenants', '//x/app/api/tenants', '/v1/v1/app/api/tenants', '/APP/API/TENANTS',
      '/app/api/usage/', '/app/webhooks/', '/v1/../admin/finance', '/admin/flags/..%2F', '/app/api/overview?x=1#frag',
    ];
    for (const p of paths) {
      for (const t of [STATIC.OWNER, S_JWT]) {
        const r = await call('GET', p, bearer(t));
        const lk = leaksOf(r); if (lk.length) bad.push(`LEAK GET ${p} -> ${r.status} ${lk.join(',')}`);
        if (r.status >= 500) bad.push(`5xx GET ${p} -> ${r.status} ${r.body.slice(0, 120)}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});

// ── PF-NEW-07 (known residual) reproduced dynamically; last, because the injected indexer entry cannot be removed ──
describe('M24-DYN team report: receipts of B stamped with a team id of A', () => {
  it('A team report counts only A receipts, even when a B receipt carries A team id (legacy x-otk-team-id)', async () => {
    indexerMod.getIndexer().index({ requestId: `${B_MARK}-inject`, provider: 'openai', model: 'gpt-4o', inputTokens: B_CU, outputTokens: 0, costUnits: B_CU, latencyMs: 1, timestamp: Date.now(), tenantId: B, teamId: seed['TA'] });
    const r = await call('GET', '/v1/v1/reports/teams', bearer(STATIC.MEMBER));
    assert.equal(r.status, 200);
    // M24-DYN-05 FINDING (dynamic reproduction of PF-NEW-07, known): getUsageByTeam aggregates every tenant by teamId and the
    // route filters by team ownership only after aggregating, so B's CU appears in A's report (13 + 7919 = 7932).
    assert.deepEqual(leaksOf(r), [], r.body);
  });
});
