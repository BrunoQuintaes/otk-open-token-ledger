/**
 * H1R2 B3 — static checks of the author-side PA-03 v1 runner (tools/academic_demo/windows/run_pa03_v1.ps1 and its
 * optional bash twin run_pa03_v1.sh).
 *
 * The two PA-03 Closeout contract tests need the historical v1 proving key (zk/build/metering_v1_final.zkey), which is
 * not versioned and exists only on the author's machine. The runner lets the author execute exactly those two tests and
 * keep sanitized evidence. These checks make sure the runner, as committed, cannot leak or transfer the key:
 *   - no network/upload primitive in executable code (npm ci only behind the explicit -NpmCi switch);
 *   - the key file is only hashed (Get-FileHash / sha256), never read, printed, copied, moved or linked;
 *   - it runs the right file with the same reporter flags as battery step R07e_contracts and the env override that the
 *     test honours;
 *   - the expected SHA-256 is the published one (scripts/ops/repro_contracts.sh);
 *   - it stays Windows PowerShell 5.1 compatible (no pwsh-7-only operators);
 *   - the README keeps the status pending_author_evidence (no PASS claimed from here).
 * Nothing here runs the PA-03 tests or touches any key.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = path.join(ROOT, 'tools', 'academic_demo', 'windows');
const PS1 = path.join(DIR, 'run_pa03_v1.ps1');
const SH = path.join(DIR, 'run_pa03_v1.sh');
const README = path.join(DIR, 'README_PA03_V1.md');
const PA03_TEST = path.join(ROOT, 'tools', 'hardhat', 'test', 'PA03Closeout.test.js');
const REPRO = path.join(ROOT, 'scripts', 'ops', 'repro_contracts.sh');
const EXPECTED = path.join(ROOT, 'docs', 'academic_release', 'expected_outcomes.json');

const TEST_NAMES = [
  'generates fresh ZK proof and submits on-chain — captures real txHash',
  'second submit with same commitment is rejected (anti-replay)',
];
const SUITE = 'PA-03 Closeout — Full Loop (ZK Proof + On-Chain)';
const ENV_VAR = 'OTK_PA03_V1_ZKEY';

const read = (f: string) => fs.readFileSync(f, 'utf8');

/** Executable PowerShell lines only: drops <# ... #> blocks and whole-line # comments. */
function psCode(src: string): string[] {
  const noBlocks = src.replace(/<#[\s\S]*?#>/g, '');
  return noBlocks.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
}
/** Executable bash lines only (whole-line # comments dropped, shebang included in the drop). */
function shCode(src: string): string[] {
  return src.split(/\r?\n/).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
}

function publishedHash(): string {
  const m = read(REPRO).match(/ZKEY_SHA256="([0-9a-f]{64})"/);
  assert.ok(m, 'scripts/ops/repro_contracts.sh must publish ZKEY_SHA256');
  return m[1];
}

describe('H1R2 B3 — PA-03 v1 author runner (static)', () => {
  it('the runner, its bash twin and the PT-BR README exist', () => {
    for (const f of [PS1, SH, README]) assert.ok(fs.existsSync(f), `missing ${path.relative(ROOT, f)}`);
  });

  it('PS1: no network or upload primitive in executable code', () => {
    const code = psCode(read(PS1)).join('\n');
    const banned = /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm|curl(\.exe)?|wget|Start-BitsTransfer|Net\.WebClient|WebClient|HttpClient|System\.Net\.Http|Send-MailMessage|ftp|scp|sftp|rsync|Invoke-Command|New-PSSession|Upload\w*|git\s+push|npm\s+publish|gh\s)\b/i;
    const hit = code.split('\n').find((l) => banned.test(l));
    assert.equal(hit, undefined, `network/upload primitive found: ${hit}`);
  });

  it('PS1: npm ci appears once and only behind the explicit -NpmCi switch', () => {
    const lines = psCode(read(PS1));
    assert.match(read(PS1), /\[switch\]\s*\$NpmCi/);
    const idx = lines.map((l, i) => (/\bnpm(\.cmd)?\b.*\bci\b/.test(l) ? i : -1)).filter((i) => i >= 0);
    assert.ok(idx.length >= 1, 'npm ci call expected (opt-in)');
    // every npm ci call lives inside the function that is only invoked under `if ($NpmCi)`
    const fnStart = lines.findIndex((l) => /^\s*function\s+Invoke-OptionalNpmCi\b/.test(l));
    assert.ok(fnStart >= 0, 'npm ci must be wrapped in Invoke-OptionalNpmCi');
    const fnEnd = lines.findIndex((l, i) => i > fnStart && /^}\s*$/.test(l));
    for (const i of idx) assert.ok(i > fnStart && i < fnEnd, `npm ci outside Invoke-OptionalNpmCi: ${lines[i]}`);
    const calls = lines.filter((l) => /\bInvoke-OptionalNpmCi\b/.test(l) && !/^\s*function\b/.test(l));
    assert.ok(calls.length >= 1);
    for (const c of calls) assert.match(c, /if\s*\(\s*\$NpmCi\s*\)/, `Invoke-OptionalNpmCi called without the switch: ${c}`);
  });

  it('PS1: the key file is only hashed — never read, printed, copied, moved or linked', () => {
    const lines = psCode(read(PS1));
    const keyVar = /\$Zkey\w*/i;
    // only the PATH and the HASH of the key may be handled; any read/copy/link/archive primitive on it is refused
    const forbidden = /\b(Get-Content|gc|cat|type|more|ReadAll\w*|OpenRead|FileStream|StreamReader|Copy-Item|cp|copy|Move-Item|mv|move|Rename-Item|Out-File|Set-Content|Add-Content|Format-Hex|Select-String|Compress-Archive|Expand-Archive|New-Item|SymbolicLink|HardLink|Junction)\b/i;
    for (const l of lines) {
      if (keyVar.test(l)) assert.doesNotMatch(l, forbidden, `key variable used with a read/copy/link primitive: ${l.trim()}`);
    }
    assert.ok(lines.some((l) => /Get-FileHash\b.*-Algorithm\s+SHA256/.test(l) && keyVar.test(l)), 'the key must be hashed with Get-FileHash -Algorithm SHA256');
    assert.ok(!lines.some((l) => /\b(Copy-Item|Move-Item|SymbolicLink|HardLink|Junction)\b/i.test(l)), 'no copy/move/link primitive at all');
  });

  it('PS1: runs exactly PA03Closeout.test.js with the R07e reporter flags and the env override', () => {
    const src = read(PS1);
    const code = psCode(src).join('\n');
    assert.match(code, /PA03Closeout\.test\.js/);
    assert.match(code, /--test-reporter=tap/);
    assert.match(code, /--test-concurrency=1/);
    assert.match(code, new RegExp(`\\$env:${ENV_VAR}\\b`));
    assert.doesNotMatch(code, /test\/\*\.test\.js|test\\\*\.test\.js/, 'must not run the whole contract suite');
    // the .ps1 is ASCII (Windows PowerShell 5.1 reads BOM-less files as ANSI): the em dash is built with [char]0x2014
    assert.match(code, /\$Dash\s*=\s*\[string\]\[char\]0x2014/);
    for (const n of [...TEST_NAMES, SUITE]) {
      for (const part of n.split(' \u2014 ')) assert.ok(code.includes(part), `runner must name the test: ${n} (part "${part}")`);
    }
    assert.ok(/^[\x00-\x7F]*$/.test(src), 'run_pa03_v1.ps1 must be pure ASCII');
  });

  it('PS1 and SH: the expected SHA-256 is the one published in scripts/ops/repro_contracts.sh', () => {
    const h = publishedHash();
    const ps = read(PS1); const sh = read(SH);
    assert.match(ps, new RegExp(`\\$ExpectedSha256\\s*=\\s*'${h}'`));
    assert.match(sh, new RegExp(`EXPECTED_SHA256="${h}"`));
    // the hash comparison must stop the run (non-zero exit) when it differs
    assert.match(psCode(ps).join('\n'), /-ne\s+\$ExpectedSha256[\s\S]{0,400}exit\s+4/);
  });

  it('PS1: Windows PowerShell 5.1 compatible (no pwsh-7-only operators) and strict', () => {
    const src = read(PS1);
    assert.match(src, /#Requires -Version 5\.1/);
    assert.match(src, /Set-StrictMode -Version/);
    const code = psCode(src).map((l) => l.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""'));
    for (const l of code) {
      assert.doesNotMatch(l, /\?\?|\?\.|&&|\|\|/, `pwsh-7-only operator: ${l.trim()}`);
      assert.doesNotMatch(l, /\s\?\s[^:]+\s:\s/, `ternary operator: ${l.trim()}`);
    }
  });

  it('PS1: evidence goes outside the repository by default and is sanitized', () => {
    const code = psCode(read(PS1)).join('\n');
    assert.match(code, /Test-IsInside/);
    assert.match(code, /AllowOutputInsideRepo/);
    assert.match(code, /<REPO>/, 'absolute repository path must be replaced in the saved TAP');
    assert.match(code, /<ZKEY_DIR>/, 'absolute key directory must be replaced in the saved TAP');
    assert.match(code, /pending_author_evidence/);
  });

  it('SH twin: no network, only hashes the key, same file and flags', () => {
    const lines = shCode(read(SH));
    const code = lines.join('\n');
    assert.doesNotMatch(code, /\b(curl|wget|scp|sftp|rsync|ftp|nc|git\s+push|npm\s+publish)\b/);
    assert.match(code, /PA03Closeout\.test\.js/);
    assert.match(code, /--test-reporter=tap/);
    assert.match(code, /--test-concurrency=1/);
    assert.match(code, new RegExp(`${ENV_VAR}=`));
    for (const l of lines) {
      if (/\$\{?ZKEY\b/.test(l)) assert.doesNotMatch(l, /\b(cat|head|tail|less|more|xxd|od|hexdump|cp|mv|ln|base64|tar|zip)\b/, `key used with a read/copy primitive: ${l.trim()}`);
    }
    for (const l of lines.filter((x) => /\bnpm\s+ci\b/.test(x))) assert.match(l, /NPM_CI/, `npm ci not gated: ${l.trim()}`);
  });

  it('PA03Closeout.test.js honours the env override and keeps the default path and skip', () => {
    const t = read(PA03_TEST);
    assert.match(t, new RegExp(`process\\.env\\.${ENV_VAR}`));
    assert.match(t, /"metering_v1_final\.zkey"/);
    assert.match(t, /skip: V1_KEY_ABSENT/);
    for (const n of TEST_NAMES) assert.ok(t.includes(`it("${n}"`), `test not found: ${n}`);
  });

  it('the two tests are exactly the R07e pending_author_evidence entries (status not changed here)', () => {
    const e = JSON.parse(read(EXPECTED));
    const pend: string[] = e.steps.R07e_contracts.pending_author_evidence;
    assert.deepEqual([...pend].sort(), TEST_NAMES.map((n) => `${SUITE} > ${n}`).sort());
  });

  it('README (PT-BR) keeps pending_author_evidence and claims no PASS', () => {
    const r = read(README);
    assert.match(r, /pending_author_evidence/);
    assert.match(r, /run_pa03_v1\.ps1/);
    assert.match(r, new RegExp(publishedHash()));
    assert.doesNotMatch(r, /status[^\n]*:\s*PASS\b/i);
  });
});
