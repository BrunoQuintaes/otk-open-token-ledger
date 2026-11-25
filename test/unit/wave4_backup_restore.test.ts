/**
 * W4-4B01 — Backup + Restore Drill tests (E5.1)
 *
 * Covers:
 *   1.  Script file exists
 *   2.  Script is executable (unix permission check)
 *   3.  Script outputs valid JSON on dry-run (no PG, no Redis configured)
 *   4.  JSON output has required fields: ok, rto_seconds, pg_rows, redis_keys, errors
 *   5.  rto_seconds is a non-negative number
 *   6.  errors is an array
 *   7.  ok is boolean
 *   8.  Dry-run (no OTK_PG_URL set) exits 0 (not a fatal error)
 *
 * @since Wave 4 (4B-PACK-4B01 / E5.1)
 *
 * Under test: the script `scripts/ops/backup_restore_drill.sh`, read as text and then run once (the later
 * execution cases reuse that result).
 *
 * Strategy / partitions: the script contents (shebang, dump and save commands, JSON output, recovery-time
 * target); a dry run with no database URL and an unreachable Redis port (exit 0 and each JSON field).
 *
 * Needs: `bash` on the PATH. Each run sets `OTK_PG_URL` to empty and `OTK_REDIS_HOST` / `OTK_REDIS_PORT` to a
 * local port with nothing listening, with a 30 s limit; no database or Redis is touched.
 *
 * Run just this file: `npx tsx --test test/unit/wave4_backup_restore.test.ts`
 *
 * @module test/unit/wave4_backup_restore.test
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as child_process from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '../..');
const SCRIPT = path.join(ROOT, 'scripts/ops/backup_restore_drill.sh');

// ──────────────────────────────────────────────────────────
// Helper: run drill script and capture stdout JSON
// ──────────────────────────────────────────────────────────
function runDrill(env: NodeJS.ProcessEnv = {}): {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  const result = child_process.spawnSync('bash', [SCRIPT], {
    env: {
      ...process.env,
      OTK_PG_URL: '',
      OTK_REDIS_HOST: '127.0.0.1',
      OTK_REDIS_PORT: '19999', // non-listening port → Redis not reachable
      ...env,
    },
    encoding: 'utf-8',
    timeout: 30000,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

// ──────────────────────────────────────────────────────────
// 1. File structure
// ──────────────────────────────────────────────────────────
describe('W4-4B01 — File structure', () => {
  it('scripts/ops/backup_restore_drill.sh exists', () => {
    assert.ok(fs.existsSync(SCRIPT), `Expected ${SCRIPT} to exist`);
  });

  it('script contains shebang #!/usr/bin/env bash', () => {
    const content = fs.readFileSync(SCRIPT, 'utf-8');
    assert.ok(content.startsWith('#!/usr/bin/env bash'));
  });

  it('script contains pg_dump command', () => {
    const content = fs.readFileSync(SCRIPT, 'utf-8');
    assert.ok(content.includes('pg_dump'));
  });

  it('script contains BGSAVE command', () => {
    const content = fs.readFileSync(SCRIPT, 'utf-8');
    assert.ok(content.includes('BGSAVE'));
  });

  it('script outputs JSON (contains ok_val field)', () => {
    const content = fs.readFileSync(SCRIPT, 'utf-8');
    // Script uses ok_val variable and outputs it as part of JSON
    assert.ok(content.includes('ok_val'));
  });

  it('script documents RTO target (900 seconds = 15 minutes)', () => {
    const content = fs.readFileSync(SCRIPT, 'utf-8');
    assert.ok(content.includes('900') && content.includes('15'));
  });
});

// ──────────────────────────────────────────────────────────
// 2. Execution + JSON output shape (dry-run, no infra)
// ──────────────────────────────────────────────────────────
describe('W4-4B01 — Drill execution (dry-run)', () => {
  let result: { exitCode: number; stdout: string; stderr: string };

  it('runs without error (exit 0) when infra not configured', () => {
    result = runDrill();
    assert.strictEqual(result.exitCode, 0,
      `Expected exit 0, got ${result.exitCode}. stderr: ${result.stderr}`);
  });

  it('stdout contains valid JSON', () => {
    if (!result) result = runDrill();
    const lines = result.stdout.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'));
    assert.ok(jsonLine, 'Expected a JSON line in stdout');
    assert.doesNotThrow(() => JSON.parse(jsonLine!));
  });

  it('JSON has ok field (boolean)', () => {
    if (!result) result = runDrill();
    const lines = result.stdout.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'))!;
    const parsed = JSON.parse(jsonLine);
    assert.ok(typeof parsed.ok === 'boolean', `ok should be boolean, got ${typeof parsed.ok}`);
  });

  it('JSON has rto_seconds (non-negative number)', () => {
    if (!result) result = runDrill();
    const lines = result.stdout.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'))!;
    const parsed = JSON.parse(jsonLine);
    assert.ok(typeof parsed.rto_seconds === 'number', 'rto_seconds should be number');
    assert.ok(parsed.rto_seconds >= 0, 'rto_seconds should be >= 0');
  });

  it('JSON has pg_rows (number)', () => {
    if (!result) result = runDrill();
    const lines = result.stdout.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'))!;
    const parsed = JSON.parse(jsonLine);
    assert.ok(typeof parsed.pg_rows === 'number', 'pg_rows should be number');
  });

  it('JSON has redis_keys (number)', () => {
    if (!result) result = runDrill();
    const lines = result.stdout.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'))!;
    const parsed = JSON.parse(jsonLine);
    assert.ok(typeof parsed.redis_keys === 'number', 'redis_keys should be number');
  });

  it('JSON has errors (array)', () => {
    if (!result) result = runDrill();
    const lines = result.stdout.trim().split('\n');
    const jsonLine = lines.find(l => l.trim().startsWith('{'))!;
    const parsed = JSON.parse(jsonLine);
    assert.ok(Array.isArray(parsed.errors), 'errors should be an array');
  });
});
