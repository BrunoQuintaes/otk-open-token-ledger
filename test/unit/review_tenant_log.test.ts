/**
 * RUN-M1-24H (ADV-M24-05): scripts/ops/review_tenant_log.mjs lists the active OTK_TENANT_LOG records that predate the
 * M24-SEC-01 fix, never prints a token and never changes the file.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'ops', 'review_tenant_log.mjs');
const TOKEN_OLD = 'fixture-token-created-by-a-tenant-0001';
const TOKEN_NEW = 'fixture-token-created-by-platform-0002';

const dirs: string[] = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function logFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'otk-tenant-log-'));
  dirs.push(dir);
  const f = path.join(dir, 'tenants.jsonl');
  const rec = (tenantId: string, token: string, createdAt: string, active = true) =>
    JSON.stringify({ tenantId, role: 'OPERATOR', token, createdAt, updatedAt: createdAt, active });
  fs.writeFileSync(f, [
    rec('t-old', TOKEN_OLD, '2026-10-01T10:00:00.000Z'),
    rec('t-new', TOKEN_NEW, '2026-10-11T10:00:00.000Z'),
    rec('t-gone', 'fixture-token-revoked-0003', '2026-10-01T09:00:00.000Z', false),
    '{not json',
  ].join('\n') + '\n');
  return f;
}
const run = (...a: string[]) => spawnSync(process.execPath, [SCRIPT, ...a], { encoding: 'utf8' });

describe('review_tenant_log (ADV-M24-05)', () => {
  it('marks only active records created before the cutoff, prints no token, leaves the file unchanged', () => {
    const f = logFile();
    const before = fs.readFileSync(f);
    const r = run(f, '--before', '2026-10-10T00:00:00Z', '--json');
    assert.equal(r.status, 1, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.toReview, 1);
    assert.equal(out.malformedLines, 1);
    assert.deepEqual(out.items.filter((i: { review: boolean }) => i.review).map((i: { tenantId: string }) => i.tenantId), ['t-old']);
    assert.ok(!r.stdout.includes(TOKEN_OLD) && !r.stdout.includes(TOKEN_NEW), 'token printed');
    assert.deepEqual(fs.readFileSync(f), before);
    const text = run(f, '--before', '2026-10-10T00:00:00Z');
    assert.ok(!text.stdout.includes(TOKEN_OLD) && /^REVIEW {2}t-old/m.test(text.stdout));
  });
  it('without --before every active record is listed for review; exit 0 when nothing is active before the cutoff', () => {
    const f = logFile();
    assert.equal(JSON.parse(run(f, '--json').stdout).toReview, 2);
    assert.equal(run(f, '--before', '2026-09-01T00:00:00Z').status, 0);
  });
  it('usage errors exit 64', () => {
    assert.equal(run().status, 64);
    assert.equal(run('missing-file.jsonl').status, 64);
    assert.equal(run(logFile(), '--before', 'yesterday').status, 64);
  });
});
