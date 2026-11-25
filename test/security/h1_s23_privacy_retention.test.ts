/**
 * H1-S23 (OTK-H1-MEGA-S01-S24-20261013, lane D): privacy / retention, with SYNTHETIC data only
 * (docs/_ops/H1/LANED_20261013/S23_PRIVACY.md). No real data, no database, no network.
 *
 * Part 1 — GDPR API (/admin/gdpr/export|erase/:tenantId, src/api/gdpr.ts) with a synthetic IGdprStore:
 *   export holds only the caller's tenant and the expected fields; cross-tenant export/erase refused with no effect;
 *   erasure leaves the signed/hash-chained receipts of the receipt store untouched; an audit log line is written;
 *   S23-F01 (fixed here): with no store configured the erasure is refused (501) instead of a false "ok, 0 erased".
 * Part 2 — /data/export jobs: tenant of the job = tenant of the credential; another tenant's job is "not found".
 * Part 3 — v3 erasure (src/operations/retention.ts eraseOperation) against a scripted in-memory PostgreSQL double that
 *   accepts ONLY the statements the module issues today (an unknown statement fails the test): what is removed, what is
 *   pseudonymised (ledger rows keep their amounts), what is kept (tombstone with the request digest), journal written
 *   before the transaction, other tenant untouched, refusal of non-terminal operations, replay after a restore.
 *   A last case pins that the shipped retention policy erases nothing by age (retention periods are still undecided).
 *
 * Modules under test: `src/api/routes.ts` and `src/api/gdpr.ts` (called in process), `src/api/receiptStore.ts`,
 * `src/operations/retention.ts` and `src/operations/context.ts`.
 *
 * Needs: nothing external. Before importing it empties `OTK_RECEIPT_LOG`, `OTK_DB_URL` and `OTK_TENANT_LOG`, sets
 * `PROVER_URL=disabled` and removes `OTK_REDIS_URL` and `OTK_TENANTS`. Part 3 writes its erasure journal to a
 * temporary directory that is removed afterwards; some cases capture `process.stderr` to read the audit log lines.
 *
 * Run just this file: `npx tsx --test test/security/h1_s23_privacy_retention.test.ts`
 *
 * @module test/security/h1_s23_privacy_retention.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

process.env['OTK_RECEIPT_LOG'] = '';
process.env['OTK_DB_URL'] = '';
process.env['OTK_TENANT_LOG'] = '';
process.env['PROVER_URL'] = 'disabled';
delete process.env['OTK_REDIS_URL'];
delete process.env['OTK_TENANTS'];

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
let routes: any; let registry: any; let gdpr: any; let receiptStore: any; let retention: any; let ctx: any;

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
    new Promise((r) => { setTimeout(r, 4000).unref(); }),
  ]);
  let json: Json; try { json = JSON.parse(res.body); } catch { json = undefined; }
  return { status: res.statusCode, body: res.body, json, hdrs: res.hdrs };
}
const bearer = (t: string) => ({ authorization: `Bearer ${t}` });
/**
 * Run fn while capturing what the structured logger writes to stderr.
 *
 * @param fn - Work to run; stderr output is swallowed while it runs and restored afterwards.
 * @returns The result of `fn` and the captured lines, each parsed as JSON (or `{ raw }` when not JSON).
 */
async function captureStderr<T>(fn: () => Promise<T>): Promise<{ out: T; lines: Json[] }> {
  const orig = process.stderr.write.bind(process.stderr);
  const chunks: string[] = [];
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c: unknown) => { chunks.push(String(c)); return true; };
  try {
    const out = await fn();
    const lines = chunks.join('').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return { raw: l }; } });
    return { out, lines };
  } finally { (process.stderr as unknown as { write: typeof orig }).write = orig; }
}

const RUN = Date.now().toString(36);
const A = `s23a-${RUN}`; const B = `s23b-${RUN}`;
const OWNER_A = `s23-owner-a-${RUN}-0123456789`; const ADMIN_A = `s23-admin-a-${RUN}-0123456789`;
const OWNER_B = `s23-owner-b-${RUN}-0123456789`;
const B_MARK = `synthetic-subject-b-${RUN}`;

/** Synthetic GDPR store: rows of two tenants, records every call. */
function syntheticStore() {
  const rows = [
    { id: `ra1-${RUN}`, tenantId: A, userId: '1001', costUnits: 13, timestamp: 1_760_000_000, requestId: `req-a1-${RUN}` },
    { id: `ra2-${RUN}`, tenantId: A, userId: '1002', costUnits: 17, timestamp: 1_760_000_100, requestId: `req-a2-${RUN}` },
    { id: `rb1-${RUN}`, tenantId: B, userId: B_MARK, costUnits: 7919, timestamp: 1_760_000_200, requestId: `req-b1-${RUN}` },
  ] as Array<Record<string, unknown>>;
  const calls: string[] = [];
  return {
    rows, calls,
    async getReceiptsForTenant(t: string) { calls.push(`get:${t}`); return rows.filter((r) => r['tenantId'] === t && !r['erased']).map((r) => ({ ...r })); },
    async eraseReceiptsForTenant(t: string) { calls.push(`erase:${t}`); let n = 0; for (const r of rows) if (r['tenantId'] === t && !r['erased']) { r['erased'] = true; n++; } return { erasedCount: n }; },
    async getAuditLogForTenant(t: string) { calls.push(`audit:${t}`); return [{ tenantId: t, action: 'synthetic' }]; },
  };
}

before(async () => {
  routes = await import('../../src/api/routes.js');
  registry = await import('../../src/api/tenantKeyRegistry.js');
  gdpr = await import('../../src/api/gdpr.js');
  receiptStore = await import('../../src/api/receiptStore.js');
  retention = await import('../../src/operations/retention.js');
  ctx = await import('../../src/operations/context.js');
  registry.clearRegistry(); registry.clearHashRegistryForTest();
  registry.registerToken(OWNER_A, A, 'OWNER'); registry.registerToken(ADMIN_A, A, 'ADMIN'); registry.registerToken(OWNER_B, B, 'OWNER');
});
after(() => { gdpr.resetGdprStoreForTest(); });

// ── Part 1 ──
describe('H1-S23 GDPR export: only the caller tenant, expected fields', () => {
  it('JSON export of A: receipts of A only, fields from the documented set, top-level shape fixed', async () => {
    const st = syntheticStore(); gdpr.setGdprStore(st);
    const r = await call('GET', `/admin/gdpr/export/${A}`, bearer(OWNER_A));
    assert.equal(r.status, 200, r.body);
    assert.deepEqual(Object.keys(r.json).sort(), ['auditLog', 'exportedAt', 'receipts', 'requestId', 'tenant']);
    assert.equal(r.json.tenant, A);
    assert.equal(r.json.receipts.length, 2);
    const allowed = new Set(['id', 'tenantId', 'userId', 'costUnits', 'timestamp', 'requestId', 'erased']);
    for (const x of r.json.receipts) {
      assert.equal(x.tenantId, A);
      for (const k of Object.keys(x)) assert.ok(allowed.has(k), `unexpected field ${k}`);
    }
    assert.ok(!r.body.includes(B) && !r.body.includes(B_MARK) && !r.body.includes('7919'), 'no data of B');
    assert.deepEqual(st.calls, [`get:${A}`, `audit:${A}`]);
  });
  it('CSV export of A: fixed header, one row per receipt of A, nothing of B', async () => {
    const st = syntheticStore(); gdpr.setGdprStore(st);
    const r = await call('GET', `/admin/gdpr/export/${A}?format=csv`, bearer(OWNER_A));
    assert.equal(r.status, 200);
    assert.equal(r.hdrs['content-type'], 'text/csv');
    const lines = r.body.split('\n');
    assert.equal(lines[0], 'id,tenantId,userId,costUnits,timestamp,requestId');
    assert.equal(lines.length, 3);
    for (const l of lines.slice(1)) assert.equal(l.split(',')[1], A);
    assert.ok(!r.body.includes(B_MARK));
  });
});

describe('H1-S23 GDPR cross-tenant and role checks (negative, each with a positive control)', () => {
  it('OWNER of A cannot export or erase B: 403, the store is never asked for B, B rows intact', async () => {
    const st = syntheticStore(); gdpr.setGdprStore(st);
    const ex = await call('GET', `/admin/gdpr/export/${B}`, bearer(OWNER_A));
    const er = await call('DELETE', `/admin/gdpr/erase/${B}`, bearer(OWNER_A));
    assert.equal(ex.status, 403); assert.equal(ex.json?.error, 'cross_tenant_forbidden');
    assert.equal(er.status, 403); assert.equal(er.json?.error, 'cross_tenant_forbidden');
    assert.ok(!ex.body.includes(B_MARK) && !er.body.includes(B_MARK));
    assert.deepEqual(st.calls, []);
    assert.equal(st.rows.filter((x) => x['tenantId'] === B && !x['erased']).length, 1);
    // encoded traversal stays inside the caller's tenant check
    assert.equal((await call('DELETE', `/admin/gdpr/erase/${A}%2F..%2F${B}`, bearer(OWNER_A))).status, 403);
    // positive control: B exports its own data
    const own = await call('GET', `/admin/gdpr/export/${B}`, bearer(OWNER_B));
    assert.equal(own.status, 200); assert.equal(own.json.receipts.length, 1);
  });
  it('ADMIN of A (no admin:gdpr) → 403 on its own tenant; no credential → 401; the store is untouched', async () => {
    const st = syntheticStore(); gdpr.setGdprStore(st);
    assert.equal((await call('GET', `/admin/gdpr/export/${A}`, bearer(ADMIN_A))).status, 403);
    assert.equal((await call('DELETE', `/admin/gdpr/erase/${A}`, bearer(ADMIN_A))).status, 403);
    assert.equal((await call('DELETE', `/admin/gdpr/erase/${A}`)).status, 401);
    assert.deepEqual(st.calls, []);
  });
});

describe('H1-S23 GDPR erasure: receipt integrity and audit trail', () => {
  it('OWNER of A erases A: count from the store, tombstone hash, B untouched, signed receipts of the receipt store not mutated', async () => {
    const st = syntheticStore(); gdpr.setGdprStore(st);
    // a hash-chained receipt of A in the receipt store (synthetic)
    const rid = `s23-chain-a-${RUN}`;
    await receiptStore.storeReceiptDurable({ provider: 'openai', model: 'gpt-4o-mini', inputTokens: 3, outputTokens: 2, costUnits: 5, latencyMs: 1, timestamp: Math.floor(Date.now() / 1000), requestId: rid, userId: 7n, nonce: 1n, tenantId: A }, A);
    const snap = (x: unknown) => JSON.stringify(x, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v));
    const before = snap(receiptStore.getReceipt(rid)); const headBefore = receiptStore.chainHead(); const auditBefore = receiptStore.auditCount();
    const { out: r, lines } = await captureStderr(() => call('DELETE', `/admin/gdpr/erase/${A}`, bearer(OWNER_A), '', ));
    assert.equal(r.status, 200, r.body);
    assert.equal(r.json.ok, true); assert.equal(r.json.tenantId, A); assert.equal(r.json.erasedCount, 2);
    assert.match(r.json.tombstoneHash, /^[0-9a-f]{64}$/);
    assert.deepEqual(st.calls, [`get:${A}`, `erase:${A}`]);
    assert.equal(st.rows.filter((x) => x['tenantId'] === B && !x['erased']).length, 1, 'B rows intact');
    // the receipt store (signed / hash-chained receipts) is not touched by this path: same object, same chain head
    assert.equal(snap(receiptStore.getReceipt(rid)), before);
    assert.equal(receiptStore.chainHead(), headBefore); assert.equal(receiptStore.auditCount(), auditBefore);
    // audit trail: one gdpr_erasure line with identifiers and counts only
    const audit = lines.filter((l) => l.message === 'gdpr_erasure');
    assert.equal(audit.length, 1, JSON.stringify(lines));
    assert.equal(audit[0].tenantId, A); assert.equal(audit[0].erasedCount, 2); assert.equal(audit[0].tombstoneHash, r.json.tombstoneHash);
    assert.equal(typeof audit[0].requestId, 'string');
    assert.ok(!JSON.stringify(audit[0]).includes('1001'), 'no receipt content (userId) in the audit line');
    // after erasure the GDPR-store rows of A are gone from the export; H1R2 C2 (S23-F02): the export now also reads the
    // receipt store, so the signed receipt this path does not erase is still exported (truthful: it is still held)
    const after = (await call('GET', `/admin/gdpr/export/${A}`, bearer(OWNER_A))).json.receipts;
    assert.deepEqual(after.map((x: Json) => x.requestId), [rid]);
  });
  it('S23-F01: with no GDPR store configured the erasure is refused (501) and logged, not confirmed as "0 erased"', async () => {
    gdpr.resetGdprStoreForTest();
    assert.equal(gdpr.isGdprStoreConfigured(), false);
    const { out: r, lines } = await captureStderr(() => call('DELETE', `/admin/gdpr/erase/${A}`, bearer(OWNER_A)));
    assert.equal(r.status, 501, r.body);
    assert.deepEqual({ ok: r.json.ok, error: r.json.error }, { ok: false, error: 'gdpr_store_not_configured' });
    assert.equal(r.json.tombstoneHash, undefined);
    assert.equal(lines.filter((l) => l.message === 'gdpr_erasure_refused' && l.tenantId === A).length, 1);
    // H1R2 C2 (S23-F02 fixed): without a GDPR store the export reads the receipt store (before: 200 with empty lists)
    const ex = await call('GET', `/admin/gdpr/export/${A}`, bearer(OWNER_A));
    assert.equal(ex.status, 200);
    assert.ok(receiptStore.getReceipt(`s23-chain-a-${RUN}`));
    assert.deepEqual(ex.json.receipts.map((x: Json) => x.requestId), [`s23-chain-a-${RUN}`]);
    assert.ok(!ex.body.includes(B));
  });
});

// ── Part 2 ──
describe('H1-S23 /data/export jobs', () => {
  it('the job belongs to the credential tenant (query/body tenantId ignored); another tenant gets 404; owner reads it', async () => {
    const c = await call('POST', `/data/export?tenantId=${B}`, bearer(OWNER_A), JSON.stringify({ tenantId: B }));
    assert.equal(c.status, 202); assert.equal(c.json.tenantId, A);
    const other = await call('GET', `/data/export/status/${c.json.jobId}`, bearer(OWNER_B));
    assert.equal(other.status, 404); assert.ok(!other.body.includes(A));
    // wait for the job by condition, not a fixed 30 ms (failed on windows-latest in CI: timer granularity ~15.6 ms)
    let own = await call('GET', `/data/export/status/${c.json.jobId}`, bearer(OWNER_A));
    for (let i = 0; i < 200 && own.json?.status !== 'done'; i++) {
      await new Promise((r) => setTimeout(r, 10));
      own = await call('GET', `/data/export/status/${c.json.jobId}`, bearer(OWNER_A));
    }
    assert.equal(own.status, 200); assert.equal(own.json.tenantId, A);
    // H1R2 C2 (S23-F03 fixed; before: stub { records: [], count: 0 }): the receipts of A, nothing of B
    assert.deepEqual(own.json.data.records.map((x: Json) => x.requestId), [`s23-chain-a-${RUN}`]);
    assert.equal(own.json.data.count, 1); assert.ok(!own.body.includes(B));
    assert.equal((await call('POST', '/data/export')).status, 401);
  });
});

// ── Part 3: v3 erasure against a scripted PostgreSQL double ──
type Row = Record<string, unknown>;
class ScriptedPg {
  t: Record<string, Row[]> = {};
  log: string[] = [];
  journalAtConnect: number[] = [];
  private snap: string | null = null;
  constructor(private journal: { entries(): unknown[] }) {}
  private where(table: string, p: unknown[]) { return (this.t[table] ?? []).filter((r) => r['tenant_id'] === p[0] && r['operation_id'] === p[1]); }
  async query(text: string, params: unknown[] = []): Promise<{ rows: Row[]; rowCount: number | null }> {
    const q = text.replace(/\s+/g, ' ').trim();
    this.log.push(q.slice(0, 60));
    let m: RegExpMatchArray | null;
    if (q === 'BEGIN') { this.snap = JSON.stringify(this.t); return { rows: [], rowCount: null }; }
    if (q === 'COMMIT') { this.snap = null; return { rows: [], rowCount: null }; }
    if (q === 'ROLLBACK') { if (this.snap) this.t = JSON.parse(this.snap); this.snap = null; return { rows: [], rowCount: null }; }
    if (/^SELECT (request_digest, request_digest_version, )?execution, reservation->>'state' AS st, money->>'state' AS money_state FROM otk_operations WHERE tenant_id = \$1 AND operation_id = \$2( FOR UPDATE)?$/.test(q)) {
      const rows = this.where('otk_operations', params).map((r) => ({ request_digest: r['request_digest'], request_digest_version: r['request_digest_version'], execution: r['execution'], st: (r['reservation'] as Row)['state'], money_state: (r['money'] as Row | null)?.['state'] ?? null }));
      return { rows, rowCount: rows.length };
    }
    if (q === 'SELECT 1 FROM otk_erasure_tombstones WHERE tenant_id = $1 AND operation_id = $2') { const n = this.where('otk_erasure_tombstones', params).length; return { rows: n ? [{ '?column?': 1 }] : [], rowCount: n }; }
    if (q === 'SELECT to_regclass($1)::text AS t') return { rows: [{ t: this.t[String(params[0])] ? String(params[0]) : null }], rowCount: 1 };
    if (/^INSERT INTO otk_erasure_tombstones \(tenant_id, operation_id, request_digest, request_digest_version, ledger_pseudonym, reason, policy_version\) VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7\) ON CONFLICT \(tenant_id, operation_id\) DO NOTHING$/.test(q)) {
      if (this.where('otk_erasure_tombstones', params).length) return { rows: [], rowCount: 0 };
      (this.t['otk_erasure_tombstones'] ??= []).push({ tenant_id: params[0], operation_id: params[1], request_digest: params[2], request_digest_version: params[3], ledger_pseudonym: params[4], reason: params[5], policy_version: params[6] });
      return { rows: [], rowCount: 1 };
    }
    if (q === "UPDATE otk_ledger SET operation_id = $3, effect_id = 'debit:' || $4 || ':' || $3 WHERE tenant_id = $1 AND operation_id = $2") {
      const rs = this.where('otk_ledger', params); for (const r of rs) { r['operation_id'] = params[2]; r['effect_id'] = `debit:${params[3]}:${params[2]}`; } return { rows: [], rowCount: rs.length };
    }
    if (q === 'UPDATE otk_money_ledger SET operation_id = $3 WHERE tenant_id = $1 AND operation_id = $2') {
      const rs = this.where('otk_money_ledger', params); for (const r of rs) r['operation_id'] = params[2]; return { rows: [], rowCount: rs.length };
    }
    if ((m = q.match(/^DELETE FROM (\w+) WHERE tenant_id = \$1 AND operation_id = \$2$/))) {
      const tb = m[1]!; const all = this.t[tb] ?? []; const keep = all.filter((r) => !(r['tenant_id'] === params[0] && r['operation_id'] === params[1]));
      this.t[tb] = keep; return { rows: [], rowCount: all.length - keep.length };
    }
    if ((m = q.match(/^DELETE FROM (otk_proof_jobs|otk_receipts) WHERE request_id = \$1$/))) {
      const tb = m[1]!; const all = this.t[tb] ?? []; const keep = all.filter((r) => r['request_id'] !== params[0]);
      this.t[tb] = keep; return { rows: [], rowCount: all.length - keep.length };
    }
    throw new Error(`ScriptedPg: unexpected statement: ${q}`);
  }
  async connect() {
    this.journalAtConnect.push(this.journal.entries().length);
    return { query: (t: string, p?: unknown[]) => this.query(t, p), release: () => {} };
  }
}

const OP = `op-synthetic-${RUN}`;
function seedPg(pg: ScriptedPg, tenant: string, op: string, execution = 'completed', st = 'settled', amount = 1234) {
  const key = { tenantId: tenant, operationId: op };
  const push = (tb: string, row: Row) => { (pg.t[tb] ??= []).push(row); };
  push('otk_operations', { tenant_id: tenant, operation_id: op, request_digest: `digest-${tenant}-${op}`, request_digest_version: 'v1', execution, reservation: { state: st }, money: { state: st } });
  push('otk_ledger', { tenant_id: tenant, operation_id: op, effect_id: `debit:${encodeURIComponent(tenant)}:${op}`, cu_units: amount });
  push('otk_money_ledger', { tenant_id: tenant, operation_id: op, usd_micros: amount * 10 });
  for (const tb of ['otk_attribution_statements', 'otk_operation_attribution', 'otk_conferences', 'otk_receipts_v3', 'otk_openings', 'otk_outbox']) {
    push(tb, { tenant_id: tenant, operation_id: op, payload: `synthetic-${tb}-${tenant}`, signature: tb === 'otk_receipts_v3' ? `sig-${tenant}-${op}` : undefined });
  }
  push('otk_receipts', { request_id: ctx.legacyReceiptId(key), tenant_id: tenant });
  push('otk_proof_jobs', { request_id: ctx.legacyReceiptId(key) });
}

describe('H1-S23 v3 erasure (retention.eraseOperation) on synthetic rows', () => {
  let dir = '';
  before(() => { dir = mkdtempSync(path.join(tmpdir(), 'h1-s23-')); });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('erases the private material of A, pseudonymises the ledger (amounts kept), keeps a tombstone; B with the SAME operation id is untouched', async () => {
    const journal = new retention.ErasureJournal(path.join(dir, 'j1.jsonl'));
    const pg = new ScriptedPg(journal);
    seedPg(pg, A, OP, 'completed', 'settled', 13); seedPg(pg, B, OP, 'completed', 'settled', 7919);
    const rowsOfB = () => JSON.stringify(Object.fromEntries(Object.entries(pg.t)
      .map(([k, rows]) => [k, rows.filter((r) => r['tenant_id'] === B || String(r['request_id'] ?? '').includes(encodeURIComponent(B)))])
      .filter(([, rows]) => (rows as Row[]).length > 0)));
    const bBefore = rowsOfB();
    const key = { tenantId: A, operationId: OP };
    const out = await retention.eraseOperation(pg, key, { journal, reason: 'synthetic_subject_request', policyVersion: 'test-policy' });
    assert.equal(out, 'erased');
    // write-ahead: the journal entry exists before the transaction opens
    assert.deepEqual(pg.journalAtConnect, [1]);
    assert.deepEqual(journal.entries().map((e: Json) => [e.tenantId, e.operationId, e.reason, e.policyVersion]), [[A, OP, 'synthetic_subject_request', 'test-policy']]);
    // removed for A: operation, private receipt v3 (with its signature), opening, conference, attribution, outbox, legacy rows
    for (const tb of ['otk_operations', 'otk_receipts_v3', 'otk_openings', 'otk_conferences', 'otk_attribution_statements', 'otk_operation_attribution', 'otk_outbox']) {
      assert.equal(pg.t[tb]!.filter((r) => r['tenant_id'] === A).length, 0, tb);
    }
    assert.equal(pg.t['otk_receipts']!.filter((r) => r['tenant_id'] === A).length, 0);
    assert.equal(pg.t['otk_proof_jobs']!.filter((r) => r['request_id'] === ctx.legacyReceiptId(key)).length, 0);
    // pseudonymised: ledger rows keep tenant and amount, lose the operation id
    const pseudo = retention.ledgerPseudonym(key);
    assert.match(pseudo, /^erased-[0-9a-f]{32}$/);
    const led = pg.t['otk_ledger']!.filter((r) => r['tenant_id'] === A);
    assert.deepEqual(led, [{ tenant_id: A, operation_id: pseudo, effect_id: `debit:${encodeURIComponent(A)}:${pseudo}`, cu_units: 13 }]);
    assert.deepEqual(pg.t['otk_money_ledger']!.filter((r) => r['tenant_id'] === A), [{ tenant_id: A, operation_id: pseudo, usd_micros: 130 }]);
    assert.ok(!JSON.stringify(pg.t['otk_ledger']).includes(`"operation_id":"${OP}","cu_units":13`));
    // kept: tombstone with the request identity (digest), reason and policy version
    assert.deepEqual(pg.t['otk_erasure_tombstones'], [{ tenant_id: A, operation_id: OP, request_digest: `digest-${A}-${OP}`, request_digest_version: 'v1', ledger_pseudonym: pseudo, reason: 'synthetic_subject_request', policy_version: 'test-policy' }]);
    // B: byte-identical
    assert.equal(rowsOfB(), bBefore);
    // a second request is answered from the tombstone
    assert.equal(await retention.eraseOperation(pg, key, { journal, reason: 'again', policyVersion: 'test-policy' }), 'already_erased');
    assert.equal(journal.entries().length, 1, 'a refused/duplicate erasure is not journalled');
  });

  it('cross-tenant: erasing (B, operation id that exists only for A) → not_found, nothing changes, nothing journalled', async () => {
    const journal = new retention.ErasureJournal(path.join(dir, 'j2.jsonl'));
    const pg = new ScriptedPg(journal);
    const opA = `${OP}-only-a`;
    seedPg(pg, A, opA);
    const before = JSON.stringify(pg.t);
    assert.equal(await retention.eraseOperation(pg, { tenantId: B, operationId: opA }, { journal, reason: 'x', policyVersion: 'p' }), 'not_found');
    assert.equal(JSON.stringify(pg.t), before);
    assert.equal(journal.entries().length, 0);
    assert.deepEqual(pg.journalAtConnect, [], 'no transaction opened');
    // positive control: A's own erasure of the same id works
    assert.equal(await retention.eraseOperation(pg, { tenantId: A, operationId: opA }, { journal, reason: 'x', policyVersion: 'p' }), 'erased');
  });

  it('an operation still carrying exposure (reservation held) is refused: rows kept, no tombstone, no journal entry', async () => {
    const journal = new retention.ErasureJournal(path.join(dir, 'j3.jsonl'));
    const pg = new ScriptedPg(journal);
    seedPg(pg, A, `${OP}-held`, 'completed', 'held');
    seedPg(pg, A, `${OP}-running`, 'running', 'settled');
    const before = JSON.stringify(pg.t);
    for (const op of [`${OP}-held`, `${OP}-running`]) {
      assert.equal(await retention.eraseOperation(pg, { tenantId: A, operationId: op }, { journal, reason: 'x', policyVersion: 'p' }), 'not_terminal', op);
    }
    assert.equal(JSON.stringify(pg.t), before);
    assert.equal(journal.entries().length, 0);
  });

  it('a restore that brings erased rows back is re-erased by reapplyErasures (journal outside the database)', async () => {
    const journal = new retention.ErasureJournal(path.join(dir, 'j4.jsonl'));
    const pg = new ScriptedPg(journal);
    const op = `${OP}-restore`;
    seedPg(pg, A, op);
    const dump = JSON.stringify(pg.t); // "backup" taken before the erasure
    assert.equal(await retention.eraseOperation(pg, { tenantId: A, operationId: op }, { journal, reason: 'subject_request', policyVersion: 'p' }), 'erased');
    pg.t = JSON.parse(dump); // "restore"
    assert.equal(pg.t['otk_receipts_v3']!.filter((r) => r['tenant_id'] === A).length, 1);
    const rep = await retention.reapplyErasures(pg, journal);
    assert.deepEqual(rep, { reapplied: 1, alreadyErased: 0, refused: [] });
    assert.equal(pg.t['otk_receipts_v3']!.filter((r) => r['tenant_id'] === A).length, 0);
    assert.equal(pg.t['otk_ledger']![0]!['operation_id'], retention.ledgerPseudonym({ tenantId: A, operationId: op }));
  });

  it('the shipped retention policy erases nothing by age (periods are a pending decision of the author)', async () => {
    const journal = new retention.ErasureJournal(path.join(dir, 'j5.jsonl'));
    const pg = new ScriptedPg(journal);
    seedPg(pg, A, `${OP}-old`);
    const before = JSON.stringify(pg.t);
    assert.equal(retention.RETENTION_POLICY_UNSET.operationsMaxAgeDays, null);
    assert.deepEqual(await retention.runRetention(pg, retention.RETENTION_POLICY_UNSET, journal, new Date('2100-01-01T00:00:00Z')), { erased: 0, skippedNotTerminal: 0, outboxDeleted: 0 });
    assert.equal(JSON.stringify(pg.t), before);
    assert.deepEqual(pg.log, []);
  });
});
