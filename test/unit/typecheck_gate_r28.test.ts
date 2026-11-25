/**
 * R28 / RV06 — the typecheck gate must only accept a recognised, completed TypeScript run.
 *
 * Each case copies the real gate script and known list into a temporary root and places a
 * fake compiler at node_modules/typescript/bin/tsc (or none). No installed package is touched.
 * Before RV06 a missing compiler produced "0 diagnostic(s)" and exit 0.
 *
 * Module under test: the script `scripts/ops/typecheck-gate.mjs` (copied into each temporary root and run
 * there with Node).
 *
 * Strategy / partitions: compiler absent; crashing without diagnostics; hanging until the timeout; not
 * TypeScript (no version banner); exit 0 with diagnostics; a new error; only a known error; a known error at
 * another position; a clean compilation.
 *
 * Needs: temporary directories (removed in `after`); each gate run has a 30 s limit and the hang case gives the
 * gate a 500 ms compiler timeout. No network.
 *
 * Run just this file: `npx tsx --test test/unit/typecheck_gate_r28.test.ts`
 *
 * @module test/unit/typecheck_gate_r28.test
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const repo = path.resolve(import.meta.dirname, '..', '..');
const KNOWN = "src/auth/sso/OidcProvider.ts(75,20): error TS2307: Cannot find module 'openid-client' or its corresponding type declarations.";
const NEW = "src/api/routes.ts(10,5): error TS2322: Type 'string' is not assignable to type 'number'.";
const roots: string[] = [];

/**
 * Build a temp root with the gate and, optionally, a fake tsc whose body is `compiler`.
 * @param compiler - Source of the fake compiler script, or `null` to leave the compiler absent.
 * @returns The temporary root; it is registered for removal in `after`.
 */
function makeRoot(compiler: string | null): string {
  const root = mkdtempSync(path.join(tmpdir(), 'otk-gate-r28-'));
  roots.push(root);
  const ops = path.join(root, 'scripts', 'ops');
  mkdirSync(ops, { recursive: true });
  copyFileSync(path.join(repo, 'scripts', 'ops', 'typecheck-gate.mjs'), path.join(ops, 'typecheck-gate.mjs'));
  // OVERNIGHT 20261005: the known list is a FIXTURE here (it used to be the repository's list, which is now empty because
  // its three entries were resolved in Phase 5); the cases test the gate's handling of known entries, not the repo state.
  writeFileSync(path.join(ops, 'typecheck-known.txt'), [
    '# fixture known list (test only)',
    "src/auth/sso/OidcProvider.ts: error TS2307: Cannot find module 'openid-client' | fixture",
    "src/auth/sso/SamlProvider.ts: error TS2307: Cannot find module '@node-saml/node-saml' | fixture",
  ].join('\n') + '\n');
  if (compiler !== null) {
    const bin = path.join(root, 'node_modules', 'typescript', 'bin');
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, 'tsc'), compiler);
  }
  return root;
}

/**
 * Fake compiler: answers --version like tsc, otherwise runs `body`.
 * @param body - Script run for a normal compile.
 * @param version - Script run for the version query; prints a TypeScript banner by default.
 */
const fake = (body: string, version = "process.stdout.write('Version 5.9.3\\n');") =>
  `if (process.argv.includes('--version')) { ${version} process.exit(0); }\n${body}\n`;

function runGate(root: string, extra: string[] = []) {
  const r = spawnSync(process.execPath, [path.join(root, 'scripts', 'ops', 'typecheck-gate.mjs'), ...extra], { encoding: 'utf8', timeout: 30_000 });
  return { status: r.status, out: r.stdout + r.stderr };
}

after(() => { for (const r of roots) rmSync(r, { recursive: true, force: true }); });

describe('R28/RV06 — typecheck gate rejects runs that are not a completed tsc check', () => {
  it('compiler absent → fails (was: exit 0 with "0 diagnostic(s)")', () => {
    const g = runGate(makeRoot(null));
    assert.notEqual(g.status, 0, g.out);
    assert.match(g.out, /compiler_missing/);
  });

  it('compiler crashes without TS diagnostics → fails', () => {
    const g = runGate(makeRoot(fake("process.stderr.write('TypeError: boom\\n    at run (tsc.js:1)\\n'); process.exit(1);")));
    assert.notEqual(g.status, 0, g.out);
    assert.match(g.out, /without_diagnostics/);
  });

  it('compiler hangs and is killed by the timeout → fails', () => {
    const g = runGate(makeRoot(fake('setInterval(() => {}, 1000);')), ['--timeout-ms=500']);
    assert.notEqual(g.status, 0, g.out);
    assert.match(g.out, /spawn_failed|killed_by_signal/);
  });

  it('something that is not TypeScript (no Version banner) → fails', () => {
    const g = runGate(makeRoot(fake('process.exit(0);', "process.stdout.write('hello\\n');")));
    assert.notEqual(g.status, 0, g.out);
    assert.match(g.out, /compiler_unrecognised/);
  });

  it('exit 0 while printing diagnostics → fails as inconsistent', () => {
    const g = runGate(makeRoot(fake(`process.stdout.write(${JSON.stringify(NEW + '\n')}); process.exit(0);`)));
    assert.notEqual(g.status, 0, g.out);
    assert.match(g.out, /inconsistent/);
  });

  it('new TS error → fails and names it', () => {
    const g = runGate(makeRoot(fake(`process.stdout.write(${JSON.stringify(KNOWN + '\n' + NEW + '\n')}); process.exit(2);`)));
    assert.equal(g.status, 1, g.out);
    assert.match(g.out, /UNEXPECTED src\/api\/routes\.ts: error TS2322/);
  });

  it('only a known TS error → passes and reports the other known entries as resolved', () => {
    const g = runGate(makeRoot(fake(`process.stdout.write(${JSON.stringify(KNOWN + '\n')}); process.exit(2);`)));
    assert.equal(g.status, 0, g.out);
    assert.match(g.out, /1 diagnostic\(s\), 1 known, 0 unexpected/);
  });

  it('a known error repeated at another position counts as new', () => {
    const again = KNOWN.replace('(75,20)', '(90,3)');
    const g = runGate(makeRoot(fake(`process.stdout.write(${JSON.stringify(KNOWN + '\n' + again + '\n')}); process.exit(2);`)));
    assert.equal(g.status, 1, g.out);
    assert.match(g.out, /2 diagnostic\(s\), 1 known, 1 unexpected/);
  });

  it('clean compilation (exit 0, no diagnostics) → passes', () => {
    const g = runGate(makeRoot(fake('process.exit(0);')));
    assert.equal(g.status, 0, g.out);
    assert.match(g.out, /0 diagnostic\(s\)/);
  });
});
