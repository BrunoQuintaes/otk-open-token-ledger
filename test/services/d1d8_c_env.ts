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
 *
 * Environment variables read (names only): `OTK_TEST_PG_URL` (admin connection to the test PostgreSQL),
 * `OTK_TEST_REDIS_URL` (test Redis) and `OTK_TEST_KEEP` (`1` keeps the test databases for inspection).
 *
 * @module test/services/d1d8_c_env
 */
import pg from 'pg';
import { ensureD1D8Schema, type PgPoolLike } from '../../src/operations/schema.js';

/**
 * Reads a required test-service connection URL from the environment.
 *
 * @param name - Which service URL to read.
 * @returns The variable's value.
 * @throws {Error} When the variable is unset or empty (the tests fail instead of skipping).
 */
export function requireEnv(name: 'OTK_TEST_PG_URL' | 'OTK_TEST_REDIS_URL'): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required for test/services (see test/services/d1d8_c_env.ts)`);
  return v;
}

/** Random run id (base 36) appended to every database name and key prefix of this process, so parallel runs never collide. */
export const RUN = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;

/**
 * A throwaway test database: its name and URL, a default pool, any extra pools opened with `newPool` (all closed by
 * `drop`), and `drop`, which closes the pools and drops the database unless `OTK_TEST_KEEP=1`.
 */
export interface TestDb { name: string; url: string; pool: pg.Pool; extraPools: pg.Pool[]; newPool(): pg.Pool; drop(): Promise<void> }

/**
 * Fresh database with the D1–D8 schema applied (unless `schema: false`).
 *
 * Side effects: creates a database named `otkd1d8c_<label>_<run id>` on the server of `OTK_TEST_PG_URL`.
 *
 * @param label - Short label put in the database name (non-alphanumeric characters become `_`).
 * @param opts - `schema: false` creates an empty database without the schema.
 * @returns The test database handle; call `drop()` at the end.
 * @throws {Error} When `OTK_TEST_PG_URL` is unset, or when the database cannot be created.
 */
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

/**
 * node-postgres Pool seen through the minimal surface the D1–D8 stores declare (no cast).
 *
 * @param p - A node-postgres pool.
 * @returns The same pool, typed as the stores' pool interface.
 */
export const asPool = (p: pg.Pool): PgPoolLike => p;
