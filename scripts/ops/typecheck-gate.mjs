#!/usr/bin/env node
/**
 * R28 — typecheck gate. Runs `tsc --noEmit` and fails on any diagnostic that is not
 * listed in scripts/ops/typecheck-known.txt. Each known entry names the open finding
 * that owns it, so remaining type errors stay visible instead of being silenced.
 *
 * RV06: the known list only applies to a recognised, completed compiler run. A missing
 * compiler, a spawn error/timeout, a signal, an unexpected exit status, or a non-zero
 * exit without TS diagnostics fails the gate before any diagnostic is interpreted.
 * tsc exit status: 0 = no diagnostics; 1/2 = diagnostics reported.
 *
 * Usage: node scripts/ops/typecheck-gate.mjs [--timeout-ms=N]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
const timeoutArg = process.argv.find((a) => a.startsWith('--timeout-ms='));
const timeout = timeoutArg ? Number(timeoutArg.split('=')[1]) : 10 * 60_000;

function fail(reason, detail = '') {
  console.log(`typecheck: FAIL ${reason}${detail ? ` — ${detail}` : ''}`);
  process.exit(1);
}

/** Why a spawnSync result is not a usable compiler run, or null when it is. */
function runProblem(run) {
  if (run.error) return ['spawn_failed', run.error.message];
  if (run.signal) return ['killed_by_signal', run.signal];
  return null;
}

if (!existsSync(tsc)) fail('compiler_missing', tsc);

const version = spawnSync(process.execPath, [tsc, '--version'], { cwd: root, encoding: 'utf8', timeout });
const vProblem = runProblem(version);
if (vProblem) fail(...vProblem);
if (version.status !== 0 || !/^Version \d+\.\d+/.test(version.stdout.trim())) {
  fail('compiler_unrecognised', (version.stdout + version.stderr).trim().slice(0, 200));
}

const run = spawnSync(process.execPath, [tsc, '--noEmit', '--pretty', 'false'], { cwd: root, encoding: 'utf8', timeout, maxBuffer: 64 * 1024 * 1024 });
const problem = runProblem(run);
if (problem) fail(...problem);
if (![0, 1, 2].includes(run.status)) fail('unexpected_exit_status', String(run.status));

const norm = (l) => l.replace(/\\/g, '/').replace(/\(\d+,\d+\)/, '').replace(/"[^"]*\/src\//g, '"src/').trim();
const found = (run.stdout + run.stderr).split('\n').filter((l) => /error TS\d+/.test(l)).map(norm);

if (run.status === 0 && found.length > 0) fail('inconsistent', `exit 0 with ${found.length} diagnostic(s)`);
if (run.status !== 0 && found.length === 0) {
  fail('compiler_failed_without_diagnostics', `exit ${run.status}: ${(run.stdout + run.stderr).trim().slice(0, 300)}`);
}

const known = readFileSync(path.join(root, 'scripts', 'ops', 'typecheck-known.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))
  .map((l) => l.split(' | ')[0].trim());

// Each known entry absorbs at most one diagnostic: a second identical error at another
// position in the same file is new and must be reported (positions are stripped by norm).
const unused = [...known];
const unexpected = [];
for (const d of found) {
  const i = unused.findIndex((k) => d.startsWith(k));
  if (i >= 0) unused.splice(i, 1); else unexpected.push(d);
}
const resolved = unused;

console.log(`typecheck: ${found.length} diagnostic(s), ${found.length - unexpected.length} known, ${unexpected.length} unexpected (${version.stdout.trim()})`);
for (const d of unexpected) console.log(`  UNEXPECTED ${d}`);
for (const k of resolved) console.log(`  resolved (remove from known list): ${k}`);
process.exit(unexpected.length > 0 ? 1 : 0);
