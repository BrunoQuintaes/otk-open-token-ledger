/**
 * NF-05 (RUN-S 2026-10-09, S-07): scripts/ops/backup.sh finished with exit 0 after copying zero files, treated a failed
 * or missing pg_dump as a warning, skipped configured sources that did not exist and wrote no checksum. A backup that
 * saved nothing must not look successful. Runs the real script in disposable directories with fake data.
 *
 * Script under test: `scripts/ops/backup.sh`, run with `bash` as a child process.
 *
 * Strategy / partitions: nothing configured; a configured source that does not exist; a database
 * URL that cannot be dumped; one real source (exit 0 and a SHA256SUMS that verifies); an empty
 * file as the only content; secondary logs without a primary source (database or receipt log);
 * failed and aborted runs (directory renamed `.FAILED`); a destination that cannot be created; a
 * run stopped by SIGTERM during the copy; a good backup whose file or checksum line is changed
 * afterwards (detected).
 *
 * Needs: `bash` on the PATH (every block is skipped when it is missing) and the local file system
 * (temporary directories removed in the `after` hook). The child gets a reduced environment: only
 * a few system variables plus `OTK_BACKUP_DIR` and the variables each test sets; the OTK storage
 * variables of the parent are never passed on. `sha256sum` is used to verify manifests. No real
 * database is needed: the failing-dump case points at a closed local port (127.0.0.1:1).
 *
 * Run just this file: `npx tsx --test test/unit/backup_script.test.ts`
 *
 * @module test/unit/backup_script.test
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ops', 'backup.sh');
const hasBash = spawnSync('bash', ['-c', 'exit 0']).status === 0;
const dirs: string[] = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const KEEP = ['PATH', 'SystemRoot', 'HOME', 'USERPROFILE', 'TEMP', 'TMP'];
const OTK_VARS = ['OTK_DB_URL', 'OTK_RECEIPT_LOG', 'OTK_DEAD_LETTER_LOG', 'OTK_GOVERNANCE_LOG', 'OTK_TENANT_LOG', 'OTK_PROOF_QUEUE_LOG'];

function run(env: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otk-backup-'));
  dirs.push(dir);
  const base: Record<string, string> = {};
  for (const k of KEEP) if (process.env[k] !== undefined) base[k] = process.env[k] as string;
  for (const k of OTK_VARS) delete base[k];
  const r = spawnSync('bash', [SCRIPT], { encoding: 'utf-8', cwd: dir, env: { ...base, OTK_BACKUP_DIR: path.join(dir, 'out'), ...env } });
  const outDir = path.join(dir, 'out');
  const made = fs.existsSync(outDir) ? fs.readdirSync(outDir).map((d) => path.join(outDir, d)) : [];
  return { status: r.status, out: r.stdout + r.stderr, made, dir };
}
function tmpFile(content: string) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'otk-backup-src-'));
  dirs.push(d);
  const f = path.join(d, 'receipts.jsonl');
  fs.writeFileSync(f, content);
  return f;
}

describe('NF-05: backup.sh never reports success for an empty or partial backup', { skip: !hasBash && 'bash not available' }, () => {
  it('nothing configured: exits non-zero (zero files is a failure)', () => {
    const r = run({});
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /no file|0 file/i);
  });
  it('a configured source that does not exist: exits non-zero', () => {
    const r = run({ OTK_RECEIPT_LOG: path.join(os.tmpdir(), `missing-${Date.now()}.jsonl`) });
    assert.notEqual(r.status, 0, r.out);
  });
  it('OTK_DB_URL set but the database cannot be dumped: exits non-zero', () => {
    const r = run({ OTK_DB_URL: 'postgres://fixture-user@127.0.0.1:1/none', OTK_RECEIPT_LOG: tmpFile('{"a":1}\n') });
    assert.notEqual(r.status, 0, r.out);
    assert.ok(!r.out.includes('fixture-user@127.0.0.1'), 'the connection string is not echoed');
  });
  it('a real source: exits 0, copies the file and writes a verifiable SHA256SUMS', () => {
    const r = run({ OTK_RECEIPT_LOG: tmpFile('{"receipt":1}\n{"receipt":2}\n') });
    assert.equal(r.status, 0, r.out);
    assert.equal(r.made.length, 1);
    const files = fs.readdirSync(r.made[0]);
    assert.ok(files.some((f) => f.startsWith('receipt_log_')));
    assert.ok(files.includes('SHA256SUMS'));
    const check = spawnSync('bash', ['-c', 'sha256sum -c SHA256SUMS'], { cwd: r.made[0], encoding: 'utf-8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
  });
  it('a backup whose only file is empty is a failure', () => {
    const r = run({ OTK_RECEIPT_LOG: tmpFile('') });
    assert.notEqual(r.status, 0, r.out);
  });
});

describe('RV-RUNS-03 / RV-RUNS-10 (adversarial review): partial backups and failed directories', { skip: !hasBash && 'bash not available' }, () => {
  it('a non-empty secondary log with an empty receipt log and no database is a failure', () => {
    const r = run({ OTK_PROOF_QUEUE_LOG: tmpFile('{"job":1}\n'), OTK_RECEIPT_LOG: tmpFile('') });
    assert.notEqual(r.status, 0, r.out);
    assert.ok(!/SHA256SUMS verified/.test(r.out), 'no success message');
  });
  it('without a primary source (OTK_DB_URL or OTK_RECEIPT_LOG) the backup fails even if other logs exist', () => {
    const r = run({ OTK_PROOF_QUEUE_LOG: tmpFile('{"job":1}\n') });
    assert.notEqual(r.status, 0, r.out);
    assert.match(r.out, /primary source/i);
  });
  it('a failed backup directory is renamed .FAILED so it is never taken for a good backup', () => {
    const r = run({ OTK_RECEIPT_LOG: tmpFile('') });
    assert.notEqual(r.status, 0);
    assert.ok(r.made.length >= 1 && r.made.every((d) => d.endsWith('.FAILED')), r.made.join(','));
  });
  it('a good backup still succeeds with a verifiable manifest', () => {
    const r = run({ OTK_RECEIPT_LOG: tmpFile('{"receipt":1}\n'), OTK_PROOF_QUEUE_LOG: tmpFile('{"job":1}\n') });
    assert.equal(r.status, 0, r.out);
    assert.ok(!r.made[0].endsWith('.FAILED'));
    const check = spawnSync('bash', ['-c', 'sha256sum -c SHA256SUMS'], { cwd: r.made[0], encoding: 'utf-8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
  });
});

describe('RV2-RUNS-03 (second review pass): an aborted backup is marked failed', { skip: !hasBash && 'bash not available' }, () => {
  it('a failing cp (set -e abort) leaves only a .FAILED directory and a non-zero exit', () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'otk-fakebin-'));
    dirs.push(fakeBin);
    fs.writeFileSync(path.join(fakeBin, 'cp'), '#!/usr/bin/env bash\necho "fake cp failure" >&2\nexit 1\n', { mode: 0o755 });
    const r = run({ OTK_RECEIPT_LOG: tmpFile('{"receipt":1}\n'), PATH: `${fakeBin}${path.delimiter}${process.env['PATH'] ?? ''}` });
    assert.notEqual(r.status, 0, r.out);
    assert.ok(r.made.length >= 1 && r.made.every((d) => d.endsWith('.FAILED')), r.made.join(','));
  });
});

describe('M24-O04 (RUN-M1-24H): destination, interruption and later corruption', { skip: !hasBash && 'bash not available' }, () => {
  it('a destination that cannot be created (a regular file in the path) exits non-zero and reports no backup', () => {
    const blocker = tmpFile('not a directory\n');
    const r = run({ OTK_RECEIPT_LOG: tmpFile('{"receipt":1}\n'), OTK_BACKUP_DIR: path.join(blocker, 'out') });
    assert.notEqual(r.status, 0, r.out);
    assert.doesNotMatch(r.out, /\[backup\] Complete/);
  });
  it('a backup interrupted by SIGTERM during the copy is left as .FAILED, never as a complete-looking directory', () => {
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'otk-fakebin-'));
    dirs.push(fakeBin);
    // the "cp" signals the backup shell (its parent) and then succeeds, as if the operator pressed Ctrl+C mid-copy
    fs.writeFileSync(path.join(fakeBin, 'cp'), '#!/usr/bin/env bash\nkill -TERM "$PPID"\nsleep 1\nexit 0\n', { mode: 0o755 });
    const r = run({ OTK_RECEIPT_LOG: tmpFile('{"receipt":1}\n'), PATH: `${fakeBin}${path.delimiter}${process.env['PATH'] ?? ''}` });
    assert.notEqual(r.status, 0, r.out);
    assert.ok(r.made.length >= 1 && r.made.every((d) => d.endsWith('.FAILED')), `${r.made.join(',')}\n${r.out}`);
  });
  it('the SHA256SUMS of a good backup detects a file corrupted afterwards and a tampered checksum line', () => {
    const r = run({ OTK_RECEIPT_LOG: tmpFile('{"receipt":1}\n{"receipt":2}\n') });
    assert.equal(r.status, 0, r.out);
    const dir = r.made[0];
    const sums = path.join(dir, 'SHA256SUMS');
    const original = fs.readFileSync(sums, 'utf-8');
    const data = fs.readdirSync(dir).find((f) => f.startsWith('receipt_log_'))!;
    fs.appendFileSync(path.join(dir, data), '{"receipt":3}\n');
    const corrupted = spawnSync('bash', ['-c', 'sha256sum -c --quiet SHA256SUMS'], { cwd: dir, encoding: 'utf-8' });
    assert.notEqual(corrupted.status, 0, 'a modified file must fail verification');
    fs.writeFileSync(sums, original.replace(/^[0-9a-f]{64}/m, '0'.repeat(64)));
    const tampered = spawnSync('bash', ['-c', 'sha256sum -c --quiet SHA256SUMS'], { cwd: dir, encoding: 'utf-8' });
    assert.notEqual(tampered.status, 0, 'a wrong checksum line must fail verification');
  });
});
