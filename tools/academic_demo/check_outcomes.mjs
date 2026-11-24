#!/usr/bin/env node
// Classifies the TAP output of one runbook step against docs/academic_release/expected_outcomes.json
// (RUN-M1-RESUME-20261012, RB-01). A step passes only if every leaf test outcome is accounted for BY NAME:
// failures, cancellations and todo must equal the declared sets exactly, skips must be in the allowed set,
// the total must equal the declared total and the summary counts must agree with the parsed leaves.
// A non-zero exit of the step is accepted only when it is fully explained by declared failures/cancellations.
//
//   node check_outcomes.mjs --expected <expected_outcomes.json> --step <name> --log <step log> --rc <exit code>
// stdout: one JSON line {step, verdict, reasons[], counts, ...}; exit 0 = PASS or PASS_DECLARED, 1 = FAIL, 2 = usage.
import fs from 'node:fs';

/** Parses node:test TAP: leaf tests (type 'test') with their full path, directive and failure type. */
export function parseTap(text) {
  const lines = text.split(/\r?\n/);
  const stack = []; // [{indent, name}]
  const leaves = [];
  const summary = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sm = /^# (tests|suites|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line);
    if (sm) { summary[sm[1]] = (summary[sm[1]] ?? 0) + Number(sm[2]); continue; }
    const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (sub) {
      const indent = sub[1].length;
      while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
      stack.push({ indent, name: sub[2] });
      continue;
    }
    const r = /^(\s*)(not ok|ok) \d+ - (.*)$/.exec(line);
    if (!r) continue;
    const indent = r[1].length;
    let title = r[3];
    let directive = null;
    const d = / # (TODO|SKIP)\b.*$/i.exec(title);
    if (d) { directive = d[1].toUpperCase(); title = title.slice(0, d.index); }
    // YAML block right after the result line
    let type = null; let failureType = null;
    if (lines[i + 1] !== undefined && /^\s*---\s*$/.test(lines[i + 1])) {
      for (let j = i + 2; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) {
        const t = /^\s*type: '(\w+)'/.exec(lines[j]); if (t) type = t[1];
        const f = /^\s*failureType: '(\w+)'/.exec(lines[j]); if (f) failureType = f[1];
      }
    }
    // the "# Subtest:" line of this result is the innermost stack entry at the same indent
    while (stack.length && stack[stack.length - 1].indent > indent) stack.pop();
    const parents = stack.filter((s) => s.indent < indent).map((s) => s.name);
    if (stack.length && stack[stack.length - 1].indent === indent) stack.pop();
    if (type === 'suite') continue;
    const name = [...parents, title].join(' > ');
    let outcome;
    if (directive === 'TODO') outcome = 'todo';
    else if (directive === 'SKIP') outcome = 'skipped';
    else if (r[2] === 'ok') outcome = 'pass';
    else if (failureType === 'cancelledByParent') outcome = 'cancelled';
    else outcome = 'fail';
    leaves.push({ name, outcome });
  }
  return { leaves, summary };
}

const eqSet = (a, b) => a.length === b.length && [...a].sort().every((v, k) => v === [...b].sort()[k]);

export function classify(exp, text, rc, step = '?') {
  const reasons = [];
  if (!exp) return { step, verdict: 'FAIL', reasons: [`no expected outcome declared for step ${step}`] };
  const { leaves, summary } = parseTap(text);
  const by = (o) => leaves.filter((l) => l.outcome === o).map((l) => l.name);
  const counts = { tests: leaves.length, pass: by('pass').length, fail: by('fail').length, cancelled: by('cancelled').length,
    skipped: by('skipped').length, todo: by('todo').length };
  for (const k of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    if (summary[k] === undefined) reasons.push(`summary line "# ${k}" missing (run did not finish or output is not TAP)`);
    else if (summary[k] !== counts[k]) reasons.push(`summary ${k}=${summary[k]} differs from parsed leaves ${counts[k]}`);
  }
  if (counts.tests !== exp.tests) reasons.push(`tests=${counts.tests}, expected exactly ${exp.tests}`);
  const want = { fail: exp.expected_failures ?? [], cancelled: exp.expected_cancelled ?? [], todo: exp.expected_todo ?? [] };
  for (const k of ['fail', 'cancelled', 'todo']) {
    const got = by(k);
    if (!eqSet(got, want[k])) {
      const extra = got.filter((n) => !want[k].includes(n)); const missing = want[k].filter((n) => !got.includes(n));
      reasons.push(`${k} set differs from declared: unexpected=${JSON.stringify(extra)} missing=${JSON.stringify(missing)}`);
    }
  }
  const badSkips = by('skipped').filter((n) => !(exp.allowed_skips ?? []).includes(n));
  if (badSkips.length) reasons.push(`skips not allowed: ${JSON.stringify(badSkips)}`);
  const explained = want.fail.length + want.cancelled.length > 0;
  if (rc !== 0 && !(explained && reasons.length === 0)) reasons.push(`exit code ${rc} not explained by declared outcomes`);
  if (rc === 0 && (counts.fail > 0 || counts.cancelled > 0)) reasons.push(`exit code 0 with fail/cancelled tests`);
  const verdict = reasons.length ? 'FAIL' : (rc === 0 && !explained ? 'PASS' : 'PASS_DECLARED');
  return { step, verdict, reasons, counts, rc, declared: { failures: want.fail, cancelled: want.cancelled, todo: want.todo } };
}

function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, '')] = argv[i + 1];
  if (!a.expected || !a.step || !a.log || a.rc === undefined || !/^\d+$/.test(a.rc)) {
    console.error('usage: check_outcomes.mjs --expected <file> --step <name> --log <file> --rc <n>'); return 2;
  }
  let exp; let text;
  try { exp = JSON.parse(fs.readFileSync(a.expected, 'utf8')).steps?.[a.step]; } catch (e) {
    console.log(JSON.stringify({ step: a.step, verdict: 'FAIL', reasons: [`cannot read expected outcomes: ${e.message}`] })); return 1;
  }
  try { text = fs.readFileSync(a.log, 'utf8'); } catch (e) {
    console.log(JSON.stringify({ step: a.step, verdict: 'FAIL', reasons: [`cannot read step log: ${e.message}`] })); return 1;
  }
  const res = classify(exp, text, Number(a.rc), a.step);
  console.log(JSON.stringify(res));
  return res.verdict === 'FAIL' ? 1 : 0;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) process.exitCode = main(process.argv.slice(2));
