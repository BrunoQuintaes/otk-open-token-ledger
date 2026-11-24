/**
 * D1–D8 / S4 — ABC-05: the official migration command works on an empty database, is idempotent,
 * upgrades a database written by the pre-S4 code without losing or reinterpreting data, survives
 * backup/restore, and rolls back compatibly (PostgreSQL 16 of the S4 stack).
 *
 * Official command (docs/IT_ADMIN_GUIDE.md, scripts/ops/migrate.js): `OTK_DB_URL=… node scripts/ops/migrate.js`
 * with the default directory scripts/migrations (all files, 001 → 150).
 *
 *   . scripts/ops/s4_env.sh && npx tsx --test --test-concurrency=1 test/services/d1d8_s4_migrations.test.ts
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestDb, type TestDb } from './d1d8_c_env.js';
import { D1D8_MIGRATIONS } from '../../src/operations/schema.js';
import { PgOperationStore } from '../../src/operations/PgOperationStore.js';
import { encodeJson } from '../../src/operations/codec.js';
import { admitReq, usage, CU } from '../fixtures/d1d8/c/builders.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MIG = path.join(ROOT, 'scripts', 'migrations');
const CONTAINER = process.env['OTK_TEST_PG_CONTAINER'] ?? 'otk-d1d8-1625-s4-postgres-1';
/** The official command, default directory (OTK_MIGRATION_DIR removed from the environment). */
const migrate = (url: string) => spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'ops', 'migrate.js')], { cwd: ROOT, env: { ...process.env, OTK_DB_URL: url, OTK_MIGRATION_DIR: undefined }, encoding: 'utf8' });
const ALL = readFileSync(path.join(ROOT, 'docs', 'IT_ADMIN_GUIDE.md'), 'utf8'); // the documented procedure exists
const P = 1_000_000_000_000n;
const dbs: TestDb[] = [];
after(async () => { for (const d of dbs) await d.drop(); });
const fresh = async (label: string) => { const d = await createTestDb(label, { schema: false }); dbs.push(d); return d; };

function docker(args: string[], input?: string): string {
  const r = spawnSync('docker', args, { encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

describe('S4 ABC-05 — official migration command', () => {
  it('empty database: every file 001 → 150 applies (exit 0); second run applies nothing', async () => {
    assert.match(ALL, /scripts\/migrations/);
    const db = await fresh('s4mig_empty');
    const r = migrate(db.url);
    assert.equal(r.status, 0, r.stderr);
    const files = spawnSync('node', ['-e', `console.log(require('fs').readdirSync(${JSON.stringify(MIG)}).filter(f=>f.endsWith('.sql')).length)`], { encoding: 'utf8' }).stdout.trim();
    assert.match(r.stderr, new RegExp(`${files} new migration\\(s\\) applied`));
    assert.match(r.stderr, /Applied: 004_retention_policy\.sql/);
    const r2 = migrate(db.url);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stderr, /0 new migration\(s\) applied/);
    // nothing was invented: no `receipts` table, no lifecycle column created out of thin air
    const t = await db.pool.query<{ t: string | null }>("SELECT to_regclass('public.receipts')::text AS t");
    assert.equal(t.rows[0]!.t, null);
  });

  it('database that HAS a legacy `receipts` table: 004/005 add exactly the original columns and keep its rows', async () => {
    const db = await fresh('s4mig_receipts');
    await db.pool.query('CREATE TABLE receipts (id TEXT PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now())');
    await db.pool.query("INSERT INTO receipts (id) VALUES ('r1'), ('r2')");
    const r = migrate(db.url);
    assert.equal(r.status, 0, r.stderr);
    const cols = await db.pool.query<{ c: string }>("SELECT column_name AS c FROM information_schema.columns WHERE table_name = 'receipts' ORDER BY 1");
    assert.deepEqual(cols.rows.map((x) => x.c), ['archived_at', 'created_at', 'erased_at', 'id', 'tombstone_hash']);
    const idx = await db.pool.query<{ i: string }>("SELECT indexname AS i FROM pg_indexes WHERE tablename = 'receipts' AND indexname LIKE 'idx_%' ORDER BY 1");
    assert.deepEqual(idx.rows.map((x) => x.i), ['idx_receipts_archived_at', 'idx_receipts_erased_at']);
    assert.equal((await db.pool.query('SELECT 1 FROM receipts')).rowCount, 2);
  });

  it('upgrade: a database written by the pre-S4 code (100–103 by the runtime, C settlement semantics) keeps every row; 150 adds an explicit money axis', async () => {
    const db = await fresh('s4mig_upgrade');
    for (const m of D1D8_MIGRATIONS.filter((x) => x.version < '150')) await db.pool.query(m.sql); // what the pre-S4 runtime applied
    // two rows as the pre-S4 code wrote them (no money column): one held, one settled at the reservation
    const insert = async (op: string, state: string, money: bigint, rmoney: bigint) => {
      const base = admitReq({ tenantId: 'U', operationId: op }, 3n, { money });
      const reservation = { ...base.reservation, state, money: { units: rmoney, scale: P, currency: 'USD' } };
      const settled = state === 'settled';
      await db.pool.query(
        `INSERT INTO otk_operations (tenant_id, operation_id, request_digest, provider, api, model_requested, config, limits, reservation, epoch_id,
           reserved_units, reserved_money, budget_ids, execution, measurement, delivery, usage, effects)
         VALUES ('U',$1,$2,'openai','openai.chat_completions','gpt-4o-mini',$3::jsonb,$4::jsonb,$5::jsonb,'e',$6::numeric,$7::numeric,'{b-U}',$8,$9,'delivered',$10::jsonb,$11::jsonb)`,
        [op, base.requestDigest, encodeJson(base.config), encodeJson(base.limits), encodeJson(reservation), (3_000_000n).toString(), money.toString(),
          settled ? 'completed' : 'upstream_started', settled ? 'final' : 'none', settled ? encodeJson(usage(1n, 1n)) : null,
          encodeJson({ receiptDigest: null, conferenceDigest: null, debitApplied: settled, proofJobId: null })],
      );
    };
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units, spent_units, held_units) VALUES ('b-U', 'U', $1::numeric, $2::numeric, $3::numeric)", [(P).toString(), (5n * P / 100n).toString(), (40n * P / 100n).toString()]);
    // quota counters as the pre-S4 code left them: settled-1 confirmed (3 CU), held-1 held (3 CU)
    await db.pool.query("INSERT INTO otk_quota_usage (tenant_id, epoch_id, confirmed_units, held_units) VALUES ('U', 'e', 3000000, 3000000)");
    await insert('held-1', 'held', 40n * P / 100n, 40n * P / 100n);
    await insert('settled-1', 'settled', 40n * P / 100n, 5n * P / 100n); // C moved US$ 0.05 to spent
    const before = await db.pool.query('SELECT tenant_id, operation_id, reservation, usage, effects, reserved_money FROM otk_operations ORDER BY 2');

    const r = migrate(db.url);
    assert.equal(r.status, 0, r.stderr);
    const after = await db.pool.query('SELECT tenant_id, operation_id, reservation, usage, effects, reserved_money FROM otk_operations ORDER BY 2');
    assert.deepEqual(after.rows, before.rows, 'existing columns untouched');
    const budget = await db.pool.query<{ s: string; h: string }>("SELECT spent_units::text AS s, held_units::text AS h FROM otk_money_budget WHERE budget_id = 'b-U'");
    assert.deepEqual(budget.rows[0], { s: (5n * P / 100n).toString(), h: (40n * P / 100n).toString() }, 'counters not reinterpreted');

    const store = new PgOperationStore(db.pool, { quotaFor: () => null, epochOf: () => 'e' });
    const held = (await store.get({ tenantId: 'U', operationId: 'held-1' }))!;
    assert.equal(held.money!.state, 'held');
    assert.equal(held.money!.reserved.units, 40n * P / 100n);
    const legacy = (await store.get({ tenantId: 'U', operationId: 'settled-1' }))!;
    assert.equal(legacy.money!.state, 'settled');
    assert.equal(legacy.money!.origin, 'legacy_pre_s4', 'the old rule is labelled, not presented as a complete quote');
    assert.equal(legacy.money!.confirmed!.units, 5n * P / 100n);
    // the new code continues the held operation with the new rule: CU settles, money pending (no quote)
    const st = await store.transition(held.key, held.revision, { execution: 'completed', measurement: 'final', usage: usage(1n, 1n), reservation: { ...held.reservation, cu: CU(2n), state: 'settled' } });
    assert.equal(st.money!.state, 'pending_price');
    const b2 = await db.pool.query<{ s: string; h: string }>("SELECT spent_units::text AS s, held_units::text AS h FROM otk_money_budget WHERE budget_id = 'b-U'");
    assert.deepEqual(b2.rows[0], { s: (5n * P / 100n).toString(), h: (40n * P / 100n).toString() }, 'pending price keeps the hold, spends nothing');
  });

  it('backup/restore of a migrated database (pg_dump/psql in the S4 container) keeps rows and migration bookkeeping; migrate.js afterwards is a no-op', async () => {
    const src = await fresh('s4mig_bk_src');
    const r = migrate(src.url);
    assert.equal(r.status, 0, r.stderr);
    const store = new PgOperationStore(src.pool, { quotaFor: () => null, epochOf: () => 'e' });
    await src.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-K', 'K', $1::numeric)", [P.toString()]);
    assert.equal((await store.admit(admitReq({ tenantId: 'K', operationId: 'k1' }, 1n, { money: P / 10n }))).outcome, 'admitted');
    const dump = docker(['exec', CONTAINER, 'pg_dump', '-U', 'otk', '--no-owner', src.name]);
    const dst = await fresh('s4mig_bk_dst');
    docker(['exec', '-i', CONTAINER, 'psql', '-U', 'otk', '-v', 'ON_ERROR_STOP=1', '-q', dst.name], dump);
    const back = (await new PgOperationStore(dst.pool, { quotaFor: () => null, epochOf: () => 'e' }).get({ tenantId: 'K', operationId: 'k1' }))!;
    assert.equal(back.money!.state, 'held');
    const r2 = migrate(dst.url);
    assert.equal(r2.status, 0, r2.stderr);
    assert.match(r2.stderr, /0 new migration\(s\) applied/);
  });

  it('rollback 150 → 100 is compatible: 150 down keeps the pre-S4 tables and rows; re-applying restores the money axis', async () => {
    const db = await fresh('s4mig_rollback');
    let r = migrate(db.url);
    assert.equal(r.status, 0, r.stderr);
    const store = new PgOperationStore(db.pool, { quotaFor: () => null, epochOf: () => 'e' });
    await db.pool.query("INSERT INTO otk_money_budget (budget_id, tenant_id, ceiling_units) VALUES ('b-R', 'R', $1::numeric)", [P.toString()]);
    await store.admit(admitReq({ tenantId: 'R', operationId: 'r1' }, 1n, { money: P / 10n }));
    // documented order (rollback/README.md): 152 → 151 → 150 down; all three are re-applied afterwards
    await db.pool.query(readFileSync(path.join(MIG, 'rollback', '152_d1d8_fps5_price_schedule.down.sql'), 'utf8'));
    await db.pool.query(readFileSync(path.join(MIG, 'rollback', '151_d1d8_fps5_money_scope.down.sql'), 'utf8'));
    await db.pool.query(readFileSync(path.join(MIG, 'rollback', '150_d1d8_s4_money.down.sql'), 'utf8'));
    const cols = await db.pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'otk_operations' AND column_name = 'money'");
    assert.equal(cols.rowCount, 0);
    assert.equal((await db.pool.query("SELECT 1 FROM otk_operations WHERE operation_id = 'r1'")).rowCount, 1, 'pre-S4 data kept');
    r = migrate(db.url);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /3 new migration\(s\) applied/);
    const guard = await db.pool.query("SELECT 1 FROM pg_trigger WHERE tgname = 'otk_money_budget_members_scope'");
    assert.equal(guard.rowCount, 1, 'the membership guard is back after re-applying 151');
    const back = (await store.get({ tenantId: 'R', operationId: 'r1' }))!;
    assert.equal(back.money!.state, 'held', 'backfill rebuilds the axis from reservation + reserved_money');
  });
});
