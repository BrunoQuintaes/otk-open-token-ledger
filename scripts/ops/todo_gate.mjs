#!/usr/bin/env node
// H1-S11/H1-S19 (OTK-H1-MEGA-S01-S24-20261013): a `todo` test is an OPEN finding, never a pass. `npm test` exits 0 with
// todo tests, so CI could stay green while a new finding is only marked todo, or after a finding was fixed without
// removing its marker. This gate reads the TAP of `npm test` and fails unless the set of todo tests is exactly the
// set declared in docs/academic_release/expected_outcomes.json (steps.R07_npm_test.expected_todo), and unless the
// run has no failed or cancelled test. It does not check totals or skips (check_outcomes.mjs does, for the package).
//
//   npm test 2>&1 | tee npm_test.tap; node scripts/ops/todo_gate.mjs --log npm_test.tap [--expected <file>]
// exit 0 = ok, 1 = gate failed, 2 = usage.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const { parseTap } = await import(pathToFileURL(path.join(HERE, '..', '..', 'tools', 'academic_demo', 'check_outcomes.mjs')).href);

const a = {}; const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
if (!a.log) { console.error('usage: todo_gate.mjs --log <npm test TAP> [--expected <expected_outcomes.json>]'); process.exit(2); }
const expectedFile = a.expected ?? path.join(HERE, '..', '..', 'docs', 'academic_release', 'expected_outcomes.json');

const { leaves, summary } = parseTap(fs.readFileSync(a.log, 'utf8'));
const declared = JSON.parse(fs.readFileSync(expectedFile, 'utf8')).steps?.R07_npm_test?.expected_todo ?? [];
const names = (o) => leaves.filter((l) => l.outcome === o).map((l) => l.name);
const todo = names('todo');
const reasons = [];
if (summary.tests === undefined) reasons.push('no TAP summary: the run did not finish');
for (const k of ['fail', 'cancelled']) if (names(k).length) reasons.push(`${k}: ${JSON.stringify(names(k))}`);
const undeclared = todo.filter((n) => !declared.includes(n));
const resolved = declared.filter((n) => !todo.includes(n));
if (undeclared.length) reasons.push(`todo tests not declared as open findings: ${JSON.stringify(undeclared)}`);
if (resolved.length) reasons.push(`declared todo tests no longer todo (remove from the manifest or restore the marker): ${JSON.stringify(resolved)}`);
console.log(JSON.stringify({ gate: 'todo', ok: reasons.length === 0, todo: todo.length, declared: declared.length, reasons }));
process.exit(reasons.length ? 1 : 0);
