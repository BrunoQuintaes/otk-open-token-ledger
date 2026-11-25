/**
 * RB-01 (RUN-M1-RESUME-20261012): tools/academic_demo/run_from_package.sh must never report success after a mandatory
 * step failed. The author-side runner of RUN-M1-24H (runbook_from_package_v2.sh) logged each exit code and then always
 * printed "runbook done" with exit 0; its run of 10/10 had 3 failing steps (npm test, contracts, demo) and still ended 0.
 *
 * The real runner runs against a tiny fake package with fake npm/npx/docker/node(test steps only)/git(ls-remote only)
 * on PATH, so every failure class can be injected without network, Docker or the real test suite:
 *   A npm ci · B tsc · C npm test · D contracts · E PostgreSQL not healthy · F Redis not healthy · G Besu not ready
 *   (demo stops) · H demo exit 1 / summary not ok · I input missing · J hash mismatch / truncated / substituted /
 *   malformed hash file / manifest mismatch / unsafe tar · K signal · L cleanup failure.
 * For each case: exit code != 0, the failed step is named, no PASS line, evidence kept, cleanup only of the run's own
 * projects, no process left behind.
 *
 * Under test: `tools/academic_demo/run_from_package.sh` (the script that verifies, extracts and runs a release
 * package end to end) together with `tools/academic_demo/check_outcomes.mjs`.
 *
 * Further scenarios beyond A–L: the all-pass baseline; a failure declared in advance by exact name is reported as
 * declared-pass, never as plain pass; a declaration that does not happen fails; an expected-outcomes file edited
 * after packaging is caught by the manifest; an existing work or report folder is refused; a Docker subnet already
 * in use is skipped; a container left by the demo is removed by the runner's cleanup (own project only).
 *
 * Needs: `bash`, `tar` and `sha256sum` (the suites are skipped without them); temporary directories (removed after
 * the run); child processes; several cases run concurrently. No network, no real Docker and no real test suite:
 * every external tool is a fake placed first on `PATH`. The signal case sends SIGTERM to the runner. Each runner
 * call is bounded at 240 s, after which the runner is signalled.
 *
 * Run just this file: `npx tsx --test test/release/academic_runbook_runner.test.ts`
 *
 * @module test/release/academic_runbook_runner.test
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const RUNNER = path.join(ROOT, 'tools', 'academic_demo', 'run_from_package.sh');
const CHECKER = path.join(ROOT, 'tools', 'academic_demo', 'check_outcomes.mjs');
const hasBash = spawnSync('bash', ['-c', 'tar --version && sha256sum --version'], { encoding: 'utf-8' }).status === 0;
const IS_WIN = process.platform === 'win32';
const fwd = (p: string) => p.replace(/\\/g, '/');
const dirs: string[] = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');
const COMMIT = 'abcdef012345' + '0'.repeat(28);
const TOP = `OTK_ACADEMIC_RELEASE_${COMMIT.slice(0, 12)}`;

// ---- fake tools -------------------------------------------------------------------------------------------------
const TAP_OK = `# Subtest: fake suite
    # Subtest: t1
    ok 1 - t1
      ---
      duration_ms: 1
      type: 'test'
      ...
    # Subtest: t2
    ok 2 - t2
      ---
      duration_ms: 1
      type: 'test'
      ...
    1..2
ok 1 - fake suite
  ---
  type: 'suite'
  ...
# tests 2
# pass 2
# fail 0
# cancelled 0
# skipped 0
# todo 0
`;
const TAP_FAIL = TAP_OK.replace('    ok 2 - t2', '    not ok 2 - t2').replace("      type: 'test'\n      ...\n    1..2", "      type: 'test'\n      failureType: 'testCodeFailure'\n      ...\n    1..2")
  .replace('# pass 2\n# fail 0', '# pass 1\n# fail 1');

function fakeBin(dir: string) {
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  const realNode = fwd(process.execPath);
  const realGit = fwd(spawnSync('bash', ['-c', 'command -v git'], { encoding: 'utf-8' }).stdout.trim());
  fs.writeFileSync(path.join(dir, 'tap_ok.txt'), TAP_OK); fs.writeFileSync(path.join(dir, 'tap_fail.txt'), TAP_FAIL);
  const common = `#!/usr/bin/env bash
D='${fwd(dir)}'
fails() { [ "\${RB_FAKE_FAIL:-}" = "\${RB_STEP:-}" ] && [ -n "\${RB_STEP:-}" ]; }
sleepy() { [ "\${RB_FAKE_SLEEP:-}" = "\${RB_STEP:-}" ] && [ -n "\${RB_STEP:-}" ] && "${realNode}" -e "setTimeout(()=>{},60000)" "RBMARK_\${RB_FAKE_MARK:-x}"; }
tapout() { sleepy; if fails; then cat "$D/tap_fail.txt"; exit 1; else cat "$D/tap_ok.txt"; exit 0; fi; }
`;
  const w = (name: string, body: string) => fs.writeFileSync(path.join(bin, name), common + body, { mode: 0o755 });
  w('npm', `case "$1" in
  -v) echo 10.9.0 ;; ping) [ "\${RB_FAKE_NET_DOWN:-0}" = 1 ] && exit 1; exit 0 ;;
  ci) sleepy; fails && { echo "npm ERR! fake failure"; exit 1; }; exit 0 ;;
  test) tapout ;;
  run) case "$*" in *test:tap*) tapout ;; *) exit 0 ;; esac ;;  # F-H1-13b: R07 runs "npm run -s test:tap"
  *) exit 0 ;;
esac\n`);
  w('npx', `sleepy; fails && { echo "fake hardhat failure"; exit 1; }; echo compiled; exit 0\n`);
  // node: real node except for the test steps the runner delegates to the package (tsc, test runners)
  w('node', `case "\${RB_STEP:-}" in
  R06b_tsc) sleepy; fails && { echo "error TS0000: fake"; exit 2; }; exit 0 ;;
  R07c_cu_reference|R07d_zk_v3|R07e_contracts|R07f_services) tapout ;;
  *) exec "${realNode}" "$@" ;;
esac\n`);
  w('git', `if [ "$1" = ls-remote ]; then [ "\${RB_FAKE_NET_DOWN:-0}" = 1 ] && exit 128; exit 0; fi; exec "${realGit}" "$@"\n`);
  // docker: state per compose project in $D/docker_state/<project>; every call logged
  w('docker', `echo "$*" >> "$D/docker_calls.log"; mkdir -p "$D/docker_state"
proj=""; prev=""; for a in "$@"; do [ "$prev" = -p ] && proj="$a"; case "$a" in label=com.docker.compose.project=*) proj="\${a#label=com.docker.compose.project=}";; esac; prev="$a"; done
case "$1" in
  version) echo 29.0.0; exit 0 ;;
  network) if [ "$2" = ls ] && [ -z "$proj" ]; then [ -n "\${RB_FAKE_USED_SUBNET:-}" ] && echo usednet; exit 0; fi
    if [ "$2" = inspect ]; then case " $* " in *" usednet "*) echo "\${RB_FAKE_USED_SUBNET} ";; esac; exit 0; fi
    [ "$2" = ls ] && [ -n "$proj" ] && [ -f "$D/docker_state/$proj" ] && echo fakenet; exit 0 ;;
  ps|volume) [ -n "$proj" ] && [ -f "$D/docker_state/$proj" ] && echo fakeid; exit 0 ;;
  compose)
    case " $* " in
      *" version "*) echo "Docker Compose version v2.fake"; exit 0 ;;
      *" up "*) touch "$D/docker_state/$proj"
        if [ "\${RB_FAKE_FAIL:-}" = "\${RB_STEP:-}" ] && [ -n "\${RB_FAKE_UNHEALTHY:-}" ]; then echo "container $proj-\${RB_FAKE_UNHEALTHY}-1 is unhealthy"; exit 1; fi; exit 0 ;;
      *" down "*) if [ "\${RB_FAKE_DOWN_FAIL:-0}" = 1 ] && [ "\${RB_STEP:-}" = "" ]; then echo "fake: down refused"; exit 1; fi
        rm -f "$D/docker_state/$proj"; exit 0 ;;
      *" ps "*) exit 0 ;;
    esac ;;
esac
exit 0\n`);
  return bin;
}

// ---- fake package -------------------------------------------------------------------------------------------------
const STEP_EXP = { tests: 2 };
function fakeSource(stepOverride: Record<string, unknown> = {}): Record<string, string | Buffer> {
  const expected = { schema: 'otk.runbook_expected_outcomes.v1', steps: {
    R07_npm_test: STEP_EXP, R07c_cu_reference: STEP_EXP, R07d_zk_v3: STEP_EXP, R07e_contracts: STEP_EXP, R07f_services: STEP_EXP, ...stepOverride } };
  // fake demo: honours RB_FAKE_FAIL=R08_demo (exit 1), RB_FAKE_BESU=notready (stops like the real demo),
  // RB_FAKE_SUMMARY_OK=0 (exit 0 but ok:false), RB_FAKE_DEMO_LEAVE=1 (leaves a container of its Besu project)
  const demo = `#!/usr/bin/env bash
mkdir -p "$DEMO_OUT"
docker compose -p "$DEMO_BESU_PROJECT" up -d >/dev/null
[ "\${RB_FAKE_BESU:-}" = notready ] && { echo "STOP: Besu not ready"; docker compose -p "$DEMO_BESU_PROJECT" down -v; exit 1; }
[ "\${RB_FAKE_FAIL:-}" = R08_demo ] && { echo "STOP: fake demo failure"; docker compose -p "$DEMO_BESU_PROJECT" down -v; exit 1; }
src=$(node -e "process.stdout.write(require('../MANIFEST.json').commit)")
ok=true; [ "\${RB_FAKE_SUMMARY_OK:-1}" = 0 ] && ok=false
printf '{"ok":%s,"source":"package:%s","operations":9,"consistent":9,"receiptCheck":{"a":true}}\\n' "$ok" "$src" > "$DEMO_OUT/DEMO_SUMMARY.json"
[ "\${RB_FAKE_DEMO_LEAVE:-0}" = 1 ] || docker compose -p "$DEMO_BESU_PROJECT" down -v >/dev/null
echo "DEMO DONE"
`;
  return {
    'tools/academic_demo/run_from_package.sh': fs.readFileSync(RUNNER),
    'tools/academic_demo/check_outcomes.mjs': fs.readFileSync(CHECKER),
    'tools/academic_demo/run_demo.sh': demo,
    'docs/academic_release/expected_outcomes.json': JSON.stringify(expected, null, 1),
    'infra/test/docker-compose.services.yml': 'services: {}\n',
    'infra/test/docker-compose.services.subnet.yml': 'networks: {}\n',
    'test/services/a.test.ts': '// fake\n',
    'tools/hardhat/package.json': '{}\n',
    'package.json': '{"name":"fake"}\n',
  };
}
function writeTree(dir: string, files: Record<string, string | Buffer>) {
  for (const [rel, body] of Object.entries(files)) { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); }
}
/**
 * builds <dir>/pkg.tar (+ .sha256); `mutate` may change the source tree after the manifest is written
 *
 * @param dir - Temporary directory that receives the staging tree, the tar and its hash file.
 * @param opts - `mutate`: edits the source tree after the manifest is written (to create a manifest mismatch);
 *   `steps`: overrides passed to the fake source (expected outcomes of the steps).
 * @returns Path of the tar file.
 */
function buildPackage(dir: string, opts: { mutate?: (src: string) => void; steps?: Record<string, unknown> } = {}) {
  const stage = path.join(dir, 'stage'); const src = path.join(stage, TOP, 'source');
  const files = fakeSource(opts.steps); writeTree(src, files);
  const m: any = { schema: 'otk.academic_release_manifest.v2', commit: COMMIT, files: {} };
  for (const [rel, body] of Object.entries(files)) m.files[rel] = { class: 'SOURCE', sha256: sha(Buffer.from(body as any)) };
  fs.writeFileSync(path.join(stage, TOP, 'MANIFEST.json'), JSON.stringify(m));
  opts.mutate?.(src);
  const tar = path.join(dir, 'pkg.tar');
  const r = spawnSync('bash', ['-c', `cd "${fwd(stage)}" && tar --force-local --sort=name -cf "${fwd(tar)}" ${TOP}`], { encoding: 'utf-8' });
  assert.equal(r.status, 0, r.stderr);
  fs.writeFileSync(tar + '.sha256', `${sha(fs.readFileSync(tar))}  pkg.tar\n`);
  return tar;
}

// ---- minimal ustar writer, for packages a normal tar command would not produce (unsafe names, symlinks) ----------
function ustar(entries: { name: string; type: '0' | '5' | '2'; body?: string; link?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const h = Buffer.alloc(512); const body = Buffer.from(e.body ?? '');
    h.write(e.name, 0, 100); h.write(e.type === '5' ? '0000755\0' : '0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116);
    h.write((e.type === '0' ? body.length : 0).toString(8).padStart(11, '0') + '\0', 124); h.write('00000000000\0', 136);
    h.write('        ', 148); h.write(e.type, 156); if (e.link) h.write(e.link, 157, 100); h.write('ustar\0', 257); h.write('00', 263);
    let sum = 0; for (const b of h) sum += b; h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h); if (e.type === '0' && body.length) { const pad = Buffer.alloc(Math.ceil(body.length / 512) * 512); body.copy(pad); blocks.push(pad); }
  }
  blocks.push(Buffer.alloc(1024));
  return Buffer.concat(blocks);
}

// ---- run the real runner ------------------------------------------------------------------------------------------
type Run = { status: number | null; out: string; result: Record<string, string>; steps: string; dir: string; docker: string; work: string };
function env(dir: string, extra: Record<string, string>) {
  const keep: Record<string, string> = {};
  for (const k of ['SystemRoot', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'WINDIR', 'ComSpec', 'PATHEXT']) if (process.env[k]) keep[k] = process.env[k] as string;
  const bin = fakeBin(dir);
  return { ...keep, PATH: `${bin}${path.delimiter}${process.env.PATH}`, RB_ID: 't' + path.basename(dir).replace(/[^a-z0-9]/gi, '').toLowerCase(), ...extra };
}
function read(dir: string) {
  const out = path.join(dir, 'out');
  const res: Record<string, string> = {};
  const rf = path.join(out, 'RUNBOOK_RESULT.txt');
  if (fs.existsSync(rf)) for (const l of fs.readFileSync(rf, 'utf-8').split('\n')) { const i = l.indexOf('='); if (i > 0) res[l.slice(0, i)] = l.slice(i + 1); }
  const sf = path.join(out, 'RUNBOOK_STEPS.txt');
  const dl = path.join(dir, 'docker_calls.log');
  return { result: res, steps: fs.existsSync(sf) ? fs.readFileSync(sf, 'utf-8') : '', docker: fs.existsSync(dl) ? fs.readFileSync(dl, 'utf-8') : '' };
}
/**
 * runs the real runner; on timeout the runner itself is signalled (its own trap cleans up and kills its step tree)
 *
 * @param extra - Extra environment variables for the runner (e.g. fault injections for the fake tools).
 * @param opts - Overrides: `tar` and `shaFile` (default: a freshly built package and its hash file), `dir` (default:
 *   a new temporary directory) and `args` (default: the standard tar, hash, work and output arguments).
 * @returns Exit status, combined output, the parsed result file, the step log, the fake docker call log and paths.
 */
async function runner(extra: Record<string, string> = {}, opts: { tar?: string; shaFile?: string; dir?: string; args?: string[] } = {}): Promise<Run> {
  const dir = opts.dir ?? tmp('otk-rb-');
  const tar = opts.tar ?? buildPackage(dir);
  const work = path.join(dir, 'w');
  const args = opts.args ?? ['--tar', tar, '--sha256-file', opts.shaFile ?? tar + '.sha256', '--workdir', work, '--out', path.join(dir, 'out')];
  const child = spawn('bash', [path.join(path.dirname(tar), 'stage', TOP, 'source', 'tools', 'academic_demo', 'run_from_package.sh'), ...args],
    { cwd: dir, env: env(dir, extra), stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; child.stdout.on('data', (d) => { out += d; }); child.stderr.on('data', (d) => { out += d; });
  const status = await new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      const pidFile = path.join(dir, 'out', 'RUNNER_PID');
      if (fs.existsSync(pidFile)) spawnSync('bash', ['-c', `kill -TERM ${fs.readFileSync(pidFile, 'utf-8').trim()}`]); else child.kill();
      out += '\n[test] runner timed out after 240 s and was signalled\n';
    }, 240_000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  return { status, out, ...read(dir), dir, work };
}
function assertFail(r: Run, step: RegExp) {
  assert.notEqual(r.status, 0, r.out);
  assert.equal(r.result.verdict, 'FAIL', r.out);
  assert.match(r.result.failed_step, step, r.out);
  assert.doesNotMatch(r.steps, /RUNBOOK_RESULT=PASS/);
  assert.doesNotMatch(r.steps, /runbook done/);
  assert.match(r.steps, /RUNBOOK_RESULT=FAIL/);
}
/**
 * only compose projects of this run were touched, and none is left
 *
 * @param r - Result of {@link runner}.
 */
function assertOwnDockerOnly(r: Run) {
  const id = r.result.rb_id;
  for (const line of r.docker.split('\n').filter(Boolean)) {
    const m = /-p (\S+)/.exec(line) ?? /label=com\.docker\.compose\.project=(\S+)/.exec(line);
    if (m) assert.match(m[1], new RegExp(`^otk-rb-${id}-`), `foreign project in: ${line}`);
    assert.doesNotMatch(line, /\b(prune|rm|rmi|kill)\b/, `destructive docker call: ${line}`);
  }
  const state = path.join(r.dir, 'docker_state');
  if (r.result.cleanup === 'OK') assert.deepEqual(fs.existsSync(state) ? fs.readdirSync(state) : [], []);
}

describe('RB-01 run_from_package.sh: success only when every step passed', { concurrency: 4, skip: !hasBash && 'bash/tar not available' }, () => {
  it('baseline: all steps pass → exit 0, verdict PASS, cleanup OK, every step logged', async () => {
    const r = await runner();
    assert.equal(r.status, 0, r.out + r.steps);
    assert.equal(r.result.verdict, 'PASS');
    assert.equal(r.result.cleanup, 'OK');
    for (const s of ['R00_preflight', 'R01_sha256', 'R02a_listing_safety', 'R02_extract', 'R02c_manifest', 'R02b_git_init', 'R04_npm_ci',
      'R04b_npm_ci_hardhat', 'R06_hardhat_compile', 'R06b_tsc', 'R07_npm_test', 'R07c_cu_reference', 'R07d_zk_v3', 'R07e_contracts',
      'R07f_services', 'R08_demo', 'R08b_demo_summary']) assert.match(r.steps, new RegExp(`${s} (verdict=PASS|expected=)`), s);
    assert.equal(r.result.package_commit, COMMIT);
    assertOwnDockerOnly(r);
  });
  it('a declared failure, by exact name, is reported as PASS_DECLARED (exit 0), never as plain PASS', async () => {
    const dir = tmp('otk-rb-');
    const tar = buildPackage(dir, { steps: { R07_npm_test: { tests: 2, expected_failures: ['fake suite > t2'] } } });
    const r = await runner({ RB_FAKE_FAIL: 'R07_npm_test' }, { tar, dir });
    assert.equal(r.status, 0, r.out + r.steps);
    assert.equal(r.result.verdict, 'PASS_DECLARED');
    assert.match(r.steps, /R07_npm_test verdict=PASS_DECLARED exit=1/);
  });
  it('a declared failure that does not happen (stale declaration) → FAIL', async () => {
    const dir = tmp('otk-rb-');
    const tar = buildPackage(dir, { steps: { R07_npm_test: { tests: 2, expected_failures: ['fake suite > t2'] } } });
    assertFail(await runner({}, { tar, dir }), /^R07_npm_test$/);
  });
  it('an expected_outcomes.json edited after packaging is caught by the manifest (R02c)', async () => {
    const dir = tmp('otk-rb-');
    const tar = buildPackage(dir, { mutate: (src) => {
      const f = path.join(src, 'docs/academic_release/expected_outcomes.json'); const e = JSON.parse(fs.readFileSync(f, 'utf-8'));
      e.steps.R07_npm_test = { tests: 2, expected_failures: ['fake suite > t2'] }; fs.writeFileSync(f, JSON.stringify(e)); } });
    assertFail(await runner({ RB_FAKE_FAIL: 'R07_npm_test' }, { tar, dir }), /^R02c_manifest$/);
  });
});

describe('RB-01 run_from_package.sh: negative cases A–L', { concurrency: 6, skip: !hasBash && 'bash/tar not available' }, () => {
  const cases: [string, Record<string, string>, RegExp][] = [
    ['A npm ci fails', { RB_FAKE_FAIL: 'R04_npm_ci' }, /^R04_npm_ci$/],
    ['A2 npm ci of tools/hardhat fails', { RB_FAKE_FAIL: 'R04b_npm_ci_hardhat' }, /^R04b_npm_ci_hardhat$/],
    ['hardhat compile fails', { RB_FAKE_FAIL: 'R06_hardhat_compile' }, /^R06_hardhat_compile$/],
    ['B tsc fails', { RB_FAKE_FAIL: 'R06b_tsc' }, /^R06b_tsc$/],
    ['C npm test has an undeclared failure', { RB_FAKE_FAIL: 'R07_npm_test' }, /^R07_npm_test$/],
    ['CU reference test fails', { RB_FAKE_FAIL: 'R07c_cu_reference' }, /^R07c_cu_reference$/],
    ['ZK v3 test fails', { RB_FAKE_FAIL: 'R07d_zk_v3' }, /^R07d_zk_v3$/],
    ['D contract test fails', { RB_FAKE_FAIL: 'R07e_contracts' }, /^R07e_contracts$/],
    ['E PostgreSQL does not become healthy', { RB_FAKE_FAIL: 'R07f_services', RB_FAKE_UNHEALTHY: 'postgres' }, /^R07f_services$/],
    ['F Redis does not become healthy', { RB_FAKE_FAIL: 'R07f_services', RB_FAKE_UNHEALTHY: 'redis' }, /^R07f_services$/],
    ['service tests fail', { RB_FAKE_FAIL: 'R07f_services' }, /^R07f_services$/],
    ['G Besu never ready (demo stops)', { RB_FAKE_BESU: 'notready' }, /^R08_demo$/],
    ['H demo ends with exit 1', { RB_FAKE_FAIL: 'R08_demo' }, /^R08_demo$/],
    ['H2 demo ends with exit 0 but its summary says ok:false', { RB_FAKE_SUMMARY_OK: '0' }, /^R08b_demo_summary$/],
    ['network unreachable (npm registry / GitHub) stops at preflight', { RB_FAKE_NET_DOWN: '1' }, /^R00_preflight$/],
  ];
  for (const [title, extra, step] of cases) {
    it(title, async () => {
      const r = await runner(extra);
      assertFail(r, step);
      assert.ok(fs.existsSync(path.join(r.dir, 'out', `${r.result.failed_step}.txt`)), 'log of the failed step kept');
      assertOwnDockerOnly(r);
      assert.equal(r.result.cleanup, 'OK');
      if (/^R07f/.test(r.result.failed_step) && extra.RB_FAKE_UNHEALTHY) {
        assert.match(fs.readFileSync(path.join(r.dir, 'out', 'R07f_services.txt'), 'utf-8'), new RegExp(`SERVICES_UP_FAILED[\\s\\S]*${extra.RB_FAKE_UNHEALTHY}|${extra.RB_FAKE_UNHEALTHY}[\\s\\S]*SERVICES_UP_FAILED`));
        assert.match(r.docker, /compose -p \S+ .*down -v/, 'services brought down after a failed up');
      }
      // nothing after the failed step ran
      if (r.result.failed_step === 'R04_npm_ci') assert.doesNotMatch(r.steps, /R07_npm_test/);
    });
  }

  it('I package file missing → FAIL at R01, nothing extracted', async () => {
    const dir = tmp('otk-rb-'); const tar = buildPackage(dir);
    const r = await runner({}, { dir, tar: path.join(dir, 'missing.tar'), shaFile: tar + '.sha256' });
    assertFail(r, /^R01_sha256$/); assert.ok(!fs.existsSync(r.work));
  });
  it('I2 expected-hash file missing → FAIL at R01', async () => {
    const dir = tmp('otk-rb-'); const tar = buildPackage(dir);
    assertFail(await runner({}, { dir, tar, shaFile: path.join(dir, 'nope.sha256') }), /^R01_sha256$/);
  });
  it('J hash differs (altered byte) → FAIL at R01 before extraction; both values recorded', async () => {
    const dir = tmp('otk-rb-'); const tar = buildPackage(dir);
    const b = fs.readFileSync(tar); b[600] ^= 0x01; fs.writeFileSync(tar, b);
    const r = await runner({}, { dir, tar });
    assertFail(r, /^R01_sha256$/); assert.ok(!fs.existsSync(r.work));
    assert.notEqual(r.result.sha256_expected, r.result.sha256_actual);
    assert.match(r.result.reason, /mismatch/);
  });
  it('J2 truncated package → FAIL at R01', async () => {
    const dir = tmp('otk-rb-'); const tar = buildPackage(dir);
    fs.writeFileSync(tar, fs.readFileSync(tar).subarray(0, 2048));
    assertFail(await runner({}, { dir, tar }), /^R01_sha256$/);
  });
  it('J3 substituted package (another valid package, announced hash of the first) → FAIL at R01', async () => {
    const dir = tmp('otk-rb-'); const tar = buildPackage(dir);
    const other = tmp('otk-rb-other-'); const tar2 = buildPackage(other, { mutate: (s) => fs.appendFileSync(path.join(s, 'package.json'), ' ') });
    fs.copyFileSync(tar2, tar);
    assertFail(await runner({}, { dir, tar }), /^R01_sha256$/);
  });
  it('J4 malformed or ambiguous expected-hash file → FAIL at R01', async () => {
    const dir = tmp('otk-rb-'); const tar = buildPackage(dir);
    fs.writeFileSync(tar + '.sha256', 'not a hash\n');
    assertFail(await runner({}, { dir, tar }), /^R01_sha256$/);
    const dir2 = tmp('otk-rb-'); const tar2 = buildPackage(dir2); const h = sha(fs.readFileSync(tar2));
    fs.writeFileSync(tar2 + '.sha256', `${h}  pkg.tar\n${'0'.repeat(64)}  other.tar\n`);
    assertFail(await runner({}, { dir: dir2, tar: tar2 }), /^R01_sha256$/);
  });
  it('J5 manifest incompatible with the files (hash announced for the tampered tar) → FAIL at R02c', async () => {
    const dir = tmp('otk-rb-');
    const tar = buildPackage(dir, { mutate: (s) => fs.appendFileSync(path.join(s, 'infra/test/docker-compose.services.yml'), '# changed\n') });
    const r = await runner({}, { dir, tar });
    assertFail(r, /^R02c_manifest$/);
    assert.match(fs.readFileSync(path.join(r.dir, 'out', 'R02c_manifest.txt'), 'utf-8'), /HASH MISMATCH infra\/test\/docker-compose\.services\.yml/);
  });
  it('J6 file listed in the manifest but omitted, or extra file not listed → FAIL at R02c', async () => {
    const d1 = tmp('otk-rb-'); const t1 = buildPackage(d1, { mutate: (s) => fs.rmSync(path.join(s, 'test/services/a.test.ts')) });
    const r1 = await runner({}, { dir: d1, tar: t1 }); assertFail(r1, /^R02c_manifest$/);
    assert.match(fs.readFileSync(path.join(d1, 'out', 'R02c_manifest.txt'), 'utf-8'), /MISSING test\/services\/a\.test\.ts/);
    const d2 = tmp('otk-rb-'); const t2 = buildPackage(d2, { mutate: (s) => fs.writeFileSync(path.join(s, 'extra.txt'), 'x') });
    const r2 = await runner({}, { dir: d2, tar: t2 }); assertFail(r2, /^R02c_manifest$/);
    assert.match(fs.readFileSync(path.join(d2, 'out', 'R02c_manifest.txt'), 'utf-8'), /NOT IN MANIFEST extra\.txt/);
  });
  it('J7 unsafe tar (".." path, absolute path, symlink, two top folders) → FAIL at R02a, nothing extracted', async () => {
    const bad: [string, Parameters<typeof ustar>[0]][] = [
      ['dotdot', [{ name: `${TOP}/`, type: '5' }, { name: `${TOP}/../evil.txt`, type: '0', body: 'x' }]],
      ['absolute', [{ name: `/tmp/${TOP}/x`, type: '0', body: 'x' }]],
      ['symlink', [{ name: `${TOP}/`, type: '5' }, { name: `${TOP}/link`, type: '2', link: '/etc' }]],
      ['twotops', [{ name: `${TOP}/a`, type: '0', body: 'x' }, { name: 'OTHER/b', type: '0', body: 'y' }]],
    ];
    for (const [label, entries] of bad) {
      const dir = tmp('otk-rb-'); buildPackage(dir);
      const tar = path.join(dir, 'pkg.tar'); fs.writeFileSync(tar, ustar(entries)); fs.writeFileSync(tar + '.sha256', sha(fs.readFileSync(tar)) + '\n');
      const r = await runner({}, { dir, tar });
      assertFail(r, /^R02a_listing_safety$/); assert.ok(!fs.existsSync(r.work), label);
      assert.ok(!fs.existsSync(path.join(dir, 'evil.txt')), label);
    }
  });
  it('existing workdir or report folder → refused (never reuses a folder)', async () => {
    const dir = tmp('otk-rb-'); const tar = buildPackage(dir); fs.mkdirSync(path.join(dir, 'w'));
    assertFail(await runner({}, { dir, tar }), /^R02_extract$/);
    const dir2 = tmp('otk-rb-'); const tar2 = buildPackage(dir2); fs.mkdirSync(path.join(dir2, 'out'));
    const r2 = await runner({}, { dir: dir2, tar: tar2 }); assert.equal(r2.status, 2);
  });

  it('L cleanup fails (a container of the run is left and docker refuses to remove it) → FAIL at 99_cleanup', async () => {
    const r = await runner({ RB_FAKE_DEMO_LEAVE: '1', RB_FAKE_DOWN_FAIL: '1' });
    assertFail(r, /^99_cleanup$/);
    assert.equal(r.result.cleanup, 'FAILED');
  });
  it('a Docker subnet already used by another network on the machine is skipped (services and demo get free ones)', async () => {
    const r = await runner({ RB_FAKE_USED_SUBNET: '172.31.100.0/24' });
    assert.equal(r.status, 0, r.out + r.steps);
    assert.match(r.steps, /subnets: services 172\.31\.101\.0\/24, demo services 172\.31\.102\.0\/24, demo Besu 172\.31\.103\.0\/24/);
  });
  it('L2 a container left by the demo is removed by the runner cleanup (only its own project) → PASS', async () => {
    const r = await runner({ RB_FAKE_DEMO_LEAVE: '1' });
    assert.equal(r.status, 0, r.out + r.steps); assert.equal(r.result.cleanup, 'OK');
    assert.match(r.docker, new RegExp(`compose -p otk-rb-${r.result.rb_id}-besu7 down -v --remove-orphans`));
    assertOwnDockerOnly(r);
  });
});

describe('RB-01 run_from_package.sh: K interruption by signal', { skip: (!hasBash && 'bash not available') || false }, () => {
  it('SIGTERM during npm test → exit 143, verdict INTERRUPTED, cleanup ran, no process of the step left', async () => {
    const dir = tmp('otk-rb-'); const tar = buildPackage(dir);
    const mark = 'k' + crypto.randomBytes(4).toString('hex');
    const out = path.join(dir, 'out');
    const child = spawn('bash', [path.join(dir, 'stage', TOP, 'source', 'tools', 'academic_demo', 'run_from_package.sh'),
      '--tar', tar, '--sha256-file', tar + '.sha256', '--workdir', path.join(dir, 'w'), '--out', out],
      { cwd: dir, env: env(dir, { RB_FAKE_SLEEP: 'R07_npm_test', RB_FAKE_MARK: mark }), stdio: 'ignore' });
    const exited = new Promise<number | null>((res) => child.on('exit', (c) => res(c)));
    const steps = path.join(out, 'RUNBOOK_STEPS.txt');
    const t0 = Date.now();
    while (!(fs.existsSync(steps) && /R06b_tsc verdict=PASS/.test(fs.readFileSync(steps, 'utf-8'))) && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 200));
    await new Promise((r) => setTimeout(r, 1500));
    // signal through bash: on Windows a Node kill() would be TerminateProcess (no trap), not a signal
    const pid = fs.readFileSync(path.join(out, 'RUNNER_PID'), 'utf-8').trim();
    spawnSync('bash', ['-c', `kill -TERM ${pid}`]);
    const code = await Promise.race([exited, new Promise<string>((r) => setTimeout(() => r('timeout'), 60_000))]);
    assert.equal(code, 143);
    const { result, steps: s } = read(dir);
    assert.equal(result.verdict, 'INTERRUPTED'); assert.match(result.reason, /signal TERM during R07_npm_test/);
    assert.doesNotMatch(s, /RUNBOOK_RESULT=PASS/);
    await new Promise((r) => setTimeout(r, 1000));
    const left = IS_WIN
      ? spawnSync('powershell', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -and $_.CommandLine -like '*RBMARK_${mark}*' }).Count`], { encoding: 'utf-8' }).stdout.trim()
      : String(spawnSync('bash', ['-c', `pgrep -c -f "^[^ ]*node .*RBMARK_${mark}" || true`], { encoding: 'utf-8' }).stdout.trim() || '0');
    assert.equal(left, '0', 'the step process (node with the marker) was killed');
  });
});
