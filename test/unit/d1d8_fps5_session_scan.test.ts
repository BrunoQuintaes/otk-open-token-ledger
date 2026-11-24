/**
 * RV2-03 (fechamento pós-S5) — the session-cookie scanner detects SYNTHETIC session credentials and
 * reports only path:line (never the value). The cookies below are fabricated for this test; they are
 * built at runtime so this file itself does not contain a cookie-shaped literal.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const dir = mkdtempSync(path.join(tmpdir(), 'otk-fps5-scan-'));
const fake = 'Zz' + 'Q9'.repeat(20) + '.synthetic';
const scan = (...files: string[]) => spawnSync('bash', ['scripts/ops/session_secret_scan.sh', ...files], { encoding: 'utf8' });

describe('RV2-03 — session secret scanner', () => {
  it('flags a Cookie header and a signed session cookie, prints only locations', () => {
    const f = path.join(dir, 'settings.json');
    writeFileSync(f, ['{', `  "a": "curl -H \\"Cookie: app_session2=s%3A${fake}\\" https://example.invalid"`, `  "b": "sid_session=s%3A${fake}"`, '  "c": "plain"', '}'].join('\n'));
    const r = scan(f);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /settings\.json:2/);
    assert.match(r.stdout, /settings\.json:3/);
    assert.ok(!r.stdout.includes(fake) && !r.stderr.includes(fake), 'value never printed');
  });

  it('ignores short placeholders and unrelated text', () => {
    const f = path.join(dir, 'clean.md');
    writeFileSync(f, 'Use a session=abc placeholder.\nCookie handling is documented here.\n');
    const r = scan(f);
    assert.equal(r.status, 0, r.stdout);
  });

  it('the current repository tree has no hit', () => {
    const r = spawnSync('bash', ['scripts/ops/session_secret_scan.sh'], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stdout.split('\n').slice(0, 5).join('\n'));
  });
});
