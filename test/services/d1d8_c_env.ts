/**
 * D1–D8 / C — real-service test environment (PostgreSQL 16 + Redis 7 of the C stack).
 *
 * These tests are NOT in the `npm test` glob: they need the isolated stack
 *   OTK_TEST_PG_PORT=55532 OTK_TEST_REDIS_PORT=56479 docker compose -p otk-d1d8-1625-c \
 *     -f infra/test/docker-compose.services.yml up -d
 * and run under the heavy-job lock:
 *   OTK_TEST_PG_URL=postgres://otk:otk-test-only@127.0.0.1:55532/otk \
 *   OTK_TEST_REDIS_URL=redis://:otk-test-only@127.0.0.1:56479 \
 *   npx tsx --test test/services/d1d8_c_*.test.ts
 * Missing configuration is a failure, not a skip. Each file creates its own database
 * (prefix otkd1d8c_) and its own Redis key prefix (otkd1d8c:), and drops/deletes them at the end
 * unless OTK_TEST_KEEP=1.
 */
import pg from 'pg';
import { ensureD1D8Schema, type PgPoolLike } from '../../src/operations/schema.js';

export function requireEnv(name: 'OTK_TEST_PG_URL' | 'OTK_TEST_REDIS_URL'): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for test/services (see test/services/d1d8_c_env.ts)`);
  return v;
}

export const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

export interface TestDb { name: string; url: string; pool: pg.Pool; extraPools: pg.Pool[]; newPool(): pg.Pool; drop(): Promise<void> }

/** Fresh database with the D1–D8 schema applied (unless `schema: false`). */
export async function createTestDb(label: string, opts: { schema?: boolean } = {}): Promise<TestDb> {
  const adminUrl = requireEnv('OTK_TEST_PG_URL');
  const name = `otkd1d8c_${label}_${RUN}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });
  await admin.query(`CREATE DATABASE "${name}"`);
  await admin.end();
  const u = new URL(adminUrl); u.pathname = `/${name}`;
  const url = String(u);
  const extraPools: pg.Pool[] = [];
  const newPool = () => { const p = new pg.Pool({ connectionString: url, max: 10 }); p.on('error', () => {}); extraPools.push(p); return p; };
  const pool = newPool();
  if (opts.schema !== false) await ensureD1D8Schema(pool);
  return {
    name, url, pool, extraPools, newPool,
    async drop() {
      for (const p of extraPools) await p.end().catch(() => {});
      if (process.env['OTK_TEST_KEEP'] === '1') return;
      const a = new pg.Pool({ connectionString: adminUrl, max: 1 });
      await a.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
      await a.end();
    },
  };
}

/** node-postgres Pool seen through the minimal surface the D1–D8 stores declare (no cast). */
export const asPool = (p: pg.Pool): PgPoolLike => p;
