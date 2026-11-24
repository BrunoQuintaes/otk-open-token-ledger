/**
 * H1 lane B (OTK-H1-MEGA-S01-S24-20261013): identity stores against a real, disposable PostgreSQL.
 *
 * Runs only with OTK_TEST_PG_URL (a throwaway database; the table otk_api_keys is dropped and recreated). Without it the
 * suite is skipped (no PostgreSQL in the default run). Same convention as h1_s01_pg_plan_store.test.ts.
 *
 * Covers: the additive migration of otk_api_keys (created_by on a pre-lane-B table keeps old rows with NULL = no
 * recorded author) and listByCreator from a second pool (another replica); PgSubjectStatusStore shared by two pools
 * (two replicas), monotonic "not before" instants, and two subjectStatus module instances over the same table.
 * A small non-gated case checks the row mapping of PgSubjectStatusStore with a fake pool (BIGINT as string).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

const PG_URL = process.env['OTK_TEST_PG_URL'];

/* eslint-disable @typescript-eslint/no-explicit-any */
describe(PG_URL ? 'H1 lane B identity stores on PostgreSQL (OTK_TEST_PG_URL set)' : 'H1 lane B identity stores on PostgreSQL (SKIPPED — set OTK_TEST_PG_URL)', { skip: !PG_URL }, () => {
  let poolA: any; let poolB: any;

  before(async () => {
    const pg = await import('pg');
    const Pool = (pg as any).default?.Pool ?? (pg as any).Pool;
    poolA = new Pool({ connectionString: PG_URL, max: 4 });
    poolB = new Pool({ connectionString: PG_URL, max: 4 });
    await poolA.query('DROP TABLE IF EXISTS otk_api_keys, otk_subject_status');
    // pre-lane-B schema with one row, to exercise the additive migration
    await poolA.query(`CREATE TABLE otk_api_keys (key_id TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, label TEXT NOT NULL,
      prefix TEXT NOT NULL, token_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'MEMBER',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), expires_at TIMESTAMPTZ, revoked_at TIMESTAMPTZ, last_used_at TIMESTAMPTZ)`);
    await poolA.query(`INSERT INTO otk_api_keys (key_id, tenant_id, label, prefix, token_hash) VALUES ('key_legacy', 't1', 'legacy', 'otk_k_aaaa', 'h0')`);
  });

  after(async () => { await poolA?.end(); await poolB?.end(); });

  it('PgApiKeyMetadataStore: migration keeps old rows without author; listByCreator sees keys written by another pool', async () => {
    const { PgApiKeyMetadataStore } = await import('../../src/infra/pg/PgApiKeyMetadataStore.js');
    const a = new PgApiKeyMetadataStore(poolA); const b = new PgApiKeyMetadataStore(poolB);
    await a.init(); await a.init(); await b.init();
    assert.equal((await a.get('key_legacy'))?.createdBy, null);
    const now = new Date().toISOString();
    const base = { tenantId: 't1', label: 'x', prefix: 'otk_k_bbbb', role: 'OWNER' as const, createdAt: now, expiresAt: null, revokedAt: null, lastUsedAt: null };
    await a.create({ ...base, keyId: 'key_u1', tokenHash: 'h1', createdBy: 'usr_1' });
    await a.create({ ...base, keyId: 'key_none', tokenHash: 'h2' });
    assert.deepEqual((await b.listByCreator('usr_1')).map((m) => m.keyId), ['key_u1']);
    await b.revoke('key_u1');
    assert.deepEqual(await a.listByCreator('usr_1'), [], 'revoked keys are not listed');
    assert.equal((await a.get('key_none'))?.createdBy, null);
  });

  it('PgSubjectStatusStore: two pools share the status; instants never decrease; two subjectStatus instances converge', async () => {
    const { PgSubjectStatusStore } = await import('../../src/infra/pg/PgSubjectStatusStore.js');
    const a = new PgSubjectStatusStore(poolA); const b = new PgSubjectStatusStore(poolB);
    await a.init(); await b.init();
    await a.put({ kind: 'tenant', id: 't-pg', inactive: true, notBeforeS: 2000, keysNotBeforeS: 0 });
    await b.put({ kind: 'tenant', id: 't-pg', inactive: false, notBeforeS: 1000, keysNotBeforeS: 2000 });
    const rows = await a.listAll();
    assert.deepEqual(rows.find((r) => r.id === 't-pg'), { kind: 'tenant', id: 't-pg', inactive: false, notBeforeS: 2000, keysNotBeforeS: 2000 });
    const sA: any = await import('../../src/auth/subjectStatus.js?pg=a' as string);
    const sB: any = await import('../../src/auth/subjectStatus.js?pg=b' as string);
    try {
      await sA.setSubjectStatusStore(a); await sB.setSubjectStatusStore(b);
      sA.markTenantInactive('t-pg2');
      assert.equal((await sA.flushSubjectStatus()).ok, true);
      assert.equal(await sB.syncSubjectStatusNow(), true);
      assert.equal(sB.isTenantInactive('t-pg2'), true);
      // restart of B: fresh cache hydrated from PostgreSQL
      sB.clearTenantStatusForTest(); assert.equal(await sB.syncSubjectStatusNow(), true);
      assert.equal(sB.isTenantInactive('t-pg2'), true);
    } finally { sA.resetSubjectStatusStoreForTest(); sB.resetSubjectStatusStoreForTest(); }
  });
});

describe('H1 lane B PgSubjectStatusStore row mapping (fake pool, always runs)', () => {
  it('maps BIGINT strings, ignores unknown kinds, writes GREATEST upserts', async () => {
    const { PgSubjectStatusStore } = await import('../../src/infra/pg/PgSubjectStatusStore.js');
    const queries: Array<{ text: string; params?: unknown[] }> = [];
    const pool = {
      async query(text: string, params?: unknown[]) {
        queries.push({ text, params });
        if (text.includes('SELECT kind')) {
          return { rows: [
            { kind: 'tenant', id: 't1', inactive: true, not_before_s: '1791900000', keys_not_before_s: '0' },
            { kind: 'user', id: 'u1', inactive: false, not_before_s: '1791900001', keys_not_before_s: '0' },
            { kind: 'other', id: 'x', inactive: true, not_before_s: '1', keys_not_before_s: '0' },
          ] };
        }
        return { rows: [] };
      },
    };
    const s = new PgSubjectStatusStore(pool);
    await s.put({ kind: 'tenant', id: 't1', inactive: true, notBeforeS: 1791900000.7, keysNotBeforeS: 0 });
    const upsert = queries.find((q) => q.text.includes('ON CONFLICT'))!;
    assert.match(upsert.text, /GREATEST\(otk_subject_status\.not_before_s/);
    assert.deepEqual(upsert.params, ['tenant', 't1', true, 1791900000, 0]);
    assert.deepEqual(await s.listAll(), [
      { kind: 'tenant', id: 't1', inactive: true, notBeforeS: 1791900000, keysNotBeforeS: 0 },
      { kind: 'user', id: 'u1', inactive: false, notBeforeS: 1791900001, keysNotBeforeS: 0 },
    ]);
  });
});
