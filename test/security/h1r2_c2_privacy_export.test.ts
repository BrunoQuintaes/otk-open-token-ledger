/**
 * H1R2 lane C2 (OTK-H1-FINAL-CLOSURE-R2-20261013): S23-F02 / S23-F03, SYNTHETIC data only
 * (docs/_ops/H1_FINAL_CLOSURE_R2_20261013/lanes/C2_PRIVACY_EXPORT.md).
 *
 * S23-F02: the GDPR export (/admin/gdpr/export/:tenantId) read only the GDPR store, which is never configured in src/:
 *   it answered 200 with EMPTY lists while the receipt store held receipts of the tenant. Now it reads the whole receipt
 *   store (memory + every page of PostgreSQL) and returns ALL and ONLY the receipts of the tenant.
 * S23-F03: /data/export was a stub that finished every job with { records: [], count: 0 } (false success). Now the job
 *   reads the same complete source; data types without an implementation answer 501; a source that cannot be read
 *   fails the job (or 503 on the GDPR export) instead of answering an empty success.
 * Exporting changes nothing: receipts, chain head, audit count and PostgreSQL rows are byte-identical afterwards.
 *
 * The PostgreSQL part runs against a REAL database when OTK_TEST_PG_URL is set (lane C2: otk_c2); it only inserts and
 * deletes rows whose request_id starts with this run's prefix.
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
let routes: any; let registry: any; let gdpr: any; let receiptStore: any;

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
  writeHead(c: number, h?: Record<string, unknown>) { this.statusCode = c; if (h) for (const [k, v] of Object.entries(h)) this.hdrs[k.toLowerCase()] = v; this.headersSent = true; return this; }
  write(d: unknown) { this.body += String(d); return true; }
  end(d?: unknown) { if (d !== undefined && d !== null) this.body += String(d); this.headersSent = true; this.emit('finish'); return this; }
}
async function call(method: string, url: string, headers: Record<string, string> = {}, body = ''): Promise<{ status: number; body: string; json: Json; hdrs: Record<string, unknown> }> {
  const res = new MockRes();
  await Promise.race([
    routes.handleRequest(mockReq(method, url, body, headers), res as unknown as ServerResponse),
    new Promise((r) => { setTimeout(r, 8000).unref(); }),
  ]);
  let json: Json; try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.statusCode, body: res.body, json, hdrs: res.hdrs };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
/** Poll an export job by condition until it leaves pending/processing. */
// H1R2 review MED-3: one active export job per tenant; each test starts without jobs of earlier tests
beforeEach(async () => { (await import('../../src/api/dataExport.js')).clearExportJobsForTest(); });

async function waitJob(jobId: string, token: string): Promise<{ status: number; json: Json; body: string }> {
  let r = await call('GET', `/data/export/status/${jobId}`, bearer(token));
  for (let i = 0; i < 400 && (r.json?.status === 'pending' || r.json?.status === 'processing'); i++) {
    await new Promise((x) => setTimeout(x, 10));
    r = await call('GET', `/data/export/status/${jobId}`, bearer(token));
  }
  return r;
}

const RUN = Date.now().toString(36);
const A = `c2a-${RUN}`; const B = `c2b-${RUN}`;
const OWNER_A = `c2-owner-a-${RUN}-0123456789`; const OWNER_B = `c2-owner-b-${RUN}-0123456789`;
const ADMIN_A = `c2-admin-a-${RUN}-0123456789`; const MEMBER_A = `c2-member-a-${RUN}-0123456789`; const VIEWER_A = `c2-viewer-a-${RUN}-0123456789`;
const B_MARK = `synthetic-subject-b-${RUN}`;
const N_A = 23; const N_B = 9;
const memA = Array.from({ length: N_A }, (_, i) => `c2-mem-a-${RUN}-${String(i).padStart(3, '0')}`);
const memB = Array.from({ length: N_B }, (_, i) => `c2-mem-b-${RUN}-${String(i).padStart(3, '0')}`);
const rcpt = (requestId: string, tenantId: string | undefined, cu: number, userId: bigint) => ({
  provider: 'openai', model: 'gpt-4o-mini', inputTokens: cu, outputTokens: 1, costUnits: cu, latencyMs: 1,
  timestamp: Math.floor(Date.now() / 1000), requestId, userId, nonce: BigInt(cu + 1), ...(tenantId ? { tenantId } : {}),
});
const snap = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
const ids = (list: Json[]) => list.map((x) => String(x.requestId)).sort();

before(async () => {
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  gdpr = await import('../../src/api/gdpr.js');
  receiptStore = await import('../../src/api/receiptStore.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest();
  registry.registerToken(OWNER_A, A, 'OWNER'); registry.registerToken(OWNER_B, B, 'OWNER');
  registry.registerToken(ADMIN_A, A, 'ADMIN'); registry.registerToken(MEMBER_A, A, 'MEMBER'); registry.registerToken(VIEWER_A, A, 'VIEWER');
  gdpr.resetGdprStoreForTest(); // the deployment default: no GDPR store configured
  for (const [i, id] of memA.entries()) {
    const r = await receiptStore.storeReceiptDurable(rcpt(id, A, 10 + i, BigInt(5000 + i)), A);
    assert.equal(r.stored, true);
  }
  for (const [i, id] of memB.entries()) {
    const r = await receiptStore.storeReceiptDurable(rcpt(id, B, 7919, BigInt(9000 + i)), B);
    assert.equal(r.stored, true);
  }
});
after(() => { gdpr.resetGdprStoreForTest(); delete process.env['OTK_EXPORT_PAGE_SIZE']; });

// ── S23-F02: GDPR export reads the receipt store ──
describe('H1R2 C2 S23-F02: the GDPR export contains all and only the receipts of the tenant (memory store)', () => {
  it('JSON export of A (no GDPR store configured) holds the N receipts of A and nothing of B', async () => {
    const r = await call('GET', `/admin/gdpr/export/${A}`, bearer(OWNER_A));
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(Object.keys(r.json).sort(), ['auditLog', 'exportedAt', 'receipts', 'requestId', 'tenant']);
    assert.deepEqual(ids(r.json.receipts), [...memA].sort(), 'every receipt of A, exactly once');
    for (const x of r.json.receipts) assert.equal(x.tenantId, A);
    const allowed = new Set(['id', 'tenantId', 'userId', 'costUnits', 'timestamp', 'requestId', 'erased']);
    for (const x of r.json.receipts) for (const k of Object.keys(x)) assert.ok(allowed.has(k), `unexpected field ${k}`);
    assert.equal(r.json.receipts.find((x: Json) => x.requestId === memA[3]).userId, '5003');
    assert.ok(!r.body.includes(B) && !r.body.includes('c2-mem-b-') && !r.json.receipts.some((x: Json) => x.costUnits === 7919), 'no data of B');
    assert.match(String(r.hdrs['x-otk-export-sources']), /receipt_store_memory/);
  });
  it('B exports its own N receipts (isolation in both directions); A cannot export B', async () => {
    const r = await call('GET', `/admin/gdpr/export/${B}`, bearer(OWNER_B));
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(ids(r.json.receipts), [...memB].sort());
    assert.ok(!r.body.includes(A));
    const x = await call('GET', `/admin/gdpr/export/${B}`, bearer(OWNER_A));
    assert.equal(x.status, 403); assert.ok(!x.body.includes(memB[0]!));
  });
  it('CSV export of A: one row per receipt of A, nothing of B', async () => {
    const r = await call('GET', `/admin/gdpr/export/${A}?format=csv`, bearer(OWNER_A));
    assert.equal(r.status, 200);
    const lines = r.body.split('\n');
    assert.equal(lines[0], 'id,tenantId,userId,costUnits,timestamp,requestId');
    assert.equal(lines.length, N_A + 1);
    for (const l of lines.slice(1)) assert.equal(l.split(',')[1], A);
  });
  it('with a GDPR store configured, its rows and the receipt store are merged (dedup by requestId)', async () => {
    const extra = { id: `c2-gdpr-only-${RUN}`, tenantId: A, userId: '42', costUnits: 1, timestamp: 1, requestId: `c2-gdpr-only-${RUN}` };
    const dup = { id: memA[0]!, tenantId: A, userId: '5000', costUnits: 10, timestamp: 1, requestId: memA[0]! };
    gdpr.setGdprStore({
      async getReceiptsForTenant(t: string) { return t === A ? [extra, dup] : []; },
      async eraseReceiptsForTenant() { return { erasedCount: 0 }; },
    });
    try {
      const r = await call('GET', `/admin/gdpr/export/${A}`, bearer(OWNER_A));
      assert.equal(r.status, 200, r.body);
      assert.deepEqual(ids(r.json.receipts), [...memA, extra.requestId].sort());
      assert.match(String(r.hdrs['x-otk-export-sources']), /gdpr_store/);
    } finally { gdpr.resetGdprStoreForTest(); }
  });
  it('exporting changes nothing: receipts, chain head, audit count and size are identical', async () => {
    const before = snap([...memA, ...memB].map((id) => receiptStore.getReceipt(id)));
    const head = receiptStore.chainHead(); const audit = receiptStore.auditCount(); const size = receiptStore.size();
    await call('GET', `/admin/gdpr/export/${A}`, bearer(OWNER_A));
    const j = await call('POST', '/data/export', bearer(OWNER_A));
    await waitJob(j.json.jobId, OWNER_A);
    assert.equal(snap([...memA, ...memB].map((id) => receiptStore.getReceipt(id))), before);
    assert.equal(receiptStore.chainHead(), head); assert.equal(receiptStore.auditCount(), audit); assert.equal(receiptStore.size(), size);
  });
});

// ── S23-F03: /data/export is not a stub ──
describe('H1R2 C2 S23-F03: /data/export returns the real data or says what is not implemented', () => {
  it('the job of A finishes with all and only the receipts of A (count = records.length), B gets its own', async () => {
    const ja = await call('POST', '/data/export', bearer(OWNER_A));
    const jb = await call('POST', '/data/export', bearer(OWNER_B));
    assert.equal(ja.status, 202, ja.body); assert.equal(jb.status, 202, jb.body);
    const a = await waitJob(ja.json.jobId, OWNER_A); const b = await waitJob(jb.json.jobId, OWNER_B);
    assert.equal(a.json.status, 'done', a.body); assert.equal(b.json.status, 'done', b.body);
    assert.deepEqual(ids(a.json.data.records), [...memA].sort());
    assert.equal(a.json.data.count, N_A);
    assert.deepEqual(a.json.data.scope, ['receipts']);
    assert.ok(Array.isArray(a.json.data.notIncluded) && a.json.data.notIncluded.length > 0, 'what is NOT exported is stated');
    for (const x of a.json.data.records) assert.equal(x.tenantId, A);
    assert.ok(!a.body.includes(B) && !a.body.includes(B_MARK));
    assert.deepEqual(ids(b.json.data.records), [...memB].sort());
    assert.ok(!b.body.includes(A));
    assert.equal((await call('GET', `/data/export/status/${ja.json.jobId}`, bearer(OWNER_B))).status, 404);
  });
  it('a data type without implementation → 501 export_type_not_implemented, no job; receipts type is accepted', async () => {
    const r = await call('POST', '/data/export?type=operations', bearer(OWNER_A));
    assert.equal(r.status, 501, r.body);
    assert.deepEqual({ ok: r.json.ok, error: r.json.error }, { ok: false, error: 'export_type_not_implemented' });
    assert.equal(r.json.jobId, undefined);
    assert.equal((await call('POST', '/data/export?type=receipts', bearer(OWNER_A))).status, 202);
  });
  it('an unknown format → 400 (before: accepted and echoed)', async () => {
    const r = await call('POST', '/data/export?format=xml', bearer(OWNER_A));
    assert.equal(r.status, 400, r.body); assert.equal(r.json.ok, false); assert.equal(r.json.jobId, undefined);
  });
  it('format=csv: the finished job also carries the CSV text of the same records', async () => {
    const j = await call('POST', '/data/export?format=csv', bearer(OWNER_A));
    const r = await waitJob(j.json.jobId, OWNER_A);
    assert.equal(r.json.status, 'done', r.body);
    const lines = String(r.json.data.csv).split('\n');
    assert.equal(lines[0], 'id,tenantId,userId,costUnits,timestamp,requestId');
    assert.equal(lines.length, N_A + 1);
  });
});

// ── a source that cannot be read is an error, not an empty success ──
describe('H1R2 C2: unreadable receipt source → error, never an empty success', () => {
  it('PostgreSQL page read fails → GDPR export 503 export_source_unavailable; export job → failed', async () => {
    receiptStore.setPgStoreForTest({
      async store() { return true; }, async get() { return undefined; },
      async listReceiptsPageForTenant() { throw new Error('synthetic connection reset'); },
    });
    try {
      const r = await call('GET', `/admin/gdpr/export/${A}`, bearer(OWNER_A));
      assert.equal(r.status, 503, r.body);
      assert.deepEqual({ ok: r.json.ok, error: r.json.error }, { ok: false, error: 'export_source_unavailable' });
      assert.equal(r.json.receipts, undefined);
      const j = await call('POST', '/data/export', bearer(OWNER_A));
      const s = await waitJob(j.json.jobId, OWNER_A);
      assert.equal(s.json.status, 'failed', s.body);
      assert.equal(s.json.error, 'export_source_unavailable');
      assert.equal(s.json.data, undefined);
    } finally { receiptStore.setPgStoreForTest(null); }
  });
});

// ── real PostgreSQL (otk_c2), receipts written by "another instance" (not in this process memory) ──
const PG_URL = process.env['OTK_TEST_PG_URL'];
describe('H1R2 C2 S23-F02 on a real PostgreSQL: every page of otk_receipts is read', { skip: PG_URL ? false : 'OTK_TEST_PG_URL not set' }, () => {
  const N_PG_A = 37; const N_PG_B = 11;
  const pgA = Array.from({ length: N_PG_A }, (_, i) => `c2-pg-a-${RUN}-${String(i).padStart(3, '0')}`);
  const pgB = Array.from({ length: N_PG_B }, (_, i) => `c2-pg-b-${RUN}-${String(i).padStart(3, '0')}`);
  const legacy = `c2-pg-legacy-${RUN}`; // row with no tenantId (legacy): belongs to 'default', never to A
  let pg: any; let pool: any;
  before(async () => {
    const { PostgresReceiptStore } = await import('../../src/api/PostgresReceiptStore.js');
    const { Pool } = await import('pg');
    pg = new PostgresReceiptStore(PG_URL!);
    await pg.init();
    pool = new Pool({ connectionString: PG_URL });
    await pool.query("DELETE FROM otk_receipts WHERE request_id LIKE 'c2-pg-%'");
    for (const [i, id] of pgA.entries()) assert.equal(await pg.store(rcpt(id, A, 100 + i, BigInt(7000 + i))), true);
    for (const [i, id] of pgB.entries()) assert.equal(await pg.store(rcpt(id, B, 7919, BigInt(8000 + i))), true);
    assert.equal(await pg.store(rcpt(legacy, undefined, 3, 1n)), true);
  });
  after(async () => {
    receiptStore.setPgStoreForTest(null);
    delete process.env['OTK_EXPORT_PAGE_SIZE'];
    await pool?.query("DELETE FROM otk_receipts WHERE request_id LIKE 'c2-pg-%' AND request_id LIKE $1", [`%${RUN}%`]);
    await pool?.end(); await pg?.close();
  });
  it('page size 5: the GDPR export of A = memory receipts of A + every PG receipt of A (8 pages), nothing of B or legacy', async () => {
    process.env['OTK_EXPORT_PAGE_SIZE'] = '5';
    let pages = 0;
    const orig = pg.listReceiptsPageForTenant.bind(pg);
    pg.listReceiptsPageForTenant = async (...a: unknown[]) => { pages++; return orig(...a); };
    receiptStore.setPgStoreForTest(pg);
    const rowsBefore = (await pool.query("SELECT request_id, receipt_json::text AS j FROM otk_receipts WHERE request_id LIKE 'c2-pg-%' ORDER BY request_id")).rows;
    const r = await call('GET', `/admin/gdpr/export/${A}`, bearer(OWNER_A));
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(ids(r.json.receipts), [...memA, ...pgA].sort());
    assert.ok(pages >= Math.ceil(N_PG_A / 5), `read ${pages} pages`);
    assert.ok(!r.body.includes(B) && !r.body.includes(legacy) && !r.body.includes('c2-pg-b-'));
    assert.equal(r.json.receipts.find((x: Json) => x.requestId === pgA[36]).userId, '7036');
    assert.match(String(r.hdrs['x-otk-export-sources']), /receipt_store_pg/);
    // the export job reads the same complete source
    const j = await call('POST', '/data/export', bearer(OWNER_A));
    const s = await waitJob(j.json.jobId, OWNER_A);
    assert.equal(s.json.status, 'done', s.body);
    assert.deepEqual(ids(s.json.data.records), [...memA, ...pgA].sort());
    assert.equal(s.json.data.count, N_A + N_PG_A);
    // B sees its own PG rows only
    const rb = await call('GET', `/admin/gdpr/export/${B}`, bearer(OWNER_B));
    assert.deepEqual(ids(rb.json.receipts), [...memB, ...pgB].sort());
    // read-only: PostgreSQL rows byte-identical after the exports
    const rowsAfter = (await pool.query("SELECT request_id, receipt_json::text AS j FROM otk_receipts WHERE request_id LIKE 'c2-pg-%' ORDER BY request_id")).rows;
    assert.deepEqual(rowsAfter, rowsBefore);
  });
  it('listReceiptsPageForTenant is keyset-paginated: pages are disjoint, ordered and complete', async () => {
    const seen: string[] = []; let after = '';
    for (;;) {
      const page = await pg.listReceiptsPageForTenant(A, after, 4);
      for (const x of page) seen.push(x.requestId);
      if (page.length < 4) break;
      after = page[page.length - 1].requestId;
    }
    const mine = seen.filter((x) => x.includes(RUN));
    assert.deepEqual(mine, [...pgA].sort());
    assert.equal(new Set(seen).size, seen.length);
  });
});

// ── M24-DYN-08 (product decision pending): minimum role for /data/export is NOT changed here ──
describe('H1R2 C2 M24-DYN-08 (PENDING_HUMAN_POLICY): minimum role for /data/export', () => {
  it('current behaviour (unchanged): any authenticated role of the tenant creates a job for its own tenant', async () => {
    for (const t of [OWNER_A, ADMIN_A, MEMBER_A, VIEWER_A]) {
      const r = await call('POST', '/data/export', bearer(t));
      assert.equal(r.status, 202, r.body); assert.equal(r.json.tenantId, A);
      await waitJob(r.json.jobId, t); // H1R2 review MED-3: one active job per tenant
    }
    assert.equal((await call('POST', '/data/export')).status, 401);
  });
  it('PROPOSAL: only ADMIN/OWNER may export (MEMBER/VIEWER → 403)',
    { todo: 'PENDING_HUMAN_POLICY M24-DYN-08: proposal only, the role in force is not changed by lane C2' }, async () => {
    assert.equal((await call('POST', '/data/export', bearer(OWNER_A))).status, 202);
    assert.equal((await call('POST', '/data/export', bearer(ADMIN_A))).status, 202);
    assert.equal((await call('POST', '/data/export', bearer(MEMBER_A))).status, 403);
    assert.equal((await call('POST', '/data/export', bearer(VIEWER_A))).status, 403);
  });
});

// ── contract: the new answers are in the source and in the OpenAPI spec ──
describe('H1R2 C2 contract: changed responses are documented in docs/api/openapi.json', () => {
  it('gdpr export 503 export_source_unavailable, data export 501 export_type_not_implemented / 400, status 404; bare errors listed', async () => {
    const fs = await import('node:fs'); const path = await import('node:path');
    const root = path.resolve(import.meta.dirname, '..', '..');
    const spec = JSON.parse(fs.readFileSync(path.join(root, 'docs/api/openapi.json'), 'utf-8'));
    const src = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
    const cases: Array<[string, string, string, string, string]> = [
      ['/admin/gdpr/export/{tenantId}', 'get', '503', 'export_source_unavailable', 'src/api/gdpr.ts'],
      ['/data/export', 'post', '501', 'export_type_not_implemented', 'src/api/dataExport.ts'],
      ['/data/export', 'post', '400', 'invalid_parameter', 'src/api/dataExport.ts'],
      ['/data/export/status/{jobId}', 'get', '404', 'not_found', 'src/api/dataExport.ts'],
    ];
    for (const [p, m, st, err, file] of cases) {
      const resp = spec.paths[p]?.[m]?.responses?.[st];
      assert.ok(resp, `${m} ${p} documents ${st}`);
      assert.ok(String(resp.description).includes(err), `${m} ${p} ${st} mentions ${err}`);
      if (err.startsWith('export_')) assert.ok(src(file).includes(`error: '${err}'`), `${file} writes ${err}`);
    }
    const doc = String(spec.components.schemas.ErrorResponse.properties.error.description);
    for (const e of ['export_source_unavailable', 'export_type_not_implemented']) assert.ok(doc.includes(e), `ErrorResponse lists ${e}`);
  });
});

describe('H1R2 review MED-3: export jobs are bounded', () => {
  it('a second export of the same tenant while one is active → 409 export_in_progress with the active job id; after it ends a new one is accepted', async () => {
    const first = await call('POST', '/data/export', bearer(OWNER_A));
    assert.equal(first.status, 202, first.body);
    const second = await call('POST', '/data/export', bearer(OWNER_A));
    assert.equal(second.status, 409, second.body);
    assert.equal(second.json.error, 'export_in_progress');
    assert.equal(second.json.jobId, first.json.jobId);
    await waitJob(first.json.jobId, OWNER_A);
    assert.equal((await call('POST', '/data/export', bearer(OWNER_A))).status, 202);
  });
  it('finished jobs expire after OTK_EXPORT_JOB_TTL_MS', async () => {
    const prev = process.env['OTK_EXPORT_JOB_TTL_MS'];
    process.env['OTK_EXPORT_JOB_TTL_MS'] = '0';
    try {
      const j = await call('POST', '/data/export', bearer(OWNER_A));
      await waitJob(j.json.jobId, OWNER_A).catch(() => undefined);
      await new Promise((r) => setTimeout(r, 20));
      const { getExportJob } = await import('../../src/api/dataExport.js');
      assert.equal(getExportJob(j.json.jobId), undefined);
    } finally { if (prev === undefined) delete process.env['OTK_EXPORT_JOB_TTL_MS']; else process.env['OTK_EXPORT_JOB_TTL_MS'] = prev; }
  });
  it('CSV cells are quoted and formula-like values neutralised (INFO-3)', async () => {
    const { csvCell } = await import('../../src/api/gdpr.js');
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    assert.equal(csvCell('-12.5'), '-12.5');
    assert.equal(csvCell('@SUM(A1)'), "'@SUM(A1)");
  });
});
