/**
 * D1–D8 / C (D3-G04 part C): migrations 100–103 through the real `scripts/ops/migrate.js` on a
 * fresh PostgreSQL database — applied once, re-run without duplication — plus the documented
 * rollback scripts, and the runtime's own idempotent schema step coexisting with migrate.js.
 *
 * Module under test: the migration runner `scripts/ops/migrate.js` (run as a child process with `OTK_DB_URL` and
 * `OTK_MIGRATION_DIR` set) and the runtime's `ensureD1D8Schema`, with the SQL migration and rollback files.
 *
 * Strategy / scenarios: a historical reproduction with the original retention migration that stops the runner; a
 * first run that applies the migrations; a second run that adds nothing; the runtime schema step as a no-op on a
 * migrated database, also twice concurrently; rollback scripts that remove only the new tables and their migration
 * rows; and re-applying everything after the rollback.
 *
 * Needs: the test PostgreSQL from `test/services/d1d8_c_env.ts` (`OTK_TEST_PG_URL`), a writable temporary directory
 * for migration subsets, and permission to spawn Node child processes.
 *
 * Run just this file: `npx tsx --test test/services/d1d8_c_schema.test.ts`
 *
 * @module test/services/d1d8_c_schema.test
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { D1D8_MIGRATIONS, ensureD1D8Schema } from '../../src/operations/schema.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEW_TABLES = ['otk_operations', 'otk_quota_usage', 'otk_money_budget', 'otk_ledger', 'otk_outbox', 'otk_openings', 'otk_receipts_v3', 'otk_conferences',
  // S4 migration 150 (ABC-03/04)
  'otk_money_budget_members', 'otk_money_ledger',
  // OVERNIGHT 20261005 migration 154 (Phase 7, attribution)
  'otk_projects', 'otk_applications', 'otk_operation_attribution', 'otk_attribution_statements',
  // migration 155 (Phase 4, erasure)
  'otk_erasure_tombstones'];
/** Versions of the D1–D8 migrations (C: 100–149, S4: 150–199). */
const D1D8_VERSIONS_LIKE = '1__\\_d1d8%';

/** The real migrate.js. Default directory = only C's files 100–103 (see C-F01 below for why). */
const C_DIR = mkdtempSync(path.join(tmpdir(), 'otkd1d8c-mig-'));
for (const m of D1D8_MIGRATIONS) copyFileSync(path.join(ROOT, 'scripts', 'migrations', `${m.version}.sql`), path.join(C_DIR, `${m.version}.sql`));
const migrate = (url: string, dir = C_DIR) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ops', 'migrate.js')], { cwd: ROOT, env: { ...process.env, OTK_DB_URL: url, OTK_MIGRATION_DIR: dir }, encoding: 'utf8' });

let db: TestDb;
before(async () => { db = await createTestDb('schema', { schema: false }); });
after(async () => { await db.drop(); });

async function tables(): Promise<string[]> {
  const r = await db.pool.query<{ t: string }>("SELECT tablename AS t FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1) ORDER BY 1", [NEW_TABLES]);
  return r.rows.map((x) => x.t);
}

describe('C-F01 / ABC-05 — historical reproduction with the ORIGINAL 004/005 (preserved by S4)', () => {
  it('original 004_retention_policy.sql stops migrate.js: it alters table "receipts", which no migration creates', async () => {
    const fresh = await createTestDb('schema_full', { schema: false });
    // S4: the shipped 004/005 are fixed (test/services/d1d8_s4_migrations.test.ts requires the full
    // chain to work); the original defect stays reproducible with the preserved original files
    const orig = mkdtempSync(path.join(tmpdir(), 'otkd1d8s4-mig-orig-'));
    const ORIG = path.join(ROOT, 'docs', '_ops', 'EXECUCAO_D1_D8_20260930', 'runs', '20260930-1625', 'S4', 'S4_1', 'abc05_originais');
    for (const f of readdirSync(path.join(ROOT, 'scripts', 'migrations')).filter((x) => x.endsWith('.sql'))) copyFileSync(path.join(ROOT, 'scripts', 'migrations', f), path.join(orig, f));
    for (const f of ['004_retention_policy.sql', '005_gdpr_tombstones.sql']) copyFileSync(path.join(ORIG, f), path.join(orig, f));
    try {
      const r = migrate(fresh.url, orig);
      assert.equal(r.status, 1);
      assert.match(r.stderr, /Failed to apply 004_retention_policy\.sql: relation \\"receipts\\" does not exist/); // JSON-escaped quotes
    } finally { await fresh.drop(); }
  });
});

describe('D3-G04/C — migrate.js twice, rollback, re-apply', () => {
  it('first migrate.js applies 100–103 (exit 0)', async () => {
    const r = migrate(db.url);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(await tables(), [...NEW_TABLES].sort());
    const v = await db.pool.query<{ version: string }>('SELECT version FROM otk_migrations WHERE version LIKE $1 ORDER BY 1', [D1D8_VERSIONS_LIKE]);
    assert.deepEqual(v.rows.map((x) => x.version), D1D8_MIGRATIONS.map((m) => m.version));
  });

  it('second migrate.js applies nothing new and duplicates nothing', async () => {
    const before = await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM otk_migrations');
    const r = migrate(db.url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /0 new migration\(s\) applied/);
    const after2 = await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM otk_migrations');
    assert.equal(after2.rows[0]!.n, before.rows[0]!.n);
  });

  it('runtime ensureD1D8Schema on the migrated database is a no-op (and twice concurrently)', async () => {
    await Promise.all([ensureD1D8Schema(db.pool), ensureD1D8Schema(db.newPool())]);
    assert.deepEqual(await tables(), [...NEW_TABLES].sort());
  });

  it('rollback scripts (155 → 154 → 153 → 152 → 151 → 150 →) 103 → 100 remove only the new tables and their otk_migrations rows; legacy tables stay', async () => {
    await db.pool.query("INSERT INTO otk_ledger (tenant_id, effect_id, epoch_id, units, source) VALUES ('t', 'e', '1', 1, 'operation')");
    for (const v of ['155_d1d8_erasure_tombstones', '154_d1d8_attribution', '153_d1d8_request_digest_version', '152_d1d8_fps5_price_schedule', '151_d1d8_fps5_money_scope', '150_d1d8_s4_money', '103_d1d8_receipts_v3', '102_d1d8_openings', '101_d1d8_outbox', '100_d1d8_operations']) {
      await db.pool.query(readFileSync(path.join(ROOT, 'scripts', 'migrations', 'rollback', `${v}.down.sql`), 'utf8'));
    }
    assert.deepEqual(await tables(), []);
    const left = await db.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM otk_migrations WHERE version LIKE $1', [D1D8_VERSIONS_LIKE]);
    assert.equal(left.rows[0]!.n, '0');
    const legacy = await db.pool.query<{ t: string | null }>("SELECT to_regclass('public.otk_migrations')::text AS t");
    assert.notEqual(legacy.rows[0]!.t, null, 'migrate.js bookkeeping table untouched');
    // rollback is idempotent
    await db.pool.query(readFileSync(path.join(ROOT, 'scripts', 'migrations', 'rollback', '100_d1d8_operations.down.sql'), 'utf8'));
  });

  it('migrate.js after rollback re-applies 100–103 and 150–155', async () => {
    const r = migrate(db.url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`${D1D8_MIGRATIONS.length} new migration\\(s\\) applied`));
    assert.deepEqual(await tables(), [...NEW_TABLES].sort());
  });
});
