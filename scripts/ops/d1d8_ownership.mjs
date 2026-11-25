#!/usr/bin/env node
/**
 * D1–D8 file ownership (S0 run 20260930-1625).
 *
 * Every path has exactly one owner, given by the first matching rule in
 * scripts/ops/d1d8_ownership_rules.json. Fronts run `check` before each commit; S4 runs it on
 * each imported branch. A path owned by someone else is a violation even if the edit is small:
 * ask the coordinator instead (control/<role>/REQUEST_*.md).
 *
 * Usage:
 *   node scripts/ops/d1d8_ownership.mjs owner <path>...          owner + rule of each path
 *   node scripts/ops/d1d8_ownership.mjs table                   TSV of every tracked path
 *   node scripts/ops/d1d8_ownership.mjs summary                 count of tracked paths per owner
 *   node scripts/ops/d1d8_ownership.mjs check --role A [--base <sha>]
 *        changed paths since base (commits + index + worktree + untracked) not owned by role → exit 1
 *
 * Reads the rules file only; it never changes files. Without `--base` the base is HEAD, so only
 * uncommitted and untracked changes are checked. Exit codes: 0 = no violation; 1 = violations;
 * 2 = usage error. Tested by test/unit/d1d8_s0_contract.test.ts.
 *
 * @module scripts/ops/d1d8_ownership
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const rulesFile = path.join(root, 'scripts', 'ops', 'd1d8_ownership_rules.json');
const { rules } = JSON.parse(readFileSync(rulesFile, 'utf8'));

/**
 * Glob → RegExp: `**` any depth (also zero dirs when followed by /), `*` within one segment.
 *
 * @param glob - A rule glob with forward slashes, matched against the whole repo-relative path.
 * @returns An anchored regular expression; every other character is matched literally.
 */
function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const compiled = rules.map(([glob, owner, note]) => ({ glob, owner, note, re: globToRegExp(glob) }));

/**
 * Finds the owner of a repository path: the first rule (in file order) whose glob matches.
 *
 * @param p - Repo-relative path; backslashes are accepted and normalised to forward slashes.
 * @returns The matching rule as `{ glob, owner, note, re }`, or `{ glob: '(none)', owner: 'S0', note: 'no rule' }`
 *   when no rule matches.
 */
export function ownerOf(p) {
  const norm = p.replace(/\\/g, '/');
  for (const r of compiled) if (r.re.test(norm)) return r;
  return { glob: '(none)', owner: 'S0', note: 'no rule' };
}

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);

function tracked() {
  // gitlinks (submodules) are listed as their path, which the rules cover explicitly
  return lines(git(['ls-files']));
}

function changedSince(base) {
  const set = new Set();
  for (const p of lines(git(['diff', '--name-only', '--no-renames', `${base}...HEAD`]))) set.add(p);
  for (const p of lines(git(['diff', '--name-only', '--no-renames', 'HEAD']))) set.add(p);
  for (const p of lines(git(['diff', '--name-only', '--no-renames', '--cached']))) set.add(p);
  for (const p of lines(git(['ls-files', '--others', '--exclude-standard']))) set.add(p);
  return [...set].sort();
}

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };

if (cmd === 'owner') {
  for (const p of rest) { const r = ownerOf(p); console.log(`${p}\t${r.owner}\t${r.glob}`); }
} else if (cmd === 'table') {
  console.log('path\towner\trule');
  for (const p of tracked()) { const r = ownerOf(p); console.log(`${p}\t${r.owner}\t${r.glob}`); }
} else if (cmd === 'summary') {
  const counts = {};
  for (const p of tracked()) { const o = ownerOf(p).owner; counts[o] = (counts[o] ?? 0) + 1; }
  console.log(JSON.stringify(counts, null, 1));
} else if (cmd === 'check') {
  const role = opt('--role');
  if (!['A', 'B', 'C', 'S0', 'S4'].includes(role ?? '')) { console.error('check: --role A|B|C|S0|S4 required'); process.exit(2); }
  const base = opt('--base') ?? git(['merge-base', 'HEAD', 'HEAD']).trim();
  const changed = changedSince(base);
  // S4 integrates everything; during integration it may touch any non-AUTHOR/FROZEN path.
  const allowed = (o) => role === 'S4' ? !['AUTHOR', 'FROZEN'].includes(o) : o === role;
  const bad = changed.map((p) => ({ p, r: ownerOf(p) })).filter(({ r }) => !allowed(r.owner));
  console.log(`ownership check role=${role} base=${base} changed=${changed.length} violations=${bad.length}`);
  for (const { p, r } of bad) console.log(`  VIOLATION ${p}\towner=${r.owner}\trule=${r.glob}`);
  process.exit(bad.length ? 1 : 0);
} else {
  console.error('usage: d1d8_ownership.mjs owner <path>... | table | summary | check --role <R> [--base <sha>]');
  process.exit(2);
}
