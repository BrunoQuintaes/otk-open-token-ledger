/**
 * RB-01 (RUN-M1-RESUME-20261012): tools/academic_demo/check_outcomes.mjs decides whether one runbook step passed.
 * A step passes only when every leaf test outcome is accounted for BY NAME (failures, cancellations and todo equal the
 * declared sets; skips inside the allowed set; total and summary consistent); a non-zero exit is accepted only when it
 * is fully explained by declared failures or cancellations.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const { parseTap, classify } = await import(pathToFileURL(path.join(ROOT, 'tools', 'academic_demo', 'check_outcomes.mjs')).href);

type Leaf = { name: string; outcome: 'pass' | 'fail' | 'cancelled' | 'todo' | 'skipped' };
/** node:test-shaped TAP: one suite per distinct parent, leaves with YAML blocks, then the summary lines. */
function tap(leaves: Leaf[], summaryOverride: Record<string, number> = {}, withSummary = true): string {
  const out: string[] = [];
  const bySuite = new Map<string, Leaf[]>();
  for (const l of leaves) { const [s, t] = l.name.split(' > '); bySuite.set(s, [...(bySuite.get(s) ?? []), { ...l, name: t }]); }
  let n = 0;
  for (const [suite, ls] of bySuite) {
    out.push(`# Subtest: ${suite}`);
    ls.forEach((l, k) => {
      const dir = l.outcome === 'todo' ? ' # TODO open item' : l.outcome === 'skipped' ? ' # SKIP reason' : '';
      const ok = l.outcome === 'pass' || l.outcome === 'skipped';
      out.push(`    # Subtest: ${l.name}`, `    ${ok ? 'ok' : 'not ok'} ${k + 1} - ${l.name}${dir}`, '      ---', '      duration_ms: 1', "      type: 'test'");
      if (l.outcome === 'cancelled') out.push("      failureType: 'cancelledByParent'");
      if (l.outcome === 'fail') out.push("      failureType: 'testCodeFailure'");
      out.push('      ...');
    });
    out.push(`    1..${ls.length}`, `${ls.some((l) => l.outcome === 'fail' || l.outcome === 'cancelled') ? 'not ok' : 'ok'} ${++n} - ${suite}`, '  ---', "  type: 'suite'", '  ...');
  }
  const c = (o: string) => leaves.filter((l) => l.outcome === o).length;
  const s = { tests: leaves.length, pass: c('pass'), fail: c('fail'), cancelled: c('cancelled'), skipped: c('skipped'), todo: c('todo'), ...summaryOverride };
  if (withSummary) for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) out.push(`# ${k} ${(s as Record<string, number>)[k]}`);
  return out.join('\n') + '\n';
}
const P = (name: string): Leaf => ({ name, outcome: 'pass' });

describe('RB-01 check_outcomes: TAP parsing', () => {
  it('names leaves by their suite path and ignores suite result lines', () => {
    const { leaves, summary } = parseTap(tap([P('S > a'), { name: 'S > b', outcome: 'fail' }, { name: 'T > c', outcome: 'todo' }]));
    assert.deepEqual(leaves, [{ name: 'S > a', outcome: 'pass' }, { name: 'S > b', outcome: 'fail' }, { name: 'T > c', outcome: 'todo' }]);
    assert.equal(summary.tests, 3);
  });
});

describe('RB-01 check_outcomes: a step passes only with outcomes accounted for by name', () => {
  const base = { tests: 3 };
  it('all pass, exit 0, nothing declared → PASS', () => {
    assert.equal(classify(base, tap([P('S > a'), P('S > b'), P('S > c')]), 0).verdict, 'PASS');
  });
  it('the declared failure, by exact name, with exit 1 → PASS_DECLARED', () => {
    const r = classify({ ...base, expected_failures: ['S > c'] }, tap([P('S > a'), P('S > b'), { name: 'S > c', outcome: 'fail' }]), 1);
    assert.equal(r.verdict, 'PASS_DECLARED', JSON.stringify(r.reasons));
  });
  it('an extra failure besides the declared one → FAIL', () => {
    const r = classify({ ...base, expected_failures: ['S > c'] }, tap([P('S > a'), { name: 'S > b', outcome: 'fail' }, { name: 'S > c', outcome: 'fail' }]), 1);
    assert.equal(r.verdict, 'FAIL'); assert.match(r.reasons.join(' '), /unexpected=\["S > b"\]/);
  });
  it('the same test name failing in another suite does not match the declaration → FAIL', () => {
    const r = classify({ ...base, expected_failures: ['S > c'] }, tap([P('S > a'), P('S > b'), { name: 'X > c', outcome: 'fail' }]), 1);
    assert.equal(r.verdict, 'FAIL');
  });
  it('a declared failure that no longer fails (stale declaration) → FAIL', () => {
    assert.equal(classify({ ...base, expected_failures: ['S > c'] }, tap([P('S > a'), P('S > b'), P('S > c')]), 0).verdict, 'FAIL');
  });
  it('declared cancellations match by name; an undeclared cancellation → FAIL', () => {
    const t = tap([P('S > a'), { name: 'S > b', outcome: 'cancelled' }, { name: 'S > c', outcome: 'cancelled' }]);
    assert.equal(classify({ ...base, expected_cancelled: ['S > b', 'S > c'] }, t, 1).verdict, 'PASS_DECLARED');
    assert.equal(classify({ ...base, expected_cancelled: ['S > b'] }, t, 1).verdict, 'FAIL');
  });
  it('todo must equal the declared set (a new or vanished todo → FAIL); todo is not counted as pass', () => {
    const t = tap([P('S > a'), P('S > b'), { name: 'S > c', outcome: 'todo' }]);
    const ok = classify({ ...base, expected_todo: ['S > c'] }, t, 0);
    assert.equal(ok.verdict, 'PASS'); assert.equal(ok.counts.pass, 2); assert.equal(ok.counts.todo, 1);
    assert.equal(classify(base, t, 0).verdict, 'FAIL');
    assert.equal(classify({ ...base, expected_todo: ['S > c', 'S > d'] }, t, 0).verdict, 'FAIL');
  });
  it('skips: allowed by name → PASS; any other skip → FAIL', () => {
    const t = tap([P('S > a'), P('S > b'), { name: 'S > c', outcome: 'skipped' }]);
    assert.equal(classify({ ...base, allowed_skips: ['S > c'] }, t, 0).verdict, 'PASS');
    assert.equal(classify(base, t, 0).verdict, 'FAIL');
  });
  it('a different total (a test file that did not load, or tests added) → FAIL', () => {
    assert.equal(classify(base, tap([P('S > a'), P('S > b')]), 0).verdict, 'FAIL');
    assert.equal(classify(base, tap([P('S > a'), P('S > b'), P('S > c'), P('S > d')]), 0).verdict, 'FAIL');
  });
  it('missing summary (run killed) or a summary that disagrees with the leaves → FAIL', () => {
    assert.equal(classify(base, tap([P('S > a'), P('S > b'), P('S > c')], {}, false), 0).verdict, 'FAIL');
    assert.equal(classify(base, tap([P('S > a'), P('S > b'), P('S > c')], { fail: 1 }), 0).verdict, 'FAIL');
  });
  it('exit code non-zero with every test passing (e.g. crash after the tests) → FAIL', () => {
    assert.equal(classify(base, tap([P('S > a'), P('S > b'), P('S > c')]), 1).verdict, 'FAIL');
  });
  it('exit code 0 while a test failed → FAIL', () => {
    assert.equal(classify({ ...base, expected_failures: ['S > c'] }, tap([P('S > a'), P('S > b'), { name: 'S > c', outcome: 'fail' }]), 0).verdict, 'FAIL');
  });
  it('no declaration for the step → FAIL', () => {
    assert.equal(classify(undefined, tap([P('S > a')]), 0).verdict, 'FAIL');
  });
  it('empty output (no tests ran) → FAIL', () => {
    assert.equal(classify({ tests: 0 }, '', 0).verdict, 'FAIL');
  });
});
