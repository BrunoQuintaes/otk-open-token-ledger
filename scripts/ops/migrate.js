/**
 * migrate.js — Schema versioning and up-only migrations
 *
 * Reads migration files from OTK_MIGRATION_DIR (default: scripts/migrations/)
 * Tracks applied versions in pg table `otk_migrations`
 * Up-only migrations (no rollback — explicit forward-only policy)
 *
 * Usage:
 *   OTK_DB_URL=postgres://... node scripts/ops/migrate.js
 *   OTK_DB_URL=postgres://... OTK_MIGRATION_DIR=./my-migrations node scripts/ops/migrate.js
 *
 * Migration file naming: NNN_description.sql (e.g., 001_create_receipts.sql)
 * Files are applied in lexicographic order. Already-applied versions are skipped.
 *
 * Details: the recorded version is the whole file name without `.sql` (renaming an applied file makes it
 * pending again). Each file runs in its own transaction together with its row in `otk_migrations`; the
 * first failure is rolled back and stops the run. Progress is logged to stderr as JSON lines (file names
 * and counts only, never the connection string). A relative OTK_MIGRATION_DIR is resolved from the
 * working directory; the default folder is resolved from this file's location.
 * Exit codes: 0 = done, or skipped because OTK_DB_URL is unset, the `pg` package is missing or there are
 * no .sql files; 1 = a migration or database error.
 * Used by the test/services migration suites.
 *
 * @since Wave 2 Pack 15 (E3.3)
 * @module scripts/ops/migrate
 */

import { readdirSync, readFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_URL = process.env['OTK_DB_URL'];
const MIGRATION_DIR = process.env['OTK_MIGRATION_DIR'] ?? resolve(__dirname, '../migrations');

function log(msg) {
  process.stderr.write(JSON.stringify({ event: 'migration', message: msg, ts: Date.now() }) + '\n');
}

async function main() {
  if (!DB_URL) {
    log('OTK_DB_URL not set — skipping migrations');
    process.exit(0);
  }

  let Pool;
  try {
    ({ Pool } = await import('pg'));
  } catch {
    log('pg module not available — skipping migrations');
    process.exit(0);
  }

  const pool = new Pool({ connectionString: DB_URL, max: 2 });

  try {
    // Create migrations tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS otk_migrations (
        version     TEXT PRIMARY KEY,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
        filename    TEXT NOT NULL
      )
    `);

    // Get already applied versions
    const applied = new Set();
    const result = await pool.query('SELECT version FROM otk_migrations ORDER BY version');
    for (const row of result.rows) {
      applied.add(row.version);
    }
    log(`${applied.size} migration(s) already applied`);

    // Read migration files
    let files;
    try {
      files = readdirSync(MIGRATION_DIR)
        .filter(f => f.endsWith('.sql'))
        .sort();
    } catch {
      log(`Migration directory ${MIGRATION_DIR} not found or empty — nothing to migrate`);
      await pool.end();
      process.exit(0);
    }

    if (files.length === 0) {
      log('No migration files found');
      await pool.end();
      process.exit(0);
    }

    // Apply pending migrations
    let appliedCount = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) {
        continue;
      }

      const filePath = resolve(MIGRATION_DIR, file);
      const sql = readFileSync(filePath, 'utf-8');

      log(`Applying migration: ${file}`);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query(
          'INSERT INTO otk_migrations (version, filename) VALUES ($1, $2)',
          [version, file],
        );
        await client.query('COMMIT');
        appliedCount++;
        log(`Applied: ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        log(`Failed to apply ${file}: ${err.message}`);
        throw err;
      } finally {
        client.release();
      }
    }

    log(`Migration complete: ${appliedCount} new migration(s) applied, ${applied.size + appliedCount} total`);
    await pool.end();
  } catch (err) {
    log(`Migration error: ${err.message}`);
    await pool.end();
    process.exit(1);
  }
}

main();
