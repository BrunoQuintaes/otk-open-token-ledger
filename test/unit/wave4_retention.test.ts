/**
 * W4-4B03 — Retention Worker + Load/Chaos tests (E5.3+E5.4)
 *
 * Covers:
 *   1.  RetentionWorker.ts file exists
 *   2.  Migration 004_retention_policy.sql exists
 *   3.  k6 smoke script exists
 *   4.  k6 stress script exists
 *   5.  chaos_inject.sh exists
 *   6.  RetentionWorker reads OTK_RECEIPT_RETENTION_DAYS from env
 *   7.  RetentionWorker reads OTK_AUDIT_RETENTION_DAYS from env
 *   8.  run() with no db returns ok=true immediately
 *   9.  run() returns RetentionRunResult shape
 *  10.  start()/stop() are safe (no errors without DB)
 *  11.  k6_smoke.js contains vus and duration options
 *  12.  k6_stress.js contains stages definition
 *  13.  chaos_inject.sh references PG and Redis
 *  14.  migration SQL contains archived_at column
 *
 * @since Wave 4 (4B-PACK-4B03 / E5.3+E5.4)
 *
 * Module under test: `src/infra/retention/RetentionWorker.ts`; the load-test scripts, the chaos script and the
 * migration SQL are checked as text (none of them is run).
 *
 * Strategy / partitions: as listed above; retention days with the variables unset (defaults 90 and 365) and set;
 * a run, start and stop without a database.
 *
 * Needs: no database. Changes `OTK_RECEIPT_RETENTION_DAYS` and `OTK_AUDIT_RETENTION_DAYS` and restores them.
 *
 * Run just this file: `npx tsx --test test/unit/wave4_retention.test.ts`
 *
 * @module test/unit/wave4_retention.test
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');

import { RetentionWorker } from '../../src/infra/retention/RetentionWorker.js';

// ──────────────────────────────────────────────────────────
// 1–5. File structure
// ──────────────────────────────────────────────────────────
describe('W4-4B03 — File structure', () => {
  it('src/infra/retention/RetentionWorker.ts exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'src/infra/retention/RetentionWorker.ts')));
  });

  it('scripts/migrations/004_retention_policy.sql exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts/migrations/004_retention_policy.sql')));
  });

  it('scripts/load/k6_smoke.js exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts/load/k6_smoke.js')));
  });

  it('scripts/load/k6_stress.js exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts/load/k6_stress.js')));
  });

  it('scripts/load/chaos_inject.sh exists', () => {
    assert.ok(fs.existsSync(path.join(ROOT, 'scripts/load/chaos_inject.sh')));
  });
});

// ──────────────────────────────────────────────────────────
// 6–7. Config from env
// ──────────────────────────────────────────────────────────
describe('W4-4B03 — RetentionWorker config', () => {
  let orig1: string | undefined, orig2: string | undefined;

  before(() => {
    orig1 = process.env['OTK_RECEIPT_RETENTION_DAYS'];
    orig2 = process.env['OTK_AUDIT_RETENTION_DAYS'];
  });
  after(() => {
    if (orig1 !== undefined) process.env['OTK_RECEIPT_RETENTION_DAYS'] = orig1; else delete process.env['OTK_RECEIPT_RETENTION_DAYS'];
    if (orig2 !== undefined) process.env['OTK_AUDIT_RETENTION_DAYS'] = orig2; else delete process.env['OTK_AUDIT_RETENTION_DAYS'];
  });

  it('reads OTK_RECEIPT_RETENTION_DAYS (default 90)', () => {
    delete process.env['OTK_RECEIPT_RETENTION_DAYS'];
    const w = new RetentionWorker(null);
    assert.strictEqual(w.config.receiptRetentionDays, 90);
  });

  it('reads OTK_RECEIPT_RETENTION_DAYS custom value', () => {
    process.env['OTK_RECEIPT_RETENTION_DAYS'] = '30';
    const w = new RetentionWorker(null);
    assert.strictEqual(w.config.receiptRetentionDays, 30);
  });

  it('reads OTK_AUDIT_RETENTION_DAYS (default 365)', () => {
    delete process.env['OTK_AUDIT_RETENTION_DAYS'];
    const w = new RetentionWorker(null);
    assert.strictEqual(w.config.auditRetentionDays, 365);
  });
});

// ──────────────────────────────────────────────────────────
// 8–10. Runtime behavior
// ──────────────────────────────────────────────────────────
describe('W4-4B03 — RetentionWorker runtime', () => {
  it('run() with no db returns ok=true', async () => {
    const w = new RetentionWorker(null);
    const result = await w.run();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.receiptsArchived, 0);
    assert.strictEqual(result.auditEntriesArchived, 0);
    assert.ok(result.durationMs >= 0);
  });

  it('run() returns RetentionRunResult with all required fields', async () => {
    const w = new RetentionWorker(null);
    const result = await w.run();
    assert.ok('ok' in result);
    assert.ok('receiptsArchived' in result);
    assert.ok('auditEntriesArchived' in result);
    assert.ok('durationMs' in result);
  });

  it('start() + stop() without DB is safe (no throw)', () => {
    const w = new RetentionWorker(null, { intervalMs: 100000 });
    assert.doesNotThrow(() => w.start());
    assert.doesNotThrow(() => w.stop());
  });

  it('lastRun is null initially, set after run()', async () => {
    const w = new RetentionWorker(null);
    assert.strictEqual(w.lastRun, null);
    await w.run();
    assert.ok(w.lastRun !== null);
  });
});

// ──────────────────────────────────────────────────────────
// 11–14. Load script + migration content
// ──────────────────────────────────────────────────────────
describe('W4-4B03 — Load scripts and migration content', () => {
  it('k6_smoke.js has vus and duration options', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts/load/k6_smoke.js'), 'utf-8');
    assert.ok(content.includes('vus'));
    assert.ok(content.includes('duration'));
  });

  it('k6_stress.js has stages definition', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts/load/k6_stress.js'), 'utf-8');
    assert.ok(content.includes('stages'));
  });

  it('chaos_inject.sh references PG and Redis', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts/load/chaos_inject.sh'), 'utf-8');
    assert.ok(content.includes('PG') || content.includes('postgres'));
    assert.ok(content.includes('Redis') || content.includes('redis'));
  });

  it('migration 004 contains archived_at column definition', () => {
    const content = fs.readFileSync(path.join(ROOT, 'scripts/migrations/004_retention_policy.sql'), 'utf-8');
    assert.ok(content.includes('archived_at'));
    assert.ok(content.includes('ALTER TABLE receipts'));
  });
});
